import { NextResponse } from 'next/server';
import { getWorkoutPlan, updateWorkoutPlan, retireWorkoutPlan } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';
import { workoutPlanBody } from '@/lib/workout-schema';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'fitness.workout.read' },
  async ({ actor, params }) => {
    const plan = await getWorkoutPlan(tenantOf(actor), actor.permissions, params.id!);
    return NextResponse.json({ data: plan });
  },
);

/**
 * Rewrites the plan, days and all.
 *
 * A replacement rather than a patch: a trainer rearranging a week thinks in
 * terms of the finished week. Members' logs are not touched — they hang off
 * the member, not the day.
 */
export const PUT = route(
  { permission: 'fitness.workout.manage', schema: workoutPlanBody },
  async ({ input, actor, params, ipAddress }) => {
    await updateWorkoutPlan(tenantOf(actor), actor.permissions, params.id!, input, { ipAddress });
    return NextResponse.json({ data: { ok: true } });
  },
);

/** Retires rather than deletes: somebody's logs point at it. */
export const DELETE = route(
  { permission: 'fitness.workout.manage' },
  async ({ actor, params, ipAddress }) => {
    await retireWorkoutPlan(tenantOf(actor), actor.permissions, params.id!, { ipAddress });
    return NextResponse.json({ data: { ok: true } });
  },
);
