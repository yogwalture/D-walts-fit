import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listExercises, createExercise } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  {
    permission: 'fitness.exercise.read',
    source: 'query',
    schema: z.object({
      search: z.string().trim().max(80).optional(),
      muscleGroup: z.string().trim().max(60).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
  },
  async ({ input, actor }) => {
    const rows = await listExercises(tenantOf(actor), actor.permissions, input);
    return NextResponse.json({ data: rows });
  },
);

export const POST = route(
  {
    permission: 'fitness.exercise.manage',
    schema: z.object({
      name: z.string().trim().min(2).max(120),
      muscleGroup: z.string().trim().min(2).max(60),
      equipment: z.string().trim().max(60).optional(),
      difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).optional(),
      instructions: z.string().trim().max(2000).optional(),
      cautions: z.string().trim().max(500).optional(),
    }),
  },
  async ({ input, actor, ipAddress }) => {
    const created = await createExercise(tenantOf(actor), actor.permissions, input, { ipAddress });
    return NextResponse.json({ data: created }, { status: 201 });
  },
);
