import { z } from 'zod';
import { isoDate, pageQuery, phone, uuid } from './common';

/**
 * Attendance.
 *
 * One endpoint takes any of the four ways a member can be identified at the
 * desk, because the receptionist should not have to choose a mode first: the
 * scanner fills `qrToken`, the search box fills `memberCode` or `phone`.
 */

/** Mirrors the AttendanceMethod enum in the schema, exactly. */
export const checkInMethod = z.enum(['MEMBER_QR', 'BRANCH_QR', 'SEARCH', 'MANUAL', 'KIOSK']);

export const checkInInput = z
  .object({
    qrToken: z.string().trim().min(10).max(200).optional(),
    memberId: uuid.optional(),
    memberCode: z.string().trim().min(2).max(40).optional(),
    phone: phone.optional(),
    branchId: uuid.optional(),
    method: checkInMethod.optional(),
    deviceLabel: z.string().trim().max(80).optional(),
    /** Letting in an ineligible member. Requires a reason and is audited. */
    override: z.boolean().default(false),
    overrideReason: z.string().trim().max(300).optional(),
  })
  .refine(
    (v) => Boolean(v.qrToken ?? v.memberId ?? v.memberCode ?? v.phone),
    { message: 'Scan a code, or search by code or phone', path: ['memberCode'] },
  )
  .refine((v) => !v.override || Boolean(v.overrideReason?.trim()), {
    message: 'Record why this member is being let in',
    path: ['overrideReason'],
  });

/** Used by the member's own app, where the member is already authenticated. */
export const branchQrCheckInInput = z.object({
  branchQrToken: z.string().trim().min(10).max(200),
});

export const checkOutInput = z.object({
  attendanceId: uuid,
});

export const attendanceListQuery = pageQuery.extend({
  date: isoDate.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  branchId: uuid.optional(),
  memberId: uuid.optional(),
  onlyOverrides: z.coerce.boolean().default(false),
});

export const peakHoursQuery = z.object({
  fromDate: isoDate,
  toDate: isoDate,
  branchId: uuid.optional(),
});

export const issueQrInput = z.object({
  memberId: uuid.optional(),
  branchId: uuid.optional(),
});

export type CheckInInput = z.infer<typeof checkInInput>;
export type AttendanceListQuery = z.infer<typeof attendanceListQuery>;
