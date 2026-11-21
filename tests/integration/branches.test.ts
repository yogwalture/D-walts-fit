/**
 * Branches, the plan limit on them, and moving a membership between them.
 *
 * How many branches a gym may have is what a plan is sold on — Growth is
 * literally "two branches" — so the limit is enforced in the service, not
 * in the interface, and the refusal names the plan rather than being a bare
 * "not allowed".
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authPrisma } from '@gym/db';
import {
  registerGym,
  createSession,
  resolveSession,
  createMember,
  createPlan,
  sellMembership,
  listBranches,
  createBranch,
  updateBranch,
  transferSubscription,
  listSubscriptions,
  AppError,
} from '@gym/core';
import { nextTestAddress } from '../support/addresses';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);

let gym: Awaited<ReturnType<typeof registerGym>>;
let ctx: { organizationId: string; userId: string };
let owner: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

async function gymOn(planKey: string) {
  const email = `branch.${unique()}@example.com`;
  createdEmails.push(email);

  const created = await registerGym({
    gymName: `Branch Gym ${unique()}`,
    ownerName: 'Branch Owner',
    email,
    phone: '9876670000',
    password: 'correct horse battery staple 47',
    planKey: planKey as never,
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

  return {
    gym: created,
    ctx: { organizationId: created.organizationId, userId: created.userId },
    owner: permissions,
  };
}

beforeAll(async () => {
  const built = await gymOn('PROFESSIONAL');
  gym = built.gym;
  ctx = built.ctx;
  owner = built.owner;
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

describe('branches', () => {
  it('starts with the one made at registration, marked as the main', async () => {
    const branches = await listBranches(ctx, owner);
    expect(branches).toHaveLength(1);
    expect(branches[0]!.isPrimary).toBe(true);
  });

  it('adds another, which never takes over as the main one', async () => {
    const added = await createBranch(ctx, owner, {
      name: 'Garkheda',
      code: 'gkd',
      city: 'Chhatrapati Sambhajinagar',
    });

    const branches = await listBranches(ctx, owner);
    expect(branches).toHaveLength(2);

    const second = branches.find((b) => b.id === added.id)!;
    // The primary is the fallback everywhere — imports, new members, classes
    // with no branch — so it is never silently reassigned.
    expect(second.isPrimary).toBe(false);
    expect(second.code).toBe('GKD');
  });

  it('refuses two branches sharing a code, however it is typed', async () => {
    await expect(createBranch(ctx, owner, { name: 'Another', code: 'GKD' })).rejects.toThrow(
      /already uses the code/i,
    );
  });

  it('stops at the plan’s limit, and says which plan', async () => {
    const starter = await gymOn('STARTER');

    // Starter covers one branch, which registration already used.
    const error = await createBranch(starter.ctx, starter.owner, { name: 'Second' }).catch(
      (e: AppError) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PLAN_LIMIT_REACHED');
    expect((error as AppError).message).toMatch(/Starter plan covers 1 branch/i);

    // And the limit is a count of live branches, not of rows ever created.
    expect(await listBranches(starter.ctx, starter.owner)).toHaveLength(1);
  });

  it('will not close the main branch', async () => {
    const branches = await listBranches(ctx, owner);
    const main = branches.find((b) => b.isPrimary)!;

    await expect(
      updateBranch(ctx, owner, main.id, { isActive: false }),
    ).rejects.toThrow(/main branch cannot be closed/i);
  });

  it('will not close a branch people still train at', async () => {
    const branches = await listBranches(ctx, owner);
    const second = branches.find((b) => b.code === 'GKD')!;

    const member = await createMember(ctx, owner, {
      firstName: 'Stays',
      lastName: 'Here',
      phone: '9830500001',
      branchId: second.id,
    });
    expect(member.id).toBeTruthy();

    await expect(
      updateBranch(ctx, owner, second.id, { isActive: false }),
    ).rejects.toThrow(/trains? at this branch/i);
  });
});

describe('moving a membership between branches', () => {
  it('moves the membership and the member, and leaves the money alone', async () => {
    const branches = await listBranches(ctx, owner);
    const main = branches.find((b) => b.isPrimary)!;
    const second = branches.find((b) => !b.isPrimary)!;

    const plan = await createPlan(ctx, owner, {
      name: `Transferable ${unique()}`,
      durationUnit: 'MONTH',
      durationValue: 1,
      price: '1500.00',
      transferAllowed: true,
    });

    const member = await createMember(ctx, owner, {
      firstName: 'Moves',
      lastName: 'Branch',
      phone: '9830500002',
      branchId: main.id,
    });
    const sale = await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: plan.id,
      payment: { amount: '1500.00', method: 'CASH' },
    });

    await transferSubscription(ctx, owner, {
      subscriptionId: sale.subscriptionId,
      toBranchId: second.id,
      reason: 'Moved house',
    });

    const { rows } = await listSubscriptions(ctx, owner, { page: 1, pageSize: 50 });
    const moved = rows.find((r) => r.id === sale.subscriptionId)!;
    expect(moved.branchId).toBe(second.id);
    expect(moved.branchName).toBe('Garkheda');
    // Nothing about the money or the dates changes: only where they train.
    expect(moved.paidAmount).toBe('1500.00');

    const row = await db.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(row.branchId).toBe(second.id);

    const event = await db.subscriptionEvent.findFirstOrThrow({
      where: { subscriptionId: sale.subscriptionId, eventType: 'TRANSFERRED' },
    });
    expect(event.fromBranchId).toBe(main.id);
    expect(event.toBranchId).toBe(second.id);
    expect(event.reason).toBe('Moved house');
  });

  it('refuses a plan that does not allow it', async () => {
    const branches = await listBranches(ctx, owner);
    const second = branches.find((b) => !b.isPrimary)!;

    const plan = await createPlan(ctx, owner, {
      name: `Fixed ${unique()}`,
      durationUnit: 'MONTH',
      durationValue: 1,
      price: '1500.00',
      transferAllowed: false,
    });
    const member = await createMember(ctx, owner, {
      firstName: 'Stuck',
      lastName: 'Here',
      phone: '9830500003',
    });
    const sale = await sellMembership(ctx, owner, { memberId: member.id, planId: plan.id });

    await expect(
      transferSubscription(ctx, owner, {
        subscriptionId: sale.subscriptionId,
        toBranchId: second.id,
        reason: 'Moved house',
      }),
    ).rejects.toThrow(/cannot be transferred/i);
  });

  it('cannot move a membership to another gym’s branch', async () => {
    const other = await gymOn('PROFESSIONAL');
    const theirBranch = (await listBranches(other.ctx, other.owner))[0]!;

    const plan = await createPlan(ctx, owner, {
      name: `Movable ${unique()}`,
      durationUnit: 'MONTH',
      durationValue: 1,
      price: '1500.00',
      transferAllowed: true,
    });
    const member = await createMember(ctx, owner, {
      firstName: 'Not',
      lastName: 'Theirs',
      phone: '9830500004',
    });
    const sale = await sellMembership(ctx, owner, { memberId: member.id, planId: plan.id });

    // Knowing another gym's branch id gains nothing.
    await expect(
      transferSubscription(ctx, owner, {
        subscriptionId: sale.subscriptionId,
        toBranchId: theirBranch.id,
        reason: 'Mischief',
      }),
    ).rejects.toThrow(/does not exist/i);
  });
});
