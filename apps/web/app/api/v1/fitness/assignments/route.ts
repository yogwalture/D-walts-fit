import { NextResponse } from 'next/server';
import { z } from 'zod';
import { boolish, isoDate } from '@gym/contracts';
import {
  listWorkoutAssignments,
  assignWorkoutPlan,
  endWorkoutAssignment,
  workoutProgress,
} from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  {
    permission: 'fitness.workout.read',
    source: 'query',
    schema: z.object({
      memberId: z.string().uuid().optional(),
      planId: z.string().uuid().optional(),
      includeEnded: boolish.default(false),
      /** With a member id, returns their training history too. */
      withProgress: boolish.default(false),
    }),
  },
  async ({ input, actor }) => {
    const rows = await listWorkoutAssignments(tenantOf(actor), actor.permissions, input);

    if (input.withProgress && input.memberId) {
      const progress = await workoutProgress(tenantOf(actor), actor.permissions, {
        memberId: input.memberId,
      });
      return NextResponse.json({ data: rows, progress });
    }

    return NextResponse.json({ data: rows });
  },
);

const body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('assign'),
    memberId: z.string().uuid(),
    planId: z.string().uuid(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    notes: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal('end'),
    assignmentId: z.string().uuid(),
    status: z.enum(['COMPLETED', 'PAUSED', 'CANCELLED']),
    reason: z.string().trim().max(500).optional(),
  }),
]);

export const POST = route(
  { permission: 'fitness.workout.assign', schema: body },
  async ({ input, actor, ipAddress }) => {
    if (input.action === 'assign') {
      const result = await assignWorkoutPlan(
        tenantOf(actor),
        actor.permissions,
        {
          memberId: input.memberId,
          planId: input.planId,
          startDate: input.startDate,
          endDate: input.endDate,
          notes: input.notes,
        },
        { ipAddress },
      );
      return NextResponse.json({ data: result }, { status: 201 });
    }

    await endWorkoutAssignment(
      tenantOf(actor),
      actor.permissions,
      input.assignmentId,
      { status: input.status, reason: input.reason },
      { ipAddress },
    );
    return NextResponse.json({ data: { ok: true } });
  },
);
