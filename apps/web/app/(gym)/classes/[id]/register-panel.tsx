'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

/**
 * The working controls on a class.
 *
 * Booking says what happened in plain words — "booked", or "waitlisted at
 * position 3" — because "success" tells the person at the desk nothing they
 * can repeat to the member in front of them. Cancelling a booking reports
 * who moved off the waitlist, since the next thing that has to happen is
 * telling that person.
 */

async function send(
  url: string,
  method: 'POST' | 'DELETE',
  body: unknown,
): Promise<{ ok: true; data: any } | { ok: false; message: string }> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      message: payload?.error?.message ?? 'Something went wrong. Please try again.',
    };
  }
  return { ok: true, data: payload?.data ?? {} };
}

interface MemberOption {
  id: string;
  name: string;
  memberCode: string;
  phone: string;
}

export function BookPanel({
  classId,
  placesLeft,
  members,
  alreadyOn,
}: {
  classId: string;
  placesLeft: number;
  members: MemberOption[];
  alreadyOn: string[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [allowIneligible, setAllowIneligible] = useState(false);
  const [ineligible, setIneligible] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const on = useMemo(() => new Set(alreadyOn), [alreadyOn]);

  const matches = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return members
      .filter((member) => !on.has(member.id))
      .filter(
        (member) =>
          needle.length === 0 ||
          member.name.toLowerCase().includes(needle) ||
          member.phone.includes(needle) ||
          member.memberCode.toLowerCase().includes(needle),
      )
      .slice(0, 8);
  }, [members, term, on]);

  async function book(memberId: string) {
    setMessage(null);
    setBusy(memberId);

    const result = await send('/api/v1/classes/bookings', 'POST', {
      classId,
      memberId,
      allowIneligible,
    });
    setBusy(null);

    if (!result.ok) {
      setMessage(result.message);
      // The door's own rules, so offer the same deliberate override.
      setIneligible(/membership|suspended|frozen|ends before/i.test(result.message));
      return;
    }

    setIneligible(false);
    setAllowIneligible(false);
    setMessage(
      result.data.status === 'WAITLISTED'
        ? `${result.data.memberName} is on the waitlist at position ${result.data.waitlistPosition}. They move in automatically if somebody cancels.`
        : `${result.data.memberName} is booked in. ${result.data.placesLeft} ${
            result.data.placesLeft === 1 ? 'place' : 'places'
          } left.`,
    );
    setTerm('');
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        {placesLeft > 0 ? 'Book a member in' : 'Add to the waitlist'}
      </button>
    );
  }

  return (
    <section className="card w-full p-5">
      {message && (
        <div
          role="status"
          className="mb-3 rounded-control border border-line bg-canvas px-3 py-2 text-sm text-ink"
        >
          {message}
        </div>
      )}

      {ineligible && (
        <label className="mb-3 flex items-start gap-2 rounded-control border border-warn/30 bg-warn/5 px-3 py-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={allowIneligible}
            onChange={(event) => setAllowIneligible(event.target.checked)}
          />
          <span className="text-sm text-ink">
            Book them anyway. The membership does not cover this class, so this is recorded
            against your name in the audit log — the same as letting someone in at the door.
          </span>
        </label>
      )}

      <input
        type="search"
        className="input"
        placeholder="Name, phone or member code"
        aria-label="Find a member"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        autoFocus
      />

      {placesLeft === 0 && (
        <p className="mt-2 text-sm text-ink-muted">
          This class is full, so anyone booked now joins the waitlist in order.
        </p>
      )}

      <ul className="mt-3 divide-y divide-line">
        {matches.map((member) => (
          <li key={member.id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-base text-ink">{member.name}</p>
              <p className="text-sm text-ink-muted">
                {member.memberCode} · {member.phone}
              </p>
            </div>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy === member.id}
              onClick={() => book(member.id)}
            >
              {busy === member.id ? 'Booking…' : placesLeft > 0 ? 'Book' : 'Waitlist'}
            </button>
          </li>
        ))}
        {matches.length === 0 && (
          <li className="py-2 text-sm text-ink-muted">
            {term.trim()
              ? 'Nobody matches that, or they are already on this class.'
              : 'Start typing a name.'}
          </li>
        )}
      </ul>

      <div className="mt-3">
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
          Done
        </button>
      </div>
    </section>
  );
}

export function MarkPresent({ bookingId }: { bookingId: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function mark(attended: boolean) {
    setBusy(true);
    await send('/api/v1/classes/attendance', 'POST', { bookingId, attended });
    setBusy(false);
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex gap-1.5">
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => mark(true)}>
        Present
      </button>
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => mark(false)}>
        No show
      </button>
      <RemoveBooking bookingId={bookingId} />
    </div>
  );
}

export function RemoveBooking({ bookingId }: { bookingId: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [promoted, setPromoted] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    const result = await send('/api/v1/classes/bookings', 'DELETE', { bookingId });
    setBusy(false);

    if (result.ok && result.data.promoted) {
      // Said out loud, because somebody now has to tell them.
      setPromoted(result.data.promoted.memberName);
    }
    startTransition(() => router.refresh());
  }

  if (promoted) {
    return (
      <span className="text-sm text-ink">
        {promoted} moved off the waitlist — tell them.
      </span>
    );
  }

  return (
    <button type="button" className="btn-secondary" disabled={busy} onClick={cancel}>
      {busy ? 'Cancelling…' : 'Cancel'}
    </button>
  );
}

export function CancelClassPanel({
  classId,
  repeats,
}: {
  classId: string;
  repeats: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [wholeSeries, setWholeSeries] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [toInform, setToInform] = useState<Array<{ memberName: string; phone: string }>>([]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reason = String(form.get('reason') ?? '').trim();

    setBusy(true);
    const result = await send('/api/v1/classes/cancel', 'POST', {
      classId,
      reason,
      wholeSeries,
    });
    setBusy(false);

    if (!result.ok) {
      setMessage(result.message);
      return;
    }

    setMessage(null);
    setCancelled(true);
    setToInform(result.data.toInform ?? []);
    startTransition(() => router.refresh());
  }

  if (cancelled && toInform.length === 0) {
    // Cancelling an empty class is common and must still confirm itself —
    // silence reads as a form that did not submit.
    return (
      <p className="w-full rounded-card border border-line bg-canvas px-4 py-3 text-base text-ink">
        Cancelled. Nobody was booked in, so there is nobody to tell.
      </p>
    );
  }

  if (cancelled) {
    return (
      <section className="card w-full p-5">
        <h2 className="text-base font-semibold text-ink">
          Cancelled. These members were booked in:
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Each person appears once, however many sessions they had booked. Messaging is not
          wired up yet, so this list is for the phone.
        </p>
        <ul className="mt-3 divide-y divide-line">
          {toInform.map((person) => (
            <li key={person.phone} className="flex items-center justify-between gap-3 py-2">
              <span className="text-base text-ink">{person.memberName}</span>
              <a href={`tel:${person.phone}`} className="text-base text-accent hover:underline">
                {person.phone}
              </a>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (!open) {
    return (
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        Cancel this class
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card w-full space-y-3 p-5" noValidate>
      {message && (
        <div
          role="alert"
          className="rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          {message}
        </div>
      )}

      <div>
        <label htmlFor="reason" className="mb-1 block text-sm font-medium text-ink">
          Why is it cancelled?
        </label>
        <input
          id="reason"
          name="reason"
          className="input"
          placeholder="The trainer is unwell"
          required
          minLength={3}
          autoFocus
        />
        <p className="mt-1 text-sm text-ink-subtle">
          The members who were booked in get this reason, so write what you would say to them.
        </p>
      </div>

      {repeats && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={wholeSeries}
            onChange={(event) => setWholeSeries(event.target.checked)}
          />
          <span className="text-sm text-ink">
            Cancel the rest of this weekly series too. Sessions that have already happened are
            left exactly as they are.
          </span>
        </label>
      )}

      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Cancelling…' : 'Cancel the class'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
          Keep it
        </button>
      </div>
    </form>
  );
}
