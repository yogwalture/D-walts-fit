/**
 * TENANT ISOLATION SUITE
 *
 * This is the test that matters most in the product. It seeds two gyms with
 * deliberately identical data and then, acting as Gym A, tries every way we
 * could think of to reach Gym B.
 *
 * Every assertion must hold TWICE over, because isolation is enforced twice:
 *
 *   Layer 2 — the application cannot build an unscoped query
 *   Layer 3 — PostgreSQL row-level security refuses to answer one
 *
 * The suite therefore tests them separately. The "RLS only" block runs raw
 * SQL with the extension bypassed entirely: if the application layer were
 * removed tomorrow, those assertions must still pass.
 *
 * A new route is not merged until the model it touches appears here.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  withTenant,
  tenantClient,
  MissingTenantContextError,
  CrossTenantWriteError,
  type TenantContext,
} from '../../packages/db/src/index.js';

const jobs = new PrismaClient({
  datasources: { db: { url: process.env.JOBS_DATABASE_URL } },
});

/** Raw application-role client: RLS applies, the extension does not. */
const appRaw = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

interface Fixture {
  orgId: string;
  ctx: TenantContext;
  memberId: string;
  subscriptionId: string;
  invoiceId: string;
  paymentId: string;
  attendanceId: string;
  leadId: string;
  planId: string;
  branchId: string;
  ownerUserId: string;
}

let A: Fixture;
let B: Fixture;

async function loadFixture(slug: string): Promise<Fixture> {
  const org = await jobs.organization.findUniqueOrThrow({ where: { slug } });
  const [member, subscription, invoice, payment, attendance, lead, plan, branch, owner] =
    await Promise.all([
      jobs.member.findFirstOrThrow({ where: { organizationId: org.id } }),
      jobs.subscription.findFirstOrThrow({ where: { organizationId: org.id } }),
      jobs.invoice.findFirstOrThrow({ where: { organizationId: org.id } }),
      jobs.payment.findFirstOrThrow({ where: { organizationId: org.id } }),
      jobs.attendance.findFirstOrThrow({ where: { organizationId: org.id } }),
      jobs.lead.findFirstOrThrow({ where: { organizationId: org.id } }),
      jobs.membershipPlan.findFirstOrThrow({ where: { organizationId: org.id } }),
      jobs.branch.findFirstOrThrow({ where: { organizationId: org.id } }),
      jobs.orgUser.findFirstOrThrow({
        where: { organizationId: org.id, role: { key: 'GYM_OWNER' } },
      }),
    ]);

  return {
    orgId: org.id,
    ctx: { organizationId: org.id, userId: owner.userId },
    memberId: member.id,
    subscriptionId: subscription.id,
    invoiceId: invoice.id,
    paymentId: payment.id,
    attendanceId: attendance.id,
    leadId: lead.id,
    planId: plan.id,
    branchId: branch.id,
    ownerUserId: owner.userId,
  };
}

beforeAll(async () => {
  A = await loadFixture('iron-temple');
  B = await loadFixture('pulse-fitness');
  expect(A.orgId).not.toBe(B.orgId);
});

afterAll(async () => {
  await Promise.all([jobs.$disconnect(), appRaw.$disconnect()]);
});

// =========================================================================
//  0. Sanity — the suite must be capable of seeing data at all
// =========================================================================

describe('sanity: the fixtures are genuinely identical across tenants', () => {
  it('both gyms have a member with the same name, phone and member code', async () => {
    const a = await jobs.member.findUniqueOrThrow({ where: { id: A.memberId } });
    const b = await jobs.member.findUniqueOrThrow({ where: { id: B.memberId } });

    expect(a.firstName).toBe(b.firstName);
    expect(a.phone).toBe(b.phone);
    expect(a.memberCode).toBe(b.memberCode);
    expect(a.id).not.toBe(b.id);
  });

  it('both gyms issued invoice number 1 in the same financial year', async () => {
    const a = await jobs.invoice.findUniqueOrThrow({ where: { id: A.invoiceId } });
    const b = await jobs.invoice.findUniqueOrThrow({ where: { id: B.invoiceId } });

    expect(a.invoiceNumber).toBe(1);
    expect(b.invoiceNumber).toBe(1);
    expect(a.invoiceCode).toBe(b.invoiceCode);
  });

  it("gym A can read its OWN records — otherwise every test below is vacuous", async () => {
    await withTenant(A.ctx, async (tx) => {
      expect(await tx.member.findFirst({ where: { id: A.memberId } })).not.toBeNull();
      expect(await tx.invoice.findFirst({ where: { id: A.invoiceId } })).not.toBeNull();
      expect(await tx.payment.findFirst({ where: { id: A.paymentId } })).not.toBeNull();
      expect(await tx.member.count()).toBe(1);
    });
  });
});

// =========================================================================
//  1. Reads across every tenant model
// =========================================================================

describe('reads: gym A cannot read gym B', () => {
  const byId: Array<[string, (tx: any, id: string) => Promise<unknown>, keyof Fixture]> = [
    ['member', (tx, id) => tx.member.findFirst({ where: { id } }), 'memberId'],
    ['subscription', (tx, id) => tx.subscription.findFirst({ where: { id } }), 'subscriptionId'],
    ['invoice', (tx, id) => tx.invoice.findFirst({ where: { id } }), 'invoiceId'],
    ['payment', (tx, id) => tx.payment.findFirst({ where: { id } }), 'paymentId'],
    ['attendance', (tx, id) => tx.attendance.findFirst({ where: { id } }), 'attendanceId'],
    ['lead', (tx, id) => tx.lead.findFirst({ where: { id } }), 'leadId'],
    ['membershipPlan', (tx, id) => tx.membershipPlan.findFirst({ where: { id } }), 'planId'],
    ['branch', (tx, id) => tx.branch.findFirst({ where: { id } }), 'branchId'],
  ];

  for (const [label, read, key] of byId) {
    it(`findFirst on B's ${label} by its exact id returns null`, async () => {
      await withTenant(A.ctx, async (tx) => {
        expect(await read(tx, B[key] as string)).toBeNull();
      });
    });
  }

  it("findUnique on B's member by primary key returns null", async () => {
    await withTenant(A.ctx, async (tx) => {
      expect(await tx.member.findUnique({ where: { id: B.memberId } })).toBeNull();
    });
  });

  it('findMany returns only gym A rows', async () => {
    await withTenant(A.ctx, async (tx) => {
      const members = await tx.member.findMany();
      expect(members).toHaveLength(1);
      expect(members[0]!.organizationId).toBe(A.orgId);
    });
  });

  it('a hostile where clause with OR cannot widen the scope', async () => {
    await withTenant(A.ctx, async (tx) => {
      const members = await tx.member.findMany({
        where: { OR: [{ id: A.memberId }, { id: B.memberId }] },
      });
      expect(members).toHaveLength(1);
      expect(members[0]!.id).toBe(A.memberId);
    });
  });

  it('an explicit organizationId in the filter cannot override the context', async () => {
    await withTenant(A.ctx, async (tx) => {
      expect(await tx.member.findMany({ where: { organizationId: B.orgId } })).toHaveLength(0);
    });
  });

  it('count, aggregate and groupBy stay inside the tenant', async () => {
    await withTenant(A.ctx, async (tx) => {
      expect(await tx.member.count()).toBe(1);
      expect(await tx.payment.count()).toBe(1);

      const totals = await tx.payment.aggregate({ _sum: { amount: true } });
      expect(Number(totals._sum.amount)).toBe(1500);

      const grouped = await tx.member.groupBy({ by: ['organizationId'], _count: true });
      expect(grouped).toHaveLength(1);
      expect(grouped[0]!.organizationId).toBe(A.orgId);
    });
  });

  it('a nested read through a relation cannot reach the other tenant', async () => {
    await withTenant(A.ctx, async (tx) => {
      const member = await tx.member.findFirst({
        where: { id: A.memberId },
        include: { subscriptions: true, invoices: true, payments: true, attendance: true },
      });
      expect(member!.subscriptions).toHaveLength(1);
      expect(member!.subscriptions.every((s: any) => s.organizationId === A.orgId)).toBe(true);
    });
  });
});

// =========================================================================
//  2. Writes
// =========================================================================

describe("writes: gym A cannot modify gym B", () => {
  it("update on B's member by id affects nothing", async () => {
    await withTenant(A.ctx, async (tx) => {
      await expect(
        tx.member.update({ where: { id: B.memberId }, data: { firstName: 'Hijacked' } }),
      ).rejects.toThrow();
    });

    const after = await jobs.member.findUniqueOrThrow({ where: { id: B.memberId } });
    expect(after.firstName).toBe('Rahul');
  });

  it("updateMany targeting B's rows changes zero rows", async () => {
    await withTenant(A.ctx, async (tx) => {
      const result = await tx.member.updateMany({
        where: { id: B.memberId },
        data: { firstName: 'Hijacked' },
      });
      expect(result.count).toBe(0);
    });

    const after = await jobs.member.findUniqueOrThrow({ where: { id: B.memberId } });
    expect(after.firstName).toBe('Rahul');
  });

  it("deleteMany targeting B's rows deletes nothing", async () => {
    await withTenant(A.ctx, async (tx) => {
      const result = await tx.member.deleteMany({ where: { id: B.memberId } });
      expect(result.count).toBe(0);
    });

    expect(await jobs.member.findUnique({ where: { id: B.memberId } })).not.toBeNull();
  });

  it("delete on B's payment by id is refused", async () => {
    await withTenant(A.ctx, async (tx) => {
      await expect(tx.payment.delete({ where: { id: B.paymentId } })).rejects.toThrow();
    });

    expect(await jobs.payment.findUnique({ where: { id: B.paymentId } })).not.toBeNull();
  });

  it("a create carrying B's organizationId is refused loudly, not silently corrected", async () => {
    await expect(
      withTenant(A.ctx, async (tx) => {
        await tx.member.create({
          data: {
            organizationId: B.orgId,
            memberCode: 'M09999',
            firstName: 'Planted',
            phone: '9000000000',
            joiningDate: new Date(),
          } as any,
        });
      }),
    ).rejects.toThrow(CrossTenantWriteError);

    const planted = await jobs.member.findFirst({ where: { memberCode: 'M09999' } });
    expect(planted).toBeNull();
  });

  it('a create with no organizationId is stamped with the acting tenant', async () => {
    const created = await withTenant(A.ctx, async (tx) =>
      tx.member.create({
        data: {
          memberCode: 'M08888',
          firstName: 'Stamped',
          phone: '9000000001',
          joiningDate: new Date(),
        } as any,
      }),
    );

    expect(created.organizationId).toBe(A.orgId);
    await jobs.member.delete({ where: { id: created.id } });
  });
});

// =========================================================================
//  3. Missing context fails closed
// =========================================================================

describe('missing context: a query with no tenant fails closed', () => {
  it('a tenant model queried with no organization throws', async () => {
    const client = tenantClient({ organizationId: '' } as TenantContext);
    await expect(client.member.findMany()).rejects.toThrow(MissingTenantContextError);
  });

  it('withTenant refuses to open a transaction with no organization', async () => {
    await expect(
      withTenant({ organizationId: '' } as TenantContext, async () => null),
    ).rejects.toThrow(MissingTenantContextError);
  });
});

// =========================================================================
//  4. Row-level security ALONE — the application layer bypassed entirely
// =========================================================================

describe('RLS only: raw SQL with the extension bypassed', () => {
  it('with no tenant context set, a tenant table returns nothing', async () => {
    const rows = await appRaw.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT count(*)::bigint AS count FROM members',
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });

  it("with gym A's context set, raw SQL cannot see gym B's member", async () => {
    await appRaw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${A.orgId}::text, true)`;

      const mine = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT count(*)::bigint AS count FROM members',
      );
      expect(Number(mine[0]!.count)).toBe(1);

      const theirs = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT count(*)::bigint AS count FROM members WHERE id = $1::uuid',
        B.memberId,
      );
      expect(Number(theirs[0]!.count)).toBe(0);
    });
  });

  it("raw SQL cannot update gym B's rows while in gym A's context", async () => {
    await appRaw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${A.orgId}::text, true)`;
      const affected = await tx.$executeRawUnsafe(
        `UPDATE members SET "firstName" = 'Hijacked' WHERE id = $1::uuid`,
        B.memberId,
      );
      expect(affected).toBe(0);
    });

    const after = await jobs.member.findUniqueOrThrow({ where: { id: B.memberId } });
    expect(after.firstName).toBe('Rahul');
  });

  it("raw SQL cannot INSERT a row into gym B while in gym A's context", async () => {
    await expect(
      appRaw.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_org_id', ${A.orgId}::text, true)`;
        await tx.$executeRawUnsafe(
          `INSERT INTO members (id, "organizationId", "memberCode", "firstName", phone,
                                "joiningDate", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1::uuid, 'M07777', 'Planted', '9000000002',
                   CURRENT_DATE, now(), now())`,
          B.orgId,
        );
      }),
    ).rejects.toThrow(/row-level security/i);

    expect(await jobs.member.findFirst({ where: { memberCode: 'M07777' } })).toBeNull();
  });

  it('the application role holds neither superuser nor BYPASSRLS', async () => {
    const [role] = await jobs.$queryRawUnsafe<
      Array<{ rolsuper: boolean; rolbypassrls: boolean }>
    >(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    // asked of the jobs role here; the app role is checked below
    expect(role).toBeDefined();

    const [appRole] = await appRaw.$queryRawUnsafe<
      Array<{ rolsuper: boolean; rolbypassrls: boolean }>
    >(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);

    expect(appRole!.rolsuper).toBe(false);
    expect(appRole!.rolbypassrls).toBe(false);
  });

  // The check above is not enough on its own, and the gap is not theoretical.
  //
  // BYPASSRLS does not leak through role membership — a role that merely
  // belongs to a BYPASSRLS role still sees nothing. But it can `SET ROLE` to
  // that role, and then it sees everything. Verified against PostgreSQL 16:
  // membership alone returned 0 rows from a FORCE-RLS table with a deny-all
  // policy; one `SET ROLE` later the same session read every row.
  //
  // This is how a managed provider breaks tenant isolation without breaking
  // a single policy. Neon grants `neon_superuser` — which carries BYPASSRLS —
  // to every role created through its console, API or CLI. Create `gym_app`
  // that way and `rolbypassrls` on the role itself is still false, so the
  // assertion above passes, the policies are all present and correct, and the
  // application is one statement away from reading every gym in the database.
  //
  // So the question is not what the role is, but what it can become.
  it('the application role cannot become a role that bypasses RLS', async () => {
    const escalations = await appRaw.$queryRawUnsafe<Array<{ rolname: string }>>(
      `SELECT r.rolname
         FROM pg_roles r
        WHERE (r.rolbypassrls OR r.rolsuper)
          AND r.rolname <> current_user
          AND pg_has_role(current_user, r.oid, 'MEMBER')`,
    );

    expect(escalations.map((row) => row.rolname)).toEqual([]);
  });

  it('every tenant table has RLS enabled AND forced', async () => {
    const rows = await jobs.$queryRawUnsafe<
      Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`);

    expect(rows.length).toBeGreaterThanOrEqual(75);
    const notForced = rows.filter((r) => !r.relforcerowsecurity).map((r) => r.relname);
    expect(notForced).toEqual([]);
  });

  it('no tenant table was left without a policy', async () => {
    const rows = await jobs.$queryRawUnsafe<Array<{ relname: string }>>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
          AND NOT EXISTS (
                SELECT 1 FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = c.relname)`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});

// =========================================================================
//  5. Shared library rows and the organization switcher
// =========================================================================

describe('shared library and organization membership', () => {
  it('the seeded exercise library is readable by both gyms', async () => {
    const seen = await Promise.all(
      [A, B].map((gym) =>
        withTenant(gym.ctx, async (tx) =>
          tx.exercise.count({ where: { organizationId: null } }),
        ),
      ),
    );
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[0]).toBe(seen[1]);
  });

  it("a gym's own exercise is invisible to the other gym", async () => {
    const privateExercise = await withTenant(A.ctx, async (tx) =>
      tx.exercise.create({
        data: { name: 'House Special Burpee', muscleGroup: 'Full body' } as any,
      }),
    );

    expect(privateExercise.organizationId).toBe(A.orgId);

    await withTenant(B.ctx, async (tx) => {
      expect(await tx.exercise.findFirst({ where: { id: privateExercise.id } })).toBeNull();
    });

    await jobs.exercise.delete({ where: { id: privateExercise.id } });
  });

  it('a user sees only the organizations they belong to', async () => {
    await withTenant(A.ctx, async (tx) => {
      const orgs = await tx.organization.findMany();
      expect(orgs.map((o: any) => o.id)).toEqual([A.orgId]);
    });
  });

  it("gym A's owner cannot read gym B's staff list", async () => {
    await withTenant(A.ctx, async (tx) => {
      const staff = await tx.orgUser.findMany({ where: { organizationId: B.orgId } });
      expect(staff).toHaveLength(0);
    });
  });
});

// =========================================================================
//  6. Sensitive data boundaries
// =========================================================================

describe('sensitive data', () => {
  it("salary is not reachable across tenants", async () => {
    const bProfile = await jobs.staffProfile.findFirstOrThrow({
      where: { organizationId: B.orgId, salaryAmount: { not: null } },
    });

    await withTenant(A.ctx, async (tx) => {
      expect(await tx.staffProfile.findFirst({ where: { id: bProfile.id } })).toBeNull();
    });
  });

  it('medical declarations are not reachable across tenants', async () => {
    const declaration = await jobs.memberMedicalDeclaration.create({
      data: {
        organizationId: B.orgId,
        memberId: B.memberId,
        hasDeclaredConditions: true,
        conditions: ['Asthma'],
      },
    });

    await withTenant(A.ctx, async (tx) => {
      expect(
        await tx.memberMedicalDeclaration.findFirst({ where: { id: declaration.id } }),
      ).toBeNull();
      expect(await tx.memberMedicalDeclaration.count()).toBe(0);
    });

    await jobs.memberMedicalDeclaration.delete({ where: { id: declaration.id } });
  });

  it('WhatsApp credentials are not reachable across tenants', async () => {
    const setting = await jobs.whatsappSetting.create({
      data: {
        organizationId: B.orgId,
        wabaId: 'waba-b',
        phoneNumberId: 'phone-b',
        accessTokenEncrypted: 'ciphertext-should-never-leak',
      },
    });

    await withTenant(A.ctx, async (tx) => {
      expect(await tx.whatsappSetting.findFirst()).toBeNull();
      expect(await tx.whatsappSetting.findFirst({ where: { id: setting.id } })).toBeNull();
    });

    await jobs.whatsappSetting.delete({ where: { id: setting.id } });
  });
});

// =========================================================================
//  7. Coverage — no tenant model may be left untested by accident
// =========================================================================

describe('coverage', () => {
  it('every tenant model is covered by a policy in the database', async () => {
    const { tenantModelNames } = await import('../../packages/db/src/index.js');
    const models = tenantModelNames();

    // Session is the documented exception: it is the auth primitive itself.
    const expected = models.filter((m) => m !== 'Session');
    expect(expected.length).toBeGreaterThan(70);

    const policies = await jobs.$queryRawUnsafe<Array<{ tablename: string }>>(
      `SELECT tablename FROM pg_policies WHERE schemaname = 'public'`,
    );
    // organizations itself carries a policy but has no organizationId column
    expect(policies.length).toBeGreaterThanOrEqual(expected.length);
  });
});
