/**
 * Workout plans: what a trainer actually does.
 *
 * Six tables for this had been in the schema since the first migration, five
 * permission keys were seeded and granted, and the sidebar carried an entry
 * marked unbuilt. Nothing existed. The data export even excluded workout
 * plans on the grounds that they "stay readable and editable in the
 * product" — a sentence written about software that did not exist, by me,
 * two days ago.
 *
 * The two rules worth testing hardest are the ones a gym would notice: a
 * member is on exactly one plan, and a member's logs survive the plan being
 * rewritten underneath them.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authPrisma } from '@gym/db';
import {
  registerGym,
  createSession,
  resolveSession,
  createMember,
  listExercises,
  createExercise,
  createWorkoutPlan,
  listWorkoutPlans,
  getWorkoutPlan,
  updateWorkoutPlan,
  retireWorkoutPlan,
  assignWorkoutPlan,
  listWorkoutAssignments,
  endWorkoutAssignment,
  myWorkout,
  logWorkout,
  workoutProgress,
  AppError,
} from '@gym/core';
import { nextTestAddress } from '../support/addresses';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

interface Gym {
  organizationId: string;
  userId: string;
  ctx: { organizationId: string; userId: string };
  permissions: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
  memberId: string;
  /** The same context plus the member, as the portal builds it. */
  asMember: { organizationId: string; userId: string; memberId: string };
}

async function freshGym(name: string): Promise<Gym> {
  const email = `fitness.${unique()}@example.com`;
  createdEmails.push(email);

  const created = await registerGym({
    gymName: `${name} ${unique()}`,
    ownerName: 'Fitness Owner',
    email,
    phone: '9876770000',
    password: 'correct horse battery staple 47',
    planKey: 'GROWTH' as never,
    acceptedTerms: true,
    ipAddress: nextTestAddress(),
  });
  createdOrgIds.push(created.organizationId);

  const session = await createSession(authPrisma, {
    userId: created.userId,
    organizationId: created.organizationId,
    type: 'WEB',
  });
  const permissions = (await resolveSession(authPrisma, session.token)).actor.permissions;
  const ctx = { organizationId: created.organizationId, userId: created.userId };

  const member = await createMember(ctx, permissions, {
    firstName: 'Workout',
    lastName: 'Member',
    phone: `97${String(Date.now()).slice(-8)}`,
  });

  return {
    organizationId: created.organizationId,
    userId: created.userId,
    ctx,
    // The owner holds every gym-side key; the self.* ones belong to a member
    // session, so they are added here to exercise the portal functions.
    permissions: {
      ...permissions,
      grants: {
        ...permissions.grants,
        'self.workout.read': 'SELF',
        'self.workout.log': 'SELF',
      },
    } as typeof permissions,
    memberId: member.id,
    asMember: { ...ctx, memberId: member.id },
  };
}

/** Two exercises from the shared library, which every gym can read. */
async function someExercises(gym: Gym): Promise<string[]> {
  const library = await listExercises(gym.ctx, gym.permissions, { limit: 10 });
  expect(library.length).toBeGreaterThanOrEqual(2);
  return [library[0]!.id, library[1]!.id];
}

function simplePlan(exerciseIds: string[], name = `Plan ${unique()}`) {
  return {
    name,
    goal: 'Build strength',
    durationWeeks: 4,
    days: [
      {
        label: 'Push',
        focus: 'Chest and shoulders',
        items: [
          { exerciseId: exerciseIds[0]!, sets: 3, reps: '8-10', restSeconds: 90 },
          { exerciseId: exerciseIds[1]!, sets: 3, reps: '12' },
        ],
      },
      { label: 'Rest', isRestDay: true, items: [] },
      {
        label: 'Pull',
        focus: 'Back and biceps',
        items: [{ exerciseId: exerciseIds[1]!, sets: 4, reps: '6' }],
      },
    ],
  };
}

beforeAll(async () => {
  // The shared exercise library has to be seeded for any of this to work.
  const shared = await db.exercise.count({ where: { organizationId: null } });
  expect(shared, 'the shared exercise library is seeded').toBeGreaterThan(1);
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================

describe('the exercise library', () => {
  it('shows the platform library and the gym’s own together', async () => {
    const gym = await freshGym('Library');

    await createExercise(gym.ctx, gym.permissions, {
      name: `Sandbag carry ${unique()}`,
      muscleGroup: 'Full body',
      equipment: 'Sandbag',
    });

    const rows = await listExercises(gym.ctx, gym.permissions, {});

    expect(rows.some((row) => !row.isOwn)).toBe(true);
    expect(rows.some((row) => row.isOwn)).toBe(true);
  });

  it('keeps one gym’s own exercises out of another’s library', async () => {
    const mine = await freshGym('Mine');
    const theirs = await freshGym('Theirs');

    const name = `Secret lift ${unique()}`;
    await createExercise(theirs.ctx, theirs.permissions, { name, muscleGroup: 'Back' });

    const rows = await listExercises(mine.ctx, mine.permissions, {});
    expect(rows.map((row) => row.name)).not.toContain(name);
  });
});

// =========================================================================

describe('building a plan', () => {
  it('writes the days and exercises in one go', async () => {
    const gym = await freshGym('Building');
    const exercises = await someExercises(gym);

    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));
    const plan = await getWorkoutPlan(gym.ctx, gym.permissions, id);

    expect(plan.days).toHaveLength(3);
    expect(plan.days[0]!.label).toBe('Push');
    expect(plan.days[0]!.items).toHaveLength(2);
    expect(plan.days[0]!.items[0]!.sets).toBe(3);
    expect(plan.days[0]!.items[0]!.reps).toBe('8-10');
    expect(plan.days[1]!.isRestDay).toBe(true);
    // Days per week counted from the days written, not from a field a
    // trainer has to keep in step by hand.
    expect(plan.daysPerWeek).toBe(2);
  });

  it('refuses a plan with no days, which would open to an empty week', async () => {
    const gym = await freshGym('Empty Plan');

    await expect(
      createWorkoutPlan(gym.ctx, gym.permissions, { name: 'Nothing', days: [] }),
    ).rejects.toThrow(AppError);
  });

  it('refuses a day with no exercises that is not marked a rest day', async () => {
    const gym = await freshGym('Empty Day');
    const exercises = await someExercises(gym);

    const error = await createWorkoutPlan(gym.ctx, gym.permissions, {
      name: 'Half written',
      days: [
        { label: 'Push', items: [{ exerciseId: exercises[0]! }] },
        { label: 'Legs', items: [] },
      ],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    // Names the day, because "a day is empty" on a 6-day plan is a hunt.
    expect((error as AppError).message).toContain('Legs');
  });

  it('refuses a rest day with exercises in it', async () => {
    const gym = await freshGym('Contradictory');
    const exercises = await someExercises(gym);

    await expect(
      createWorkoutPlan(gym.ctx, gym.permissions, {
        name: 'Contradiction',
        days: [{ label: 'Rest', isRestDay: true, items: [{ exerciseId: exercises[0]! }] }],
      }),
    ).rejects.toThrow(AppError);
  });

  it('refuses an exercise from another gym’s library', async () => {
    const mine = await freshGym('Borrower');
    const theirs = await freshGym('Lender');

    const stolen = await createExercise(theirs.ctx, theirs.permissions, {
      name: `Theirs only ${unique()}`,
      muscleGroup: 'Legs',
    });

    const error = await createWorkoutPlan(mine.ctx, mine.permissions, {
      name: 'Borrowed',
      days: [{ label: 'Day 1', items: [{ exerciseId: stolen.id }] }],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toContain('not in your library');
  });

  it('counts how many members are on each plan, not how many ever were', async () => {
    const gym = await freshGym('Counting');
    const exercises = await someExercises(gym);
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));

    await assignWorkoutPlan(gym.ctx, gym.permissions, {
      memberId: gym.memberId,
      planId: id,
    });

    let plans = await listWorkoutPlans(gym.ctx, gym.permissions, {});
    expect(plans.find((plan) => plan.id === id)!.activeMembers).toBe(1);

    const assignments = await listWorkoutAssignments(gym.ctx, gym.permissions, { planId: id });
    await endWorkoutAssignment(gym.ctx, gym.permissions, assignments[0]!.id, {
      status: 'COMPLETED',
    });

    plans = await listWorkoutPlans(gym.ctx, gym.permissions, {});
    expect(plans.find((plan) => plan.id === id)!.activeMembers).toBe(0);
  });
});

// =========================================================================

describe('rewriting a plan', () => {
  it('replaces the week and says how many members it affected', async () => {
    const gym = await freshGym('Rewriting');
    const exercises = await someExercises(gym);
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));

    await assignWorkoutPlan(gym.ctx, gym.permissions, { memberId: gym.memberId, planId: id });

    await updateWorkoutPlan(gym.ctx, gym.permissions, id, {
      name: 'Rewritten',
      days: [{ label: 'Full body', items: [{ exerciseId: exercises[0]!, sets: 5, reps: '5' }] }],
    });

    const plan = await getWorkoutPlan(gym.ctx, gym.permissions, id);
    expect(plan.name).toBe('Rewritten');
    expect(plan.days).toHaveLength(1);
    expect(plan.days[0]!.items[0]!.sets).toBe(5);

    const audit = await db.auditLog.findFirst({
      where: { organizationId: gym.organizationId, action: 'fitness.workout.updated' },
    });
    // Editing a plan changes what everybody on it does next session.
    expect(audit!.summary).toContain('1 member is on it');
  });

  /**
   * The one that would lose a member's training history if it were wrong.
   * Days and items are replaced wholesale on an edit, and logs reference
   * them — so a careless cascade would delete a year of somebody's lifts
   * because their trainer reordered a week.
   */
  it('keeps a member’s logs when the plan underneath them is rewritten', async () => {
    const gym = await freshGym('History');
    const exercises = await someExercises(gym);
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));
    await assignWorkoutPlan(gym.ctx, gym.permissions, { memberId: gym.memberId, planId: id });

    const workout = await myWorkout(gym.asMember, gym.permissions);
    const pushDay = workout!.days.find((day) => day.label === 'Push')!;

    await logWorkout(gym.asMember, gym.permissions, {
      dayId: pushDay.id,
      entries: pushDay.items.map((item) => ({
        planItemId: item.id,
        setsCompleted: 3,
        repsCompleted: '10',
        weightKg: '40.00',
      })),
    });

    const before = await workoutProgress(gym.asMember, gym.permissions);
    expect(before.sessionsLogged).toBe(1);
    expect(before.bests.length).toBeGreaterThan(0);

    await updateWorkoutPlan(gym.ctx, gym.permissions, id, {
      name: 'Rewritten again',
      days: [{ label: 'New day', items: [{ exerciseId: exercises[0]! }] }],
    });

    const after = await workoutProgress(gym.asMember, gym.permissions);
    expect(after.sessionsLogged).toBe(1);
    expect(after.bests.length).toBe(before.bests.length);
  });

  it('will not retire a plan members are still on', async () => {
    const gym = await freshGym('Retiring');
    const exercises = await someExercises(gym);
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));
    await assignWorkoutPlan(gym.ctx, gym.permissions, { memberId: gym.memberId, planId: id });

    const error = await retireWorkoutPlan(gym.ctx, gym.permissions, id).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toContain('1 member is still on this plan');
    expect((error as AppError).message).toContain('open the app to nothing');
  });
});

// =========================================================================

describe('putting a member on a plan', () => {
  it('ends the plan they were on, rather than leaving them on two', async () => {
    const gym = await freshGym('Switching');
    const exercises = await someExercises(gym);
    const first = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises, 'Beginner'));
    const second = await createWorkoutPlan(
      gym.ctx,
      gym.permissions,
      simplePlan(exercises, 'Intermediate'),
    );

    await assignWorkoutPlan(gym.ctx, gym.permissions, {
      memberId: gym.memberId,
      planId: first.id,
    });
    const moved = await assignWorkoutPlan(gym.ctx, gym.permissions, {
      memberId: gym.memberId,
      planId: second.id,
    });

    // The screen can say "moved from Beginner", which is what happened.
    expect(moved.replaced).toBe('Beginner');

    const active = await listWorkoutAssignments(gym.ctx, gym.permissions, {
      memberId: gym.memberId,
    });
    expect(active).toHaveLength(1);
    expect(active[0]!.planName).toBe('Intermediate');
  });

  it('refuses to assign a plan with nothing in it', async () => {
    const gym = await freshGym('Hollow');
    const exercises = await someExercises(gym);

    // Built with days, then emptied by an edit to one rest day.
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));
    await db.workoutPlanDay.deleteMany({ where: { workoutPlanId: id } });

    const error = await assignWorkoutPlan(gym.ctx, gym.permissions, {
      memberId: gym.memberId,
      planId: id,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toContain('empty week');
  });

  it('cannot put another gym’s member on a plan', async () => {
    const mine = await freshGym('Mine Again');
    const theirs = await freshGym('Theirs Again');
    const exercises = await someExercises(mine);
    const { id } = await createWorkoutPlan(mine.ctx, mine.permissions, simplePlan(exercises));

    await expect(
      assignWorkoutPlan(mine.ctx, mine.permissions, {
        memberId: theirs.memberId,
        planId: id,
      }),
    ).rejects.toThrow(AppError);
  });

  it('sets an end date from the plan’s own length', async () => {
    const gym = await freshGym('Dated');
    const exercises = await someExercises(gym);
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, {
      ...simplePlan(exercises),
      durationWeeks: 6,
    });

    await assignWorkoutPlan(gym.ctx, gym.permissions, {
      memberId: gym.memberId,
      planId: id,
      startDate: '2026-11-01',
    });

    const [assignment] = await listWorkoutAssignments(gym.ctx, gym.permissions, {
      memberId: gym.memberId,
    });
    expect(assignment!.startDate).toBe('2026-11-01');
    expect(assignment!.endDate).toBe('2026-12-13');
  });
});

// =========================================================================

describe('what the member sees and logs', () => {
  it('says nothing rather than erroring when they are on no plan', async () => {
    const gym = await freshGym('Unassigned');

    expect(await myWorkout(gym.asMember, gym.permissions)).toBeNull();
  });

  it('carries the trainer’s notes and the exercise’s cautions through', async () => {
    const gym = await freshGym('Careful');

    const exercise = await createExercise(gym.ctx, gym.permissions, {
      name: `Overhead press ${unique()}`,
      muscleGroup: 'Shoulders',
      instructions: 'Brace, press straight up.',
      cautions: 'Skip this if your shoulder is sore.',
    });

    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, {
      name: 'Careful plan',
      days: [
        {
          label: 'Shoulders',
          items: [
            { exerciseId: exercise.id, sets: 3, reps: '8', trainerNotes: 'Stop one short.' },
          ],
        },
      ],
    });
    await assignWorkoutPlan(gym.ctx, gym.permissions, { memberId: gym.memberId, planId: id });

    const workout = await myWorkout(gym.asMember, gym.permissions);
    const item = workout!.days[0]!.items[0]!;

    // A caution in the library and nowhere else is a caution nobody reads.
    expect(item.cautions).toContain('shoulder is sore');
    expect(item.instructions).toContain('Brace');
    expect(item.trainerNotes).toBe('Stop one short.');
  });

  it('shows what they lifted last time, which is the number they want', async () => {
    const gym = await freshGym('Last Time');
    const exercises = await someExercises(gym);
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));
    await assignWorkoutPlan(gym.ctx, gym.permissions, { memberId: gym.memberId, planId: id });

    const first = await myWorkout(gym.asMember, gym.permissions);
    const day = first!.days.find((d) => !d.isRestDay)!;
    expect(day.items[0]!.lastLogged).toBeNull();

    await logWorkout(gym.asMember, gym.permissions, {
      dayId: day.id,
      performedOn: '2026-11-18',
      entries: [{ planItemId: day.items[0]!.id, setsCompleted: 3, repsCompleted: '8', weightKg: '55.00' }],
    });

    const second = await myWorkout(gym.asMember, gym.permissions);
    const sameItem = second!.days
      .flatMap((d) => d.items)
      .find((item) => item.id === day.items[0]!.id)!;

    expect(sameItem.lastLogged).toEqual({
      weightKg: '55',
      repsCompleted: '8',
      on: '2026-11-18',
    });
  });

  it('points at the day they have done least recently', async () => {
    const gym = await freshGym('Rotation');
    const exercises = await someExercises(gym);
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));
    await assignWorkoutPlan(gym.ctx, gym.permissions, { memberId: gym.memberId, planId: id });

    const before = await myWorkout(gym.asMember, gym.permissions);
    const push = before!.days.find((day) => day.label === 'Push')!;
    const pull = before!.days.find((day) => day.label === 'Pull')!;

    // Nothing logged: the first work day.
    expect(before!.suggestedDayId).toBe(push.id);

    await logWorkout(gym.asMember, gym.permissions, {
      dayId: push.id,
      entries: [{ planItemId: push.items[0]!.id, setsCompleted: 3 }],
    });

    const after = await myWorkout(gym.asMember, gym.permissions);
    // Push is done, so pull is next — and the rest day is never suggested.
    expect(after!.suggestedDayId).toBe(pull.id);
  });

  it('replaces a day’s log rather than doubling it when they fix a typo', async () => {
    const gym = await freshGym('Correcting');
    const exercises = await someExercises(gym);
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));
    await assignWorkoutPlan(gym.ctx, gym.permissions, { memberId: gym.memberId, planId: id });

    const workout = await myWorkout(gym.asMember, gym.permissions);
    const day = workout!.days.find((d) => !d.isRestDay)!;

    await logWorkout(gym.asMember, gym.permissions, {
      dayId: day.id,
      performedOn: '2026-11-19',
      entries: [{ planItemId: day.items[0]!.id, weightKg: '40.00' }],
    });
    await logWorkout(gym.asMember, gym.permissions, {
      dayId: day.id,
      performedOn: '2026-11-19',
      entries: [{ planItemId: day.items[0]!.id, weightKg: '45.00' }],
    });

    const logs = await db.workoutLog.findMany({
      where: { memberId: gym.memberId, performedOn: new Date('2026-11-19') },
    });
    expect(logs).toHaveLength(1);
    expect(Number(logs[0]!.weightKg)).toBe(45);

    // And one session, not two.
    const progress = await workoutProgress(gym.asMember, gym.permissions);
    expect(progress.sessionsLogged).toBe(1);
  });

  it('counts a session as a day, not as a row per exercise', async () => {
    const gym = await freshGym('Sessions');
    const exercises = await someExercises(gym);
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));
    await assignWorkoutPlan(gym.ctx, gym.permissions, { memberId: gym.memberId, planId: id });

    const workout = await myWorkout(gym.asMember, gym.permissions);
    const day = workout!.days.find((d) => d.items.length > 1)!;

    await logWorkout(gym.asMember, gym.permissions, {
      dayId: day.id,
      performedOn: '2026-11-20',
      entries: day.items.map((item) => ({ planItemId: item.id, setsCompleted: 3 })),
    });

    const progress = await workoutProgress(gym.asMember, gym.permissions);
    // Two exercises on one day is one session. Counting rows would tell a
    // member they trained twice.
    expect(progress.sessionsLogged).toBe(1);
  });

  /**
   * The trainer's screen and the member's screen have to agree.
   *
   * `listWorkoutAssignments` counted log rows, so a member who logged one
   * six-exercise day appeared to the trainer as six sessions while their own
   * app said one. A browser run caught it; nothing in the unit suite did,
   * because every unit test until this one logged a single exercise.
   */
  it('counts a session the same way for the trainer as for the member', async () => {
    const gym = await freshGym('Agreement');
    const exercises = await someExercises(gym);
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));
    await assignWorkoutPlan(gym.ctx, gym.permissions, { memberId: gym.memberId, planId: id });

    const workout = await myWorkout(gym.asMember, gym.permissions);
    const day = workout!.days.find((d) => d.items.length > 1)!;
    expect(day.items.length).toBeGreaterThan(1);

    await logWorkout(gym.asMember, gym.permissions, {
      dayId: day.id,
      performedOn: '2026-11-21',
      entries: day.items.map((item) => ({ planItemId: item.id, setsCompleted: 3 })),
    });

    const [assignment] = await listWorkoutAssignments(gym.ctx, gym.permissions, {
      memberId: gym.memberId,
    });
    const progress = await workoutProgress(gym.asMember, gym.permissions);

    expect(assignment!.sessionsLogged).toBe(1);
    expect(assignment!.sessionsLogged).toBe(progress.sessionsLogged);
    expect(assignment!.lastLoggedOn).toBe('2026-11-21');
  });

  it('refuses a log against a day that is not in their plan', async () => {
    const gym = await freshGym('Wrong Day');
    const other = await freshGym('Other Plan');
    const exercises = await someExercises(gym);
    const mine = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));
    const theirs = await createWorkoutPlan(
      other.ctx,
      other.permissions,
      simplePlan(await someExercises(other)),
    );

    await assignWorkoutPlan(gym.ctx, gym.permissions, {
      memberId: gym.memberId,
      planId: mine.id,
    });

    const theirDay = await db.workoutPlanDay.findFirstOrThrow({
      where: { workoutPlanId: theirs.id },
      select: { id: true },
    });

    await expect(
      logWorkout(gym.asMember, gym.permissions, {
        dayId: theirDay.id,
        entries: [{ planItemId: theirDay.id, setsCompleted: 1 }],
      }),
    ).rejects.toThrow(AppError);
  });

  it('refuses a log from somebody on no plan at all', async () => {
    const gym = await freshGym('No Plan Log');

    await expect(
      logWorkout(gym.asMember, gym.permissions, {
        dayId: '00000000-0000-7000-8000-000000000000',
        entries: [{ planItemId: '00000000-0000-7000-8000-000000000001' }],
      }),
    ).rejects.toThrow(AppError);
  });

  it('refuses an effort score outside one to ten', async () => {
    const gym = await freshGym('Effort');
    const exercises = await someExercises(gym);
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));
    await assignWorkoutPlan(gym.ctx, gym.permissions, { memberId: gym.memberId, planId: id });

    const workout = await myWorkout(gym.asMember, gym.permissions);
    const day = workout!.days.find((d) => !d.isRestDay)!;

    await expect(
      logWorkout(gym.asMember, gym.permissions, {
        dayId: day.id,
        entries: [{ planItemId: day.items[0]!.id, perceivedEffort: 47 }],
      }),
    ).rejects.toThrow(AppError);
  });

  it('refuses a session logged in the future', async () => {
    const gym = await freshGym('Future');
    const exercises = await someExercises(gym);
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));
    await assignWorkoutPlan(gym.ctx, gym.permissions, { memberId: gym.memberId, planId: id });

    const workout = await myWorkout(gym.asMember, gym.permissions);
    const day = workout!.days.find((d) => !d.isRestDay)!;

    await expect(
      logWorkout(gym.asMember, gym.permissions, {
        dayId: day.id,
        performedOn: '2030-01-01',
        entries: [{ planItemId: day.items[0]!.id }],
      }),
    ).rejects.toThrow(AppError);
  });

  it('keeps a personal best per exercise', async () => {
    const gym = await freshGym('Bests');
    const exercises = await someExercises(gym);
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));
    await assignWorkoutPlan(gym.ctx, gym.permissions, { memberId: gym.memberId, planId: id });

    const workout = await myWorkout(gym.asMember, gym.permissions);
    const day = workout!.days.find((d) => !d.isRestDay)!;
    const item = day.items[0]!;

    for (const [date, weight] of [
      ['2026-11-10', '40.00'],
      ['2026-11-12', '60.00'],
      ['2026-11-14', '50.00'],
    ] as const) {
      await logWorkout(gym.asMember, gym.permissions, {
        dayId: day.id,
        performedOn: date,
        entries: [{ planItemId: item.id, weightKg: weight, repsCompleted: '5' }],
      });
    }

    const progress = await workoutProgress(gym.asMember, gym.permissions);
    const best = progress.bests.find((row) => row.exerciseName === item.exerciseName)!;

    // The heaviest, not the latest.
    expect(Number(best.weightKg)).toBe(60);
    expect(best.on).toBe('2026-11-12');
    expect(progress.sessionsLogged).toBe(3);
  });

  it('shows a member nothing of another member’s training', async () => {
    const gym = await freshGym('Private');
    const exercises = await someExercises(gym);
    const { id } = await createWorkoutPlan(gym.ctx, gym.permissions, simplePlan(exercises));

    const other = await createMember(gym.ctx, gym.permissions, {
      firstName: 'Somebody',
      lastName: 'Else',
      phone: `96${String(Date.now()).slice(-8)}`,
    });
    await assignWorkoutPlan(gym.ctx, gym.permissions, { memberId: other.id, planId: id });
    await assignWorkoutPlan(gym.ctx, gym.permissions, { memberId: gym.memberId, planId: id });

    const otherCtx = { ...gym.ctx, memberId: other.id };
    const otherWorkout = await myWorkout(otherCtx, gym.permissions);
    await logWorkout(otherCtx, gym.permissions, {
      dayId: otherWorkout!.days[0]!.id,
      entries: [{ planItemId: otherWorkout!.days[0]!.items[0]!.id, weightKg: '99.00' }],
    });

    // Same plan, so the same items — but their own progress only.
    const progress = await workoutProgress(gym.asMember, gym.permissions);
    expect(progress.sessionsLogged).toBe(0);

    const mine = await myWorkout(gym.asMember, gym.permissions);
    expect(mine!.days[0]!.items[0]!.lastLogged).toBeNull();
  });
});
