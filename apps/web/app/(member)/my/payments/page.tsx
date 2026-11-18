import type { Metadata } from 'next';
import { memberPayments } from '@gym/core';
import { requireActor } from '@/lib/current-session';
import { memberContextOf } from '@/lib/tenant';
import { Badge, Card, EmptyState, rupees } from '@/components/ui';

export const metadata: Metadata = { title: 'Payments' };
export const dynamic = 'force-dynamic';

/**
 * What they have paid, and what they still owe — in one list.
 *
 * "What do I owe" and "what did I pay in March" are the same question asked
 * from two ends, and a member does not know which of our tables holds the
 * answer.
 */
export default async function MyPaymentsPage() {
  const { actor } = await requireActor('/my/payments');
  const { rows, outstanding } = await memberPayments(
    memberContextOf(actor),
    actor.permissions,
    {},
  );

  const owed = Number(outstanding) > 0;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Payments</h1>

      <Card>
        <p className="text-sm text-ink-subtle">Outstanding</p>
        <p className="text-3xl font-semibold text-ink">{rupees(outstanding)}</p>
        <p className="mt-1 text-sm text-ink-muted">
          {owed
            ? 'Pay at the desk, or ask them to send you a payment link.'
            : 'Nothing owing — you are all settled.'}
        </p>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <EmptyState title="Nothing yet" description="Invoices and payments appear here." />
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line">
            {rows.map((row) => (
              <li key={`${row.kind}-${row.id}`} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-base text-ink">{row.description}</p>
                    <p className="text-sm text-ink-muted">
                      {row.date}
                      {row.code ? ` · ${row.code}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-base font-medium text-ink">{rupees(row.amount)}</p>
                    {row.kind === 'INVOICE' && Number(row.amountDue) > 0 ? (
                      <Badge tone="expiring">{rupees(row.amountDue!)} due</Badge>
                    ) : (
                      <Badge tone="active">{row.kind === 'PAYMENT' ? 'Paid' : 'Settled'}</Badge>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
