import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PAYPAL_ENV = (Deno.env.get('PAYPAL_ENV') || 'live').toLowerCase();
const IS_SANDBOX = PAYPAL_ENV === 'sandbox';
const BASE = IS_SANDBOX ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
const CLIENT_ID = IS_SANDBOX ? Deno.env.get('PAYPAL_SANDBOX_CLIENT_ID') : Deno.env.get('PAYPAL_CLIENT_ID');
const CLIENT_SECRET = IS_SANDBOX ? Deno.env.get('PAYPAL_SANDBOX_CLIENT_SECRET') : Deno.env.get('PAYPAL_CLIENT_SECRET');

const SAR_PER_USD = 3.75;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PayPal auth failed [${res.status}]: ${text}`);
  return JSON.parse(text).access_token as string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return json({ error: 'PayPal credentials are not configured' }, 500);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json();
    const action = body?.action;

    // ---------- CREATE ORDER ----------
    if (action === 'create') {
      const kind: 'invoice' | 'payment_request' = body.kind === 'payment_request' ? 'payment_request' : 'invoice';
      const recordId = String(body.record_id || '');
      const returnUrl = String(body.return_url || '');
      const cancelUrl = String(body.cancel_url || returnUrl);
      if (!recordId || !returnUrl) return json({ error: 'record_id and return_url are required' }, 400);

      // Read the authoritative amount from the database (never trust the client)
      let amountSar = 0;
      let description = '';
      if (kind === 'invoice') {
        const { data, error } = await supabase
          .from('invoices')
          .select('id, amount, status, submission_id')
          .eq('id', recordId)
          .maybeSingle();
        if (error || !data) return json({ error: 'Invoice not found' }, 404);
        if (data.status === 'paid') return json({ error: 'الفاتورة مسددة مسبقاً' }, 409);
        amountSar = Number(data.amount || 0);
        description = `فاتورة رقم ${data.id}`;
      } else {
        const { data, error } = await supabase
          .from('payment_requests')
          .select('id, amount_sar, amount_usd, status, description')
          .eq('id', recordId)
          .maybeSingle();
        if (error || !data) return json({ error: 'Payment request not found' }, 404);
        if (data.status === 'paid') return json({ error: 'الطلب مسدد مسبقاً' }, 409);
        amountSar = Number(data.amount_sar || 0);
        description = data.description || `طلب سداد ${data.id}`;
      }

      if (!(amountSar > 0)) return json({ error: 'قيمة غير صالحة للسداد' }, 400);
      const amountUsd = (amountSar / SAR_PER_USD).toFixed(2);

      const token = await getAccessToken();
      const res = await fetch(`${BASE}/v2/checkout/orders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: `${kind}:${recordId}`,
              custom_id: `${kind}:${recordId}`,
              description: description.slice(0, 127),
              amount: { currency_code: 'USD', value: amountUsd },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: 'Rifanis Finance',
                locale: 'ar-SA',
                user_action: 'PAY_NOW',
                shipping_preference: 'NO_SHIPPING',
                return_url: returnUrl,
                cancel_url: cancelUrl,
              },
            },
          },
        }),
      });

      const text = await res.text();
      if (!res.ok) {
        console.error(`PayPal create order failed [${res.status}]: ${text}`);
        return json({ error: 'تعذّر إنشاء عملية الدفع', status: res.status, details: text }, res.status);
      }
      const order = JSON.parse(text);
      const approve = (order.links || []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve');
      return json({ order_id: order.id, approve_url: approve?.href, amount_usd: amountUsd, amount_sar: amountSar });
    }

    // ---------- CAPTURE ORDER ----------
    if (action === 'capture') {
      const orderId = String(body.order_id || '');
      if (!orderId) return json({ error: 'order_id is required' }, 400);

      const token = await getAccessToken();
      const res = await fetch(`${BASE}/v2/checkout/orders/${orderId}/capture`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const text = await res.text();
      let order: any = null;
      try { order = JSON.parse(text); } catch { /* ignore */ }

      // Already captured previously -> treat as success by re-reading the order
      const alreadyCaptured =
        !res.ok && JSON.stringify(order?.details || []).includes('ORDER_ALREADY_CAPTURED');

      if (!res.ok && !alreadyCaptured) {
        console.error(`PayPal capture failed [${res.status}]: ${text}`);
        return json({ error: 'تعذّر تأكيد الدفع', status: res.status, details: text }, res.status);
      }

      if (alreadyCaptured) {
        const look = await fetch(`${BASE}/v2/checkout/orders/${orderId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        order = await look.json();
      }

      const unit = order?.purchase_units?.[0];
      const custom: string = unit?.custom_id || unit?.reference_id || '';
      const capture = unit?.payments?.captures?.[0];
      const completed = order?.status === 'COMPLETED' || capture?.status === 'COMPLETED';

      if (!completed) {
        return json({ error: 'لم تكتمل عملية الدفع', paypal_status: order?.status ?? null }, 402);
      }

      const [kind, recordId] = custom.split(':');
      const paidAt = new Date().toISOString();

      if (kind === 'invoice' && recordId) {
        await supabase.from('invoices').update({ status: 'paid', paid_at: paidAt }).eq('id', recordId);
      } else if (kind === 'payment_request' && recordId) {
        await supabase.from('payment_requests').update({ status: 'paid', paid_at: paidAt }).eq('id', recordId);
      }

      return json({
        success: true,
        kind: kind ?? null,
        record_id: recordId ?? null,
        capture_id: capture?.id ?? null,
        amount: capture?.amount ?? null,
        paid_at: paidAt,
      });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    console.error('paypal-order error:', err instanceof Error ? err.message : String(err));
    return json({ error: err instanceof Error ? err.message : 'خطأ في الخادم' }, 500);
  }
});
