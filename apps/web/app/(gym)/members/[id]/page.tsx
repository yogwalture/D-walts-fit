import type { Metadata } from 'next';
import Link from 'next/link';
import { withTenant } from '@gym/db';
import { getMember, listTrainers } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  membershipTone,
  rupees,
  shortDate,
  spoken,
  timeOfDay,
} from '@/components/ui';
import { SellMembershipPanel } from './sell-panel';
import { TrainerPicker } from './trainer-picker';
import { TakePaymentPanel } from './payment-panel';

export const metadata: Metadata = { title: 'Member' };
export const dynamic = 'force-dynamic';

/**
 * A member's profile — the screen staff spend the most time on after
 * check-in.
 *
 * Laid out the way the questions come: are they current, what do they owe,
 * when were they last in, and what have they bought. Medical details appear
 * only for someone entitled to see them, and are not even fetched otherwise.
 */
export default async function MemberPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { session, actor, ctx } = await requireActor('/members');
  const { id } = await params;
  const query = await searchParams;

  const member = await getMember(ctx, actor.permissions, id);

  const [plans, attendance, payments, trainers] = await Promise.all([
    holds(session, 'memberships.subscription.create')
      ? withTenant(ctx, (tx) =>
          tx.membershipPlan.findMany({
            where: { deletedAt: null, isActive: true },
            select: { id: true, name: true, price: true, durationUnit: true, durationValue: true },
            orderBy: [{ displayOrder: 'asc' }, { price: 'asc' }],
          }),
        )
      : Promise.resolve([]),
    withTenant(ctx, (tx) =>
      tx.attendance.findMany({
        where: { memberId: id },
        orderBy: { checkedInAt: 'desc' },
        take: 10,
        select: { id: true, checkedInAt: true, checkedOutAt: true, wasOverride: true },
      }),
    ),
    holds(session, 'finance.payment.read')
      ? withTenant(ctx, (tx) =>
          tx.payment.findMany({
            where: { memberId: id, status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
            orderBy: { receivedAt: 'desc' },
            take: 10,
            select: {
              id: true,
              receiptCode: true,
              amount: true,
              method: true,
              receivedAt: true,
              status: true,
            },
          }),
        )
      : Promise.resolve([]),
    holds(session, 'members.member.update') && holds(session, 'staff.profile.read')
      ? listTrainers(ctx, actor.permissions)
      : Promise.resolve([]),
  ]);

  const name = [member.firstName, member.lastName].filter(Boolean).join(' ');
  const { tone, label } = membershipTone(member.membershipExpiresAt);
  const owes = Number(member.outstandingAmount);
  const live = member.subscriptions.find((s) => s.status === 'ACTIVE' || s.status === 'FROZEN');

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {query.welcome === '1' && (
        <p className="rounded-control bg-emerald-50 px-3.5 py-2.5 text-base text-emerald-900 ring-1 ring-inset ring-emerald-200">
          {name} is registered as {member.memberCode}. Sell them a membership below to get started.
        </p>
      )}

      <PageHeader
        title={name}
        subtitle={`${member.memberCode} · joined ${shortDate(member.joiningDate)}${
          member.branch ? ` · ${member.branch.name}` : ''
        }`}
        action={
          <div className="flex items-center gap-2">
            <a href={`tel:+91${member.phone}`} className="btn-ghost tabular-nums">
              {member.phone}
            </a>
            {holds(session, 'members.member.update') && (
              <Link href={`/members/${id}/edit`} className="btn-ghost">
                Edit
              </Link>
            )}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card p-5">
          <p className="text-sm font-medium text-ink-muted">Membership</p>
          <p className="mt-2 flex items-center gap-2">
            <Badge tone={tone}>{label}</Badge>
          </p>
          <p className="mt-1.5 text-base text-ink">
            {live ? live.plan.name : 'No active plan'}
            {member.membershipExpiresAt && (
              <span className="text-ink-muted"> · until {shortDate(member.membershipExpiresAt)}</span>
            )}
          </p>
        </div>

        {holds(session, 'finance.payment.read') && (
          <div className="card p-5">
            <p className="text-sm font-medium text-ink-muted">Outstanding</p>
            <p
              className={`mt-2 text-3xl font-semibold tabular-nums ${
                owes > 0 ? 'text-amber-700' : 'text-ink'
              }`}
            >
              {rupees(member.outstandingAmount)}
            </p>
          </div>
        )}

        <div className="card p-5">
          <p className="text-sm font-medium text-ink-muted">Last visit</p>
          <p className="mt-2 text-xl font-semibold text-ink">
            {member.lastVisitAt ? shortDate(member.lastVisitAt) : 'Never'}
          </p>
          {member.lastVisitAt && (
            <p className="mt-1 text-sm text-ink-subtle">{timeOfDay(member.lastVisitAt)}</p>
          )}
        </div>
      </div>

      {plans.length > 0 && (
        <SellMembershipPanel
          memberId={id}
          memberName={member.firstName}
          plans={plans.map((plan) => ({
            id: plan.id,
            name: plan.name,
            price: plan.price.toString(),
            duration: `${plan.durationValue} ${plan.durationUnit.toLowerCase()}${
              plan.durationValue > 1 ? 's' : ''
            }`,
          }))}
          isRenewal={Boolean(live)}
          renewalFrom={live ? shortDate(live.endDate) : null}
        />
      )}

      {owes > 0 && holds(session, 'finance.payment.create') && (
        <TakePaymentPanel memberId={id} outstanding={member.outstandingAmount.toString()} />
      )}

      <Card title="Memberships" padded={false}>
        <DataTable
          rows={member.subscriptions}
          empty={
            <EmptyState
              title="No memberships yet"
              description="Sell this member a plan and it will appear here, with every freeze, extension and renewal."
            />
          }
          columns={[
            { key: 'plan', header: 'Plan', cell: (row) => row.plan.name },
            {
              key: 'period',
              header: 'Period',
              cell: (row) => (
                <span className="text-ink-muted">
                  {shortDate(row.startDate)} – {shortDate(row.endDate)}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (row) => (
                <Badge
                  tone={
                    row.status === 'ACTIVE'
                      ? 'active'
                      : row.status === 'FROZEN'
                        ? 'frozen'
                        : row.status === 'EXPIRED'
                          ? 'expired'
                          : 'neutral'
                  }
                >
                  {row.status.toLowerCase()}
                </Badge>
              ),
            },
            {
              key: 'amount',
              header: 'Paid',
              align: 'right',
              hideOnMobile: true,
              cell: (row) => (
                <span className="tabular-nums">
                  {rupees(row.paidAmount)}
                  <span className="text-ink-subtle"> / {rupees(row.totalAmount)}</span>
                </span>
              ),
            },
          ]}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Recent visits" padded={false}>
          {attendance.length === 0 ? (
            <p className="px-5 py-6 text-base text-ink-muted">No visits recorded yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {attendance.map((visit) => (
                <li key={visit.id} className="flex items-center justify-between px-5 py-2.5">
                  <span className="text-base text-ink">{shortDate(visit.checkedInAt)}</span>
                  <span className="text-sm tabular-nums text-ink-muted">
                    {timeOfDay(visit.checkedInAt)}
                    {visit.checkedOutAt && ` – ${timeOfDay(visit.checkedOutAt)}`}
                    {visit.wasOverride && <span className="ml-2 text-amber-700">override</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {holds(session, 'finance.payment.read') && (
          <Card title="Payments" padded={false}>
            {payments.length === 0 ? (
              <p className="px-5 py-6 text-base text-ink-muted">Nothing received yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {payments.map((payment) => (
                  <li key={payment.id} className="flex items-center justify-between px-5 py-2.5">
                    <div className="min-w-0">
                      <p className="text-base text-ink">{rupees(payment.amount)}</p>
                      <p className="text-sm text-ink-muted">
                        {spoken(payment.method)} ·{' '}
                        <a
                          href={`/api/v1/finance/payments/${payment.id}/receipt`}
                          target="_blank"
                          rel="noreferrer"
                          className="tabular-nums text-accent hover:underline"
                        >
                          {payment.receiptCode}
                        </a>
                      </p>
                    </div>
                    <span className="shrink-0 text-sm text-ink-muted">
                      {shortDate(payment.receivedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      {member.canSeeMedical && 'medicalDeclaration' in member && member.medicalDeclaration && (
        <Card title="Medical" description="Visible to you because of your role">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Detail
              label="Declared conditions"
              value={
                member.medicalDeclaration.conditions.length > 0
                  ? member.medicalDeclaration.conditions.join(', ')
                  : 'None declared'
              }
            />
            <Detail label="Medications" value={member.medicalDeclaration.medications ?? '—'} />
            <Detail label="Allergies" value={member.medicalDeclaration.allergies ?? '—'} />
            <Detail label="Injuries" value={member.medicalDeclaration.injuries ?? '—'} />
          </dl>
        </Card>
      )}

      <Card title="Details">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Detail label="Email" value={member.email ?? '—'} />
          <Detail label="Date of birth" value={shortDate(member.dateOfBirth)} />
          <Detail
            label="Address"
            value={
              [member.addressLine1, member.city, member.state, member.postalCode]
                .filter(Boolean)
                .join(', ') || '—'
            }
          />
          <Detail
            label="Emergency contact"
            value={
              member.emergencyContactName
                ? `${member.emergencyContactName} (${member.emergencyContactPhone ?? 'no number'})`
                : '—'
            }
          />
          <div>
            <dt className="text-sm font-medium text-ink-muted">Trainer</dt>
            <dd className="mt-0.5 text-base text-ink">
              {holds(session, 'members.member.update') && holds(session, 'staff.profile.read') ? (
                <TrainerPicker
                  memberId={id}
                  current={
                    member.assignedTrainer
                      ? {
                          orgUserId: member.assignedTrainer.id,
                          fullName: member.assignedTrainer.user.fullName,
                        }
                      : null
                  }
                  trainers={trainers.map((trainer) => ({
                    orgUserId: trainer.orgUserId,
                    fullName: trainer.fullName,
                    designation: trainer.designation,
                    memberCount: trainer.memberCount,
                  }))}
                />
              ) : (
                (member.assignedTrainer?.user.fullName ?? 'Not assigned')
              )}
            </dd>
          </div>
          <Detail label="Occupation" value={member.occupation ?? '—'} />
        </dl>
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
