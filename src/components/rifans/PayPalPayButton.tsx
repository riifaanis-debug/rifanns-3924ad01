import React, { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Loader2 } from 'lucide-react';

interface Props {
  kind: 'invoice' | 'payment_request';
  recordId: string;
  label?: string;
}

const PayPalPayButton: React.FC<Props> = ({ kind, recordId, label = 'سداد الفاتورة' }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setLoading(true);
    setError(null);
    try {
      const returnUrl = `${window.location.origin}/#/pay/return`;
      const cancelUrl = `${window.location.origin}/#/pay/cancel`;
      const { data, error: fnError } = await supabase.functions.invoke('paypal-order', {
        body: { action: 'create', kind, record_id: recordId, return_url: returnUrl, cancel_url: cancelUrl },
      });
      if (fnError) throw new Error(fnError.message);
      if (data?.error) throw new Error(data.error);
      if (!data?.approve_url) throw new Error('تعذّر بدء عملية الدفع');
      window.location.href = data.approve_url;
    } catch (e: any) {
      setError(e?.message || 'تعذّر بدء عملية الدفع');
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2" dir="rtl">
      <button
        onClick={start}
        disabled={loading}
        className="min-w-[11.625rem] h-8 px-8 rounded-full bg-brand text-white text-[0.875rem] font-bold disabled:opacity-60 flex items-center justify-center gap-2 active:scale-95 transition-transform"
      >
        {loading && <Loader2 size={14} className="animate-spin" />}
        {loading ? 'جارٍ التحويل...' : label}
      </button>
      <img src="https://www.paypalobjects.com/images/Debit_Credit_APM.svg" alt="طرق الدفع المتاحة" />
      <section className="text-[0.75rem] text-muted dark:text-gray-400">
        مدعوم من{' '}
        <img
          src="https://www.paypalobjects.com/paypal-ui/logos/svg/paypal-wordmark-color.svg"
          alt="PayPal"
          className="h-[0.875rem] align-middle inline"
        />
      </section>
      {error && <div className="text-[11px] text-red-600 text-center">{error}</div>}
    </div>
  );
};

export default PayPalPayButton;
