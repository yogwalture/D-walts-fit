import { NextResponse } from 'next/server';
import { z } from 'zod';
import { boolish } from '@gym/contracts';
import { listWorkoutPlans, createWorkoutPlan } from '@gym/core';
import { workoutPlanBody } from '@/lib/workout-schema';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  {
    permission: 'fitness.workout.read',
    source: 'query',
    schema: z.object({ includeInactive: boolish.default(false) }),
  },
  async ({ input, actor }) => {
    const rows = await listWorkoutPlans(tenantOf(actor), actor.permissions, input);
    return NextResponse.json({ data: rows });
  },
);

export const POST = route(
  { permission: 'fitness.workout.manage', schema: workoutPlanBody },
  async ({ input, actor, ipAddress }) => {
    const created = await createWorkoutPlan(tenantOf(actor), actor.permissions, input, {
      ipAddress,
    });
    return NextResponse.json({ data: created }, { status: 201 });
  },
);
