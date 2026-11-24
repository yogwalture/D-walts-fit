/**
 * Seeds the database.
 *
 *   - the permission registry and the seven system roles
 *   - SaaS plans and feature flags
 *   - a small shared exercise library every gym can read
 *   - two complete demo gyms with DELIBERATELY IDENTICAL data, which is
 *     what makes the tenant isolation suite meaningful: same member names,
 *     same phone numbers, same member codes, same invoice numbers.
 *
 * Runs as the job role, which holds BYPASSRLS. Tenant provisioning is the
 * one legitimate cross-tenant write in the system, and it happens here and
 * in the platform's gym-creation service — nowhere else.
 */

import { PrismaClient } from '@prisma/client';
import { PERMISSIONS, ROLE_MATRIX } from './seed-data/permissions';

const url =
  process.env.SEED_DATABASE_URL ??
  process.env.JOBS_DATABASE_URL ??
  process.env.DIRECT_DATABASE_URL;

const prisma = new PrismaClient({ datasources: { db: { url } } });

const log = (msg: string) => process.stdout.write(`  ${msg}\n`);

async function seedPermissions() {
  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      create: {
        key: permission.key,
        domain: permission.domain,
        resource: permission.resource,
        action: permission.action,
        label: permission.label,
        isSensitive: permission.isSensitive ?? false,
      },
      update: {
        domain: permission.domain,
        resource: permission.resource,
        action: permission.action,
        label: permission.label,
        isSensitive: permission.isSensitive ?? false,
      },
    });
  }
  log(`${PERMISSIONS.length} permissions`);
}

async function seedSystemRoles() {
  for (const role of ROLE_MATRIX) {
    const existing = await prisma.role.findFirst({
      where: { organizationId: null, key: role.key },
    });

    const record = existing
      ? await prisma.role.update({
          where: { id: existing.id },
          data: {
            name: role.name,
            description: role.description,
            rank: role.rank,
            isSystem: true,
            isPlatform: role.isPlatform ?? false,
          },
        })
      : await prisma.role.create({
          data: {
            organizationId: null,
            key: role.key,
            name: role.name,
            description: role.description,
            rank: role.rank,
            isSystem: true,
            isPlatform: role.isPlatform ?? false,
          },
        });

    await prisma.rolePermission.deleteMany({ where: { roleId: record.id } });
    await prisma.rolePermission.createMany({
      data: Object.entries(role.grants).map(([permissionKey, scope]) => ({
        organizationId: null,
        roleId: record.id,
        permissionKey,
        scope,
      })),
      skipDuplicates: true,
    });

    log(`role ${role.key.padEnd(14)} ${Object.keys(role.grants).length} permissions`);
  }
}

async function seedPlatformPlans() {
  const plans = [
    {
      key: 'STARTER', name: 'Starter', monthlyPrice: 1499, annualPrice: 14990,
      maxMembers: 200, maxBranches: 1, maxStaff: 5, maxStorageMb: 2048,
      whatsappCredits: 1000, trialDays: 7, displayOrder: 1,
      tagline: 'One branch, up to 200 members',
      features: ['members', 'memberships', 'attendance', 'billing', 'whatsapp', 'member_app'],
    },
    {
      key: 'GROWTH', name: 'Growth', monthlyPrice: 2999, annualPrice: 29990,
      maxMembers: 750, maxBranches: 2, maxStaff: 15, maxStorageMb: 10240,
      whatsappCredits: 5000, trialDays: 7, displayOrder: 2,
      tagline: 'Two branches, CRM and classes',
      features: ['members', 'memberships', 'attendance', 'billing', 'whatsapp', 'member_app',
                 'crm', 'classes', 'workouts', 'inventory', 'reports'],
    },
    {
      key: 'PROFESSIONAL', name: 'Professional', monthlyPrice: 5999, annualPrice: 59990,
      maxMembers: 2500, maxBranches: 5, maxStaff: 50, maxStorageMb: 51200,
      whatsappCredits: 20000, trialDays: 7, displayOrder: 3,
      tagline: 'Multi-branch, video library, white-label',
      features: ['members', 'memberships', 'attendance', 'billing', 'whatsapp', 'member_app',
                 'crm', 'classes', 'workouts', 'inventory', 'reports', 'video', 'payroll',
                 'white_label', 'advanced_analytics'],
    },
    {
      key: 'ENTERPRISE', name: 'Enterprise', monthlyPrice: 11999, annualPrice: 119990,
      maxMembers: null, maxBranches: null, maxStaff: null, maxStorageMb: 204800,
      whatsappCredits: 100000, trialDays: 7, displayOrder: 4,
      tagline: 'Unlimited scale, custom domain, priority support',
      features: ['members', 'memberships', 'attendance', 'billing', 'whatsapp', 'member_app',
                 'crm', 'classes', 'workouts', 'inventory', 'reports', 'video', 'payroll',
                 'white_label', 'advanced_analytics', 'custom_domain', 'api_access',
                 'priority_support'],
    },
  ];

  for (const plan of plans) {
    await prisma.platformPlan.upsert({
      where: { key: plan.key },
      create: plan,
      update: plan,
    });
  }
  log(`${plans.length} SaaS plans`);
}

async function seedFeatureFlags() {
  const flags = [
    { key: 'linkedin_integration', name: 'LinkedIn integration', defaultOn: false },
    { key: 'kiosk_mode', name: 'Reception kiosk mode', defaultOn: true },
    { key: 'member_self_renewal', name: 'Member self-service renewal', defaultOn: true },
    { key: 'progress_photos', name: 'Progress photographs', defaultOn: false },
    { key: 'bulk_whatsapp', name: 'Bulk WhatsApp campaigns', defaultOn: true },
  ];
  for (const flag of flags) {
    await prisma.featureFlag.upsert({ where: { key: flag.key }, create: flag, update: flag });
  }
  log(`${flags.length} feature flags`);
}

async function seedSharedExercises() {
  const exercises = [
    { name: 'Barbell Bench Press', muscleGroup: 'Chest', equipment: 'Barbell', difficulty: 'INTERMEDIATE' },
    { name: 'Push-up', muscleGroup: 'Chest', equipment: 'Bodyweight', difficulty: 'BEGINNER' },
    { name: 'Lat Pulldown', muscleGroup: 'Back', equipment: 'Cable machine', difficulty: 'BEGINNER' },
    { name: 'Deadlift', muscleGroup: 'Back', equipment: 'Barbell', difficulty: 'ADVANCED' },
    { name: 'Overhead Press', muscleGroup: 'Shoulders', equipment: 'Barbell', difficulty: 'INTERMEDIATE' },
    { name: 'Lateral Raise', muscleGroup: 'Shoulders', equipment: 'Dumbbell', difficulty: 'BEGINNER' },
    { name: 'Barbell Squat', muscleGroup: 'Legs', equipment: 'Barbell', difficulty: 'INTERMEDIATE' },
    { name: 'Leg Press', muscleGroup: 'Legs', equipment: 'Machine', difficulty: 'BEGINNER' },
    { name: 'Bicep Curl', muscleGroup: 'Arms', equipment: 'Dumbbell', difficulty: 'BEGINNER' },
    { name: 'Tricep Pushdown', muscleGroup: 'Arms', equipment: 'Cable machine', difficulty: 'BEGINNER' },
    { name: 'Plank', muscleGroup: 'Core', equipment: 'Bodyweight', difficulty: 'BEGINNER' },
    { name: 'Treadmill Run', muscleGroup: 'Cardio', equipment: 'Treadmill', difficulty: 'BEGINNER' },
  ] as const;

  for (const exercise of exercises) {
    const existing = await prisma.exercise.findFirst({
      where: { organizationId: null, name: exercise.name },
    });
    if (!existing) {
      await prisma.exercise.create({
        data: {
          organizationId: null,
          name: exercise.name,
          slug: exercise.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          muscleGroup: exercise.muscleGroup,
          equipment: exercise.equipment,
          difficulty: exercise.difficulty,
          instructions: 'Seeded library entry. Replace with your own coaching notes.',
        },
      });
    }
  }
  log(`${exercises.length} shared exercises`);
}

// ---------------------------------------------------------- demo tenants --

interface DemoGymSpec {
  slug: string;
  name: string;
  ownerEmail: string;
  branchName: string;
}

/**
 * Both demo gyms get the SAME member name, phone, member code, plan name and
 * invoice number. If anything leaks between tenants, the isolation tests see
 * two rows where there must be one.
 */
async function seedDemoGym(spec: DemoGymSpec) {
  const existing = await prisma.organization.findUnique({ where: { slug: spec.slug } });
  if (existing) {
    log(`gym ${spec.slug} already present, skipping`);
    return existing.id;
  }

  const starter = await prisma.platformPlan.findUniqueOrThrow({ where: { key: 'GROWTH' } });

  const org = await prisma.organization.create({
    data: {
      name: spec.name,
      slug: spec.slug,
      legalName: `${spec.name} Private Limited`,
      status: 'ACTIVE',
      ownerEmail: spec.ownerEmail,
      settings: {
        create: {
          gstin: '27AAAAA0000A1Z5',
          contactEmail: spec.ownerEmail,
          contactPhone: '02412345678',
          memberCodePrefix: 'M',
          memberCodeNextNumber: 2,
        },
      },
      branding: { create: { displayName: spec.name } },
      tenantSubscription: {
        create: {
          platformPlanId: starter.id,
          status: 'ACTIVE',
          billingCycle: 'MONTHLY',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 864e5),
        },
      },
    },
  });

  const branch = await prisma.branch.create({
    data: {
      organizationId: org.id,
      name: spec.branchName,
      code: 'MAIN',
      city: 'Chhatrapati Sambhajinagar',
      state: 'Maharashtra',
      isPrimary: true,
    },
  });

  const taxRate = await prisma.taxRate.create({
    data: {
      organizationId: org.id,
      name: 'GST 18%',
      percentage: 18,
      components: { cgst: 9, sgst: 9 },
      isDefault: true,
    },
  });

  // --- staff, one per system role ---------------------------------------
  const roleKeys = ['GYM_OWNER', 'GYM_MANAGER', 'RECEPTIONIST', 'TRAINER', 'ACCOUNTANT'] as const;
  const orgUserByRole = new Map<string, string>();

  for (const roleKey of roleKeys) {
    const role = await prisma.role.findFirstOrThrow({
      where: { organizationId: null, key: roleKey },
    });
    const email =
      roleKey === 'GYM_OWNER'
        ? spec.ownerEmail
        : `${roleKey.toLowerCase()}@${spec.slug}.example.com`;

    const user = await prisma.user.create({
      data: {
        email,
        fullName: `${roleKey.replace('_', ' ').toLowerCase()} (${spec.slug})`,
        status: 'ACTIVE',
        // No password is seeded. Accounts are activated through the invitation
        // flow, so no demo credential can ever reach production.
      },
    });

    const orgUser = await prisma.orgUser.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
        branches: { create: { organizationId: org.id, branchId: branch.id } },
        staffProfile: {
          create: {
            organizationId: org.id,
            designation: role.name,
            employeeCode: `E-${roleKey}`,
            joiningDate: new Date('2026-01-15'),
            salaryAmount: roleKey === 'GYM_OWNER' ? null : 25000,
          },
        },
      },
    });
    orgUserByRole.set(roleKey, orgUser.id);
  }

  // --- plan, member, subscription, invoice, payment, attendance ----------
  const plan = await prisma.membershipPlan.create({
    data: {
      organizationId: org.id,
      name: 'Monthly Membership',
      description: 'Full gym access, one month',
      category: 'GENERAL',
      durationUnit: 'MONTH',
      durationValue: 1,
      price: 1500,
      taxRateId: taxRate.id,
      graceDays: 3,
      planBranches: { create: { organizationId: org.id, branchId: branch.id } },
    },
  });

  const member = await prisma.member.create({
    data: {
      organizationId: org.id,
      branchId: branch.id,
      memberCode: 'M00001',
      firstName: 'Rahul',
      lastName: 'Sharma',
      phone: '9876543210',
      email: `rahul.sharma@${spec.slug}.example.com`,
      gender: 'MALE',
      dateOfBirth: new Date('1994-06-12'),
      joiningDate: new Date('2026-10-01'),
      status: 'ACTIVE',
      fitnessGoals: ['Weight loss', 'General fitness'],
      assignedTrainerOrgUserId: orgUserByRole.get('TRAINER'),
      emergencyContactName: 'Priya Sharma',
      emergencyContactPhone: '9876543211',
    },
  });

  const startDate = new Date('2026-11-01');
  const endDate = new Date('2026-11-30');

  const subscription = await prisma.subscription.create({
    data: {
      organizationId: org.id,
      memberId: member.id,
      planId: plan.id,
      branchId: branch.id,
      status: 'ACTIVE',
      startDate,
      endDate,
      graceUntil: new Date('2026-12-03'),
      listPrice: 1500,
      taxableAmount: 1271.19,
      taxAmount: 228.81,
      totalAmount: 1500,
      paidAmount: 1500,
      events: {
        create: {
          organizationId: org.id,
          eventType: 'CREATED',
          effectiveDate: startDate,
          amountDelta: 1500,
        },
      },
    },
  });

  await prisma.member.update({
    where: { id: member.id },
    data: { activeSubscriptionId: subscription.id, membershipExpiresAt: endDate },
  });

  await prisma.invoiceSequence.create({
    data: {
      organizationId: org.id,
      series: 'INV',
      financialYear: '2026-27',
      prefix: 'INV',
      nextNumber: 2,
    },
  });

  const invoice = await prisma.invoice.create({
    data: {
      organizationId: org.id,
      branchId: branch.id,
      memberId: member.id,
      series: 'INV',
      financialYear: '2026-27',
      invoiceNumber: 1,
      invoiceCode: 'INV/2026-27/00001',
      status: 'PAID',
      issueDate: startDate,
      subtotal: 1271.19,
      taxAmount: 228.81,
      total: 1500,
      amountPaid: 1500,
      amountDue: 0,
      lines: {
        create: {
          organizationId: org.id,
          description: 'Monthly Membership — November 2026',
          itemType: 'MEMBERSHIP',
          planId: plan.id,
          subscriptionId: subscription.id,
          quantity: 1,
          unitPrice: 1271.19,
          taxRateId: taxRate.id,
          taxPercentage: 18,
          taxAmount: 228.81,
          lineTotal: 1500,
        },
      },
    },
  });

  await prisma.payment.create({
    data: {
      organizationId: org.id,
      branchId: branch.id,
      memberId: member.id,
      invoiceId: invoice.id,
      subscriptionId: subscription.id,
      receiptCode: 'RCP/2026-27/00001',
      amount: 1500,
      method: 'UPI',
      status: 'CAPTURED',
      referenceNumber: '432198765432',
      receivedAt: startDate,
    },
  });

  await prisma.attendance.create({
    data: {
      organizationId: org.id,
      branchId: branch.id,
      memberId: member.id,
      subscriptionId: subscription.id,
      attendanceDate: new Date('2026-11-16'),
      method: 'MEMBER_QR',
      subscriptionStatusAtEntry: 'ACTIVE',
    },
  });

  await prisma.lead.create({
    data: {
      organizationId: org.id,
      branchId: branch.id,
      fullName: 'Anita Deshmukh',
      phone: '9123456780',
      source: 'INSTAGRAM',
      status: 'FOLLOW_UP',
      nextFollowUpAt: new Date('2026-11-19'),
      assignedToOrgUserId: orgUserByRole.get('RECEPTIONIST'),
      interestedPlanId: plan.id,
    },
  });

  log(`gym ${spec.slug.padEnd(14)} org=${org.id}`);
  return org.id;
}

async function main() {
  process.stdout.write('\nSeeding gym-cloud\n\n');

  process.stdout.write('platform\n');
  await seedPermissions();
  await seedSystemRoles();
  await seedPlatformPlans();
  await seedFeatureFlags();
  await seedSharedExercises();

  process.stdout.write('\ndemo tenants\n');
  await seedDemoGym({
    slug: 'iron-temple',
    name: 'Iron Temple Fitness',
    ownerEmail: 'owner@iron-temple.example.com',
    branchName: 'Iron Temple — Main',
  });
  await seedDemoGym({
    slug: 'pulse-fitness',
    name: 'Pulse Fitness Studio',
    ownerEmail: 'owner@pulse-fitness.example.com',
    branchName: 'Pulse — Main',
  });

  process.stdout.write('\nDone.\n\n');
}

main()
  .catch((error) => {
    process.stderr.write(`\nSeed failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
