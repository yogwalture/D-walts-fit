import { z } from 'zod';
import { boolish } from '@gym/contracts';

/**
 * The plan body, shared by create and update.
 *
 * In `lib/` rather than exported from the route, because Next refuses any
 * export from a route file that is not a handler — a schema exported beside
 * the handlers fails the build with "not a valid Route export field".
 */
export const workoutPlanBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional(),
  goal: z.string().trim().max(200).optional(),
  difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).optional(),
  durationWeeks: z.coerce.number().int().min(1).max(52).optional(),
  daysPerWeek: z.coerce.number().int().min(1).max(14).optional(),
  days: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(60),
        focus: z.string().trim().max(120).optional(),
        isRestDay: boolish.optional(),
        notes: z.string().trim().max(1000).optional(),
        items: z.array(
          z.object({
            exerciseId: z.string().uuid(),
            sets: z.coerce.number().int().min(1).max(20).optional(),
            // Free text, because "8-10" and "to failure" are both real
            // answers a trainer writes.
            reps: z.string().trim().max(40).optional(),
            weightKg: z.string().trim().max(10).optional(),
            restSeconds: z.coerce.number().int().min(0).max(900).optional(),
            tempo: z.string().trim().max(20).optional(),
            trainerNotes: z.string().trim().max(500).optional(),
          }),
        ),
      }),
    )
    .min(1)
    .max(14),
});
