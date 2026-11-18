import type { Metadata } from 'next';
import { getWhatsappSettings } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import { Badge, Card, PageHeader } from '@/components/ui';
import { WhatsappPanel } from './panel';

export const metadata: Metadata = { title: 'WhatsApp' };
export const dynamic = 'force-dynamic';

/**
 * This gym's own WhatsApp connection.
 *
 * Each gym brings its own number and its own token: one shared number would
 * put every gym's messages — and every gym's ban risk — on one account.
 * Nothing here is claimed to work until Meta has answered a real call with
 * these credentials.
 */
export default async function WhatsappPage() {
  const { session, actor, ctx } = await requireActor('/settings/whatsapp');

  const settings = await getWhatsappSettings(ctx, actor.permissions);
  const canEdit = holds(session, 'comms.template.manage');

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title="WhatsApp"
        subtitle="Your gym's own WhatsApp Business number"
        action={
          <Badge tone={settings.isEnabled ? 'active' : 'neutral'}>
            {settings.isEnabled ? 'Connected' : 'Not connected'}
          </Badge>
        }
      />

      {!settings.encryptionAvailable && (
        <div
          role="alert"
          className="rounded-card border border-danger/20 bg-danger/5 px-4 py-3 text-base text-ink"
        >
          This server has no encryption key set, so an access token cannot be stored safely.
          Nothing can be connected until it is.
        </div>
      )}

      <Card title="How this works">
        <ol className="space-y-2 text-base text-ink-muted">
          <li>
            <span className="font-medium text-ink">1.</span> Create a WhatsApp Business account
            in Meta Business Manager and add your gym's number to it.
          </li>
          <li>
            <span className="font-medium text-ink">2.</span> Copy the phone number ID and a
            permanent access token from Meta's dashboard, and paste them below.
          </li>
          <li>
            <span className="font-medium text-ink">3.</span> Submit your message templates to
            Meta for approval, then record the approved name against each template here.
          </li>
        </ol>
        <p className="mt-3 text-sm text-ink-subtle">
          The official Business API only — never an unofficial library driving a personal
          account, which gets the number banned and loses the channel your members actually read.
        </p>
      </Card>

      {settings.lastErrorCode && (
        <div
          role="alert"
          className="rounded-card border border-warning/30 bg-warning/5 px-4 py-3 text-base text-ink"
        >
          WhatsApp last refused these credentials
          {settings.lastErrorAt ? ` on ${settings.lastErrorAt.slice(0, 10)}` : ''}. Nothing will
          send until that is fixed.
        </div>
      )}

      <Card title="Connection">
        <dl className="mb-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Detail label="Number" value={settings.displayPhoneNumber ?? 'Not connected'} />
          <Detail label="Phone number ID" value={settings.phoneNumberId ?? '—'} />
          <Detail label="Business" value={settings.businessName ?? '—'} />
          <Detail
            label="Token"
            value={
              settings.tokenHint === 'unreadable'
                ? 'Stored, but unreadable with this server’s key'
                : (settings.tokenHint ?? 'None stored')
            }
          />
          <Detail
            label="Last verified"
            value={settings.lastVerifiedAt ? settings.lastVerifiedAt.slice(0, 10) : 'Never'}
          />
        </dl>

        {canEdit && (
          <WhatsappPanel
            connected={settings.isEnabled}
            hasToken={Boolean(settings.tokenHint)}
            phoneNumberId={settings.phoneNumberId}
            disabled={!settings.encryptionAvailable}
          />
        )}
      </Card>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-ink-subtle">{label}</dt>
      <dd className="break-all text-base text-ink">{value}</dd>
    </div>
  );
}
