/**
 * Leads — the people who have not joined yet.
 *
 * A gym's growth is almost entirely this: someone walks in, asks the price,
 * says they will think about it, and is never called again. The dashboard
 * has counted open enquiries since Phase 1 and nothing could create one.
 *
 * So the follow-up is what these tests are mostly about. An enquiry with no
 * next date is the one that gets forgotten, and a conversion that half
 * happens is worse than one that does not.
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
  createLead,
  listLeads,
  getLead,
  updateLead,
  logActivity,
  convertLead,
  getPipeline,
  bookTrial,
  recordTrialOutcome,
  getDashboardSummary,
  businessDayIso,
  AppError,
} from '@gym/core';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);
const iso = (d: Date) => d.toISOString().slice(0, 10);
/**
 * Relative to the gym's own business day rather than to UTC.
 *
 * "Due today" means due on the gym's today, and after 18:30 UTC that is
 * tomorrow's UTC date — a test built on UTC passes only for part of a day.
 */
const daysFromNow = (n: number) =>
  businessDayIso('Asia/Kolkata', new Date(Date.now() + n * 86_400_000));

let gym: Awaited<ReturnType<typeof registerGym>>;
let ctx: { organizationId: string; userId: string };
let owner: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
let planId: string;

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

beforeAll(async () => {
  const email = `crm.${unique()}@example.com`;
  createdEmails.push(email);

  gym = await registerGym({
    gymName: `CRM Gym ${unique()}`,
    ownerName: 'CRM Owner',
    email,
    phone: '9876570000',
    password: 'correct horse battery staple 47',
    planKey: 'PROFESSIONAL',
    acceptedTerms: true,
  });
  createdOrgIds.push(gym.organizationId);
  ctx = { organizationId: gym.organizationId, userId: gym.userId };

  const session = await createSession(authPrisma, {
    userId: gym.userId,
    organizationId: gym.organizationId,
    type: 'WEB',
  });
  owner = (await resolveSession(authPrisma, session.token)).actor.permissions;

  const plan = await createPlan(ctx, owner, {
    name: 'Monthly',
    durationUnit: 'MONTH',
    durationValue: 1,
    price: '1500.00',
  });
  planId = plan.id;
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================
//  Recording an enquiry
// =========================================================================

describe('recording an enquiry', () => {
  it('always has a next follow-up, even when nobody set one', async () => {
    const lead = await createLead(ctx, owner, {
      fullName: 'Anita Shah',
      phone: '9830000001',
      source: 'WALK_IN',
      interestedPlanId: planId,
    });

    const row = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    // An enquiry with no next date is the one that gets forgotten, so one is
    // set whether or not the person at the desk thought about it.
    expect(row.nextFollowUpAt).not.toBeNull();
    expect(row.nextFollowUpAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.status).toBe('NEW');
  });

  it('warns when the same number enquires twice', async () => {
    await expect(
      createLead(ctx, owner, { fullName: 'Anita Again', phone: '9830000001' }),
    ).rejects.toThrow(/already an open enquiry/i);

    // Overridable, because one number can reach a whole family.
    const forced = await createLead(ctx, owner, {
      fullName: 'Anita Again',
      phone: '9830000001',
      allowDuplicate: true,
    });
    expect(forced.duplicateOf).not.toBeNull();
  });

  it('warns when the number already belongs to a member', async () => {
    await createMember(ctx, owner, {
      firstName: 'Already',
      lastName: 'Joined',
      phone: '9830000009',
    });

    const error = await createLead(ctx, owner, {
      fullName: 'Already Joined',
      phone: '9830000009',
    }).catch((e: AppError) => e);

    expect((error as AppError).code).toBe('DUPLICATE_LEAD');
    // Naming them saves a wasted call.
    expect((error as AppError).publicMessage).toMatch(/M\d{5}/);
  });
});

// =========================================================================
//  The follow-up, which is the whole point
// =========================================================================

describe('follow-ups', () => {
  it('puts the overdue ones first, because that is the list a gym works from', async () => {
    const overdue = await createLead(ctx, owner, {
      fullName: 'Forgotten Person',
      phone: '9830000002',
      nextFollowUpAt: daysFromNow(-5),
    });
    await createLead(ctx, owner, {
      fullName: 'Later Person',
      phone: '9830000003',
      nextFollowUpAt: daysFromNow(10),
    });

    const { rows } = await listLeads(ctx, owner, { filter: 'open' });
    expect(rows[0]!.id, 'the oldest follow-up is at the top').toBe(overdue.id);
    expect(rows[0]!.daysUntilFollowUp).toBeLessThan(0);
  });

  it('has an overdue filter and a due-today filter', async () => {
    const overdue = await listLeads(ctx, owner, { filter: 'overdue' });
    expect(overdue.total).toBeGreaterThanOrEqual(1);
    expect(overdue.rows.every((row) => (row.daysUntilFollowUp ?? 0) < 0)).toBe(true);

    await createLead(ctx, owner, {
      fullName: 'Due Today',
      phone: '9830000004',
      nextFollowUpAt: daysFromNow(0),
    });

    const dueToday = await listLeads(ctx, owner, { filter: 'today' });
    expect(dueToday.rows.some((row) => row.fullName === 'Due Today')).toBe(true);
  });

  it('logs a call and sets the next date in one action', async () => {
    const { rows } = await listLeads(ctx, owner, { search: 'Forgotten' });
    const lead = rows[0]!;

    await logActivity(ctx, owner, {
      leadId: lead.id,
      activityType: 'CALL',
      outcome: 'Asked to call back next week',
      notes: 'Comparing us with the gym near the station',
      nextFollowUpAt: daysFromNow(7),
      status: 'FOLLOW_UP',
    });

    const after = await getLead(ctx, owner, lead.id);
    expect(after.status).toBe('FOLLOW_UP');
    expect(after.activities[0]!.activityType).toBe('CALL');
    expect(after.activities[0]!.outcome).toBe('Asked to call back next week');

    // The next date moved, which is the part that keeps the lead alive.
    const daysOut = Math.round(
      (after.nextFollowUpAt!.getTime() - Date.now()) / 86_400_000,
    );
    expect(daysOut).toBeGreaterThanOrEqual(6);
  });

  it('takes a lost enquiry off the follow-up list entirely', async () => {
    const lost = await createLead(ctx, owner, {
      fullName: 'Went Elsewhere',
      phone: '9830000005',
    });

    await expect(
      updateLead(ctx, owner, lost.id, { status: 'LOST' }),
    ).rejects.toThrow(/why this enquiry was lost/i);

    await updateLead(ctx, owner, lost.id, {
      status: 'LOST',
      lostReason: 'Joined the gym near their office',
    });

    const row = await db.lead.findUniqueOrThrow({ where: { id: lost.id } });
    expect(row.status).toBe('LOST');
    expect(row.lostAt).not.toBeNull();
    // Otherwise it sits in the overdue list forever, and the list stops
    // being something anyone trusts.
    expect(row.nextFollowUpAt).toBeNull();

    const overdue = await listLeads(ctx, owner, { filter: 'overdue' });
    expect(overdue.rows.some((r) => r.id === lost.id)).toBe(false);
  });
});

// =========================================================================
//  Trials
// =========================================================================

describe('trial sessions', () => {
  let trialLeadId: string;

  it('books one and follows up the day after', async () => {
    const lead = await createLead(ctx, owner, {
      fullName: 'Trial Person',
      phone: '9830000006',
    });
    trialLeadId = lead.id;

    const when = new Date(Date.now() + 2 * 86_400_000);
    await bookTrial(ctx, owner, { leadId: lead.id, scheduledFor: when.toISOString() });

    const row = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.status).toBe('TRIAL_BOOKED');
    // The answer comes the day after the trial, so that is when to call.
    const followUpDay = Math.round(
      (row.nextFollowUpAt!.getTime() - when.getTime()) / 86_400_000,
    );
    expect(followUpDay).toBe(1);
  });

  it('records whether they turned up', async () => {
    const lead = await getLead(ctx, owner, trialLeadId);
    const booking = lead.trialBookings[0]!;

    await recordTrialOutcome(ctx, owner, {
      bookingId: booking.id,
      attended: true,
      feedback: 'Liked the free weights area',
    });

    const after = await getLead(ctx, owner, trialLeadId);
    expect(after.trialBookings[0]!.attended).toBe(true);
    expect(after.activities.some((a) => a.activityType === 'TRIAL')).toBe(true);
  });

  it('refuses a date it cannot read', async () => {
    await expect(
      bookTrial(ctx, owner, { leadId: trialLeadId, scheduledFor: 'next tuesday' }),
    ).rejects.toThrow(AppError);
  });
});

// =========================================================================
//  Converting
// =========================================================================

describe('converting an enquiry', () => {
  it('creates the member and links both ways in one transaction', async () => {
    const lead = await createLead(ctx, owner, {
      fullName: 'Ramesh Pawar',
      phone: '9830000007',
      email: 'ramesh@example.com',
      city: 'Pune',
      source: 'INSTAGRAM',
    });

    const result = await convertLead(ctx, owner, { leadId: lead.id });

    expect(result.memberCode).toMatch(/^M\d{5}$/);

    const member = await db.member.findUniqueOrThrow({ where: { id: result.memberId } });
    expect(member.firstName).toBe('Ramesh');
    expect(member.lastName).toBe('Pawar');
    expect(member.email).toBe('ramesh@example.com');
    expect(member.city).toBe('Pune');
    // No membership sold yet, so not active — selling one is the next step.
    expect(member.status).toBe('INACTIVE');
    // The link that lets a gym answer "which members came from Instagram"
    // a year later, which is the only way to know if the advertising worked.
    expect(member.convertedFromLeadId).toBe(lead.id);

    const row = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.status).toBe('CONVERTED');
    expect(row.convertedAt).not.toBeNull();
    expect(row.nextFollowUpAt, 'no longer needs chasing').toBeNull();
  });

  it('says where a member came from, on their own timeline', async () => {
    const entry = await db.memberTimelineEntry.findFirst({
      where: { organizationId: gym.organizationId, sourceType: 'Lead' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(entry?.title).toContain('instagram');
  });

  it('cannot be done twice', async () => {
    const { rows } = await listLeads(ctx, owner, { filter: 'converted' });
    await expect(
      convertLead(ctx, owner, { leadId: rows[0]!.id }),
    ).rejects.toThrow(/already become a member/i);
  });

  it('warns when the number is already a member', async () => {
    const lead = await createLead(ctx, owner, {
      fullName: 'Already Joined',
      phone: '9830000009',
      allowDuplicate: true,
    });

    await expect(convertLead(ctx, owner, { leadId: lead.id })).rejects.toThrow(
      /already has that number/i,
    );

    // Still possible deliberately, for a family sharing a number.
    const forced = await convertLead(ctx, owner, {
      leadId: lead.id,
      allowDuplicate: true,
    });
    expect(forced.memberCode).toMatch(/^M\d{5}$/);
  });

  it('refuses to log activity against a converted enquiry', async () => {
    const { rows } = await listLeads(ctx, owner, { filter: 'converted' });
    await expect(
      logActivity(ctx, owner, { leadId: rows[0]!.id, activityType: 'CALL' }),
    ).rejects.toThrow(AppError);
  });
});

// =========================================================================
//  The pipeline
// =========================================================================

describe('the pipeline', () => {
  it('counts what is open, overdue and due today', async () => {
    const pipeline = await getPipeline(ctx, owner, {});

    expect(pipeline.openTotal).toBeGreaterThan(0);
    expect(pipeline.overdueTotal).toBeGreaterThanOrEqual(0);
    expect(pipeline.byStatus.length).toBeGreaterThan(0);
  });

  it('says which sources actually bring people in', async () => {
    const pipeline = await getPipeline(ctx, owner, {});
    const sources = pipeline.bySource.map((row) => row.label);
    expect(sources).toContain('walk in');
    expect(sources).toContain('instagram');
    // Largest first, because that is the one worth spending on.
    expect(pipeline.bySource[0]!.value).toBeGreaterThanOrEqual(
      pipeline.bySource[pipeline.bySource.length - 1]!.value,
    );
  });

  it('reports a conversion rate out of concluded enquiries, not all of them', async () => {
    const pipeline = await getPipeline(ctx, owner, {});

    // Open enquiries have not failed — counting them against the rate would
    // make a gym that is busy look like a gym that is losing.
    expect(pipeline.conversionRate).toBeGreaterThan(0);
    expect(pipeline.conversionRate).toBeLessThanOrEqual(100);

    const expected = Math.round(
      (pipeline.convertedInRange / (pipeline.convertedInRange + pipeline.lostInRange)) * 100,
    );
    expect(pipeline.conversionRate).toBe(expected);
  });

  it('feeds the dashboard, which has counted enquiries since Phase 1', async () => {
    const summary = await getDashboardSummary(ctx, owner, { range: 'last30' });
    expect(summary.leads.open).toBeGreaterThan(0);
    expect(summary.leads.newInRange).toBeGreaterThan(0);
    expect(summary.leads.convertedInRange).toBeGreaterThan(0);
  });
});

// =========================================================================
//  Isolation
// =========================================================================

describe('an enquiry belongs to one gym', () => {
  it('is never another gym’s', async () => {
    const otherOrg = await db.organization.findFirstOrThrow({ where: { slug: 'iron-temple' } });
    const theirs = await db.lead.findFirst({
      where: { organizationId: otherOrg.id },
      select: { id: true },
    });

    if (theirs) {
      await expect(getLead(ctx, owner, theirs.id)).rejects.toThrow(AppError);
      await expect(
        convertLead(ctx, owner, { leadId: theirs.id }),
      ).rejects.toThrow(AppError);
    }

    const ours = await listLeads(ctx, owner, { pageSize: 100 });
    for (const row of ours.rows) {
      const record = await db.lead.findUniqueOrThrow({ where: { id: row.id } });
      expect(record.organizationId).toBe(gym.organizationId);
    }
  });
});
