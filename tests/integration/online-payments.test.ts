/**
 * Taking money online.
 *
 * One rule is tested harder than everything else in this file, because it is
 * the rule that decides whether a gym can be robbed by anyone who can open
 * developer tools: **a frontend payment success message is never proof of
 * payment.** Every test below that looks like paranoia is enforcing it.
 *
 * Razorpay itself is stubbed at the HTTP boundary — the port the services
 * take — so these run with no network and no credentials. What they cannot
 * prove is that Razorpay's real API behaves as the stub does; that needs
 * real test keys, and until it has them the integration is recorded as
 * unverified in DEVELOPMENT_STATUS.md.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { authPrisma } from '@gym/db';
import {
  registerGym,
  createSession,
  resolveSession,
  createMember,
  createPlan,
  sellMembership,
  saveGatewaySettings,
  getGatewaySettings,
  setGatewayEnabled,
  gatewayCredentialsFor,
  gatewayByWebhookId,
  startOnlinePayment,
  confirmOnlinePayment,
  onlinePaymentAvailability,
  applyVerifiedGatewayPayment,
  AppError,
  type GatewayPort,
} from '@gym/core';
import { nextTestAddress } from '../support/addresses';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);

const KEY_ID = 'rzp_test_AbCdEfGhIjKlMn';
const KEY_SECRET = 'test_secret_do_not_use_anywhere';
const WEBHOOK_SECRET = 'webhook_secret_for_tests';

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

/**
 * A stand-in for Razorpay.
 *
 * Deliberately a liar on request: `state` decides what the "gateway" says a
 * payment's status is, so a test can hand the server a perfectly signed
 * confirmation for a payment that never succeeded and watch it refuse.
 */
function stubGateway(options: {
  state?: string;
  amountPaise?: number;
  orderIdFor?: string;
  orderAmount?: number;
} = {}) {
  const calls: string[] = [];
  let sequence = 0;

  const port: GatewayPort = {
    async createOrder(_config, input) {
      calls.push('createOrder');
      sequence += 1;
      return {
        id: `order_stub${sequence}${unique()}`,
        amount: options.orderAmount ?? input.amount,
        currency: input.currency ?? 'INR',
        status: 'created',
      };
    },
    async fetchPayment(_config, paymentId) {
      calls.push('fetchPayment');
      return {
        id: paymentId,
        status: options.state ?? 'captured',
        amount: options.amountPaise ?? 0,
        order_id: options.orderIdFor ?? '',
        method: 'upi',
      };
    },
    verifyCheckoutSignature(config, input) {
      calls.push('verifyCheckoutSignature');
      const expected = createHmac('sha256', config.keySecret)
        .update(`${input.orderId}|${input.paymentId}`)
        .digest('hex');
      return expected === input.signature;
    },
  };

  return { port, calls };
}

/** The signature a real Razorpay checkout hands the browser. */
function handoffSignature(orderId: string, paymentId: string): string {
  return createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

interface Gym {
  organizationId: string;
  userId: string;
  ctx: { organizationId: string; userId: string };
  permissions: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
}

async function freshGym(name: string): Promise<Gym> {
  const email = `online.${unique()}@example.com`;
  createdEmails.push(email);

  const created = await registerGym({
    gymName: `${name} ${unique()}`,
    ownerName: 'Online Owner',
    email,
    phone: '9876750000',
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

  return {
    organizationId: created.organizationId,
    userId: created.userId,
    ctx: { organizationId: created.organizationId, userId: created.userId },
    permissions: (await resolveSession(authPrisma, session.token)).actor.permissions,
  };
}

/** A gym with a connected gateway, a member, and an unpaid invoice. */
async function gymWithUnpaidInvoice(name: string) {
  const gym = await freshGym(name);

  await saveGatewaySettings(
    gym.ctx,
    gym.permissions,
    { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET },
    { verify: async () => undefined },
  );

  const member = await createMember(gym.ctx, gym.permissions, {
    firstName: 'Online',
    lastName: 'Payer',
    phone: `98${String(Date.now()).slice(-8)}`,
  });

  const plan = await createPlan(gym.ctx, gym.permissions, {
    name: `Online Plan ${unique()}`,
    durationDays: 90,
    price: '3000.00',
  });

  const sale = await sellMembership(gym.ctx, gym.permissions, {
    memberId: member.id,
    planId: plan.id,
    startDate: new Date().toISOString().slice(0, 10),
  });

  const invoice = await db.invoice.findFirstOrThrow({
    where: { organizationId: gym.organizationId, memberId: member.id },
    select: { id: true, invoiceCode: true, total: true, amountDue: true },
  });

  return { ...gym, memberId: member.id, invoice, sale };
}

beforeAll(async () => {
  // These tests store encrypted credentials, so the key has to be present.
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY must be set for the online payment suite.');
  }
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================

describe('a gym connecting their own gateway', () => {
  it('stores the credentials and gives them their own webhook URL', async () => {
    const gym = await freshGym('Connecting');

    const saved = await saveGatewaySettings(
      gym.ctx,
      gym.permissions,
      { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET },
      { verify: async () => undefined },
    );

    expect(saved.isVerified).toBe(true);
    expect(saved.isEnabled).toBe(true);
    expect(saved.isLiveMode).toBe(false);
    expect(saved.webhookUrl).toMatch(/\/api\/webhooks\/razorpay\/[A-Za-z0-9_-]{20,}$/);
    // Each gym's URL is its own, so one gym's webhook cannot carry another's.
    const other = await freshGym('Connecting Too');
    const otherSaved = await saveGatewaySettings(
      other.ctx,
      other.permissions,
      { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: 'a_different_webhook_secret' },
      { verify: async () => undefined },
    );
    expect(otherSaved.webhookUrl).not.toBe(saved.webhookUrl);
  });

  it('never hands the secret back, only enough to know one is stored', async () => {
    const gym = await freshGym('Secretive');
    await saveGatewaySettings(
      gym.ctx,
      gym.permissions,
      { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET },
      { verify: async () => undefined },
    );

    const view = await getGatewaySettings(gym.ctx, gym.permissions);

    expect(JSON.stringify(view)).not.toContain(KEY_SECRET);
    expect(JSON.stringify(view)).not.toContain(WEBHOOK_SECRET);
    // The hint distinguishes "nothing saved" from "something saved".
    expect(view.secretHint).toBeTruthy();
    expect(view.secretHint!.length).toBeLessThan(KEY_SECRET.length);
  });

  it('refuses to switch on credentials the gateway rejected', async () => {
    const gym = await freshGym('Rejected');

    await expect(
      saveGatewaySettings(
        gym.ctx,
        gym.permissions,
        { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET },
        {
          verify: async () => {
            throw new Error('Razorpay responded 401: authentication failed');
          },
        },
      ),
    ).rejects.toThrow(AppError);

    // Saved for them to correct, but off — nobody meets the failure at the
    // payment screen.
    const view = await getGatewaySettings(gym.ctx, gym.permissions);
    expect(view.isVerified).toBe(false);
    expect(view.isEnabled).toBe(false);
    expect(view.lastErrorCode).toContain('401');

    await expect(setGatewayEnabled(gym.ctx, gym.permissions, true)).rejects.toThrow(AppError);
  });

  it('refuses something that is not a Razorpay key id', async () => {
    const gym = await freshGym('Nonsense Key');

    await expect(
      saveGatewaySettings(
        gym.ctx,
        gym.permissions,
        { keyId: 'my-api-key', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET },
        { verify: async () => undefined },
      ),
    ).rejects.toThrow(AppError);
  });

  it('keeps one gym’s credentials unreadable to another', async () => {
    const mine = await freshGym('Mine');
    const theirs = await freshGym('Theirs');

    await saveGatewaySettings(
      theirs.ctx,
      theirs.permissions,
      { keyId: KEY_ID, keySecret: 'their_very_own_secret', webhookSecret: WEBHOOK_SECRET },
      { verify: async () => undefined },
    );

    const view = await getGatewaySettings(mine.ctx, mine.permissions);
    expect(view.keyId).toBeNull();
    expect(view.isVerified).toBe(false);

    // And the credential loader is scoped by organization, not by luck.
    expect(await gatewayCredentialsFor(mine.organizationId)).toBeNull();
    const loaded = await gatewayCredentialsFor(theirs.organizationId);
    expect(loaded!.keySecret).toBe('their_very_own_secret');
  });

  it('resolves a webhook id to exactly one gym', async () => {
    const gym = await freshGym('Hooked');
    const saved = await saveGatewaySettings(
      gym.ctx,
      gym.permissions,
      { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET },
      { verify: async () => undefined },
    );

    const webhookId = saved.webhookUrl!.split('/').pop()!;
    const resolved = await gatewayByWebhookId(webhookId);

    expect(resolved!.organizationId).toBe(gym.organizationId);
    expect(await gatewayByWebhookId('not-a-real-webhook-id')).toBeNull();
  });
});

// =========================================================================

describe('asking for an online payment', () => {
  it('creates an order for what is actually due, not what was asked for', async () => {
    const gym = await gymWithUnpaidInvoice('Ordering');
    const { port } = stubGateway();

    const started = await startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, port);

    // The amount comes from the invoice. A browser does not get to choose.
    expect(started.amountPaise).toBe(Math.round(Number(gym.invoice.amountDue) * 100));
    expect(started.keyId).toBe(KEY_ID);
    expect(started.orderId).toMatch(/^order_stub/);
    expect(started.isLiveMode).toBe(false);

    // The pending row is the link to the ledger, and it is PENDING.
    const pending = await db.payment.findFirstOrThrow({
      where: { razorpayOrderId: started.orderId },
      select: { status: true, method: true, receiptCode: true, amount: true },
    });
    expect(pending.status).toBe('PENDING');
    expect(pending.method).toBe('RAZORPAY');
    // No receipt for money that has not arrived: the series must stay gapless.
    expect(pending.receiptCode).toBeNull();
  });

  it('reuses an order already open on the same invoice', async () => {
    const gym = await gymWithUnpaidInvoice('Reusing');
    const { port, calls } = stubGateway();

    const first = await startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, port);
    const second = await startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, port);

    // Two live orders on one invoice is how an invoice gets paid twice.
    expect(second.orderId).toBe(first.orderId);
    expect(calls.filter((c) => c === 'createOrder')).toHaveLength(1);
  });

  it('abandons an order the gateway created for the wrong amount', async () => {
    const gym = await gymWithUnpaidInvoice('Wrong Amount');
    const { port } = stubGateway({ orderAmount: 100 });

    await expect(
      startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, port),
    ).rejects.toThrow(AppError);

    const rows = await db.payment.count({
      where: { organizationId: gym.organizationId, method: 'RAZORPAY' },
    });
    expect(rows).toBe(0);
  });

  it('will not start one for a gym with no gateway connected', async () => {
    const gym = await freshGym('Unconnected');
    const member = await createMember(gym.ctx, gym.permissions, {
      firstName: 'No',
      lastName: 'Gateway',
      phone: `97${String(Date.now()).slice(-8)}`,
    });
    const plan = await createPlan(gym.ctx, gym.permissions, {
      name: `Plan ${unique()}`,
      durationDays: 30,
      price: '1000.00',
    });
    await sellMembership(gym.ctx, gym.permissions, {
      memberId: member.id,
      planId: plan.id,
      startDate: new Date().toISOString().slice(0, 10),
    });
    const invoice = await db.invoice.findFirstOrThrow({
      where: { organizationId: gym.organizationId },
      select: { id: true },
    });

    const { port } = stubGateway();
    await expect(startOnlinePayment(gym.ctx, { invoiceId: invoice.id }, port)).rejects.toThrow(
      AppError,
    );

    const availability = await onlinePaymentAvailability(gym.ctx, gym.permissions);
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('not connected');
  });

  it('cannot be started against another gym’s invoice', async () => {
    const mine = await gymWithUnpaidInvoice('Mine Again');
    const theirs = await gymWithUnpaidInvoice('Theirs Again');
    const { port } = stubGateway();

    await expect(
      startOnlinePayment(mine.ctx, { invoiceId: theirs.invoice.id }, port),
    ).rejects.toThrow(AppError);
  });

  it('cannot be started by a member against somebody else’s invoice', async () => {
    const gym = await gymWithUnpaidInvoice('Nosy Member');
    const { port } = stubGateway();

    await expect(
      startOnlinePayment(
        gym.ctx,
        { invoiceId: gym.invoice.id, memberId: '00000000-0000-7000-8000-000000000000' },
        port,
      ),
    ).rejects.toThrow(AppError);
  });
});

// =========================================================================

describe('what the browser says is never the evidence', () => {
  it('refuses a confirmation with a forged signature', async () => {
    const gym = await gymWithUnpaidInvoice('Forged');
    const { port, calls } = stubGateway();
    const started = await startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, port);

    await expect(
      confirmOnlinePayment(
        gym.ctx,
        {
          orderId: started.orderId,
          razorpayPaymentId: 'pay_iMadeThisUp',
          signature: 'f'.repeat(64),
        },
        port,
      ),
    ).rejects.toThrow(AppError);

    // Refused before it ever asked the gateway anything.
    expect(calls).not.toContain('fetchPayment');

    const still = await db.payment.findFirstOrThrow({
      where: { razorpayOrderId: started.orderId },
      select: { status: true },
    });
    expect(still.status).toBe('PENDING');
  });

  it('records the forgery attempt in the gym’s own log', async () => {
    const gym = await gymWithUnpaidInvoice('Logged Forgery');
    const { port } = stubGateway();
    const started = await startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, port);

    await confirmOnlinePayment(
      gym.ctx,
      { orderId: started.orderId, razorpayPaymentId: 'pay_nope', signature: 'a'.repeat(64) },
      port,
    ).catch(() => undefined);

    const rows = await db.auditLog.findMany({
      where: { organizationId: gym.organizationId, action: 'payment.online.forged' },
    });
    expect(rows).toHaveLength(1);
  });

  it('refuses a correctly signed confirmation for a payment that never succeeded', async () => {
    const gym = await gymWithUnpaidInvoice('Signed But False');
    const { port: creator } = stubGateway();
    const started = await startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, creator);

    // The attacker's best case: a genuine, correctly signed handoff — which
    // Razorpay's own API then says was never captured.
    const { port } = stubGateway({
      state: 'failed',
      orderIdFor: started.orderId,
      amountPaise: started.amountPaise,
    });

    const result = await confirmOnlinePayment(
      gym.ctx,
      {
        orderId: started.orderId,
        razorpayPaymentId: 'pay_declined',
        signature: handoffSignature(started.orderId, 'pay_declined'),
      },
      port,
    );

    expect(result.state).toBe('failed');
    expect(result.message).toContain('Nothing has been taken');

    const still = await db.payment.findFirstOrThrow({
      where: { razorpayOrderId: started.orderId },
      select: { status: true },
    });
    expect(still.status).toBe('PENDING');
  });

  it('says "waiting on your bank" rather than failing, while it is still pending', async () => {
    const gym = await gymWithUnpaidInvoice('Waiting');
    const { port: creator } = stubGateway();
    const started = await startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, creator);

    const { port } = stubGateway({
      state: 'created',
      orderIdFor: started.orderId,
      amountPaise: started.amountPaise,
    });

    const result = await confirmOnlinePayment(
      gym.ctx,
      {
        orderId: started.orderId,
        razorpayPaymentId: 'pay_slow',
        signature: handoffSignature(started.orderId, 'pay_slow'),
      },
      port,
    );

    expect(result.state).toBe('pending');
    expect(result.message).toContain('not confirmed');
  });

  it('refuses a real payment that belongs to a different order', async () => {
    const gym = await gymWithUnpaidInvoice('Wrong Order');
    const { port: creator } = stubGateway();
    const started = await startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, creator);

    const { port } = stubGateway({
      state: 'captured',
      orderIdFor: 'order_somebodyElses',
      amountPaise: started.amountPaise,
    });

    await expect(
      confirmOnlinePayment(
        gym.ctx,
        {
          orderId: started.orderId,
          razorpayPaymentId: 'pay_elsewhere',
          signature: handoffSignature(started.orderId, 'pay_elsewhere'),
        },
        port,
      ),
    ).rejects.toThrow(AppError);
  });

  it('settles a genuine payment, with a receipt, and marks the invoice paid', async () => {
    const gym = await gymWithUnpaidInvoice('Genuine');
    const { port: creator } = stubGateway();
    const started = await startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, creator);

    const { port } = stubGateway({
      state: 'captured',
      orderIdFor: started.orderId,
      amountPaise: started.amountPaise,
    });

    const result = await confirmOnlinePayment(
      gym.ctx,
      {
        orderId: started.orderId,
        razorpayPaymentId: 'pay_genuine',
        signature: handoffSignature(started.orderId, 'pay_genuine'),
      },
      port,
    );

    expect(result.state).toBe('captured');
    // A member who pays by UPI has the same right to a receipt as one who
    // pays in notes, and the series must include online takings.
    expect(result.receiptCode).toMatch(/^RCP\//);

    const invoice = await db.invoice.findUniqueOrThrow({
      where: { id: gym.invoice.id },
      select: { status: true, amountDue: true },
    });
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amountDue)).toBe(0);

    const member = await db.member.findUniqueOrThrow({
      where: { id: gym.memberId },
      select: { outstandingAmount: true },
    });
    expect(Number(member.outstandingAmount)).toBe(0);
  });

  it('cannot bank the same payment twice, however many times it is confirmed', async () => {
    const gym = await gymWithUnpaidInvoice('Twice');
    const { port: creator } = stubGateway();
    const started = await startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, creator);

    const { port } = stubGateway({
      state: 'captured',
      orderIdFor: started.orderId,
      amountPaise: started.amountPaise,
    });

    const first = await confirmOnlinePayment(
      gym.ctx,
      {
        orderId: started.orderId,
        razorpayPaymentId: 'pay_once',
        signature: handoffSignature(started.orderId, 'pay_once'),
      },
      port,
    );
    const second = await confirmOnlinePayment(
      gym.ctx,
      {
        orderId: started.orderId,
        razorpayPaymentId: 'pay_once',
        signature: handoffSignature(started.orderId, 'pay_once'),
      },
      port,
    );

    expect(first.state).toBe('captured');
    expect(second.state).toBe('captured');
    // Same receipt, not a second one: the series is not inflated by retries.
    expect(second.receiptCode).toBe(first.receiptCode);

    const captured = await db.payment.count({
      where: { invoiceId: gym.invoice.id, status: 'CAPTURED' },
    });
    expect(captured).toBe(1);

    const invoice = await db.invoice.findUniqueOrThrow({
      where: { id: gym.invoice.id },
      select: { amountPaid: true, total: true },
    });
    expect(Number(invoice.amountPaid)).toBe(Number(invoice.total));
  });

  it('cannot bank the same webhook twice, which is what Razorpay retries do', async () => {
    const gym = await gymWithUnpaidInvoice('Retried Webhook');
    const { port } = stubGateway();
    const started = await startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, port);

    // The settlement path itself, called twice, exactly as a retried webhook
    // calls it. The earlier double-confirm test does not reach here, because
    // confirmOnlinePayment short-circuits on an already-captured row — so
    // without this test, removing the guard inside the settlement path goes
    // unnoticed. (It did, until this test was written.)
    const once = await applyVerifiedGatewayPayment(db, {
      organizationId: gym.organizationId,
      razorpayPaymentId: 'pay_retried',
      razorpayOrderId: started.orderId,
      amountPaise: started.amountPaise,
    });
    const again = await applyVerifiedGatewayPayment(db, {
      organizationId: gym.organizationId,
      razorpayPaymentId: 'pay_retried',
      razorpayOrderId: started.orderId,
      amountPaise: started.amountPaise,
    });

    expect(once.applied).toBe(true);
    expect(again.applied).toBe(true);
    expect(again.reason).toBe('already_captured');

    const invoice = await db.invoice.findUniqueOrThrow({
      where: { id: gym.invoice.id },
      select: { amountPaid: true, total: true, status: true },
    });
    // The number that would move if the guard were gone: paid twice over.
    expect(Number(invoice.amountPaid)).toBe(Number(invoice.total));
    expect(invoice.status).toBe('PAID');

    const member = await db.member.findUniqueOrThrow({
      where: { id: gym.memberId },
      select: { outstandingAmount: true },
    });
    expect(Number(member.outstandingAmount)).toBe(0);

    // And exactly one receipt number was consumed by the two calls.
    const receipts = await db.payment.findMany({
      where: { invoiceId: gym.invoice.id, status: 'CAPTURED' },
      select: { receiptCode: true },
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.receiptCode).toMatch(/^RCP\//);
  });

  it('reports captured when the webhook settled it first, without banking it again', async () => {
    const gym = await gymWithUnpaidInvoice('Webhook First');
    const { port: creator } = stubGateway();
    const started = await startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, creator);

    // The common race: the webhook lands while the member's phone is still
    // talking to us.
    await applyVerifiedGatewayPayment(db, {
      organizationId: gym.organizationId,
      razorpayPaymentId: 'pay_webhookfirst',
      razorpayOrderId: started.orderId,
      amountPaise: started.amountPaise,
    });

    const { port } = stubGateway({
      state: 'captured',
      orderIdFor: started.orderId,
      amountPaise: started.amountPaise,
    });
    const result = await confirmOnlinePayment(
      gym.ctx,
      {
        orderId: started.orderId,
        razorpayPaymentId: 'pay_webhookfirst',
        signature: handoffSignature(started.orderId, 'pay_webhookfirst'),
      },
      port,
    );

    expect(result.state).toBe('captured');
    expect(result.receiptCode).toMatch(/^RCP\//);

    const invoice = await db.invoice.findUniqueOrThrow({
      where: { id: gym.invoice.id },
      select: { amountPaid: true, total: true },
    });
    expect(Number(invoice.amountPaid)).toBe(Number(invoice.total));
  });

  it('refuses a webhook amount that disagrees with the invoice', async () => {
    const gym = await gymWithUnpaidInvoice('Short Paid');
    const { port } = stubGateway();
    const started = await startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, port);

    // Straight at the settlement path, as a verified webhook would arrive.
    const result = await applyVerifiedGatewayPayment(db, {
      organizationId: gym.organizationId,
      razorpayPaymentId: 'pay_short',
      razorpayOrderId: started.orderId,
      amountPaise: 100,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('amount_mismatch');
  });

  it('refuses a verified payment aimed at the wrong tenant', async () => {
    const gym = await gymWithUnpaidInvoice('Tenant Mix');
    const other = await freshGym('Other Tenant');
    const { port } = stubGateway();
    const started = await startOnlinePayment(gym.ctx, { invoiceId: gym.invoice.id }, port);

    const result = await applyVerifiedGatewayPayment(db, {
      organizationId: other.organizationId,
      razorpayPaymentId: 'pay_crosstenant',
      razorpayOrderId: started.orderId,
      amountPaise: started.amountPaise,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('tenant_mismatch');
  });
});
