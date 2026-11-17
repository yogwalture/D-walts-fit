import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMember } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import { PageHeader } from '@/components/ui';
import { EditMemberForm } from './edit-form';

export const metadata: Metadata = { title: 'Edit member' };
export const dynamic = 'force-dynamic';

const iso = (value: Date | null): string => (value ? value.toISOString().slice(0, 10) : '');

export default async function EditMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { session, actor, ctx } = await requireActor('/members');
  const { id } = await params;

  if (!holds(session, 'members.member.update')) notFound();

  const member = await getMember(ctx, actor.permissions, id);
  const name = [member.firstName, member.lastName].filter(Boolean).join(' ');

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title={`Edit ${name}`} subtitle={member.memberCode} />
      <EditMemberForm
        memberId={id}
        memberName={member.firstName}
        canArchive={holds(session, 'members.member.delete')}
        initial={{
          firstName: member.firstName,
          lastName: member.lastName ?? '',
          phone: member.phone,
          email: member.email ?? '',
          dateOfBirth: iso(member.dateOfBirth),
          gender: member.gender ?? '',
          occupation: member.occupation ?? '',
          addressLine1: member.addressLine1 ?? '',
          city: member.city ?? '',
          state: member.state ?? '',
          postalCode: member.postalCode ?? '',
          emergencyContactName: member.emergencyContactName ?? '',
          emergencyContactPhone: member.emergencyContactPhone ?? '',
          emergencyContactRelation: member.emergencyContactRelation ?? '',
          notes: member.notes ?? '',
        }}
      />
    </div>
  );
}
