'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Logging what happened, and when to try again.
 *
 * The next follow-up date is in the same form as the call, not a separate
 * step. That is the whole design: a follow-up you have to remember to
 * schedule afterwards is a follow-up that does not happen, and the enquiry
 * goes quiet.
 *
 * The quick buttons set a date without making anyone open a date picker,
 * because this gets used between phone calls.
 */

const ACTIVITIES = [
  { value: 'CALL', label: 'Called' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'SMS', label: 'Texted' },
  { value: 'EMAIL', label: 'Emailed' },
  { value: 'VISIT', label: 'They visited' },
  { value: 'NOTE', label: 'Note' },
] as const;

const STATUSES = [
  { value: '', label: 'Leave as it is' },
  { value: 'CONTACTED', label: 'Contacted' },
  { value: 'FOLLOW_UP', label: 'Following up' },
  { value: 'NEGOTIATION', label: 'Negotiating' },
  { value: 'LOST', label: 'Lost' },
] as const;

const localDate = (offsetDays: number): string => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

type Mode = null | 'log' | 'trial' | 'convert' | 'lost';

export function FollowUpPanel({
  leadId,
  leadName,
  canConvert,
  canEdit,
}: {
  leadId: string;
  leadName: string;
  canConvert: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [mode, setMode] = useState<Mode>(null);
  const [nextDate, setNextDate] = useState(localDate(3));
  const [message, setMessage] = useState<string | null>(null);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [busy, setBusy] = useState(false);

  async function send(path: string, body: Record<string, unknown>, method = 'POST') {
    setBusy(true);
    setMessage(null);

    const response = await fetch(`/api/v1/crm/${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      if (payload?.error?.code === 'DUPLICATE_MEMBER') {
        setAllowDuplicate(false);
        setMessage(payload.error.message);
        return false;
      }
      setMessage(payload?.error?.message ?? 'That did not go through.');
      return false;
    }

    setMode(null);
    setMessage(null);
    startTransition(() => router.refresh());
    return true;
  }

  if (!mode) {
    return (
      <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 className="text-base font-semibold text-ink">What happened?</h2>
          <p className="mt-0.5 text-base text-ink-muted">
            Log it and set when to try again — in one step, so the next call actually gets made.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={() => setMode('log')}>
            Log a call
          </button>
          <button type="button" className="btn-ghost" onClick={() => setMode('trial')}>
            Book a trial
          </button>
          {canConvert && (
            <button type="button" className="btn-ghost" onClick={() => setMode('convert')}>
              They joined
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="rounded-control border border-line px-4 py-2 text-base font-medium text-rose-700 hover:bg-rose-50"
              onClick={() => setMode('lost')}
            >
              Lost
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="card space-y-4 p-5">
      {message && (
        <p
          role="alert"
          className="rounded-control bg-amber-50 px-3.5 py-2.5 text-base text-amber-900 ring-1 ring-inset ring-amber-200"
        >
          {message}
        </p>
      )}

      {mode === 'log' && (
        <form
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const text = (key: string) => {
              const value = form.get(key);
              return typeof value === 'string' && value.trim() ? value.trim() : undefined;
            };
            void send('activity', {
              leadId,
              activityType: text('activityType') ?? 'CALL',
              outcome: text('outcome'),
              notes: text('notes'),
              nextFollowUpAt: nextDate || null,
              status: text('status'),
            });
          }}
          className="space-y-4"
        >
          <h2 className="text-base font-semibold text-ink">What happened with {leadName}?</h2>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="activityType" className="block text-sm font-medium text-ink">
                How
              </label>
              <select id="activityType" name="activityType" className="input mt-1" defaultValue="CALL">
                {ACTIVITIES.map((activity) => (
                  <option key={activity.value} value={activity.value}>
                    {activity.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="outcome" className="block text-sm font-medium text-ink">
                What they said
              </label>
              <input
                id="outcome"
                name="outcome"
                className="input mt-1"
                placeholder="Wants to think about it, call next week"
                autoFocus
              />
            </div>
          </div>

          <div>
            <label htmlFor="notes" className="block text-sm font-medium text-ink">
              Anything else
            </label>
            <input id="notes" name="notes" className="input mt-1" />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-ink">Try again on</label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {[
                  { days: 1, label: 'Tomorrow' },
                  { days: 3, label: 'In 3 days' },
                  { days: 7, label: 'Next week' },
                  { days: 30, label: 'In a month' },
                ].map((option) => (
                  <button
                    key={option.days}
                    type="button"
                    aria-pressed={nextDate === localDate(option.days)}
                    onClick={() => setNextDate(localDate(option.days))}
                    className={
                      nextDate === localDate(option.days)
                        ? 'rounded-control bg-accent px-2.5 py-1 text-sm font-medium text-white'
                        : 'rounded-control border border-line px-2.5 py-1 text-sm font-medium text-ink-muted hover:bg-canvas'
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <input
                type="date"
                className="input mt-2 py-1.5"
                value={nextDate}
                onChange={(event) => setNextDate(event.target.value)}
                aria-label="Next follow-up date"
              />
            </div>

            <div>
              <label htmlFor="status" className="block text-sm font-medium text-ink">
                Move them to
              </label>
              <select id="status" name="status" className="input mt-1">
                {STATUSES.filter((s) => s.value !== 'LOST').map((status) => (
                  <option key={status.value} value={status.value}>
                    {status.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <Actions busy={busy} onCancel={() => setMode(null)} label="Save" />
        </form>
      )}

      {mode === 'trial' && (
        <form
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const when = String(form.get('scheduledFor') ?? '');
            if (!when) return;
            void send('trials', { leadId, scheduledFor: new Date(when).toISOString() });
          }}
          className="space-y-4"
        >
          <h2 className="text-base font-semibold text-ink">Book a trial for {leadName}</h2>
          <p className="text-base text-ink-muted">
            A trial converts better than anything else. The follow-up is set for the day after —
            which is when the answer comes.
          </p>

          <div>
            <label htmlFor="scheduledFor" className="block text-sm font-medium text-ink">
              When
            </label>
            <input
              id="scheduledFor"
              name="scheduledFor"
              type="datetime-local"
              className="input mt-1"
              required
              autoFocus
            />
          </div>

          <Actions busy={busy} onCancel={() => setMode(null)} label="Book it" />
        </form>
      )}

      {mode === 'convert' && (
        <form
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            void send('convert', { leadId, allowDuplicate });
          }}
          className="space-y-4"
        >
          <h2 className="text-base font-semibold text-ink">{leadName} joined</h2>
          <p className="text-base text-ink-muted">
            This creates their member record and keeps the link to where they came from — so you
            can still see in a year which of your members came from Instagram.
          </p>
          <p className="text-base text-ink-muted">
            They start inactive. Selling them a membership is the next step.
          </p>

          {message && (
            <label className="flex items-start gap-2 text-base text-ink">
              <input
                type="checkbox"
                className="mt-1"
                checked={allowDuplicate}
                onChange={(event) => setAllowDuplicate(event.target.checked)}
              />
              <span>Create them anyway — families often share one number.</span>
            </label>
          )}

          <Actions busy={busy} onCancel={() => setMode(null)} label="Create their member record" />
        </form>
      )}

      {mode === 'lost' && (
        <form
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const reason = String(form.get('lostReason') ?? '').trim();
            if (!reason) return;
            void send(`leads/${leadId}`, { status: 'LOST', lostReason: reason }, 'PATCH');
          }}
          className="space-y-4"
        >
          <h2 className="text-base font-semibold text-ink">Mark {leadName} as lost</h2>
          <p className="text-base text-ink-muted">
            They come off the follow-up list. The reason is worth recording — a run of the same
            one tells you something.
          </p>

          <div>
            <label htmlFor="lostReason" className="block text-sm font-medium text-ink">
              Why<span className="text-rose-600"> *</span>
            </label>
            <input
              id="lostReason"
              name="lostReason"
              className="input mt-1"
              placeholder="Too expensive, joined elsewhere, moved away"
              required
              autoFocus
            />
          </div>

          <Actions busy={busy} onCancel={() => setMode(null)} label="Mark as lost" />
        </form>
      )}
    </div>
  );
}

function Actions({
  busy,
  onCancel,
  label,
}: {
  busy: boolean;
  onCancel: () => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? 'Saving…' : label}
      </button>
      <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}
