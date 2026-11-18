'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Preparing a campaign, and writing a template.
 *
 * The audience is counted before anything is queued, because "this will
 * message 412 people" is the one number that stops a mistake becoming 412
 * mistakes. And the result says what was skipped and why, rather than a
 * tick: skipping somebody who opted out is the system working, and the
 * person pressing the button should see it happen.
 */

const AUDIENCES = [
  { value: 'active', label: 'Members with a live membership' },
  { value: 'expiring', label: 'Memberships expiring soon' },
  { value: 'expired', label: 'Members who have lapsed' },
  { value: 'leads', label: 'Open enquiries' },
] as const;

interface TemplateOption {
  id: string;
  name: string;
  category: string;
  body: string;
  variables: string[];
  sendable: boolean;
  blockedReason: string | null;
  approvalStatus: string;
}

async function send(url: string, method: 'POST' | 'PUT', body: unknown) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false as const,
      message: payload?.error?.message ?? 'Something went wrong. Please try again.',
    };
  }
  return { ok: true as const, data: payload?.data ?? {} };
}

export function ComposePanel({
  canSend,
  canTemplate,
  connected,
  templates,
}: {
  canSend: boolean;
  canTemplate: boolean;
  connected: boolean;
  templates: TemplateOption[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [mode, setMode] = useState<'closed' | 'campaign' | 'template'>('closed');
  const [templateId, setTemplateId] = useState(templates.find((t) => t.sendable)?.id ?? '');
  const [audience, setAudience] = useState<string>('active');
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<null | {
    queued: number;
    skipped: number;
    skippedReasons: Record<string, number>;
    blockedReason: string | null;
  }>(null);

  const selected = templates.find((t) => t.id === templateId) ?? null;

  async function countAudience(next: string) {
    setAudience(next);
    setCount(null);
    const result = await send('/api/v1/comms/campaigns', 'PUT', { kind: next });
    if (result.ok) setCount(result.data.count ?? 0);
  }

  async function queue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    setBusy(true);
    setMessage(null);
    const result = await send('/api/v1/comms/campaigns', 'POST', {
      name: String(form.get('name') ?? '').trim(),
      templateId,
      audience: { kind: audience },
    });
    setBusy(false);

    if (!result.ok) {
      setMessage(result.message);
      return;
    }

    setOutcome({
      queued: result.data.queued,
      skipped: result.data.skipped,
      skippedReasons: result.data.skippedReasons ?? {},
      blockedReason: result.data.blockedReason,
    });
    startTransition(() => router.refresh());
  }

  async function addTemplate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string): string | undefined => {
      const value = form.get(key);
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed.length > 0 ? trimmed : undefined;
    };

    setBusy(true);
    setMessage(null);
    const result = await send('/api/v1/comms/templates', 'POST', {
      name: text('name'),
      channel: 'WHATSAPP',
      category: text('category') ?? 'UTILITY',
      body: text('body'),
      providerTemplateName: text('providerTemplateName'),
    });
    setBusy(false);

    if (!result.ok) {
      setMessage(result.message);
      return;
    }

    setMode('closed');
    startTransition(() => router.refresh());
  }

  if (outcome) {
    return (
      <section className="card p-5">
        <h2 className="text-base font-semibold text-ink">
          {outcome.queued} {outcome.queued === 1 ? 'message' : 'messages'} queued
        </h2>

        {outcome.blockedReason ? (
          <p className="mt-1 text-base text-ink">{outcome.blockedReason}</p>
        ) : (
          <p className="mt-1 text-sm text-ink-muted">
            These go out on the next send, usually within a few minutes. Each one is marked sent
            only once WhatsApp has accepted it.
          </p>
        )}

        {outcome.skipped > 0 && (
          <p className="mt-2 text-sm text-ink-muted">
            {outcome.skipped} skipped —{' '}
            {Object.entries(outcome.skippedReasons)
              .map(([reason, n]) => `${n} ${reason}`)
              .join(', ')}
            .
          </p>
        )}

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setOutcome(null);
              setMode('closed');
            }}
          >
            Done
          </button>
        </div>
      </section>
    );
  }

  if (mode === 'closed') {
    return (
      <div className="flex flex-wrap gap-2">
        {canSend && templates.some((t) => t.sendable) && (
          <button type="button" className="btn-primary" onClick={() => setMode('campaign')}>
            Prepare a campaign
          </button>
        )}
        {canTemplate && (
          <button type="button" className="btn-secondary" onClick={() => setMode('template')}>
            Write a template
          </button>
        )}
      </div>
    );
  }

  return (
    <section className="card p-5">
      {message && (
        <div
          role="alert"
          className="mb-4 rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          {message}
        </div>
      )}

      {mode === 'campaign' ? (
        <form onSubmit={queue} className="space-y-4" noValidate>
          <div>
            <label htmlFor="name" className="mb-1 block text-sm font-medium text-ink">
              What is this campaign called?
            </label>
            <input
              id="name"
              name="name"
              className="input"
              placeholder="November expiry reminders"
              required
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="templateId" className="mb-1 block text-sm font-medium text-ink">
              Template
            </label>
            <select
              id="templateId"
              className="input"
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
              required
            >
              {templates
                .filter((template) => template.sendable)
                .map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
            </select>
            {selected && (
              <p className="mt-1 rounded-control bg-canvas px-3 py-2 text-sm text-ink-muted">
                {selected.body}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="audience" className="mb-1 block text-sm font-medium text-ink">
              Who gets it
            </label>
            <select
              id="audience"
              className="input"
              value={audience}
              onChange={(event) => countAudience(event.target.value)}
            >
              {AUDIENCES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-sm text-ink-subtle" data-testid="audience-count">
              {count === null
                ? 'Choose an audience to see how many that is.'
                : `${count} ${count === 1 ? 'person' : 'people'} match. Anyone who has opted out is skipped.`}
            </p>
          </div>

          {!connected && (
            <p className="rounded-control border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-ink">
              WhatsApp is not connected, so these will wait in the queue rather than being sent.
            </p>
          )}

          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={busy || !templateId}>
              {busy ? 'Queueing…' : 'Queue the campaign'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setMode('closed')}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={addTemplate} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="template-name" className="mb-1 block text-sm font-medium text-ink">
                Name
              </label>
              <input
                id="template-name"
                name="name"
                className="input"
                placeholder="Membership expiring"
                required
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="category" className="mb-1 block text-sm font-medium text-ink">
                Kind
              </label>
              <select id="category" name="category" className="input" defaultValue="UTILITY">
                <option value="UTILITY">Utility — reminders, receipts</option>
                <option value="MARKETING">Marketing — offers, campaigns</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="body" className="mb-1 block text-sm font-medium text-ink">
              The message
            </label>
            <textarea
              id="body"
              name="body"
              className="input min-h-28"
              placeholder="Hello {{memberName}}, your {{planName}} membership ends on {{expiryDate}}."
              required
            />
            <p className="mt-1 text-sm text-ink-subtle">
              Anything in double braces is filled in per person: memberName, firstName, planName,
              expiryDate, memberCode.
            </p>
          </div>

          <div>
            <label
              htmlFor="providerTemplateName"
              className="mb-1 block text-sm font-medium text-ink"
            >
              The name WhatsApp approved it under
            </label>
            <input
              id="providerTemplateName"
              name="providerTemplateName"
              className="input"
              placeholder="membership_expiring"
            />
            <p className="mt-1 text-sm text-ink-subtle">
              Leave this blank for now if you have not submitted it yet. WhatsApp only accepts a
              message against a template it has approved, so nothing will send until both this and
              the approval are in place.
            </p>
          </div>

          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save template'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setMode('closed')}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
