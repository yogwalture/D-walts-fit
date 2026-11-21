import { NextResponse } from 'next/server';
import { z } from 'zod';
import { boolish, isoDate } from '@gym/contracts';
import { myWorkout, logWorkout, workoutProgress } from '@gym/core';
import { route } from '@/lib/handler';
import { memberContextOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** A member's own plan, with what they lifted last time on each exercise. */
export const GET = route({ permission: 'self.workout.read' }, async ({ actor }) => {
  const ctx = memberContextOf(actor);
  const [workout, progress] = await Promise.all([
    myWorkout(ctx, actor.permissions),
    workoutProgress(ctx, actor.permissions),
  ]);
  return NextResponse.json({ data: workout, progress });
});

/**
 * Logging a session: the whole day at once.
 *
 * Exercise by exercise would be a dozen requests from a gym floor with bad
 * signal, and a half-recorded session when one of them fails.
 */
export const POST = route(
  {
    permission: 'self.workout.log',
    schema: z.object({
      dayId: z.string().uuid(),
      performedOn: isoDate.optional(),
      entries: z
        .array(
          z.object({
            planItemId: z.string().uuid(),
            setsCompleted: z.coerce.number().int().min(0).max(30).optional(),
            repsCompleted: z.string().trim().max(40).optional(),
            weightKg: z.string().trim().max(10).optional(),
            durationSeconds: z.coerce.number().int().min(0).max(14_400).optional(),
            perceivedEffort: z.coerce.number().int().min(1).max(10).optional(),
            completed: boolish.optional(),
            memberNotes: z.string().trim().max(500).optional(),
          }),
        )
        .min(1)
        .max(40),
    }),
  },
  async ({ input, actor }) => {
    const result = await logWorkout(memberContextOf(actor), actor.permissions, input);
    return NextResponse.json({ data: result }, { status: 201 });
  },
);
