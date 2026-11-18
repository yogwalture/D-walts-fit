'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Putting a member under a trainer.
 *
 * The member profile has said "Trainer: Not assigned" since Phase 2 with no
 * way to change it — and the trainer role has carried OWN scope on members
 * all along, so until something assigned them, a trainer signing in saw an
 * empty list.
 */
export function TrainerPicker({
  memberId,
  current,
  trainers,
}: {
  memberId: string;
  current: { orgUserId: string; fullName: string } | null;
  trainers: Array<{ orgUserId: string; fullName: string; designation: string | null; memberCount: number }>;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState(current?.orgUserId ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setMessage(null);

    const response = await fetch('/api/v1/members/trainer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId, orgUserId: choice || null }),
    });

    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setMessage(payload?.error?.message ?? 'That could not be saved.');
      return;
    }

    setEditing(false);
    startTransition(() => router.refresh());
  }

  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        <span className="text-base text-ink">{current?.fullName ?? 'Not assigned'}</span>
        <button
          type="button"
          className="text-sm font-medium text-accent hover:underline"
          onClick={() => setEditing(true)}
        >
          {current ? 'Change' : 'Assign'}
        </button>
      </span>
    );
  }

  if (trainers.length === 0) {
    return (
      <span className="text-base text-ink-muted">
        No trainers on the team yet.{' '}
        <button
          type="button"
          className="text-sm font-medium text-accent hover:underline"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span className="block space-y-2">
      {message && (
        <span role="alert" className="block text-sm text-rose-700">
          {message}
        </span>
      )}

      <select
        className="input py-1.5 text-base"
        value={choice}
        onChange={(event) => setChoice(event.target.value)}
        aria-label="Trainer"
      >
        <option value="">Nobody</option>
        {trainers.map((trainer) => (
          <option key={trainer.orgUserId} value={trainer.orgUserId}>
            {trainer.fullName}
            {trainer.designation ? ` — ${trainer.designation}` : ''} ({trainer.memberCount})
          </option>
        ))}
      </select>

      <span className="flex items-center gap-2">
        <button type="button" className="btn-primary px-3 py-1 text-sm" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="btn-ghost px-3 py-1 text-sm"
          onClick={() => {
            setEditing(false);
            setChoice(current?.orgUserId ?? '');
            setMessage(null);
          }}
        >
          Cancel
        </button>
      </span>
    </span>
  );
}
