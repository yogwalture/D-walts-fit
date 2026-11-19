'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Paying an invoice from the member's phone.
 *
 * Two things in here are load-bearing.
 *
 * The checkout script is injected rather than put in the page. The site's
 * CSP uses `strict-dynamic`, which ignores host allowlists in `script-src`
 * and instead trusts whatever an already-trusted script loads — so a script
 * element created by this bundle is allowed, and a script tag written into
 * the HTML by anybody else is not. It loads on the first tap, so a member
 * who never pays never fetches it.
 *
 * And the handler does NOT tell the server the payment succeeded. It hands
 * back what Razorpay gave it and asks the server to find out. The server
 * checks the signature and then re-reads the payment from Razorpay's own
 * API; this component cannot make a payment real by claiming it is.
 */

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('checkout_unavailable')));
      return;
    }

    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('checkout_unavailable'));
    document.head.appendChild(script);
  });
}

export function PayButton({
  invoiceId,
  amountDue,
  memberName,
  available,
}: {
  invoiceId: string;
  amountDue: string;
  memberName: string;
  available: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!available) {
    // Honest rather than hopeful: a button that opens an error is worse
    // than a sentence explaining why there is no button.
    return (
      <p className="mt-1 text-sm text-ink-subtle">Pay at the desk — this gym takes cash and UPI there.</p>
    );
  }

  async function pay() {
    setBusy(true);
    setError(null);
    setStatus(null);

    try {
      await loadCheckout();
    } catch {
      setBusy(false);
      setError('The payment window could not load. Check your connection and try again.');
      return;
    }

    const startResponse = await fetch('/api/v1/portal/pay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start', invoiceId }),
    });

    const started = await startResponse.json().catch(() => null);
    if (!startResponse.ok) {
      setBusy(false);
      setError(started?.error?.message ?? 'That could not be started. Please try again.');
      return;
    }

    const order = started.data;

    const checkout = new window.Razorpay!({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amountPaise,
      currency: order.currency,
      name: order.description,
      prefill: { name: memberName },
      // Razorpay's own retry UI, so a declined card does not mean starting
      // again from our screen.
      retry: { enabled: true },
      handler: async (response: Record<string, string>) => {
        setStatus('Checking with your bank…');

        const confirmResponse = await fetch('/api/v1/portal/pay', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'confirm',
            orderId: response.razorpay_order_id,
            razorpayPaymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature,
          }),
        });

        const confirmed = await confirmResponse.json().catch(() => null);
        setBusy(false);

        if (!confirmResponse.ok) {
          // The money may well have left their account — the webhook will
          // settle it. Saying "failed" here would be a lie.
          setStatus(
            'We could not confirm that just now. If your bank took the money it will ' +
              'appear here shortly; nothing will be taken twice.',
          );
          router.refresh();
          return;
        }

        setStatus(confirmed.data.message);
        router.refresh();
      },
      modal: {
        ondismiss: () => {
          setBusy(false);
          // Closing the window is not a failure, and the order stays open
          // so tapping Pay again reuses it rather than making a second one.
          setStatus('Payment window closed. Nothing has been taken.');
        },
      },
    });

    checkout.open();
  }

  return (
    <div className="mt-2">
      <button type="button" onClick={pay} disabled={busy} className="btn-primary w-full">
        {busy ? 'Opening…' : `Pay ${amountDue} now`}
      </button>

      {status && (
        <p role="status" className="mt-2 text-sm text-ink-muted">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
