import { getJobsClient, withTenant } from '@gym/db';
import type { RegisterGymInput } from '@gym/contracts';
import { AppError } from '../errors';
import { assessPassword, hashPassword } from '../auth/password';
import { createSession, type CreatedSession } from '../auth/session';
import { writeAudit } from '../audit/log';

/**
 * Tenant provisioning.
 *
 * This is the ONE legitimate cross-tenant write in the system: creating an
 * organization necessarily happens before that organization exists to be
 * scoped to. It therefore runs under the job role, and it is deliberately
 * the only service that does. Everything it creates afterwards is written
 * inside the new tenant's own context, so the usual rules resume
 * immediately.
 */

const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'www', 'platform', 'support', 'billing', 'status',
  'login', 'register', 'pricing', 'features', 'about', 'contact', 'blog',
  'docs', 'help', 'static', 'assets', 'cdn', 'mail', 'm',
]);

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
    .replace(/^-|-$/g, '');
}

async function allocateSlug(db: any, name: string): Promise<string> {
  const base = slugify(name) || 'gym';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (RESERVED_SLUGS.has(candidate)) continue;
    const taken = await db.organization.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  throw new AppError('CONFLICT', 'Could not allocate a unique address for that gym name.');
}

export interface RegisterGymResult {
  organizationId: string;
  organizationSlug: string;
  userId: string;
  session: CreatedSession;
}

export async function registerGym(
  input: RegisterGymInput & { ipAddress?: string; userAgent?: string },
): Promise<RegisterGymResult> {
  const db = getJobsClient();

  const problems = assessPassword(input.password, [input.ownerName, input.email, input.gymName]);
  if (problems.length > 0) {
    throw new AppError('VALIDATION_FAILED', problems[0]!, [
      { field: 'password', issue: problems[0]! },
    ]);
  }

  const existingUser = await db.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (existingUser) {
    // Deliberately specific: this is a registration form, and a person who
    // already has an account needs to be told to sign in, not left guessing.
    throw new AppError('CONFLICT', 'An account already exists for that email address.');
  }

  const [plan, ownerRole] = await Promise.all([
    db.platformPlan.findUnique({ where: { key: input.planKey } }),
    db.role.findFirst({ where: { organizationId: null, key: 'GYM_OWNER' } }),
  ]);

  if (!plan) throw new AppError('NOT_FOUND', 'That plan is not available.');
  if (!ownerRole) {
    throw new AppError('INTERNAL_ERROR', 'System roles are not seeded. Run pnpm db:seed.');
  }

  const slug = await allocateSlug(db, input.gymName);
  const passwordHash = await hashPassword(input.password);
  const now = new Date();
  const trialEnds = new Date(now.getTime() + plan.trialDays * 864e5);

  // One transaction: a half-created tenant is worse than no tenant.
  const created = await db.$transaction(async (tx: any) => {
    const organization = await tx.organization.create({
      data: {
        name: input.gymName,
        slug,
        status: 'TRIAL',
        ownerEmail: input.email,
        settings: {
          create: {
            contactEmail: input.email,
            contactPhone: input.phone,
            legalAddress: input.city ? { city: input.city } : undefined,
          },
        },
        branding: { create: { displayName: input.gymName } },
        tenantSubscription: {
          create: {
            platformPlanId: plan.id,
            status: 'TRIAL',
            billingCycle: 'MONTHLY',
            trialEndsAt: trialEnds,
            currentPeriodStart: now,
            currentPeriodEnd: trialEnds,
          },
        },
      },
      select: { id: true, slug: true },
    });

    const branch = await tx.branch.create({
      data: {
        organizationId: organization.id,
        name: `${input.gymName} — Main`,
        code: 'MAIN',
        city: input.city,
        isPrimary: true,
      },
      select: { id: true },
    });

    const user = await tx.user.create({
      data: {
        email: input.email,
        fullName: input.ownerName,
        phone: input.phone,
        passwordHash,
        status: 'ACTIVE',
        emailVerifiedAt: null,
      },
      select: { id: true },
    });

    // Deliberately assigned to no branch. A branch row narrows every
    // operational grant from ALL to BRANCH — which is right for a manager
    // who works at one branch, and wrong for the owner of the gym: pinned
    // to the branch they registered with, an owner who later opened a
    // second one could not register a member there, could not see staff
    // outside it, and could not move a membership into it. No rows means
    // organization-wide, which is what an owner is.
    await tx.orgUser.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        roleId: ownerRole.id,
        status: 'ACTIVE',
        acceptedAt: now,
      },
    });

    // Consent is recorded with its version and the address it came from,
    // because "they ticked a box" is not a record under the DPDP Act.
    await tx.consent.createMany({
      data: (['TERMS', 'PRIVACY_POLICY'] as const).map((consentType) => ({
        organizationId: organization.id,
        subjectType: 'USER' as const,
        subjectId: user.id,
        consentType,
        granted: true,
        policyVersion: '2026-11-01',
        ipAddress: input.ipAddress,
        userAgent: input.userAgent?.slice(0, 500),
      })),
    });

    await tx.taxRate.create({
      data: {
        organizationId: organization.id,
        name: 'GST 18%',
        percentage: 18,
        components: { cgst: 9, sgst: 9 },
        isDefault: true,
      },
    });

    await tx.invoiceSequence.create({
      data: {
        organizationId: organization.id,
        series: 'INV',
        financialYear: financialYearOf(now),
        prefix: 'INV',
      },
    });

    return { organization, user, branch };
  });

  const session = await createSession(db, {
    userId: created.user.id,
    organizationId: created.organization.id,
    type: 'WEB',
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  // From here on the usual rules apply: the audit row is written inside the
  // new tenant's own context.
  await withTenant(
    { organizationId: created.organization.id, userId: created.user.id },
    async (tx) =>
      writeAudit(tx, {
        organizationId: created.organization.id,
        actorUserId: created.user.id,
        actorRoleKey: 'GYM_OWNER',
        action: 'organization.registered',
        entityType: 'Organization',
        entityId: created.organization.id,
        summary: `${input.gymName} registered on the ${plan.name} plan`,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      }),
  );

  return {
    organizationId: created.organization.id,
    organizationSlug: created.organization.slug,
    userId: created.user.id,
    session,
  };
}

/** Indian financial year: April to March, written as 2026-27. */
export function financialYearOf(date: Date): string {
  const year = date.getUTCFullYear();
  const startYear = date.getUTCMonth() + 1 >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
