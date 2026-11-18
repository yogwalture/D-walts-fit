'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

interface Row {
  id: string;
  className: string;
  trainerName: string | null;
  startsAt: string;
  endsAt: string;
  room: string | null;
  placesLeft: number;
  capacity: number;
  myBookingId: string | null;
  myStatus: string | null;
  myWaitlistPosition: number | null;
}

const time = (value: string) =>
  new Date(value).toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

/**
 * One class, with the one action that makes sense on it.
 *
 * A full class offers the waitlist rather than a greyed-out button, and the
 * result says where they stand — "you are third" is information a member
 * can act on; "added" is not.
 */
export function ClassRow({ row }: { row: Row }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function act() {
    setBusy(true);
    setMessage(null);

    const response = row.myBookingId
      ? await fetch('/api/v1/me/classes', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bookingId: row.myBookingId }),
        })
      : await fetch('/api/v1/me/classes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ classId: row.id }),
        });

    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setMessage(payload?.error?.message ?? 'That did not work.');
      return;
    }

    if (!row.myBookingId && payload?.data?.status === 'WAITLISTED') {
      setMessage(
        `You are number ${payload.data.waitlistPosition} on the waitlist. We will move you in if somebody drops out.`,
      );
    }

    startTransition(() => router.refresh());
  }

  const booked = row.myStatus === 'BOOKED';
  const waiting = row.myStatus === 'WAITLISTED';
  const full = row.placesLeft === 0;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="w-20 shrink-0">
        <p className="text-base font-semibold text-ink">{time(row.startsAt)}</p>
        <p className="text-sm text-ink-subtle">{time(row.endsAt)}</p>
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-medium text-ink">{row.className}</p>
        <p className="truncate text-sm text-ink-muted">
          {[row.trainerName, row.room].filter(Boolean).join(' · ') || 'At the gym'}
        </p>
        {message && <p className="mt-1 text-sm text-ink">{message}</p>}
        {waiting && !message && (
          <p className="mt-1 text-sm text-ink-muted">
            Waiting — number {row.myWaitlistPosition}
          </p>
        )}
      </div>

      <button
        type="button"
        className={booked || waiting ? 'btn-secondary' : 'btn-primary'}
        disabled={busy}
        onClick={act}
      >
        {busy
          ? '…'
          : booked || waiting
            ? 'Cancel'
            : full
              ? 'Join waitlist'
              : 'Book'}
      </button>
    </div>
  );
}
