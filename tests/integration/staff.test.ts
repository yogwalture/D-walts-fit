/**
 * Staff, trainers, and who may see a salary.
 *
 * Two promises the product had been making and not keeping: the member
 * profile said "Trainer: Not assigned" with no way to assign one, and the
 * trainer role carried OWN scope on members — so a trainer signed in and saw
 * an empty list, because nothing ever filled it.
 *
 * The salary tests are the ones that matter. A receptionist must not be able
 * to read what a trainer is paid, and it must not merely be hidden from the
 * screen — it must not be read from the database at all.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authPrisma } from '@gym/db';
import {
  registerGym,
  createSession,
  resolveSession,
  resolvePermissions,
  createMember,
  listMembers,
  inviteStaff,
  acceptInvitation,
  getStaffProfile,
  updateStaffProfile,
  listTrainers,
  listPendingInvitations,
  revokeInvitation,
  assignTrainer,
  trainerRoster,
  AppError,
} from '@gym/core';
import { nextTestAddress } from '../support/addresses';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);

let gym: Awaited<ReturnType<typeof registerGym>>;
let ctx: { organizationId: string; userId: string };
let owner: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
let trainerOrgUserId: string;
let memberId: string;

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

/**
 * Invites someone and has them accept, which is the only way an OrgUser
 * comes into being — an administrator never creates an account for another
 * person, they invite them and the invitee sets their own password.
 */
async function addTeamMember(
  email: string,
  fullName: string,
  roleId: string,
): Promise<string> {
  const invitation = await inviteStaff({
    organizationId: gym.organizationId,
    email,
    fullName,
    roleId,
    branchIds: [],
    invitedByUserId: gym.userId,
  });

  await acceptInvitation({
    token: invitation.token,
    fullName,
    password: 'correct horse battery staple 47',
  });

  const orgUser = await db.orgUser.findFirstOrThrow({
    where: { organizationId: gym.organizationId, user: { email } },
    select: { id: true },
  });
  return orgUser.id;
}

/** The permission set a given system role actually resolves to. */
async function permissionsFor(roleKey: string) {
  const role = await db.role.findFirstOrThrow({
    where: { organizationId: null, key: roleKey },
    include: { permissions: { select: { permissionKey: true, scope: true } } },
  });
  return resolvePermissions({
    roleKey,
    rolePermissions: role.permissions,
    overrides: [],
    branchIds: [],
    planFeatures: ['crm', 'classes', 'workouts', 'inventory', 'video', 'whatsapp'],
    isPlatformAdmin: false,
  });
}

beforeAll(async () => {
  const email = `staff.${unique()}@example.com`;
  createdEmails.push(email);

  gym = await registerGym({
    gymName: `Staff Gym ${unique()}`,
    ownerName: 'Staff Owner',
    email,
    phone: '9876560000',
    password: 'correct horse battery staple 47',
    planKey: 'PROFESSIONAL',
    acceptedTerms: true,
    ipAddress: nextTestAddress(),
  });
  createdOrgIds.push(gym.organizationId);
  ctx = { organizationId: gym.organizationId, userId: gym.userId };

  const session = await createSession(authPrisma, {
    userId: gym.userId,
    organizationId: gym.organizationId,
    type: 'WEB',
  });
  owner = (await resolveSession(authPrisma, session.token)).actor.permissions;

  // A trainer on the team.
  const trainerRole = await db.role.findFirstOrThrow({
    where: { organizationId: null, key: 'TRAINER' },
  });
  const trainerEmail = `trainer.${unique()}@example.com`;
  createdEmails.push(trainerEmail);

  trainerOrgUserId = await addTeamMember(trainerEmail, 'Suresh Pawar', trainerRole.id);

  const member = await createMember(ctx, owner, {
    firstName: 'Ravi',
    lastName: 'Kulkarni',
    phone: '9820550001',
  });
  memberId = member.id;
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================
//  Salary — who may see it, and whether it is even read
// =========================================================================

describe('salary', () => {
  it('is set by someone who holds the permission', async () => {
    await updateStaffProfile(ctx, owner, trainerOrgUserId, {
      designation: 'Senior trainer',
      specialisations: ['Strength', 'Rehab'],
      employeeCode: 'T-001',
      salaryAmount: '28000.00',
      salaryCycle: 'MONTHLY',
      bankAccountMasked: 'XXXX4417',
      bankIfsc: 'HDFC0001234',
    });

    const profile = await getStaffProfile(ctx, owner, trainerOrgUserId);
    expect(profile.canSeeSalary).toBe(true);
    expect(profile.salary?.amount).toBe('28000.00');
    expect(profile.salary?.bankAccountMasked).toBe('XXXX4417');
    expect(profile.designation).toBe('Senior trainer');
    expect(profile.specialisations).toEqual(['Strength', 'Rehab']);
  });

  it('is not even fetched for someone without the permission', async () => {
    // A manager may read and edit the team's profiles and holds no salary
    // permission at all — the separation this is here to prove.
    const manager = await permissionsFor('GYM_MANAGER');

    const profile = await getStaffProfile(ctx, manager, trainerOrgUserId);
    expect(profile.fullName).toBe('Suresh Pawar');
    expect(profile.designation).toBe('Senior trainer');

    // But the pay is absent from the object, not merely blank: the
    // difference matters, because a hidden-but-present value ends up in a
    // log, a cache or a serialised response on the way past.
    expect(profile.canSeeSalary).toBe(false);
    expect('salary' in profile).toBe(false);
  });

  it('is out of reach for a receptionist, who cannot read staff profiles at all', async () => {
    const reception = await permissionsFor('RECEPTIONIST');
    await expect(getStaffProfile(ctx, reception, trainerOrgUserId)).rejects.toThrow(AppError);
  });

  it('cannot be changed by someone who may only edit a profile', async () => {
    // A manager may fix a designation. That must not let them set a wage.
    const manager = await permissionsFor('GYM_MANAGER');

    await expect(
      updateStaffProfile(ctx, manager, trainerOrgUserId, { salaryAmount: '99999.00' }),
    ).rejects.toThrow(AppError);

    // The ordinary fields still work for them.
    await updateStaffProfile(ctx, manager, trainerOrgUserId, { department: 'Floor' });
    const profile = await getStaffProfile(ctx, owner, trainerOrgUserId);
    expect(profile.department).toBe('Floor');
    expect(profile.salary?.amount, 'and the pay is untouched').toBe('28000.00');
  });

  it('keeps the figure out of the audit log', async () => {
    const audit = await db.auditLog.findFirst({
      where: { organizationId: gym.organizationId, action: 'staff.salary.updated' },
      orderBy: { createdAt: 'desc' },
    });

    expect(audit, 'the change itself is recorded').not.toBeNull();
    expect(audit!.summary).toContain('Suresh Pawar');
    // Anyone who can read the audit log would otherwise be able to read
    // every salary in the gym from it.
    expect(JSON.stringify(audit)).not.toContain('28000');
  });

  it('refuses a duplicate employee code', async () => {
    const otherEmail = `second.${unique()}@example.com`;
    createdEmails.push(otherEmail);

    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'RECEPTIONIST' },
    });
    const secondId = await addTeamMember(otherEmail, 'Nisha Kale', role.id);

    await expect(
      updateStaffProfile(ctx, owner, secondId, { employeeCode: 'T-001' }),
    ).rejects.toThrow(AppError);
  });
});

// =========================================================================
//  Assigning a trainer
// =========================================================================

describe('assigning a trainer', () => {
  it('lists who can take members, by what their role can do', async () => {
    const trainers = await listTrainers(ctx, owner);

    const suresh = trainers.find((t) => t.orgUserId === trainerOrgUserId);
    expect(suresh, 'the trainer is assignable').toBeDefined();
    expect(suresh!.fullName).toBe('Suresh Pawar');
    expect(suresh!.designation).toBe('Senior trainer');
    expect(suresh!.memberCount).toBe(0);

    // The owner reads members at ALL scope, not OWN, so is not a trainer.
    const names = trainers.map((t) => t.fullName);
    expect(names).not.toContain('Staff Owner');
  });

  it('puts a member under a trainer, and says so on the profile', async () => {
    await assignTrainer(ctx, owner, { memberId, orgUserId: trainerOrgUserId });

    const member = await db.member.findUniqueOrThrow({ where: { id: memberId } });
    expect(member.assignedTrainerOrgUserId).toBe(trainerOrgUserId);

    const assignment = await db.trainerAssignment.findFirstOrThrow({
      where: { memberId, toDate: null },
    });
    expect(assignment.orgUserId).toBe(trainerOrgUserId);
    expect(assignment.isPrimary).toBe(true);
  });

  it('shows on the member’s timeline, because a member asks who their trainer is', async () => {
    const entry = await db.memberTimelineEntry.findFirst({
      where: { memberId, sourceType: 'TrainerAssignment' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(entry?.title).toBe('Assigned to Suresh Pawar');
  });

  it('counts towards the trainer’s load', async () => {
    const trainers = await listTrainers(ctx, owner);
    const suresh = trainers.find((t) => t.orgUserId === trainerOrgUserId)!;
    expect(suresh.memberCount).toBe(1);
  });

  it('closes the old assignment when the trainer changes', async () => {
    const otherEmail = `trainer2.${unique()}@example.com`;
    createdEmails.push(otherEmail);

    const trainerRole = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'TRAINER' },
    });
    const secondTrainerId = await addTeamMember(otherEmail, 'Kavita Jadhav', trainerRole.id);

    await assignTrainer(ctx, owner, { memberId, orgUserId: secondTrainerId });

    const open = await db.trainerAssignment.findMany({ where: { memberId, toDate: null } });
    expect(open, 'exactly one trainer at a time').toHaveLength(1);
    expect(open[0]!.orgUserId).toBe(secondTrainerId);

    // The history survives: a gym looks back at who trained whom.
    const all = await db.trainerAssignment.count({ where: { memberId } });
    expect(all).toBe(2);
  });

  it('can take a member off a trainer entirely', async () => {
    await assignTrainer(ctx, owner, { memberId, orgUserId: null });

    const member = await db.member.findUniqueOrThrow({ where: { id: memberId } });
    expect(member.assignedTrainerOrgUserId).toBeNull();

    const open = await db.trainerAssignment.count({ where: { memberId, toDate: null } });
    expect(open).toBe(0);
  });

  it('refuses a trainer who is not active', async () => {
    const suspendedEmail = `gone.${unique()}@example.com`;
    createdEmails.push(suspendedEmail);

    const trainerRole = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'TRAINER' },
    });
    const goneId = await addTeamMember(suspendedEmail, 'Former Trainer', trainerRole.id);
    await db.orgUser.update({ where: { id: goneId }, data: { status: 'SUSPENDED' } });

    await expect(
      assignTrainer(ctx, owner, { memberId, orgUserId: goneId }),
    ).rejects.toThrow(AppError);
  });

  it('refuses a trainer from another gym', async () => {
    const otherOrg = await db.organization.findFirstOrThrow({ where: { slug: 'iron-temple' } });
    const theirs = await db.orgUser.findFirst({
      where: { organizationId: otherOrg.id },
      select: { id: true },
    });

    if (theirs) {
      await expect(
        assignTrainer(ctx, owner, { memberId, orgUserId: theirs.id }),
      ).rejects.toThrow(AppError);

      const member = await db.member.findUniqueOrThrow({ where: { id: memberId } });
      expect(member.assignedTrainerOrgUserId).toBeNull();
    }
  });
});

// =========================================================================
//  Invitations that have not been accepted yet
// =========================================================================

describe('pending invitations', () => {
  it('are visible, because an invited person has no account to show', async () => {
    // Until this existed, inviting someone left no trace anywhere in the
    // product: the team page showed nothing and the sender could not tell
    // whether it had gone out.
    const email = `pending.${unique()}@example.com`;
    createdEmails.push(email);

    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'RECEPTIONIST' },
    });
    await inviteStaff({
      organizationId: gym.organizationId,
      email,
      fullName: 'Not Yet Joined',
      roleId: role.id,
      branchIds: [],
      invitedByUserId: gym.userId,
    });

    const pending = await listPendingInvitations(ctx, owner);
    const invitation = pending.find((row) => row.email === email);

    expect(invitation, 'the invitation is listed').toBeDefined();
    // The name the inviter typed, so the team page shows a person rather
    // than a bare email address.
    expect(invitation!.fullName).toBe('Not Yet Joined');
    expect(invitation!.roleName).toBe('Receptionist');
    expect(invitation!.invitedBy).toBe('Staff Owner');
    expect(invitation!.isExpired).toBe(false);
    expect(invitation!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('disappear once accepted', async () => {
    const email = `accepts.${unique()}@example.com`;
    createdEmails.push(email);

    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'RECEPTIONIST' },
    });
    await addTeamMember(email, 'Joins Promptly', role.id);

    const pending = await listPendingInvitations(ctx, owner);
    expect(pending.some((row) => row.email === email)).toBe(false);
  });

  it('can be taken back, and then cannot be accepted', async () => {
    const email = `mistake.${unique()}@example.com`;
    createdEmails.push(email);

    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'RECEPTIONIST' },
    });
    const invitation = await inviteStaff({
      organizationId: gym.organizationId,
      email,
      fullName: 'Wrong Address',
      roleId: role.id,
      branchIds: [],
      invitedByUserId: gym.userId,
    });

    const pending = await listPendingInvitations(ctx, owner);
    const row = pending.find((entry) => entry.email === email)!;

    await revokeInvitation(ctx, owner, row.id);

    const after = await listPendingInvitations(ctx, owner);
    expect(after.some((entry) => entry.email === email)).toBe(false);

    // The token must be dead, not merely hidden from the list.
    await expect(
      acceptInvitation({
        token: invitation.token,
        fullName: 'Wrong Address',
        password: 'correct horse battery staple 47',
      }),
    ).rejects.toThrow(AppError);
  });

  it('are never another gym’s, even though the table sits outside row-level security', async () => {
    // verification_tokens is exempt from RLS because it is read before any
    // tenant is known — so the tenant filter is explicit here, and this is
    // the test that it is actually applied.
    const otherOrg = await db.organization.findFirstOrThrow({ where: { slug: 'iron-temple' } });
    const theirRole = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'RECEPTIONIST' },
    });
    const theirEmail = `theirs.${unique()}@example.com`;
    createdEmails.push(theirEmail);

    const theirInvitation = await inviteStaff({
      organizationId: otherOrg.id,
      email: theirEmail,
      fullName: 'Their Person',
      roleId: theirRole.id,
      branchIds: [],
      invitedByUserId: gym.userId,
    });

    const ours = await listPendingInvitations(ctx, owner);
    expect(ours.some((row) => row.email === theirEmail)).toBe(false);

    // And knowing the id is not enough to revoke it.
    const theirRow = await db.verificationToken.findFirstOrThrow({
      where: { email: theirEmail, type: 'STAFF_INVITATION' },
      select: { id: true },
    });
    await expect(revokeInvitation(ctx, owner, theirRow.id)).rejects.toThrow(AppError);

    // Still usable by them, because we did not manage to cancel it.
    const stillThere = await db.verificationToken.findUniqueOrThrow({
      where: { id: theirRow.id },
    });
    expect(stillThere.consumedAt).toBeNull();
    expect(theirInvitation.token).toBeTruthy();

    await db.verificationToken.delete({ where: { id: theirRow.id } });
  });
});

// =========================================================================
//  What a trainer actually sees
// =========================================================================

describe('a trainer’s own list', () => {
  it('fills the list the trainer role has always been scoped to', async () => {
    await assignTrainer(ctx, owner, { memberId, orgUserId: trainerOrgUserId });

    const roster = await trainerRoster(ctx, owner, trainerOrgUserId);
    expect(roster.trainer?.fullName).toBe('Suresh Pawar');
    expect(roster.members).toHaveLength(1);
    expect(roster.members[0]!.name).toBe('Ravi Kulkarni');
    expect(roster.members[0]!.since).not.toBeNull();
  });

  it('narrows the members list to their own, for a trainer signing in', async () => {
    const trainerPermissions = await permissionsFor('TRAINER');

    // A second member nobody assigned to them.
    await createMember(ctx, owner, {
      firstName: 'Someone',
      lastName: 'Else',
      phone: '9820550002',
    });

    const asOwner = await listMembers(ctx, owner, { pageSize: 100 });
    expect(asOwner.total).toBeGreaterThanOrEqual(2);

    // The trainer's context is their own user id — which is what the OWN
    // scope narrows against.
    const trainerUser = await db.orgUser.findUniqueOrThrow({
      where: { id: trainerOrgUserId },
      select: { userId: true },
    });

    const asTrainer = await listMembers(
      { organizationId: gym.organizationId, userId: trainerUser.userId },
      trainerPermissions,
      { pageSize: 100 },
    );

    expect(asTrainer.total, 'only the member assigned to them').toBe(1);
    expect(asTrainer.rows[0]!.name).toBe('Ravi Kulkarni');
  });
});
