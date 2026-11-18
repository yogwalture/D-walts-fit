import { NextResponse } from 'next/server';
import { staffProfileInput } from '@gym/contracts';
import { getStaffProfile, updateStaffProfile } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'staff.profile.read' }, async ({ actor, params }) =>
  getStaffProfile(tenantOf(actor), actor.permissions, params.id!),
);

/**
 * Edits a profile.
 *
 * Salary and bank fields are mapped through like any other, and the service
 * then demands `staff.salary.update` the moment any of them is present — so
 * a manager who may fix a designation cannot set a wage by including one
 * extra key in the body.
 */
export const PATCH = route(
  { permission: 'staff.profile.update', schema: staffProfileInput },
  async ({ input, actor, params, ipAddress }) => {
    await updateStaffProfile(
      tenantOf(actor),
      actor.permissions,
      params.id!,
      {
        employeeCode: input.employeeCode,
        designation: input.designation,
        department: input.department,
        joiningDate: input.joiningDate,
        specialisations: input.specialisations,
        certifications: input.certifications,
        bio: input.bio,
        salaryAmount: input.salaryAmount,
        salaryCycle: input.salaryCycle,
        bankAccountMasked: input.bankAccountMasked,
        bankIfsc: input.bankIfsc,
        panMasked: input.panMasked,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: { updated: true } }, { status: 200 });
  },
);
