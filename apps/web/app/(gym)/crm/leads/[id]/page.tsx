import type { Metadata } from 'next';
import Link from 'next/link';
import { getLead } from '@gym/core';
import { requireActor, holds, planLock } from '@/lib/current-session';
import { FeatureLocked } from '@/components/plan-gate';
import { Badge, Card, PageHeader, rupees, shortDate, timeOfDay } from '@/components/ui';
import { FollowUpPanel } from './follow-up-panel';

export const metadata: Metadata = { title: 'Enquiry' };
export const dynamic = 'force-dynamic';

const STATUS_TONES: Record<string, 'active' | 'expiring' | 'expired' | 'frozen' | 'neutral'> = {
  NEW: 'frozen',
  CONTACTED: 'neutral',
  FOLLOW_UP: 'expiring',
  TRIAL_BOOKED: 'frozen',
  NEGOTIATION: 'expiring',
  CONVERTED: 'active',
  LOST: 'expired',
};

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { session, actor, ctx } = await requireActor('/crm/leads');

  // The plan, not the role, is what can stop a gym here: Enquiries is a
  // Growth feature. Checking it before the services run means a gym on
  // Starter meets an explanation, not a server error.
  const locked = planLock(session, 'crm.lead.read');
  if (locked) {
    return (
      <FeatureLocked
        feature={locked}
        title="Enquiries"
        blurb="Record every walk-in and phone enquiry, keep a follow-up date against each one, and see how many turn into members."
      />
    );
  }
  const { id } = await params;

  const lead = await getLead(ctx, actor.permissions, id);
  const open = !['CONVERTED', 'LOST'].includes(lead.status);

  const overdueDays = lead.nextFollowUpAt
    ? Math.round((Date.now() - new Date(lead.nextFollowUpAt).getTime()) / 86_400_000)
    : null;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={lead.fullName}
        subtitle={`${lead.source.toLowerCase().replace('_', ' ')} enquiry · ${shortDate(lead.createdAt)}`}
        action={
          <div className="flex items-center gap-2">
            <a href={`tel:+91${lead.phone}`} className="btn-ghost tabular-nums">
              {lead.phone}
            </a>
            <Link href="/crm/leads" className="btn-ghost">
              Back
            </Link>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card p-5">
          <p className="text-sm font-medium text-ink-muted">Status</p>
          <p className="mt-2">
            <Badge tone={STATUS_TONES[lead.status] ?? 'neutral'}>
              {lead.status.toLowerCase().replace('_', ' ')}
            </Badge>
          </p>
          {lead.lostReason && (
            <p className="mt-1.5 text-sm text-ink-muted">{lead.lostReason}</p>
          )}
          {lead.convertedMember && (
            <Link
              href={`/members/${lead.convertedMember.id}`}
              className="mt-1.5 block text-sm font-medium text-accent hover:underline"
            >
              Now member {lead.convertedMember.memberCode}
            </Link>
          )}
        </div>

        <div className="card p-5">
          <p className="text-sm font-medium text-ink-muted">Next follow-up</p>
          <p
            className={`mt-2 text-xl font-semibold ${
              overdueDays !== null && overdueDays > 0 ? 'text-amber-700' : 'text-ink'
            }`}
          >
            {lead.nextFollowUpAt ? shortDate(lead.nextFollowUpAt) : 'None'}
          </p>
          {overdueDays !== null && overdueDays > 0 && (
            <p className="mt-1 text-sm text-amber-700">{overdueDays} days overdue</p>
          )}
        </div>

        <div className="card p-5">
          <p className="text-sm font-medium text-ink-muted">Interested in</p>
          <p className="mt-2 text-lg font-semibold text-ink">
            {lead.interestedPlan?.name ?? 'Not sure yet'}
          </p>
          {lead.interestedPlan && (
            <p className="mt-1 text-sm text-ink-muted">{rupees(lead.interestedPlan.price)}</p>
          )}
        </div>
      </div>

      {open && holds(session, 'crm.followup.manage') && (
        <FollowUpPanel
          leadId={id}
          leadName={lead.fullName}
          canConvert={holds(session, 'crm.lead.update') && holds(session, 'members.member.create')}
          canEdit={holds(session, 'crm.lead.update')}
        />
      )}

      <Card title="What has happened" padded={false}>
        {lead.activities.length === 0 ? (
          <p className="px-5 py-6 text-base text-ink-muted">
            Nothing logged yet. Every call, message and visit recorded here is what stops an
            enquiry going quiet.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {lead.activities.map((activity) => (
              <li key={activity.id} className="px-5 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-medium text-ink">
                      {activity.activityType.toLowerCase().replace('_', ' ')}
                      {activity.outcome && (
                        <span className="font-normal text-ink-muted"> — {activity.outcome}</span>
                      )}
                    </p>
                    {activity.notes && (
                      <p className="mt-0.5 text-base text-ink-muted">{activity.notes}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-sm text-ink-subtle">
                    {shortDate(activity.occurredAt)} · {timeOfDay(activity.occurredAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {lead.trialBookings.length > 0 && (
        <Card title="Trial sessions" padded={false}>
          <ul className="divide-y divide-line">
            {lead.trialBookings.map((trial) => (
              <li key={trial.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <p className="text-base text-ink">
                    {shortDate(trial.scheduledFor)} · {timeOfDay(trial.scheduledFor)}
                  </p>
                  {trial.feedback && (
                    <p className="text-sm text-ink-muted">{trial.feedback}</p>
                  )}
                </div>
                <Badge
                  tone={
                    trial.attended === null
                      ? 'neutral'
                      : trial.attended
                        ? 'active'
                        : 'expired'
                  }
                >
                  {trial.attended === null
                    ? 'booked'
                    : trial.attended
                      ? 'came'
                      : 'did not come'}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Details">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Detail label="Email" value={lead.email ?? '—'} />
          <Detail label="City" value={lead.city ?? '—'} />
          <Detail label="Where exactly" value={lead.sourceDetail ?? '—'} />
          <Detail label="Budget" value={lead.budgetNote ?? '—'} />
          <Detail label="With" value={lead.assignedTo?.user.fullName ?? 'Nobody'} />
          <Detail label="Branch" value={lead.branch?.name ?? '—'} />
        </dl>
        {lead.notes && <p className="mt-4 text-base text-ink">{lead.notes}</p>}
      </Card>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm font-medium text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-base text-ink">{value}</dd>
    </div>
  );
}
