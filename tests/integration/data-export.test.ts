/**
 * Taking your data out.
 *
 * This suite exists for a specific reason. The product had been telling gyms
 * for several phases that a lapsed trial means "read-only, not locked out —
 * every record readable and exportable", and that a suspended gym "can still
 * export everything". The permission engine had a special carve-out keeping
 * `org.export.create` alive through read-only mode. And nothing implemented
 * an export. So the first tests here check the two things that make the
 * promise real rather than rhetorical: that every table is accounted for,
 * and that it still works when a gym has stopped paying.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { authPrisma, tenantModelNames } from '@gym/db';
import {
  registerGym,
  createSession,
  resolveSession,
  createMember,
  createPlan,
  sellMembership,
  checkIn,
  exportManifest,
  gymExportFiles,
  memberExportFiles,
  exportedModels,
  exportColumnSpecs,
  EXPORT_EXCLUSIONS,
  resolvePermissions,
  AppError,
} from '@gym/core';
import { nextTestAddress } from '../support/addresses';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

async function collect(generator: AsyncGenerator<string>): Promise<string> {
  let text = '';
  for await (const chunk of generator) text += chunk;
  return text;
}

interface Gym {
  organizationId: string;
  userId: string;
  ctx: { organizationId: string; userId: string };
  permissions: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
  memberId: string;
  memberCode: string;
}

async function gymWithSomeHistory(name: string): Promise<Gym> {
  const email = `export.${unique()}@example.com`;
  createdEmails.push(email);

  const created = await registerGym({
    gymName: `${name} ${unique()}`,
    ownerName: 'Export Owner',
    email,
    phone: '9876760000',
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
    firstName: 'Export',
    lastName: 'Subject',
    phone: `96${String(Date.now()).slice(-8)}`,
  });

  const plan = await createPlan(ctx, permissions, {
    name: `Export Plan ${unique()}`,
    durationDays: 90,
    price: '3000.00',
  });
  await sellMembership(ctx, permissions, {
    memberId: member.id,
    planId: plan.id,
    startDate: new Date().toISOString().slice(0, 10),
  });
  await checkIn(ctx, permissions, { memberId: member.id, method: 'MANUAL' });

  const row = await db.member.findUniqueOrThrow({
    where: { id: member.id },
    select: { memberCode: true },
  });

  return {
    organizationId: created.organizationId,
    userId: created.userId,
    ctx,
    permissions,
    memberId: member.id,
    memberCode: row.memberCode,
  };
}

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================

describe('nothing is forgotten and nothing is leaked', () => {
  /**
   * Every column named in the export has to exist.
   *
   * Prisma throws on an unknown field in a `select`, so a renamed column
   * would turn one file of the export into a 500 — and the person who finds
   * out is a gym owner trying to leave, at the worst possible moment to meet
   * a bug. Nothing in a typechecker catches a string naming a column,
   * because the delegate is reached dynamically.
   */
  it('names only real models and real columns', () => {
    const models = new Map(
      Prisma.dmmf.datamodel.models.map((model) => [
        model.name,
        new Set(model.fields.map((field) => field.name)),
      ]),
    );

    const specs = exportColumnSpecs();
    // Both lists: the gym's export and a member's own. An earlier version of
    // this test read the source with a regex and quietly stopped covering
    // the member specs when a field was inserted between `model` and
    // `columns` — so the specs are data now, not text to be parsed.
    expect(specs.length).toBeGreaterThan(40);

    const problems: string[] = [];
    for (const spec of specs) {
      const modelName = spec.model[0]!.toUpperCase() + spec.model.slice(1);
      const fields = models.get(modelName);
      if (!fields) {
        problems.push(`no such model: ${spec.model}`);
        continue;
      }
      for (const column of spec.columns) {
        if (!fields.has(column)) problems.push(`${spec.model}.${column} does not exist`);
      }
    }

    expect(problems).toEqual([]);
  });

  /**
   * Every file in a member's own export has to be scoped by a column that
   * exists on that model, or the export either throws or — the outcome worth
   * a test — returns every member's rows to one member.
   */
  it('scopes a member’s own export by a column that exists', () => {
    const models = new Map(
      Prisma.dmmf.datamodel.models.map((model) => [
        model.name,
        new Set(model.fields.map((field) => field.name)),
      ]),
    );

    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const source = readFileSync('packages/core/src/org/export.ts', 'utf8');
    const block = source.slice(source.indexOf('const MEMBER_TABLES'));
    const scopes = [...block.matchAll(/model: '(\w+)',\s*\n\s*scopeBy: '(\w+)'/g)];

    expect(scopes.length).toBeGreaterThan(8);

    for (const [, model, scopeBy] of scopes) {
      const modelName = model![0]!.toUpperCase() + model!.slice(1);
      expect(models.get(modelName)?.has(scopeBy!), `${model}.${scopeBy}`).toBe(true);
    }
  });

  /**
   * Every tenant table is either exported or deliberately excluded.
   *
   * A table added next year for an unrelated reason would otherwise be
   * silently missing from every export, and nobody would notice until a gym
   * left and found a gap.
   */
  it('accounts for every table that belongs to a gym', () => {
    const exported = new Set(
      exportedModels().map((model) => model[0]!.toUpperCase() + model.slice(1)),
    );
    const excluded = new Set(Object.keys(EXPORT_EXCLUSIONS));

    const unaccounted = tenantModelNames().filter(
      (model) => !exported.has(model) && !excluded.has(model),
    );

    expect(unaccounted, 'add these to TABLES or to EXPORT_EXCLUSIONS with a reason').toEqual([]);
  });

  it('gives every exclusion a reason somebody can argue with', () => {
    for (const [model, reason] of Object.entries(EXPORT_EXCLUSIONS)) {
      expect(reason.length, `${model} needs a real reason`).toBeGreaterThan(25);
    }
  });

  it('never exports a credential or a live token', () => {
    const excluded = Object.keys(EXPORT_EXCLUSIONS);
    // The three that would matter most if this list ever drifted.
    expect(excluded).toContain('Session');
    expect(excluded).toContain('WhatsappSetting');
    expect(excluded).toContain('PaymentGatewaySetting');

    const exported = exportedModels();
    expect(exported).not.toContain('session');
    expect(exported).not.toContain('whatsappSetting');
    expect(exported).not.toContain('paymentGatewaySetting');
  });
});

// =========================================================================

describe('a gym taking its data out', () => {
  it('says what is in it before anybody downloads it', async () => {
    const gym = await gymWithSomeHistory('Manifest');

    const manifest = await exportManifest(gym.ctx, gym.permissions);

    expect(manifest.gym).toContain('Manifest');
    expect(manifest.totalRows).toBeGreaterThan(0);
    // Each file is described in words, not just named: "subscriptions" does
    // not tell an owner whether their memberships are in there.
    for (const table of manifest.tables) {
      expect(table.describes.length).toBeGreaterThan(10);
    }
    expect(manifest.tables.map((t) => t.name)).toContain('members');
    expect(manifest.tables.map((t) => t.name)).toContain('payments');
    expect(manifest.tables.map((t) => t.name)).toContain('activity-log');
  });

  it('produces a readable CSV for every file, headers and all', async () => {
    const gym = await gymWithSomeHistory('Readable');
    const { files } = await gymExportFiles(gym.ctx, gym.permissions);

    const members = files.find((file) => file.name === 'members.csv')!;
    const text = await collect(members.contents);
    const lines = text.trim().split('\r\n');

    expect(lines[0]).toContain('"memberCode"');
    expect(lines[0]).toContain('"firstName"');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Export"');
    expect(lines[1]).toContain(`"${gym.memberCode}"`);

    // A file with no rows still carries its header, so the structure is
    // obvious to whoever imports it.
    const refunds = files.find((file) => file.name === 'refunds.csv')!;
    const refundText = await collect(refunds.contents);
    expect(refundText.trim().split('\r\n')).toHaveLength(1);
    expect(refundText).toContain('"amount"');
  });

  it('includes a README that explains how the files join up', async () => {
    const gym = await gymWithSomeHistory('Explained');
    const { files } = await gymExportFiles(gym.ctx, gym.permissions);

    const readme = await collect(files.find((file) => file.name === 'README.txt')!.contents);

    expect(readme).toContain('This is your');
    expect(readme).toContain('memberCode');
    // The omissions are stated, not left to be discovered.
    expect(readme).toContain('What is not here');
    expect(readme).toContain('photographs');
    expect(readme).toContain('Health declarations');
  });

  it('carries not one row of another gym’s data', async () => {
    const mine = await gymWithSomeHistory('Mine');
    const theirs = await gymWithSomeHistory('Theirs');

    const { files } = await gymExportFiles(mine.ctx, mine.permissions);

    let everything = '';
    for (const file of files) everything += await collect(file.contents);

    expect(everything).toContain(mine.memberCode === theirs.memberCode ? mine.organizationId : mine.memberCode);
    expect(everything).not.toContain(theirs.organizationId);
    expect(everything).not.toContain(theirs.memberId);
  });

  it('defuses a cell a spreadsheet would run as a formula', async () => {
    const gym = await gymWithSomeHistory('Injected');

    // The classic: a name typed at the front desk that Excel treats as code.
    await db.member.update({
      where: { id: gym.memberId },
      data: { firstName: '=HYPERLINK("http://evil.example","Click")' },
    });

    const { files } = await gymExportFiles(gym.ctx, gym.permissions);
    const text = await collect(files.find((file) => file.name === 'members.csv')!.contents);

    expect(text).toContain(`"'=HYPERLINK`);
    expect(text).not.toContain('"=HYPERLINK');
  });

  it('writes an audit row, because an export is a bulk read of personal data', async () => {
    const gym = await gymWithSomeHistory('Audited');
    await gymExportFiles(gym.ctx, gym.permissions, { ipAddress: '203.0.113.9' });

    const rows = await db.auditLog.findMany({
      where: { organizationId: gym.organizationId, action: 'org.export.created' },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toMatch(/rows across \d+ files/);
    expect(rows[0]!.ipAddress).toBe('203.0.113.9');
  });

  it('refuses somebody without the permission', async () => {
    const gym = await gymWithSomeHistory('Refused');
    const stripped = { ...gym.permissions, grants: {} } as typeof gym.permissions;

    await expect(exportManifest(gym.ctx, stripped)).rejects.toThrow(AppError);
  });
});

// =========================================================================

  /**
   * These six tables were excluded two days ago on the grounds that workout
   * plans "stay readable and editable in the product" — a sentence written
   * about software that did not exist. They are a gym's own work and they
   * belong in their export.
   */
  it('carries the gym’s training plans and every session logged against them', async () => {
    const gym = await gymWithSomeHistory('Trained');
    const { files, manifest } = await gymExportFiles(gym.ctx, gym.permissions);

    const names = manifest.tables.map((table) => table.name);
    expect(names).toContain('workout-plans');
    expect(names).toContain('workout-plan-days');
    expect(names).toContain('workout-plan-exercises');
    expect(names).toContain('workout-assignments');
    expect(names).toContain('workout-logs');
    expect(names).toContain('exercises');

    const logs = files.find((file) => file.name === 'workout-logs.csv')!;
    const text = await collect(logs.contents);
    // Header present even with no rows, so whoever imports it sees the shape.
    expect(text).toContain('"performedOn"');
    expect(text).toContain('"weightKg"');
  });

  it('does not pass off the shared exercise library as the gym’s own', async () => {
    const gym = await gymWithSomeHistory('Library Honesty');

    const shared = await db.exercise.count({ where: { organizationId: null } });
    expect(shared, 'the shared library is seeded').toBeGreaterThan(1);

    const { files } = await gymExportFiles(gym.ctx, gym.permissions);
    const text = await collect(files.find((file) => file.name === 'exercises.csv')!.contents);

    // Header only: this gym has added none of its own, and the twelve shared
    // ones belong to the platform.
    expect(text.trim().split('\r\n')).toHaveLength(1);
  });

describe('a gym that has stopped paying', () => {
  /**
   * The whole reason the permission engine carves `org.export.create` out of
   * read-only mode. If this test fails, the product is telling gyms their
   * data is still theirs while refusing to give it to them.
   */
  it('can still take everything out', async () => {
    const gym = await gymWithSomeHistory('Lapsed');

    await db.tenantSubscription.updateMany({
      where: { organizationId: gym.organizationId },
      data: { status: 'PAST_DUE', isReadOnly: true, graceUntil: new Date(Date.now() - 86_400_000) },
    });

    // Permissions resolved as the app resolves them for a read-only gym.
    const session = await createSession(authPrisma, {
      userId: gym.userId,
      organizationId: gym.organizationId,
      type: 'WEB',
    });
    const readOnly = (await resolveSession(authPrisma, session.token)).actor.permissions;

    expect(readOnly.isReadOnly).toBe(true);
    // Selling is gone, exporting is not.
    expect('memberships.subscription.create' in readOnly.grants).toBe(false);
    expect('org.export.create' in readOnly.grants).toBe(true);

    const { files, manifest } = await gymExportFiles(gym.ctx, readOnly);
    expect(manifest.totalRows).toBeGreaterThan(0);

    const members = await collect(files.find((file) => file.name === 'members.csv')!.contents);
    expect(members).toContain(gym.memberCode);
  });
});

// =========================================================================

describe('a member taking their own data', () => {
  it('gets their own records, including the health note the gym export leaves out', async () => {
    const gym = await gymWithSomeHistory('Member Own');

    const memberPermissions = {
      ...gym.permissions,
      grants: { ...gym.permissions.grants, 'self.export.create': 'SELF' },
    } as unknown as typeof gym.permissions;

    const { files, memberCode } = await memberExportFiles(
      { ...gym.ctx, memberId: gym.memberId },
      memberPermissions,
    );

    expect(memberCode).toBe(gym.memberCode);

    const names = files.map((file) => file.name);
    expect(names).toContain('my-details.csv');
    expect(names).toContain('my-visits.csv');
    // A medical note is the member's before it is the gym's.
    expect(names).toContain('my-health-declaration.csv');

    const details = await collect(files.find((file) => file.name === 'my-details.csv')!.contents);
    expect(details).toContain(gym.memberCode);

    const visits = await collect(files.find((file) => file.name === 'my-visits.csv')!.contents);
    expect(visits.trim().split('\r\n')).toHaveLength(2);
  });

  it('cannot be asked for without a member on the session', async () => {
    const gym = await gymWithSomeHistory('No Member');
    const memberPermissions = {
      ...gym.permissions,
      grants: { ...gym.permissions.grants, 'self.export.create': 'SELF' },
    } as unknown as typeof gym.permissions;

    await expect(
      memberExportFiles({ ...gym.ctx, memberId: null }, memberPermissions),
    ).rejects.toThrow(AppError);
  });

  it('carries nobody else’s rows', async () => {
    const gym = await gymWithSomeHistory('Two Members');

    const other = await createMember(gym.ctx, gym.permissions, {
      firstName: 'Somebody',
      lastName: 'Else',
      phone: `95${String(Date.now()).slice(-8)}`,
    });
    await checkIn(gym.ctx, gym.permissions, { memberId: other.id, method: 'MANUAL' });

    const memberPermissions = {
      ...gym.permissions,
      grants: { ...gym.permissions.grants, 'self.export.create': 'SELF' },
    } as unknown as typeof gym.permissions;

    const { files } = await memberExportFiles(
      { ...gym.ctx, memberId: gym.memberId },
      memberPermissions,
    );

    let everything = '';
    for (const file of files) everything += await collect(file.contents);

    expect(everything).not.toContain('Somebody');
    expect(everything).not.toContain(other.id);
  });
});
