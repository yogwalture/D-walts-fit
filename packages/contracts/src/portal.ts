import { z } from 'zod';
import { uuid } from './common';

/**
 * The member portal.
 *
 * Note what is absent: no member id anywhere. It comes from the session, so
 * there is nothing for a crafted request to substitute.
 */

export const selfBookClassInput = z.object({ classId: uuid });

export const selfCancelBookingInput = z.object({ bookingId: uuid });

export const selfCheckInInput = z.object({
  /** The token from the branch QR code at the entrance. */
  code: z.string().trim().min(10).max(120),
});

export const memberClassQuery = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
});
