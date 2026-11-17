import { NextResponse } from 'next/server';
import { createMemberInput, memberListQuery } from '@gym/contracts';
import { createMember, listMembers } from '@gym/core';
import { route, paged } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'members.member.read', source: 'query', schema: memberListQuery },
  async ({ input, actor }) => {
    const { rows, total } = await listMembers(tenantOf(actor), actor.permissions, {
      page: input.page,
      pageSize: input.pageSize,
      search: input.search,
      filter: input.filter,
      branchId: input.branchId,
      trainerOrgUserId: input.trainerOrgUserId,
      sortBy: input.sortBy,
      sortDir: input.sortDir,
    });
    return NextResponse.json(paged(rows, total, input.page, input.pageSize), { status: 200 });
  },
);

/**
 * Registers a member.
 *
 * A matching phone or email comes back as a 409 carrying the matches, so the
 * desk sees who it collided with and can either open that member or tick
 * "add anyway". Blocking outright would be wrong — families share numbers.
 *
 * Every field is written out rather than spread. They are all optional on
 * the service's side, so a spread lets a mismatched name through in silence:
 * that is exactly how the address typed at the desk went nowhere.
 */
export const POST = route(
  { permission: 'members.member.create', schema: createMemberInput },
  async ({ input, actor, ipAddress, userAgent }) => {
    const member = await createMember(
      tenantOf(actor),
      actor.permissions,
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
        joiningDate: input.joiningDate,
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
        allowDuplicate: input.allowDuplicate,
      },
      { ipAddress, userAgent },
    );
    return NextResponse.json({ data: member }, { status: 201 });
  },
);
