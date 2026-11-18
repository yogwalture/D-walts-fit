import { z } from 'zod';
import { isoDate, uuid } from './common';

/**
 * Staff attendance, the rota and leave.
 *
 * Shift times are `HH:MM` strings rather than instants: a shift is "nine to
 * five at this gym", which does not belong to a particular date and does
 * not move when the clocks do.
 */

export const staffAttendanceStatus = z.enum([
  'PRESENT',
  'ABSENT',
  'HALF_DAY',
  'ON_LEAVE',
  'WEEKLY_OFF',
  'HOLIDAY',
]);

export const leaveStatus = z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED']);

const clockTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

export const staffAttendanceInput = z
  .object({
    orgUserId: uuid,
    date: isoDate.optional(),
    status: staffAttendanceStatus.optional(),
    action: z.enum(['IN', 'OUT']).optional(),
    notes: z.string().trim().max(300).optional(),
  })
  .refine((value) => value.status !== undefined || value.action !== undefined, {
    message: 'Say what happened: a status, or in or out',
    path: ['action'],
  });

export const staffDayQuery = z.object({ date: isoDate.optional() });

export const attendanceSummaryQuery = z.object({ from: isoDate, to: isoDate });

export const shiftInput = z.object({
  orgUserId: uuid,
  /** 0 = Sunday. Omitted for a one-off shift on a date. */
  weekday: z.coerce.number().int().min(0).max(6).optional(),
  shiftDate: isoDate.optional(),
  startTime: clockTime,
  endTime: clockTime,
  notes: z.string().trim().max(200).optional(),
});

export const leaveRequestInput = z.object({
  /** Omitted means the person asking. Filing for somebody else needs approval rights. */
  orgUserId: uuid.optional(),
  leaveType: z.string().trim().min(2).max(40),
  fromDate: isoDate,
  toDate: isoDate,
  reason: z.string().trim().max(500).optional(),
  halfDay: z.coerce.boolean().default(false),
});

export const leaveDecisionInput = z.object({
  leaveId: uuid,
  approve: z.coerce.boolean(),
  note: z.string().trim().max(300).optional(),
});

export const leaveListQuery = z.object({
  status: leaveStatus.optional(),
  orgUserId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type ShiftInput = z.infer<typeof shiftInput>;
export type LeaveRequestInput = z.infer<typeof leaveRequestInput>;
