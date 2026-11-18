import { z } from 'zod';
import { isoDate, isoDateTime, uuid } from './common';

/**
 * Classes and bookings.
 *
 * `repeatOn` uses 0 = Sunday, matching JavaScript's own weekday numbering
 * rather than inventing a second convention for the same thing.
 */

export const classStatus = z.enum(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']);

export const classBookingStatus = z.enum([
  'BOOKED',
  'WAITLISTED',
  'CANCELLED',
  'ATTENDED',
  'NO_SHOW',
]);

export const classTypeInput = z.object({
  name: z.string().trim().min(2, 'Enter a name').max(80),
  description: z.string().trim().max(500).optional(),
  defaultDurationMinutes: z.coerce.number().int().min(5).max(480).default(60),
  defaultCapacity: z.coerce.number().int().min(1).max(500).default(20),
  colorHex: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'A colour like #16A34A')
    .optional(),
  requiresBooking: z.coerce.boolean().default(true),
});

export const updateClassTypeInput = classTypeInput
  .partial()
  .extend({ isActive: z.coerce.boolean().optional() });

export const scheduleClassInput = z.object({
  classTypeId: uuid,
  branchId: uuid.optional(),
  trainerOrgUserId: uuid.optional(),
  title: z.string().trim().max(120).optional(),
  startsAt: isoDateTime,
  durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
  capacity: z.coerce.number().int().min(1).max(500).optional(),
  room: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(1000).optional(),
  /** 0 = Sunday. Empty for a one-off class. */
  repeatOn: z.array(z.coerce.number().int().min(0).max(6)).max(7).default([]),
  repeatWeeks: z.coerce.number().int().min(0).max(12).default(0),
});

export const timetableQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  branchId: uuid.optional(),
  classTypeId: uuid.optional(),
  trainerOrgUserId: uuid.optional(),
  includeCancelled: z.coerce.boolean().default(false),
});

export const bookClassInput = z.object({
  classId: uuid,
  memberId: uuid,
  /**
   * Booking a member whose membership does not cover the class. Deliberate
   * and audited, the same way an override at the door is.
   */
  allowIneligible: z.coerce.boolean().default(false),
});

export const cancelBookingInput = z.object({
  bookingId: uuid,
  reason: z.string().trim().max(200).optional(),
});

export const classAttendanceInput = z.object({
  bookingId: uuid,
  attended: z.coerce.boolean(),
});

export const cancelClassInput = z.object({
  classId: uuid,
  reason: z.string().trim().min(3, 'Say why').max(200),
  wholeSeries: z.coerce.boolean().default(false),
});

export type ClassTypeInput = z.infer<typeof classTypeInput>;
export type ScheduleClassInput = z.infer<typeof scheduleClassInput>;
export type TimetableQuery = z.infer<typeof timetableQuery>;
export type BookClassInput = z.infer<typeof bookClassInput>;
