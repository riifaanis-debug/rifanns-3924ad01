import React, { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';

type State = 'loading' | 'success' | 'failed' | 'cancelled';

interface Props {
  cancelled?: boolean;
}

const PaymentReturnPage: React.FC<Props> = ({ cancelled = false }) => {
  const [state, setState] = useState<State>(cancelled ? 'cancelled' : 'loading');
  const [message, setMessage] = useState<string>('');

  useEffect(() => {
    if (cancelled) return;
    const hash = window.location.hash;
    const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
    const orderId = new URLSearchParams(query).get('token');

    if (!orderId) {
      setState('failed');
      setMessage('لم نتمكن من قراءة بيانات العملية.');
      return;
    }

    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('paypal-order', {
          body: { action: 'capture', order_id: orderId },
        });
        if (error) throw new Error(error.message);
        if (data?.error) throw new Error(data.error);
        setState('success');
        setMessage('تم استلام سدادك بنجاح وتحديث حالة الفاتورة.');
      } catch (e: any) {
        setState('failed');
        setMessage(e?.message || 'تعذّر تأكيد الدفع. يرجى المحاولة مرة أخرى.');
      }
    })();
  }, [cancelled]);

  return (
    <div dir="rtl" className="min-h-screen bg-page dark:bg-[#06010a] flex items-center justify-center px-4">
      <div className="w-full max-w-[420px] bg-white dark:bg-[#12031a] rounded-2xl border border-gold/50 shadow-xl p-6 text-center">
        {state === 'loading' && (
          <>
            <Loader2 size={36} className="mx-auto text-gold animate-spin mb-3" />
            <h1 className="text-base font-bold text-brand dark:text-gold">جارٍ تأكيد الدفع...</h1>
          </>
        )}
        {state === 'success' && (
          <>
            <CheckCircle2 size={40} className="mx-auto text-green-600 mb-3" />
            <h1 className="text-base font-bold text-brand dark:text-gold mb-1">تم السداد بنجاح</h1>
            <p className="text-xs text-muted dark:text-gray-400">{message}</p>
          </>
        )}
        {(state === 'failed' || state === 'cancelled') && (
          <>
            <XCircle size={40} className="mx-auto text-red-500 mb-3" />
            <h1 className="text-base font-bold text-brand dark:text-gold mb-1">
              {state === 'cancelled' ? 'تم إلغاء العملية' : 'لم يكتمل الدفع'}
            </h1>
            <p className="text-xs text-muted dark:text-gray-400">
              {state === 'cancelled' ? 'يمكنك إعادة المحاولة في أي وقت.' : message}
            </p>
          </>
        )}

        <button
          onClick={() => (window.location.hash = '#/dashboard?tab=invoices')}
          className="mt-5 w-full rounded-xl bg-gold text-brand font-bold text-sm py-2.5 active:scale-95 transition-transform"
        >
          العودة إلى فواتيري
        </button>
      </div>
    </div>
  );
};

export default PaymentReturnPage;
