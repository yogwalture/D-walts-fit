import type { Metadata } from 'next';
import Link from 'next/link';
import { listTemplates, listCampaigns, listMessages, getWhatsappSettings } from '@gym/core';
import { requireActor, holds, planLock } from '@/lib/current-session';
import { FeatureLocked } from '@/components/plan-gate';
import { Badge, Card, EmptyState, PageHeader, StatTile } from '@/components/ui';
import { ComposePanel } from './panel';

export const metadata: Metadata = { title: 'Messages' };
export const dynamic = 'force-dynamic';

const STATUS_TONES: Record<string, 'active' | 'expiring' | 'expired' | 'frozen' | 'neutral'> = {
  SENT: 'active',
  DELIVERED: 'active',
  READ: 'active',
  QUEUED: 'frozen',
  SENDING: 'frozen',
  FAILED: 'expired',
  SKIPPED: 'neutral',
  CANCELLED: 'neutral',
};

/**
 * Messages.
 *
 * The screen is built around one honesty: a message is "sent" only when
 * WhatsApp has accepted it. Until this gym connects WhatsApp, a campaign
 * queues and says so in as many words — a tick and a number, with nothing
 * having left the building, is the kind of thing a gym acts on.
 */
export default async function ComposePage() {
  const { session, actor, ctx } = await requireActor('/communication/compose');

  const locked = planLock(session, 'comms.message.send');
  if (locked) {
    return (
      <FeatureLocked
        feature={locked}
        title="WhatsApp messaging"
        blurb="Reach members on the channel they actually read — expiry reminders, class changes, and campaigns, through WhatsApp's official Business API."
      />
    );
  }

  const [templates, campaigns, recent, whatsapp] = await Promise.all([
    listTemplates(ctx, actor.permissions, { includeInactive: true }),
    listCampaigns(ctx, actor.permissions, {}),
    listMessages(ctx, actor.permissions, { limit: 20 }),
    getWhatsappSettings(ctx, actor.permissions),
  ]);

  const canSend = holds(session, 'comms.campaign.create');
  const canTemplate = holds(session, 'comms.template.manage');

  const queued = campaigns.reduce((sum, c) => sum + c.queuedCount, 0);
  const sent = campaigns.reduce((sum, c) => sum + c.sentCount, 0);
  const failed = campaigns.reduce((sum, c) => sum + c.failedCount, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Messages"
        subtitle={`${templates.length} ${templates.length === 1 ? 'template' : 'templates'}`}
        action={
          <Link href="/settings/whatsapp" className="btn-secondary">
            WhatsApp settings
          </Link>
        }
      />

      {!whatsapp.isEnabled && (
        <div
          role="status"
          className="rounded-card border border-warning/30 bg-warning/5 px-4 py-3 text-base text-ink"
        >
          <p className="font-medium">WhatsApp is not connected, so nothing can be sent yet.</p>
          <p className="mt-1 text-sm text-ink-muted">
            Campaigns can still be prepared — they wait in the queue and go out the moment the
            connection is made. Nothing is marked as sent in the meantime.{' '}
            <Link href="/settings/whatsapp" className="font-medium text-accent hover:underline">
              Connect WhatsApp
            </Link>
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <StatTile label="Sent" value={sent} tone="good" hint="Accepted by WhatsApp" />
        <StatTile
          label="Waiting"
          value={queued}
          tone={queued > 0 ? 'warn' : 'default'}
          hint="Queued, not yet sent"
        />
        <StatTile label="Failed" value={failed} tone={failed > 0 ? 'warn' : 'good'} />
        <StatTile
          label="Ready to send"
          value={templates.filter((t) => t.sendable).length}
          hint="Approved templates"
        />
      </div>

      {(canSend || canTemplate) && (
        <ComposePanel
          canSend={canSend}
          canTemplate={canTemplate}
          connected={whatsapp.isEnabled}
          templates={templates.map((template) => ({
            id: template.id,
            name: template.name,
            category: template.category,
            body: template.body,
            variables: template.variables,
            sendable: template.sendable,
            blockedReason: template.blockedReason,
            approvalStatus: template.approvalStatus,
          }))}
        />
      )}

      <Card title="Templates" description="WhatsApp only accepts what it has approved" padded={false}>
        {templates.length === 0 ? (
          <EmptyState
            title="No templates yet"
            description="A template is the wording WhatsApp approves. Write one, submit it to WhatsApp, then record the name they approve it under."
          />
        ) : (
          <ul className="divide-y divide-line">
            {templates.map((template) => (
              <li key={template.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium text-ink">{template.name}</p>
                  <p className="truncate text-sm text-ink-muted">{template.body}</p>
                  {template.blockedReason && (
                    <p className="mt-0.5 text-sm text-ink-subtle">{template.blockedReason}</p>
                  )}
                </div>
                <Badge tone={template.sendable ? 'active' : 'expiring'}>
                  {template.sendable ? 'Ready' : template.approvalStatus.toLowerCase()}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {campaigns.length > 0 && (
        <Card title="Campaigns" padded={false}>
          <ul className="divide-y divide-line">
            {campaigns.map((campaign) => (
              <li key={campaign.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium text-ink">{campaign.name}</p>
                  <p className="text-sm text-ink-muted">
                    {campaign.recipientCount} recipients · {campaign.sentCount} sent
                    {campaign.skippedCount > 0 ? ` · ${campaign.skippedCount} skipped` : ''}
                    {campaign.failedCount > 0 ? ` · ${campaign.failedCount} failed` : ''}
                  </p>
                </div>
                {campaign.queuedCount > 0 && (
                  <Badge tone="frozen">{campaign.queuedCount} waiting</Badge>
                )}
                <Badge tone={campaign.status === 'COMPLETED' ? 'active' : 'neutral'}>
                  {campaign.status.toLowerCase()}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {recent.length > 0 && (
        <Card title="Recent messages" padded={false}>
          <ul className="divide-y divide-line">
            {recent.map((message) => (
              <li key={message.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base text-ink">
                    {message.recipientName ?? message.toAddress}
                  </p>
                  <p className="truncate text-sm text-ink-muted">
                    {message.errorMessage ?? message.body ?? ''}
                  </p>
                </div>
                <Badge tone={STATUS_TONES[message.status] ?? 'neutral'}>
                  {message.status.toLowerCase()}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
