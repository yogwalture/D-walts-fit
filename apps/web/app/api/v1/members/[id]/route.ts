import { NextResponse } from 'next/server';
import { archiveMemberInput, updateMemberInput } from '@gym/contracts';
import { archiveMember, getMember, updateMember } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'members.member.read' }, async ({ actor, params }) =>
  getMember(tenantOf(actor), actor.permissions, params.id!),
);

/**
 * Updates a member.
 *
 * Mapped field by field: everything here is optional, so a spread would let
 * a renamed field be dropped without a word from the typechecker.
 */
export const PATCH = route(
  { permission: 'members.member.update', schema: updateMemberInput },
  async ({ input, actor, params, ipAddress }) => {
    await updateMember(
      tenantOf(actor),
      actor.permissions,
      params.id!,
      {
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        altPhone: input.altPhone,
        email: input.email,
        dateOfBirth: input.dateOfBirth,
        gender: input.gender,
        bloodGroup: input.bloodGroup,
        branchId: input.branchId,
        assignedTrainerOrgUserId: input.assignedTrainerOrgUserId,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        emergencyContactName: input.emergencyContactName,
        emergencyContactPhone: input.emergencyContactPhone,
        emergencyContactRelation: input.emergencyContactRelation,
        fitnessGoals: input.fitnessGoals,
        occupation: input.occupation,
        referredBy: input.referredBy,
        notes: input.notes,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: { updated: true } }, { status: 200 });
  },
);

/**
 * Archives a member. Never deletes: the invoices, payments and attendance
 * stay, because a gym's financial history cannot have holes in it.
 */
export const DELETE = route(
  { permission: 'members.member.delete', schema: archiveMemberInput },
  async ({ input, actor, params, ipAddress }) => {
    await archiveMember(tenantOf(actor), actor.permissions, params.id!, {
      reason: input.reason,
      ipAddress,
    });
    return NextResponse.json({ data: { archived: true } }, { status: 200 });
  },
);
