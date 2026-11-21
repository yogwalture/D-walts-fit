import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import {
  requirePermission,
  scopeOf,
  branchFilter,
  type ResolvedPermissions,
} from '../rbac/engine';
import { today } from '../shared/dates';

/**
 * Workout plans: what a trainer actually does.
 *
 * Six tables for this had been in the schema since the first migration, five
 * permission keys were seeded and granted to trainers and managers, and the
 * sidebar carried an entry marked `built: false`. Nothing existed — no
 * service, no screen. The data export even excluded workout plans on the
 * grounds that they "stay readable and editable in the product", which was
 * a sentence written about software that did not exist.
 *
 * Two decisions shape what follows.
 *
 * A plan is a template until it is assigned. The same plan goes to forty
 * members, and editing it changes what all forty are doing next session —
 * which is what a trainer means by "I updated the beginner plan". A member
 * who needs something different gets their own plan, not a silent fork.
 *
 * A log belongs to the member, not to the plan. It records what they
 * actually did, which is frequently not what the plan said, and it survives
 * the plan being edited or deleted: the history of somebody's training is
 * not a detail of the document that prompted it.
 */

export interface FitnessContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

// ------------------------------------------------------------ exercises ---

export interface ExerciseRow {
  id: string;
  name: string;
  muscleGroup: string;
  equipment: string | null;
  difficulty: string;
  instructions: string | null;
  cautions: string | null;
  /** False for the platform's shared library, which a gym may read but not edit. */
  isOwn: boolean;
}

/**
 * The exercise library: the platform's shared entries plus the gym's own.
 *
 * Shared rows carry a null organizationId and are readable by every gym and
 * writable by none — twelve squats are twelve squats, and making each gym
 * type them in again would be rude. A gym's own entries sit alongside.
 */
export async function listExercises(
  ctx: FitnessContext,
  permissions: ResolvedPermissions,
  options: { search?: string; muscleGroup?: string; limit?: number } = {},
): Promise<ExerciseRow[]> {
  requirePermission(permissions, 'fitness.exercise.read');

  return withTenant(ctx, async (tx) => {
    const rows = await tx.exercise.findMany({
      where: {
        isActive: true,
        ...(options.muscleGroup ? { muscleGroup: options.muscleGroup } : {}),
        ...(options.search
          ? { name: { contains: options.search, mode: 'insensitive' as const } }
          : {}),
      },
      orderBy: [{ muscleGroup: 'asc' }, { name: 'asc' }],
      take: Math.min(options.limit ?? 200, 500),
      select: {
        id: true,
        name: true,
        muscleGroup: true,
        equipment: true,
        difficulty: true,
        instructions: true,
        cautions: true,
        organizationId: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      muscleGroup: row.muscleGroup,
      equipment: row.equipment,
      difficulty: row.difficulty,
      instructions: row.instructions,
      cautions: row.cautions,
      isOwn: row.organizationId !== null,
    }));
  });
}

export async function createExercise(
  ctx: FitnessContext,
  permissions: ResolvedPermissions,
  input: {
    name: string;
    muscleGroup: string;
    equipment?: string;
    difficulty?: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
    instructions?: string;
    cautions?: string;
  },
  meta: { ipAddress?: string } = {},
): Promise<{ id: string }> {
  requirePermission(permissions, 'fitness.exercise.manage');

  return withTenant(ctx, async (tx) => {
    const exercise = await tx.exercise.create({
      data: {
        organizationId: ctx.organizationId,
        name: input.name.trim(),
        muscleGroup: input.muscleGroup.trim(),
        equipment: input.equipment?.trim() || null,
        difficulty: input.difficulty ?? 'BEGINNER',
        instructions: input.instructions?.trim() || null,
        cautions: input.cautions?.trim() || null,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'fitness.exercise.created',
      entityType: 'Exercise',
      entityId: exercise.id,
      summary: `${input.name.trim()} (${input.muscleGroup.trim()})`,
      ipAddress: meta.ipAddress,
    });

    return exercise;
  });
}

// ----------------------------------------------------------------- plans ---

export interface WorkoutPlanSummary {
  id: string;
  name: string;
  goal: string | null;
  difficulty: string;
  durationWeeks: number;
  daysPerWeek: number;
  /** Days actually written, which is not always daysPerWeek. */
  daysWritten: number;
  exercises: number;
  /** How many members are on it right now. */
  activeMembers: number;
  isActive: boolean;
}

export async function listWorkoutPlans(
  ctx: FitnessContext,
  permissions: ResolvedPermissions,
  options: { includeInactive?: boolean } = {},
): Promise<WorkoutPlanSummary[]> {
  requirePermission(permissions, 'fitness.workout.read');

  return withTenant(ctx, async (tx) => {
    const plans = await tx.workoutPlan.findMany({
      where: {
        deletedAt: null,
        ...(options.includeInactive ? {} : { isActive: true }),
      },
      orderBy: { name: 'asc' },
      take: 200,
      select: {
        id: true,
        name: true,
        goal: true,
        difficulty: true,
        durationWeeks: true,
        daysPerWeek: true,
        isActive: true,
        days: { select: { _count: { select: { items: true } } } },
        _count: { select: { assignments: true } },
      },
    });

    // Counted separately because `_count` cannot filter, and "12 members"
    // meaning "12 who were ever on it" would be a misleading number on the
    // one screen a trainer uses to decide what to edit.
    const active = await tx.memberWorkoutAssignment.groupBy({
      by: ['workoutPlanId'],
      where: { status: 'ACTIVE' },
      _count: { _all: true },
    });
    const activeByPlan = new Map(
      active.map((row: any) => [row.workoutPlanId, row._count._all as number]),
    );

    return plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      goal: plan.goal,
      difficulty: plan.difficulty,
      durationWeeks: plan.durationWeeks,
      daysPerWeek: plan.daysPerWeek,
      daysWritten: plan.days.length,
      exercises: plan.days.reduce((sum, day) => sum + day._count.items, 0),
      activeMembers: activeByPlan.get(plan.id) ?? 0,
      isActive: plan.isActive,
    }));
  });
}

export interface WorkoutPlanDetail extends Omit<WorkoutPlanSummary, 'daysWritten' | 'exercises'> {
  description: string | null;
  days: Array<{
    id: string;
    dayIndex: number;
    label: string;
    focus: string | null;
    isRestDay: boolean;
    notes: string | null;
    items: Array<{
      id: string;
      exerciseId: string;
      exerciseName: string;
      muscleGroup: string;
      cautions: string | null;
      sets: number | null;
      reps: string | null;
      weightKg: string | null;
      restSeconds: number | null;
      tempo: string | null;
      trainerNotes: string | null;
    }>;
  }>;
}

export async function getWorkoutPlan(
  ctx: FitnessContext,
  permissions: ResolvedPermissions,
  planId: string,
): Promise<WorkoutPlanDetail> {
  requirePermission(permissions, 'fitness.workout.read');

  return withTenant(ctx, async (tx) => {
    const plan = await tx.workoutPlan.findFirst({
      where: { id: planId, deletedAt: null },
      select: {
        id: true,
        name: true,
        description: true,
        goal: true,
        difficulty: true,
        durationWeeks: true,
        daysPerWeek: true,
        isActive: true,
        days: {
          orderBy: { dayIndex: 'asc' },
          select: {
            id: true,
            dayIndex: true,
            label: true,
            focus: true,
            isRestDay: true,
            notes: true,
            items: {
              orderBy: { displayOrder: 'asc' },
              select: {
                id: true,
                exerciseId: true,
                sets: true,
                reps: true,
                weightKg: true,
                restSeconds: true,
                tempo: true,
                trainerNotes: true,
                exercise: { select: { name: true, muscleGroup: true, cautions: true } },
              },
            },
          },
        },
      },
    });
    if (!plan) throw new AppError('NOT_FOUND', 'That workout plan was not found.');

    const active = await tx.memberWorkoutAssignment.count({
      where: { workoutPlanId: planId, status: 'ACTIVE' },
    });

    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      goal: plan.goal,
      difficulty: plan.difficulty,
      durationWeeks: plan.durationWeeks,
      daysPerWeek: plan.daysPerWeek,
      isActive: plan.isActive,
      activeMembers: active,
      days: plan.days.map((day) => ({
        id: day.id,
        dayIndex: day.dayIndex,
        label: day.label,
        focus: day.focus,
        isRestDay: day.isRestDay,
        notes: day.notes,
        items: day.items.map((item) => ({
          id: item.id,
          exerciseId: item.exerciseId,
          exerciseName: item.exercise.name,
          muscleGroup: item.exercise.muscleGroup,
          // Carried through to the screen a member reads, not left in the
          // library: "not if you have a shoulder problem" is useless where
          // nobody is looking.
          cautions: item.exercise.cautions,
          sets: item.sets,
          reps: item.reps,
          weightKg: item.weightKg ? item.weightKg.toString() : null,
          restSeconds: item.restSeconds,
          tempo: item.tempo,
          trainerNotes: item.trainerNotes,
        })),
      })),
    };
  });
}

export interface WorkoutPlanInput {
  name: string;
  description?: string;
  goal?: string;
  difficulty?: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
  durationWeeks?: number;
  daysPerWeek?: number;
  days: Array<{
    label: string;
    focus?: string;
    isRestDay?: boolean;
    notes?: string;
    items: Array<{
      exerciseId: string;
      sets?: number;
      reps?: string;
      weightKg?: string;
      restSeconds?: number;
      tempo?: string;
      trainerNotes?: string;
    }>;
  }>;
}

/**
 * Creates a plan with its days and exercises in one transaction.
 *
 * All at once rather than a plan then days then items, because a plan with
 * no days is not a plan — a half-built one left behind by a failed request
 * is something a trainer has to notice and delete.
 */
export async function createWorkoutPlan(
  ctx: FitnessContext,
  permissions: ResolvedPermissions,
  input: WorkoutPlanInput,
  meta: { ipAddress?: string } = {},
): Promise<{ id: string }> {
  requirePermission(permissions, 'fitness.workout.manage');
  assertPlanIsCoherent(input);

  return withTenant(ctx, async (tx) => {
    await assertExercisesExist(tx, input);

    const orgUser = await tx.orgUser.findFirst({
      where: { userId: ctx.userId },
      select: { id: true },
    });

    const plan = await tx.workoutPlan.create({
      data: {
        organizationId: ctx.organizationId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        goal: input.goal?.trim() || null,
        difficulty: input.difficulty ?? 'BEGINNER',
        durationWeeks: input.durationWeeks ?? 4,
        daysPerWeek: input.daysPerWeek ?? input.days.filter((day) => !day.isRestDay).length,
        createdByOrgUserId: orgUser?.id ?? null,
      },
      select: { id: true },
    });

    await writeDays(tx, ctx.organizationId, plan.id, input.days);

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'fitness.workout.created',
      entityType: 'WorkoutPlan',
      entityId: plan.id,
      summary: `${input.name.trim()} — ${input.days.length} days`,
      ipAddress: meta.ipAddress,
    });

    return plan;
  });
}

/**
 * Replaces a plan's days wholesale.
 *
 * Deliberately a replacement rather than a patch: a trainer rearranging a
 * week thinks in terms of the finished week, and reconciling individual day
 * and item edits against a form that can reorder, delete and insert is where
 * the bugs would live. Logs survive it — they reference the member and the
 * exercise, so a day that no longer exists does not erase what was done on it.
 */
export async function updateWorkoutPlan(
  ctx: FitnessContext,
  permissions: ResolvedPermissions,
  planId: string,
  input: WorkoutPlanInput,
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'fitness.workout.manage');
  assertPlanIsCoherent(input);

  await withTenant(ctx, async (tx) => {
    const existing = await tx.workoutPlan.findFirst({
      where: { id: planId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!existing) throw new AppError('NOT_FOUND', 'That workout plan was not found.');

    await assertExercisesExist(tx, input);

    const onIt = await tx.memberWorkoutAssignment.count({
      where: { workoutPlanId: planId, status: 'ACTIVE' },
    });

    await tx.workoutPlan.update({
      where: { id: planId },
      data: {
        name: input.name.trim(),
        description: input.description?.trim() || null,
        goal: input.goal?.trim() || null,
        difficulty: input.difficulty ?? 'BEGINNER',
        durationWeeks: input.durationWeeks ?? 4,
        daysPerWeek: input.daysPerWeek ?? input.days.filter((day) => !day.isRestDay).length,
      },
    });

    // Items go with their days by cascade; the logs do not, because they
    // hang off the member.
    await tx.workoutPlanDay.deleteMany({ where: { workoutPlanId: planId } });
    await writeDays(tx, ctx.organizationId, planId, input.days);

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'fitness.workout.updated',
      entityType: 'WorkoutPlan',
      entityId: planId,
      // The number matters: editing a plan changes what everybody on it is
      // doing next session, and an audit line that does not say how many
      // people were affected is not much of a record.
      summary: `${input.name.trim()} rewritten — ${onIt} ${onIt === 1 ? 'member is' : 'members are'} on it`,
      ipAddress: meta.ipAddress,
    });
  });
}

export async function retireWorkoutPlan(
  ctx: FitnessContext,
  permissions: ResolvedPermissions,
  planId: string,
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'fitness.workout.manage');

  await withTenant(ctx, async (tx) => {
    const onIt = await tx.memberWorkoutAssignment.count({
      where: { workoutPlanId: planId, status: 'ACTIVE' },
    });
    if (onIt > 0) {
      throw new AppError(
        'CONFLICT',
        `${onIt} ${onIt === 1 ? 'member is' : 'members are'} still on this plan. ` +
          'Move them to another one first, or they will open the app to nothing.',
      );
    }

    const plan = await tx.workoutPlan.findFirst({
      where: { id: planId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!plan) throw new AppError('NOT_FOUND', 'That workout plan was not found.');

    // Retired, not deleted: somebody's logs point at it, and the history of
    // what a member was doing last year should still make sense.
    await tx.workoutPlan.update({
      where: { id: planId },
      data: { isActive: false },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'fitness.workout.retired',
      entityType: 'WorkoutPlan',
      entityId: planId,
      summary: `${plan.name} retired`,
      ipAddress: meta.ipAddress,
    });
  });
}

// ----------------------------------------------------------- assignments ---

export interface WorkoutAssignmentRow {
  id: string;
  memberId: string;
  memberName: string;
  memberCode: string;
  planId: string;
  planName: string;
  startDate: string;
  endDate: string | null;
  status: string;
  /** Sessions logged against this assignment. */
  sessionsLogged: number;
  lastLoggedOn: string | null;
}

/**
 * Who is on what.
 *
 * Scoped: a trainer with OWN on `fitness.workout.assign` sees the members
 * assigned to them, which is the same narrowing the members list uses — and
 * it is done in the query rather than by hiding rows in the interface.
 */
export async function listWorkoutAssignments(
  ctx: FitnessContext,
  permissions: ResolvedPermissions,
  options: { memberId?: string; planId?: string; includeEnded?: boolean } = {},
): Promise<WorkoutAssignmentRow[]> {
  requirePermission(permissions, 'fitness.workout.read');
  const scope = scopeOf(permissions, 'fitness.workout.assign');

  return withTenant(ctx, async (tx) => {
    let memberScope: Record<string, unknown> = {};
    if (scope === 'OWN') {
      const orgUser = await tx.orgUser.findFirst({
        where: { userId: ctx.userId },
        select: { id: true },
      });
      memberScope = {
        member: { assignedTrainerOrgUserId: orgUser?.id ?? NO_SUCH_ID },
      };
    } else if (scope === 'BRANCH') {
      memberScope = { member: { branchId: branchFilter(permissions, 'fitness.workout.assign') } };
    }

    const rows = await tx.memberWorkoutAssignment.findMany({
      where: {
        ...memberScope,
        ...(options.memberId ? { memberId: options.memberId } : {}),
        ...(options.planId ? { workoutPlanId: options.planId } : {}),
        ...(options.includeEnded ? {} : { status: 'ACTIVE' }),
      },
      orderBy: { startDate: 'desc' },
      take: 200,
      select: {
        id: true,
        memberId: true,
        workoutPlanId: true,
        startDate: true,
        endDate: true,
        status: true,
        member: { select: { firstName: true, lastName: true, memberCode: true } },
        workoutPlan: { select: { name: true } },
        logs: { orderBy: { performedOn: 'desc' }, take: 1, select: { performedOn: true } },
      },
    });

    // A session is a day, not a row. `_count: { logs: true }` — which is
    // what this did — counts one per exercise, so a member who did a
    // six-exercise day showed up on the trainer's screen as six sessions.
    // The member's own progress screen had always counted days; the two
    // disagreed, and the browser run is what noticed.
    const sessionsByAssignment = new Map<string, Set<string>>();
    if (rows.length > 0) {
      const logs = await tx.workoutLog.groupBy({
        by: ['assignmentId', 'performedOn'],
        where: { assignmentId: { in: rows.map((row) => row.id) } },
      });
      for (const log of logs) {
        if (!log.assignmentId) continue;
        const days = sessionsByAssignment.get(log.assignmentId) ?? new Set<string>();
        days.add(log.performedOn.toISOString().slice(0, 10));
        sessionsByAssignment.set(log.assignmentId, days);
      }
    }

    return rows.map((row) => ({
      id: row.id,
      memberId: row.memberId,
      memberName: `${row.member.firstName} ${row.member.lastName ?? ''}`.trim(),
      memberCode: row.member.memberCode,
      planId: row.workoutPlanId,
      planName: row.workoutPlan.name,
      startDate: row.startDate.toISOString().slice(0, 10),
      endDate: row.endDate ? row.endDate.toISOString().slice(0, 10) : null,
      status: row.status,
      sessionsLogged: sessionsByAssignment.get(row.id)?.size ?? 0,
      lastLoggedOn: row.logs[0]
        ? row.logs[0].performedOn.toISOString().slice(0, 10)
        : null,
    }));
  });
}

const NO_SUCH_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Puts a member on a plan.
 *
 * One active plan at a time: a member with two is a member who does not know
 * what to do today, and the app would have to pick one anyway. Assigning a
 * second ends the first, which is what a trainer means by "move them onto
 * the intermediate plan".
 */
export async function assignWorkoutPlan(
  ctx: FitnessContext,
  permissions: ResolvedPermissions,
  input: { memberId: string; planId: string; startDate?: string; endDate?: string; notes?: string },
  meta: { ipAddress?: string } = {},
): Promise<{ id: string; replaced: string | null }> {
  requirePermission(permissions, 'fitness.workout.assign');

  return withTenant(ctx, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: input.memberId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, assignedTrainerOrgUserId: true },
    });
    if (!member) throw new AppError('NOT_FOUND', 'That member was not found.');

    if (scopeOf(permissions, 'fitness.workout.assign') === 'OWN') {
      const orgUser = await tx.orgUser.findFirst({
        where: { userId: ctx.userId },
        select: { id: true },
      });
      if (member.assignedTrainerOrgUserId !== orgUser?.id) {
        // Same answer as a member who does not exist: a trainer learning
        // which members exist by which ids are refused is a leak of its own.
        throw new AppError('NOT_FOUND', 'That member was not found.');
      }
    }

    const plan = await tx.workoutPlan.findFirst({
      where: { id: input.planId, deletedAt: null, isActive: true },
      select: { id: true, name: true, durationWeeks: true, days: { select: { id: true } } },
    });
    if (!plan) throw new AppError('NOT_FOUND', 'That workout plan was not found.');

    if (plan.days.length === 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${plan.name} has no days in it yet. A member assigned to it would open the app to an empty week.`,
      );
    }

    const orgUser = await tx.orgUser.findFirst({
      where: { userId: ctx.userId },
      select: { id: true },
    });

    const current = await tx.memberWorkoutAssignment.findFirst({
      where: { memberId: input.memberId, status: 'ACTIVE' },
      select: { id: true, workoutPlan: { select: { name: true } } },
    });

    if (current) {
      await tx.memberWorkoutAssignment.update({
        where: { id: current.id },
        data: { status: 'COMPLETED', endDate: today() },
      });
    }

    const startDate = input.startDate ? new Date(input.startDate) : today();
    const endDate = input.endDate
      ? new Date(input.endDate)
      : new Date(startDate.getTime() + plan.durationWeeks * 7 * 86_400_000);

    const assignment = await tx.memberWorkoutAssignment.create({
      data: {
        organizationId: ctx.organizationId,
        memberId: input.memberId,
        workoutPlanId: input.planId,
        assignedByOrgUserId: orgUser?.id ?? null,
        startDate,
        endDate,
        status: 'ACTIVE',
        notes: input.notes?.trim() || null,
      },
      select: { id: true },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'fitness.workout.assigned',
      entityType: 'MemberWorkoutAssignment',
      entityId: assignment.id,
      summary:
        `${member.firstName} ${member.lastName ?? ''}`.trim() +
        ` put on ${plan.name}` +
        (current ? ` (from ${current.workoutPlan.name})` : ''),
      ipAddress: meta.ipAddress,
    });

    return { id: assignment.id, replaced: current?.workoutPlan.name ?? null };
  });
}

export async function endWorkoutAssignment(
  ctx: FitnessContext,
  permissions: ResolvedPermissions,
  assignmentId: string,
  input: { status: 'COMPLETED' | 'PAUSED' | 'CANCELLED'; reason?: string },
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'fitness.workout.assign');

  await withTenant(ctx, async (tx) => {
    const assignment = await tx.memberWorkoutAssignment.findFirst({
      where: { id: assignmentId },
      select: {
        id: true,
        member: { select: { firstName: true, lastName: true } },
        workoutPlan: { select: { name: true } },
      },
    });
    if (!assignment) throw new AppError('NOT_FOUND', 'That assignment was not found.');

    await tx.memberWorkoutAssignment.update({
      where: { id: assignmentId },
      data: {
        status: input.status,
        // A pause keeps its end date: it is coming back.
        ...(input.status === 'PAUSED' ? {} : { endDate: today() }),
        ...(input.reason ? { notes: input.reason.trim() } : {}),
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'fitness.workout.assignment.ended',
      entityType: 'MemberWorkoutAssignment',
      entityId: assignmentId,
      summary:
        `${assignment.member.firstName} ${assignment.member.lastName ?? ''}`.trim() +
        ` — ${assignment.workoutPlan.name} ${input.status.toLowerCase()}` +
        (input.reason ? `: ${input.reason.trim()}` : ''),
      ipAddress: meta.ipAddress,
    });
  });
}

// ------------------------------------------------------------- shared ---

function assertPlanIsCoherent(input: WorkoutPlanInput): void {
  if (!input.name?.trim()) {
    throw new AppError('VALIDATION_FAILED', 'Give the plan a name.', [
      { field: 'name', issue: 'Required' },
    ]);
  }
  if (input.days.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'A plan needs at least one day. A member assigned to an empty plan opens the app to nothing.',
      [{ field: 'days', issue: 'Add at least one day' }],
    );
  }
  if (input.days.length > 14) {
    throw new AppError('VALIDATION_FAILED', 'A plan covers at most a fortnight of days.', [
      { field: 'days', issue: 'At most 14' },
    ]);
  }

  for (const [index, day] of input.days.entries()) {
    if (!day.label?.trim()) {
      throw new AppError('VALIDATION_FAILED', `Day ${index + 1} needs a label.`, [
        { field: `days.${index}.label`, issue: 'Required' },
      ]);
    }
    if (!day.isRestDay && day.items.length === 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${day.label.trim()} has no exercises. Mark it a rest day, or add something to it.`,
        [{ field: `days.${index}.items`, issue: 'Empty and not a rest day' }],
      );
    }
    if (day.isRestDay && day.items.length > 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${day.label.trim()} is marked a rest day but has exercises in it.`,
        [{ field: `days.${index}.items`, issue: 'Rest day with exercises' }],
      );
    }
  }
}

/**
 * Every exercise named has to exist and be reachable by this gym.
 *
 * Without this, an id from another gym's library — or one simply mistyped —
 * becomes a foreign key error with no useful message, or worse, a plan item
 * pointing at something the gym cannot read, which renders as a blank row in
 * a member's app.
 */
async function assertExercisesExist(tx: any, input: WorkoutPlanInput): Promise<void> {
  const ids = [
    ...new Set(input.days.flatMap((day) => day.items.map((item) => item.exerciseId))),
  ];
  if (ids.length === 0) return;

  // The tenant client already narrows this to the gym's own rows plus the
  // shared library, so a count mismatch means an id this gym cannot use.
  const found = await tx.exercise.count({ where: { id: { in: ids }, isActive: true } });
  if (found !== ids.length) {
    throw new AppError(
      'VALIDATION_FAILED',
      'One of those exercises is not in your library.',
      [{ field: 'days', issue: 'Unknown exercise' }],
    );
  }
}

async function writeDays(
  tx: any,
  organizationId: string,
  planId: string,
  days: WorkoutPlanInput['days'],
): Promise<void> {
  for (const [dayIndex, day] of days.entries()) {
    const created = await tx.workoutPlanDay.create({
      data: {
        organizationId,
        workoutPlanId: planId,
        dayIndex,
        label: day.label.trim(),
        focus: day.focus?.trim() || null,
        isRestDay: day.isRestDay ?? false,
        notes: day.notes?.trim() || null,
      },
      select: { id: true },
    });

    if (day.items.length === 0) continue;

    await tx.workoutPlanItem.createMany({
      data: day.items.map((item, order) => ({
        organizationId,
        workoutPlanDayId: created.id,
        exerciseId: item.exerciseId,
        displayOrder: order,
        sets: item.sets ?? null,
        reps: item.reps?.trim() || null,
        weightKg: item.weightKg ? item.weightKg : null,
        restSeconds: item.restSeconds ?? null,
        tempo: item.tempo?.trim() || null,
        trainerNotes: item.trainerNotes?.trim() || null,
      })),
    });
  }
}

// --------------------------------------------- what the member actually sees ---

export interface MemberWorkout {
  assignmentId: string;
  planName: string;
  planGoal: string | null;
  startDate: string;
  endDate: string | null;
  /** Which day of the plan to do next, by what they have logged. */
  suggestedDayId: string | null;
  days: Array<{
    id: string;
    label: string;
    focus: string | null;
    isRestDay: boolean;
    notes: string | null;
    /** The last day they logged anything from this day of the plan. */
    lastDoneOn: string | null;
    items: Array<{
      id: string;
      exerciseName: string;
      muscleGroup: string;
      instructions: string | null;
      cautions: string | null;
      sets: number | null;
      reps: string | null;
      weightKg: string | null;
      restSeconds: number | null;
      tempo: string | null;
      trainerNotes: string | null;
      /** What they lifted last time, which is what they want to beat. */
      lastLogged: { weightKg: string | null; repsCompleted: string | null; on: string } | null;
    }>;
  }>;
}

/**
 * A member's own plan.
 *
 * Carries what they lifted last time on every exercise, because that is the
 * number somebody standing at a rack actually wants — a plan that says "3 x
 * 8" and nothing else leaves them guessing at the weight they used on
 * Tuesday.
 */
export async function myWorkout(
  ctx: { organizationId: string; userId: string; memberId?: string | null },
  permissions: ResolvedPermissions,
): Promise<MemberWorkout | null> {
  requirePermission(permissions, 'self.workout.read');
  const memberId = requireMemberId(ctx);

  return withTenant(ctx, async (tx) => {
    const assignment = await tx.memberWorkoutAssignment.findFirst({
      where: { memberId, status: 'ACTIVE' },
      orderBy: { startDate: 'desc' },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        workoutPlan: {
          select: {
            name: true,
            goal: true,
            days: {
              orderBy: { dayIndex: 'asc' },
              select: {
                id: true,
                label: true,
                focus: true,
                isRestDay: true,
                notes: true,
                items: {
                  orderBy: { displayOrder: 'asc' },
                  select: {
                    id: true,
                    sets: true,
                    reps: true,
                    weightKg: true,
                    restSeconds: true,
                    tempo: true,
                    trainerNotes: true,
                    exercise: {
                      select: {
                        name: true,
                        muscleGroup: true,
                        instructions: true,
                        cautions: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    // Not an error: most members are not on a plan, and the screen says so.
    if (!assignment) return null;

    // Their last log per plan item, in one query rather than one per
    // exercise — a 30-exercise plan would otherwise be 30 round trips on a
    // phone connection.
    const itemIds = assignment.workoutPlan.days.flatMap((day) =>
      day.items.map((item) => item.id),
    );

    const lastByItem = new Map<
      string,
      { weightKg: string | null; repsCompleted: string | null; on: string }
    >();
    const lastDoneByDay = new Map<string, string>();

    if (itemIds.length > 0) {
      const logs = await tx.workoutLog.findMany({
        where: { memberId, planItemId: { in: itemIds } },
        orderBy: { performedOn: 'desc' },
        take: 500,
        select: {
          planItemId: true,
          weightKg: true,
          repsCompleted: true,
          performedOn: true,
        },
      });

      for (const log of logs) {
        if (!log.planItemId || lastByItem.has(log.planItemId)) continue;
        lastByItem.set(log.planItemId, {
          weightKg: log.weightKg ? log.weightKg.toString() : null,
          repsCompleted: log.repsCompleted,
          on: log.performedOn.toISOString().slice(0, 10),
        });
      }

      for (const day of assignment.workoutPlan.days) {
        const dates = day.items
          .map((item) => lastByItem.get(item.id)?.on)
          .filter(Boolean) as string[];
        if (dates.length > 0) lastDoneByDay.set(day.id, dates.sort().at(-1)!);
      }
    }

    const days = assignment.workoutPlan.days.map((day) => ({
      id: day.id,
      label: day.label,
      focus: day.focus,
      isRestDay: day.isRestDay,
      notes: day.notes,
      lastDoneOn: lastDoneByDay.get(day.id) ?? null,
      items: day.items.map((item) => ({
        id: item.id,
        exerciseName: item.exercise.name,
        muscleGroup: item.exercise.muscleGroup,
        instructions: item.exercise.instructions,
        cautions: item.exercise.cautions,
        sets: item.sets,
        reps: item.reps,
        weightKg: item.weightKg ? item.weightKg.toString() : null,
        restSeconds: item.restSeconds,
        tempo: item.tempo,
        trainerNotes: item.trainerNotes,
        lastLogged: lastByItem.get(item.id) ?? null,
      })),
    }));

    return {
      assignmentId: assignment.id,
      planName: assignment.workoutPlan.name,
      planGoal: assignment.workoutPlan.goal,
      startDate: assignment.startDate.toISOString().slice(0, 10),
      endDate: assignment.endDate ? assignment.endDate.toISOString().slice(0, 10) : null,
      // The day they have done least recently, skipping rest days. Crude on
      // purpose: a plan is a rotation, not a calendar, and a member who did
      // legs yesterday wants to be pointed at push today.
      suggestedDayId: suggestDay(days),
      days,
    };
  });
}

function suggestDay(days: MemberWorkout['days']): string | null {
  const workDays = days.filter((day) => !day.isRestDay);
  if (workDays.length === 0) return null;

  const never = workDays.find((day) => day.lastDoneOn === null);
  if (never) return never.id;

  return workDays.reduce((oldest, day) =>
    (day.lastDoneOn ?? '') < (oldest.lastDoneOn ?? '') ? day : oldest,
  ).id;
}

export interface LogWorkoutInput {
  /** The plan day being logged, so every exercise in it lands together. */
  dayId: string;
  performedOn?: string;
  entries: Array<{
    planItemId: string;
    setsCompleted?: number;
    repsCompleted?: string;
    weightKg?: string;
    durationSeconds?: number;
    /** 1-10, the member's own sense of how hard it was. */
    perceivedEffort?: number;
    completed?: boolean;
    memberNotes?: string;
  }>;
}

/**
 * A member logging a session.
 *
 * The whole day at once, because that is how somebody uses it: they finish,
 * they fill the sheet in, they put the phone away. Logging exercise by
 * exercise would mean a dozen requests from a gym floor with bad signal and
 * a half-recorded session when one of them fails.
 *
 * Re-logging the same day replaces that day's entries rather than adding to
 * them, so a member correcting a typo does not end up with two sessions.
 */
export async function logWorkout(
  ctx: { organizationId: string; userId: string; memberId?: string | null },
  permissions: ResolvedPermissions,
  input: LogWorkoutInput,
): Promise<{ logged: number; performedOn: string }> {
  requirePermission(permissions, 'self.workout.log');
  const memberId = requireMemberId(ctx);

  if (input.entries.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Nothing to log.', [
      { field: 'entries', issue: 'Empty' },
    ]);
  }

  const performedOn = input.performedOn ? new Date(input.performedOn) : today();
  if (performedOn.getTime() > Date.now() + 86_400_000) {
    throw new AppError('VALIDATION_FAILED', 'That date is in the future.', [
      { field: 'performedOn', issue: 'Future date' },
    ]);
  }

  return withTenant(ctx, async (tx) => {
    // The assignment is read from the member, never from the request: there
    // is no input through which to log against somebody else's plan.
    const assignment = await tx.memberWorkoutAssignment.findFirst({
      where: { memberId, status: 'ACTIVE' },
      select: { id: true, workoutPlanId: true },
    });
    if (!assignment) {
      throw new AppError('CONFLICT', 'You are not on a workout plan at the moment.');
    }

    const day = await tx.workoutPlanDay.findFirst({
      where: { id: input.dayId, workoutPlanId: assignment.workoutPlanId },
      select: { id: true, label: true, items: { select: { id: true, exerciseId: true } } },
    });
    if (!day) {
      throw new AppError('NOT_FOUND', 'That day is not part of your plan.');
    }

    const itemsById = new Map(day.items.map((item) => [item.id, item.exerciseId]));
    for (const entry of input.entries) {
      if (!itemsById.has(entry.planItemId)) {
        throw new AppError('VALIDATION_FAILED', 'One of those exercises is not in that day.');
      }
      if (entry.perceivedEffort !== undefined && (entry.perceivedEffort < 1 || entry.perceivedEffort > 10)) {
        throw new AppError('VALIDATION_FAILED', 'Effort is a number from 1 to 10.', [
          { field: 'perceivedEffort', issue: 'Out of range' },
        ]);
      }
    }

    // Replace rather than append, so correcting a mistake does not double
    // the session.
    await tx.workoutLog.deleteMany({
      where: {
        memberId,
        performedOn,
        planItemId: { in: [...itemsById.keys()] },
      },
    });

    await tx.workoutLog.createMany({
      data: input.entries.map((entry) => ({
        organizationId: ctx.organizationId,
        memberId,
        assignmentId: assignment.id,
        planItemId: entry.planItemId,
        exerciseId: itemsById.get(entry.planItemId)!,
        performedOn,
        setsCompleted: entry.setsCompleted ?? null,
        repsCompleted: entry.repsCompleted?.trim() || null,
        weightKg: entry.weightKg ? entry.weightKg : null,
        durationSeconds: entry.durationSeconds ?? null,
        perceivedEffort: entry.perceivedEffort ?? null,
        completed: entry.completed ?? true,
        memberNotes: entry.memberNotes?.trim() || null,
      })),
    });

    return {
      logged: input.entries.length,
      performedOn: performedOn.toISOString().slice(0, 10),
    };
  });
}

export interface MemberProgress {
  sessionsLogged: number;
  sessionsThisMonth: number;
  firstLoggedOn: string | null;
  lastLoggedOn: string | null;
  /** Heaviest set per exercise, which is the number people care about. */
  bests: Array<{ exerciseName: string; weightKg: string; reps: string | null; on: string }>;
}

/**
 * What a member has actually done.
 *
 * Also what a trainer opens before a session, so it takes an explicit member
 * id for staff and falls back to the session's own member for the portal —
 * with the permission checked accordingly rather than one function trusting
 * whoever calls it.
 */
export async function workoutProgress(
  ctx: { organizationId: string; userId: string; memberId?: string | null },
  permissions: ResolvedPermissions,
  options: { memberId?: string } = {},
): Promise<MemberProgress> {
  const asStaff = options.memberId !== undefined && options.memberId !== ctx.memberId;
  if (asStaff) requirePermission(permissions, 'fitness.workout.read');
  else requirePermission(permissions, 'self.workout.read');

  const memberId = asStaff ? options.memberId! : requireMemberId(ctx);

  return withTenant(ctx, async (tx) => {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const logs = await tx.workoutLog.findMany({
      where: { memberId },
      orderBy: { performedOn: 'asc' },
      take: 5_000,
      select: {
        performedOn: true,
        weightKg: true,
        repsCompleted: true,
        exercise: { select: { name: true } },
      },
    });

    // A session is a day, not a row: twelve exercises on Tuesday is one
    // session, and counting rows would tell a member they trained 12 times.
    const days = new Set(logs.map((log) => log.performedOn.toISOString().slice(0, 10)));
    const thisMonth = new Set(
      logs
        .filter((log) => log.performedOn >= monthStart)
        .map((log) => log.performedOn.toISOString().slice(0, 10)),
    );

    const best = new Map<string, { weightKg: number; reps: string | null; on: string }>();
    for (const log of logs) {
      if (!log.weightKg || !log.exercise) continue;
      const weight = Number(log.weightKg.toString());
      const current = best.get(log.exercise.name);
      if (!current || weight > current.weightKg) {
        best.set(log.exercise.name, {
          weightKg: weight,
          reps: log.repsCompleted,
          on: log.performedOn.toISOString().slice(0, 10),
        });
      }
    }

    const sorted = [...days].sort();

    return {
      sessionsLogged: days.size,
      sessionsThisMonth: thisMonth.size,
      firstLoggedOn: sorted[0] ?? null,
      lastLoggedOn: sorted.at(-1) ?? null,
      bests: [...best.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([exerciseName, entry]) => ({
          exerciseName,
          weightKg: entry.weightKg.toFixed(2),
          reps: entry.reps,
          on: entry.on,
        })),
    };
  });
}

function requireMemberId(ctx: { memberId?: string | null }): string {
  if (!ctx.memberId) {
    throw new AppError('FORBIDDEN', 'This is only available to a member of the gym.');
  }
  return ctx.memberId;
}
