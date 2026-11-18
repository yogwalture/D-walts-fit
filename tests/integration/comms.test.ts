/**
 * Messaging.
 *
 * One rule decides most of this: a message is marked sent only when a
 * provider has accepted it and handed back an id. Everything else stays
 * queued or is recorded as failed with a reason. A gym that believes a
 * member was told their membership expires, when nothing left the
 * building, makes decisions on that belief.
 *
 * So the tests are largely about what happens when things are *not* right:
 * no credentials, an unapproved template, an opt-out that lands while the
 * message is in the queue.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authPrisma } from '@gym/db';
import {
  registerGym,
  createSession,
  resolveSession,
  createMember,
  createPlan,
  sellMembership,
  createLead,
  listTemplates,
  createTemplate,
  updateTemplate,
  variablesIn,
  renderTemplate,
  describeSendability,
  resolveAudience,
  queueCampaign,
  drainMessageQueue,
  listMessages,
  listCampaigns,
  setPreference,
  recordInboundOptOut,
  getWhatsappSettings,
  applyWhatsappWebhook,
  queueExpiryReminders,
  encryptSecret,
  decryptSecret,
  secretHint,
  AppError,
} from '@gym/core';
import { toWhatsappNumber } from '@gym/integrations';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);

let gym: Awaited<ReturnType<typeof registerGym>>;
let ctx: { organizationId: string; userId: string };
let owner: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
let approvedTemplateId: string;
let memberIds: string[] = [];

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

beforeAll(async () => {
  process.env.ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

  const email = `comms.${unique()}@example.com`;
  createdEmails.push(email);

  gym = await registerGym({
    gymName: `Comms Gym ${unique()}`,
    ownerName: 'Comms Owner',
    email,
    phone: '9876680000',
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

  for (const [first, phone] of [
    ['Asha', '9840000001'],
    ['Bilal', '9840000002'],
    ['Chetan', '9840000003'],
  ] as const) {
    const member = await createMember(ctx, owner, { firstName: first, lastName: 'Member', phone });
    await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: plan.id,
      payment: { amount: '1500.00', method: 'CASH' },
    });
    memberIds.push(member.id);
  }

  const template = await createTemplate(ctx, owner, {
    name: 'Membership expiring',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    body: 'Hello {{memberName}}, your {{planName}} membership ends on {{expiryDate}}.',
    providerTemplateName: 'membership_expiring',
  });
  approvedTemplateId = template.id;

  // Meta approved it; nothing in this product can do that on Meta's behalf.
  await updateTemplate(ctx, owner, approvedTemplateId, { approvalStatus: 'APPROVED' });
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================

describe('credential encryption', () => {
  it('round-trips a secret', () => {
    const token = 'EAAG-not-a-real-token-0123456789';
    const stored = encryptSecret(token);
    expect(stored).not.toContain(token);
    expect(stored.startsWith('v1.')).toBe(true);
    expect(decryptSecret(stored)).toBe(token);
  });

  it('refuses a ciphertext somebody edited', () => {
    const stored = encryptSecret('secret-value');
    const [version, iv, tag, body] = stored.split('.');
    const tampered = [version, iv, tag, `${body!.slice(0, -2)}AA`].join('.');
    // GCM authenticates as well as encrypts, so this throws rather than
    // yielding plausible rubbish.
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('shows the tail of a token, never the head', () => {
    // A Meta token's prefix identifies the app; its tail identifies nothing.
    expect(secretHint('EAAGabcdefgh1234')).toBe('…1234');
  });

  it('stores the token so the database alone does not yield it', async () => {
    await db.whatsappSetting.create({
      data: {
        organizationId: gym.organizationId,
        phoneNumberId: '1234567890',
        accessTokenEncrypted: encryptSecret('super-secret-token'),
        isEnabled: false,
      },
    });

    const row = await db.whatsappSetting.findFirstOrThrow({
      where: { organizationId: gym.organizationId },
    });
    expect(row.accessTokenEncrypted).not.toContain('super-secret-token');

    const view = await getWhatsappSettings(ctx, owner);
    expect(view.tokenHint).toBe('…oken');
    expect(JSON.stringify(view)).not.toContain('super-secret-token');
  });
});

describe('templates', () => {
  it('finds the variables a body uses, in order and without repeats', () => {
    expect(variablesIn('Hi {{name}}, your {{plan}} ends soon, {{name}}.')).toEqual([
      'name',
      'plan',
    ]);
  });

  it('leaves an unknown variable visible rather than blanking it', () => {
    // A message that goes out reading "Hello ," is worse than one that
    // shows the hole in the template.
    expect(renderTemplate('Hello {{name}}, due {{date}}', { name: 'Asha' })).toBe(
      'Hello Asha, due {{date}}',
    );
  });

  it('will not send a WhatsApp template Meta has not approved', async () => {
    const draft = await createTemplate(ctx, owner, {
      name: `Offer ${unique()}`,
      channel: 'WHATSAPP',
      category: 'MARKETING',
      body: 'Hello {{memberName}}, 20% off this week.',
    });

    const templates = await listTemplates(ctx, owner);
    const row = templates.find((t) => t.id === draft.id)!;
    expect(row.sendable).toBe(false);
    expect(row.blockedReason).toMatch(/not approved this template/i);
  });

  it('needs the name Meta approved it under, not the gym’s own name', () => {
    const { sendable, blockedReason } = describeSendability({
      channel: 'WHATSAPP',
      isActive: true,
      approvalStatus: 'APPROVED',
      providerTemplateName: null,
    });
    expect(sendable).toBe(false);
    expect(blockedReason).toMatch(/approved this template under/i);
  });

  it('loses the approval when the wording changes', async () => {
    const template = await createTemplate(ctx, owner, {
      name: `Renewal ${unique()}`,
      channel: 'WHATSAPP',
      body: 'Hello {{memberName}}, time to renew.',
      providerTemplateName: 'renewal_v1',
    });
    await updateTemplate(ctx, owner, template.id, { approvalStatus: 'APPROVED' });

    await updateTemplate(ctx, owner, template.id, {
      body: 'Hi {{memberName}}, renew today and get a free shaker.',
    });

    const after = (await listTemplates(ctx, owner)).find((t) => t.id === template.id)!;
    // Meta approved particular words, not a slot to put words in.
    expect(after.approvalStatus).toBe('DRAFT');
    expect(after.sendable).toBe(false);
  });

  it('keeps the approval when only the gym’s own label changes', async () => {
    await updateTemplate(ctx, owner, approvedTemplateId, { name: 'Membership ending' });
    const after = (await listTemplates(ctx, owner)).find((t) => t.id === approvedTemplateId)!;
    expect(after.approvalStatus).toBe('APPROVED');
    expect(after.sendable).toBe(true);
  });
});

describe('the audience', () => {
  it('counts who a campaign would reach before anything is sent', async () => {
    const audience = await resolveAudience(ctx, owner, { kind: 'active' });
    expect(audience).toHaveLength(3);
    expect(audience[0]!.values.memberName).toMatch(/\w/);
    expect(audience[0]!.values.expiryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('can target enquiries rather than members', async () => {
    await createLead(ctx, owner, { fullName: 'Walk In', phone: '9840000009' });
    const audience = await resolveAudience(ctx, owner, { kind: 'leads' });
    expect(audience).toHaveLength(1);
    expect(audience[0]!.subjectType).toBe('LEAD');
  });
});

describe('queueing a campaign', () => {
  it('queues rather than sending, and says nothing has gone yet', async () => {
    const result = await queueCampaign(ctx, owner, {
      name: 'Expiry reminders',
      templateId: approvedTemplateId,
      audience: { kind: 'active' },
    });

    expect(result.queued).toBe(3);
    // WhatsApp is not connected in this gym, so the honest answer is that
    // nothing has been sent — not a tick and a number.
    expect(result.blockedReason).toMatch(/not connected/i);

    const messages = await listMessages(ctx, owner, { jobId: result.jobId });
    expect(messages).toHaveLength(3);
    expect(messages.every((m) => m.status === 'QUEUED')).toBe(true);
    expect(messages[0]!.body).toMatch(/your Monthly membership ends on/);
  });

  it('refuses to queue against a template that cannot send', async () => {
    const draft = await createTemplate(ctx, owner, {
      name: `Unapproved ${unique()}`,
      channel: 'WHATSAPP',
      body: 'Hello {{memberName}}.',
    });

    // Queueing four hundred messages that can never send is not a kindness.
    await expect(
      queueCampaign(ctx, owner, {
        name: 'Doomed',
        templateId: draft.id,
        audience: { kind: 'active' },
      }),
    ).rejects.toThrow(/not approved/i);
  });

  it('skips somebody who has opted out, and records why', async () => {
    await setPreference(ctx, owner, {
      subjectType: 'MEMBER',
      subjectId: memberIds[0]!,
      channel: 'WHATSAPP',
      category: 'UTILITY',
      optedIn: false,
      source: 'Asked at the desk',
    });

    const result = await queueCampaign(ctx, owner, {
      name: 'Second run',
      templateId: approvedTemplateId,
      audience: { kind: 'active' },
    });

    expect(result.queued).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.skippedReasons['opted out']).toBe(1);

    const skipped = (await listMessages(ctx, owner, { jobId: result.jobId })).find(
      (m) => m.status === 'SKIPPED',
    )!;
    expect(skipped.errorMessage).toMatch(/opted out/i);
  });

  it('treats marketing as opt-in and utility as opt-out', async () => {
    const marketing = await createTemplate(ctx, owner, {
      name: `Promo ${unique()}`,
      channel: 'WHATSAPP',
      category: 'MARKETING',
      body: 'Hello {{memberName}}, new classes this month.',
      providerTemplateName: 'promo_v1',
    });
    await updateTemplate(ctx, owner, marketing.id, { approvalStatus: 'APPROVED' });

    const result = await queueCampaign(ctx, owner, {
      name: 'Promo run',
      templateId: marketing.id,
      audience: { kind: 'active' },
    });

    // Nobody has opted in to marketing, so nobody is sent any.
    expect(result.queued).toBe(0);
    expect(result.skipped).toBe(3);
  });
});

describe('sending', () => {
  it('holds messages rather than failing them when WhatsApp is not connected', async () => {
    const before = await listMessages(ctx, owner, { status: 'QUEUED' });
    expect(before.length).toBeGreaterThan(0);

    const result = await drainMessageQueue({ organizationId: gym.organizationId });

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    // Held, not failed: they go the moment WhatsApp is connected, rather
    // than being buried as errors nobody revisits.
    expect(result.held).toBeGreaterThan(0);

    // Everything the drain held is still queued. The only rows that left
    // the queue are ones it deliberately skipped for an opt-out.
    const after = await listMessages(ctx, owner, { status: 'QUEUED' });
    expect(after.length).toBe(before.length - result.skipped);
    expect(after.length).toBeGreaterThan(0);
  });

  it('honours an opt-out that arrives while the message is queued', async () => {
    const queuedFor = (await listMessages(ctx, owner, { status: 'QUEUED' })).find(
      (m) => m.recipientName?.startsWith('Bilal'),
    )!;
    expect(queuedFor).toBeDefined();

    // The member replies STOP on WhatsApp; the webhook records it.
    await recordInboundOptOut({
      organizationId: gym.organizationId,
      subjectType: 'MEMBER',
      subjectId: memberIds[1]!,
      channel: 'WHATSAPP',
      source: 'Replied STOP',
    });

    await drainMessageQueue({ organizationId: gym.organizationId });

    const after = await listMessages(ctx, owner, {});
    const theirs = after.filter((m) => m.recipientName?.startsWith('Bilal'));
    expect(theirs.every((m) => m.status === 'SKIPPED' || m.status === 'FAILED')).toBe(true);
  });

  it('marks a message sent only when the provider returns an id', async () => {
    // A connected gym, with the provider stubbed: the point is what the
    // sender records, not that Meta works.
    await db.whatsappSetting.updateMany({
      where: { organizationId: gym.organizationId },
      data: {
        isEnabled: true,
        isVerified: true,
        phoneNumberId: '1234567890',
        accessTokenEncrypted: encryptSecret('test-token'),
      },
    });

    const integrations = await import('@gym/integrations');
    let counter = 0;
    const spy = vi
      .spyOn(integrations, 'sendWhatsappTemplate')
      // A distinct id per message, as a real provider gives: the column is
      // unique precisely so a duplicate cannot be recorded as two sends.
      .mockImplementation(async () => ({
        ok: true as const,
        providerMessageId: `wamid.TEST${(counter += 1)}`,
      }));

    const result = await drainMessageQueue({ organizationId: gym.organizationId });
    expect(result.sent).toBeGreaterThan(0);

    const sent = (await listMessages(ctx, owner, { status: 'SENT' }))[0]!;
    expect(sent).toBeDefined();
    expect(sent.sentAt).not.toBeNull();

    const row = await db.message.findFirstOrThrow({ where: { id: sent.id } });
    expect(row.providerMessageId).toMatch(/^wamid\.TEST\d+$/);

    // The number is handed to Meta in the form it wants.
    expect(spy.mock.calls[0]![1].to).toMatch(/^91\d{10}$/);
    spy.mockRestore();
  });

  it('gives up after three attempts rather than retrying for ever', async () => {
    const template = await createTemplate(ctx, owner, {
      name: `Retry ${unique()}`,
      channel: 'WHATSAPP',
      body: 'Hello {{memberName}}.',
      providerTemplateName: 'retry_v1',
    });
    await updateTemplate(ctx, owner, template.id, { approvalStatus: 'APPROVED' });

    await setPreference(ctx, owner, {
      subjectType: 'MEMBER',
      subjectId: memberIds[2]!,
      channel: 'WHATSAPP',
      category: 'UTILITY',
      optedIn: true,
    });

    const job = await queueCampaign(ctx, owner, {
      name: 'Flaky run',
      templateId: template.id,
      audience: { kind: 'selected', memberIds: [memberIds[2]!] },
    });
    expect(job.queued).toBe(1);

    const integrations = await import('@gym/integrations');
    const spy = vi.spyOn(integrations, 'sendWhatsappTemplate').mockResolvedValue({
      ok: false,
      configured: true,
      code: '130429',
      message: 'Rate limit hit',
      retryable: true,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await drainMessageQueue({ organizationId: gym.organizationId });
    }
    spy.mockRestore();

    const messages = await listMessages(ctx, owner, { jobId: job.jobId });
    expect(messages[0]!.status).toBe('FAILED');
    expect(messages[0]!.errorMessage).toMatch(/rate limit/i);
  });

  it('keeps going when one message blows up, rather than abandoning the batch', async () => {
    const template = await createTemplate(ctx, owner, {
      name: `Batch ${unique()}`,
      channel: 'WHATSAPP',
      body: 'Hello {{memberName}}.',
      providerTemplateName: 'batch_v1',
    });
    await updateTemplate(ctx, owner, template.id, { approvalStatus: 'APPROVED' });

    for (const id of memberIds) {
      await setPreference(ctx, owner, {
        subjectType: 'MEMBER',
        subjectId: id,
        channel: 'WHATSAPP',
        category: 'UTILITY',
        optedIn: true,
      });
    }

    const job = await queueCampaign(ctx, owner, {
      name: 'Batch run',
      templateId: template.id,
      audience: { kind: 'selected', memberIds },
    });
    expect(job.queued).toBe(3);

    const integrations = await import('@gym/integrations');
    let call = 0;
    const spy = vi.spyOn(integrations, 'sendWhatsappTemplate').mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error('provider exploded');
      return { ok: true as const, providerMessageId: `wamid.BATCH${call}` };
    });

    const result = await drainMessageQueue({ organizationId: gym.organizationId });
    spy.mockRestore();

    // The first one blew up; the other two still went. This runs on a
    // schedule with nobody watching, so the batch has to survive a bad row.
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);

    const messages = await listMessages(ctx, owner, { jobId: job.jobId });
    expect(messages.filter((m) => m.status === 'SENT')).toHaveLength(2);
    const failed = messages.find((m) => m.status === 'FAILED')!;
    expect(failed.errorMessage).toMatch(/provider exploded/);
  });

  it('closes a campaign once nothing is outstanding', async () => {
    const campaigns = await listCampaigns(ctx, owner, {});
    const open = campaigns.filter((c) => c.queuedCount > 0);
    const done = campaigns.filter((c) => c.queuedCount === 0 && c.recipientCount > 0);

    expect(done.length).toBeGreaterThan(0);
    // A campaign with nothing left to send is closed; one still holding
    // messages is not, so "running" means running.
    expect(done.every((c) => c.status === 'COMPLETED')).toBe(true);
    expect(open.every((c) => c.status !== 'COMPLETED')).toBe(true);
  });
});

describe('what WhatsApp tells us afterwards', () => {
  async function sendOne(): Promise<{ messageId: string; providerId: string }> {
    const template = await createTemplate(ctx, owner, {
      name: `Receipts ${unique()}`,
      channel: 'WHATSAPP',
      body: 'Hello {{memberName}}.',
      providerTemplateName: 'receipts_v1',
    });
    await updateTemplate(ctx, owner, template.id, { approvalStatus: 'APPROVED' });

    await setPreference(ctx, owner, {
      subjectType: 'MEMBER',
      subjectId: memberIds[2]!,
      channel: 'WHATSAPP',
      category: 'UTILITY',
      optedIn: true,
    });

    const job = await queueCampaign(ctx, owner, {
      name: `Receipt run ${unique()}`,
      templateId: template.id,
      audience: { kind: 'selected', memberIds: [memberIds[2]!] },
    });

    const providerId = `wamid.R${unique()}`;
    const integrations = await import('@gym/integrations');
    const spy = vi
      .spyOn(integrations, 'sendWhatsappTemplate')
      .mockResolvedValue({ ok: true, providerMessageId: providerId });
    await drainMessageQueue({ organizationId: gym.organizationId });
    spy.mockRestore();

    const row = await db.message.findFirstOrThrow({ where: { providerMessageId: providerId } });
    return { messageId: row.id, providerId };
  }

  it('turns a sent message into a delivered one', async () => {
    const { messageId, providerId } = await sendOne();

    await applyWhatsappWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '1234567890' },
                statuses: [
                  { id: providerId, status: 'delivered', timestamp: '1800000000' },
                ],
              },
            },
          ],
        },
      ],
    });

    // "We sent it" and "it arrived" are the difference between blaming the
    // member and blaming the number.
    const row = await db.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(row.status).toBe('DELIVERED');
    expect(row.deliveredAt).not.toBeNull();
  });

  it('records a provider failure against the message', async () => {
    const { messageId, providerId } = await sendOne();

    await applyWhatsappWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '1234567890' },
                statuses: [
                  {
                    id: providerId,
                    status: 'failed',
                    errors: [{ code: 131026, title: 'Message undeliverable' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const row = await db.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(row.status).toBe('FAILED');
    expect(row.errorMessage).toMatch(/undeliverable/i);
  });

  it('honours a STOP reply immediately', async () => {
    const member = await db.member.findUniqueOrThrow({ where: { id: memberIds[2]! } });

    const outcome = await applyWhatsappWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '1234567890' },
                messages: [{ from: `91${member.phone}`, text: { body: 'stop' } }],
              },
            },
          ],
        },
      ],
    });

    expect(outcome.optOuts).toBe(1);

    const preferences = await db.communicationPreference.findMany({
      where: { subjectId: memberIds[2]!, channel: 'WHATSAPP' },
    });
    // Across categories, not just the one they happened to receive: a
    // person who asked to be left alone has asked once.
    expect(preferences.length).toBeGreaterThanOrEqual(2);
    expect(preferences.every((p) => p.optedIn === false)).toBe(true);
  });

  it('ignores a receipt for a number that is not ours', async () => {
    const outcome = await applyWhatsappWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '9999999999' },
                statuses: [{ id: 'wamid.SOMEONEELSE', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    });

    // The tenant comes from our own records, never from the payload.
    expect(outcome.unknownTenant).toBe(true);
    expect(outcome.statusUpdates).toBe(0);
  });
});

describe('expiry reminders', () => {
  it('reports a gym that has no approved expiry template', async () => {
    const email = `reminder.${unique()}@example.com`;
    createdEmails.push(email);

    const bare = await registerGym({
      gymName: `Bare Gym ${unique()}`,
      ownerName: 'Bare Owner',
      email,
      phone: '9876700000',
      password: 'correct horse battery staple 47',
      planKey: 'PROFESSIONAL',
      acceptedTerms: true,
    });
    createdOrgIds.push(bare.organizationId);

    const run = await queueExpiryReminders({
      organizationId: bare.organizationId,
      daysAhead: 7,
    });

    // Counted rather than silently skipped: "nothing went out" and "there
    // was nothing to send with" are different problems with different fixes.
    expect(run.withoutTemplate).toBe(1);
    expect(run.queued).toBe(0);
  });

  it('queues one reminder per expiring membership, and never twice', async () => {
    const template = await createTemplate(ctx, owner, {
      key: 'membership_expiring_soon',
      name: 'Expiring soon',
      channel: 'WHATSAPP',
      category: 'UTILITY',
      body: 'Hello {{memberName}}, your {{planName}} ends on {{expiryDate}}.',
      providerTemplateName: 'expiring_soon',
    });
    await updateTemplate(ctx, owner, template.id, { approvalStatus: 'APPROVED' });

    for (const id of memberIds) {
      await setPreference(ctx, owner, {
        subjectType: 'MEMBER',
        subjectId: id,
        channel: 'WHATSAPP',
        category: 'UTILITY',
        optedIn: true,
      });
    }

    // Move one membership to exactly seven days out.
    const sevenDays = new Date(Date.now() + 7 * 86_400_000);
    sevenDays.setUTCHours(0, 0, 0, 0);
    await db.subscription.updateMany({
      where: { memberId: memberIds[0]!, organizationId: gym.organizationId },
      data: { endDate: sevenDays, status: 'ACTIVE' },
    });

    const first = await queueExpiryReminders({
      organizationId: gym.organizationId,
      daysAhead: 7,
    });
    expect(first.queued).toBe(1);

    // A scheduler that fires twice must not message anybody twice.
    const second = await queueExpiryReminders({
      organizationId: gym.organizationId,
      daysAhead: 7,
    });
    expect(second.queued).toBe(0);

    const messages = await db.message.findMany({
      where: { organizationId: gym.organizationId, recipientId: memberIds[0]! },
    });
    expect(messages.filter((m) => m.idempotencyKey?.startsWith('expiry:'))).toHaveLength(1);
  });
});

describe('the number Meta wants', () => {
  it('puts an Indian number into international form', () => {
    expect(toWhatsappNumber('9876543210')).toBe('919876543210');
    expect(toWhatsappNumber('919876543210')).toBe('919876543210');
    expect(toWhatsappNumber('09876543210')).toBe('919876543210');
    expect(toWhatsappNumber('+91 98765 43210')).toBe('919876543210');
  });
});

describe('one gym’s messages are not another’s', () => {
  it('cannot read or queue into another gym', async () => {
    const email = `comms.other.${unique()}@example.com`;
    createdEmails.push(email);

    const other = await registerGym({
      gymName: `Other Comms ${unique()}`,
      ownerName: 'Other Owner',
      email,
      phone: '9876690000',
      password: 'correct horse battery staple 47',
      planKey: 'PROFESSIONAL',
      acceptedTerms: true,
    });
    createdOrgIds.push(other.organizationId);

    const otherCtx = { organizationId: other.organizationId, userId: other.userId };
    const otherSession = await createSession(authPrisma, {
      userId: other.userId,
      organizationId: other.organizationId,
      type: 'WEB',
    });
    const otherOwner = (await resolveSession(authPrisma, otherSession.token)).actor.permissions;

    expect(await listMessages(otherCtx, otherOwner, {})).toHaveLength(0);
    expect(await listCampaigns(otherCtx, otherOwner, {})).toHaveLength(0);
    expect(await listTemplates(otherCtx, otherOwner)).toHaveLength(0);

    // Knowing our template id gains nothing.
    await expect(
      queueCampaign(otherCtx, otherOwner, {
        name: 'Mischief',
        templateId: approvedTemplateId,
        audience: { kind: 'active' },
      }),
    ).rejects.toThrow(/not found/i);

    const theirSettings = await getWhatsappSettings(otherCtx, otherOwner);
    expect(theirSettings.tokenHint).toBeNull();
    expect(theirSettings.isEnabled).toBe(false);
  });
});
