'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Freeze, unfreeze, extend and cancel, on the row.
 *
 * Every one of these moves a date or an amount, so every one demands a
 * reason the server records against the staff member's name. The dialog is
 * deliberately plain about consequences — "this adds 10 days to their
 * membership" — because the person doing it is usually mid-conversation with
 * the member it affects.
 *
 * The rules themselves (freeze allowance, refund ceiling, whether the plan
 * permits any of this) live on the server. This form only asks.
 */

interface Subscription {
  id: string;
  memberName: string;
  status: string;
  endDate: Date | string;
  freezeDaysUsed: number;
  freezeDaysAllowed: number;
  freezeAllowed: boolean;
  paidAmount: string;
}

type Action = 'freeze' | 'unfreeze' | 'extend' | 'cancel';

const iso = (value: Date | string): string => new Date(value).toISOString().slice(0, 10);

/**
 * Today, as the person at the desk would write it.
 *
 * Built from local parts rather than `toISOString().slice(0, 10)`, which
 * converts to UTC first — so for anyone in India before 05:30 the date box
 * would quietly default to yesterday.
 */
const today = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

const rupees = (value: string | number): string =>
  `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function SubscriptionActions({
  subscription,
  permissions,
}: {
  subscription: Subscription;
  permissions: { freeze: boolean; extend: boolean; cancel: boolean };
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [action, setAction] = useState<Action | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [fromDate, setFromDate] = useState(today());
  const [toDate, setToDate] = useState(today());
  const [days, setDays] = useState('7');
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState('');

  const live = subscription.status === 'ACTIVE' || subscription.status === 'FROZEN';
  const frozen = subscription.status === 'FROZEN';
  const freezeLeft = Math.max(0, subscription.freezeDaysAllowed - subscription.freezeDaysUsed);

  async function send(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);

    const response = await fetch(`/api/v1/memberships/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscriptionId: subscription.id, ...body }),
    });

    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setMessage(payload?.error?.message ?? 'That did not go through. Nothing was changed.');
      return;
    }

    setAction(null);
    setReason('');
    startTransition(() => router.refresh());
  }

  if (!live) {
    return <span className="text-sm text-ink-subtle">—</span>;
  }

  const canDoAnything =
    (permissions.freeze && (frozen || subscription.freezeAllowed)) ||
    permissions.extend ||
    permissions.cancel;

  if (!canDoAnything) {
    return <span className="text-sm text-ink-subtle">—</span>;
  }

  if (!action) {
    return (
      <div className="flex flex-wrap justify-end gap-1.5">
        {permissions.freeze && frozen && (
          <button
            type="button"
            className="rounded-control border border-line px-2.5 py-1 text-sm font-medium text-ink-muted hover:bg-canvas"
            onClick={() => setAction('unfreeze')}
          >
            Unfreeze
          </button>
        )}
        {permissions.freeze && !frozen && subscription.freezeAllowed && freezeLeft > 0 && (
          <button
            type="button"
            className="rounded-control border border-line px-2.5 py-1 text-sm font-medium text-ink-muted hover:bg-canvas"
            onClick={() => setAction('freeze')}
          >
            Freeze
          </button>
        )}
        {permissions.extend && (
          <button
            type="button"
            className="rounded-control border border-line px-2.5 py-1 text-sm font-medium text-ink-muted hover:bg-canvas"
            onClick={() => setAction('extend')}
          >
            Extend
          </button>
        )}
        {permissions.cancel && (
          <button
            type="button"
            className="rounded-control border border-line px-2.5 py-1 text-sm font-medium text-rose-700 hover:bg-rose-50"
            onClick={() => setAction('cancel')}
          >
            Cancel
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="min-w-72 space-y-2 rounded-control border border-line bg-canvas p-3 text-left">
      {message && (
        <p role="alert" className="text-sm text-rose-700">
          {message}
        </p>
      )}

      {action === 'freeze' && (
        <>
          <p className="text-sm font-medium text-ink">
            Freeze {subscription.memberName}&rsquo;s membership
          </p>
          <div className="flex gap-2">
            <label className="flex-1 text-sm text-ink-muted">
              From
              <input
                type="date"
                className="input mt-0.5 py-1"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
              />
            </label>
            <label className="flex-1 text-sm text-ink-muted">
              To
              <input
                type="date"
                className="input mt-0.5 py-1"
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
              />
            </label>
          </div>
          <p className="text-sm text-ink-subtle">
            {freezeLeft} of {subscription.freezeDaysAllowed} days left on this plan. The days are
            added to the end of the membership.
          </p>
          <input
            className="input py-1 text-sm"
            placeholder="Reason — travelling, injury…"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </>
      )}

      {action === 'unfreeze' && (
        <>
          <p className="text-sm font-medium text-ink">
            Unfreeze {subscription.memberName}&rsquo;s membership
          </p>
          <p className="text-sm text-ink-subtle">
            Only the days they did not use are returned. Starting again today.
          </p>
        </>
      )}

      {action === 'extend' && (
        <>
          <p className="text-sm font-medium text-ink">Extend by</p>
          <div className="flex items-center gap-2">
            <input
              className="input w-20 py-1 text-sm tabular-nums"
              inputMode="numeric"
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
            <span className="text-sm text-ink-muted">
              days, from {iso(subscription.endDate)}
            </span>
          </div>
          <input
            className="input py-1 text-sm"
            placeholder="Reason — required"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </>
      )}

      {action === 'cancel' && (
        <>
          <p className="text-sm font-medium text-ink">
            Cancel {subscription.memberName}&rsquo;s membership
          </p>
          <input
            className="input py-1 text-sm"
            placeholder="Reason — required"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <label className="block text-sm text-ink-muted">
            Refund (optional)
            <input
              className="input mt-0.5 py-1 text-sm tabular-nums"
              inputMode="decimal"
              placeholder="0.00"
              value={refund}
              onChange={(event) => setRefund(event.target.value)}
            />
          </label>
          <p className="text-sm text-ink-subtle">
            {rupees(subscription.paidAmount)} was paid. A refund is recorded as its own entry; the
            original payment is never rewritten.
          </p>
        </>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          className="btn-primary px-3 py-1 text-sm"
          disabled={
            busy ||
            ((action === 'extend' || action === 'cancel') && !reason.trim())
          }
          onClick={() => {
            if (action === 'freeze') void send('freeze', { fromDate, toDate, reason: reason.trim() || undefined });
            if (action === 'unfreeze') void send('unfreeze', {});
            if (action === 'extend') void send('extend', { days: Number(days), reason: reason.trim() });
            if (action === 'cancel')
              void send('cancel', {
                reason: reason.trim(),
                refundAmount: refund.trim() || undefined,
              });
          }}
        >
          {busy ? 'Working…' : 'Confirm'}
        </button>
        <button
          type="button"
          className="btn-ghost px-3 py-1 text-sm"
          onClick={() => {
            setAction(null);
            setMessage(null);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
