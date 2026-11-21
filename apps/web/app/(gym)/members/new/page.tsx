import type { Metadata } from 'next';
import { withTenant } from '@gym/db';
import { requireActor } from '@/lib/current-session';
import { PageHeader } from '@/components/ui';
import { RegisterMemberForm } from './register-form';

export const metadata: Metadata = { title: 'Register member' };
export const dynamic = 'force-dynamic';

export default async function NewMemberPage() {
  const { ctx } = await requireActor('/members/new');

  const branches = await withTenant(ctx, (tx) =>
    tx.branch.findMany({
      // Bounded: more than 100 branches for one gym is a data
      // problem, and a truncated list beats a request that times out.
      take: 100,
      where: { deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Register member"
        subtitle="A name and a mobile number are enough to get started."
      />
      <RegisterMemberForm branches={branches} />
    </div>
  );
}
