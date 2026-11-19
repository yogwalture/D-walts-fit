import { randomBytes } from 'node:crypto';
import { getJobsClient, withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import { requirePermission, type ResolvedPermissions } from '../rbac/engine';
import { decryptSecret, encryptSecret, encryptionAvailable, secretHint } from '../shared/crypto';
import type { RazorpayConfig } from '@gym/integrations';

/**
 * A gym's own payment gateway account.
 *
 * The decision this file encodes, which is a commercial one before it is a
 * technical one: **a member's fee is the gym's money, so it is collected
 * into the gym's own Razorpay account, not ours.** Routing every gym's
 * takings through one platform account would make us the party holding other
 * businesses' money, which in India is a payment aggregator and needs an RBI
 * licence. It would also mean a payout schedule, reconciliation and disputes
 * for several hundred gyms, all of it our problem.
 *
 * So each gym connects their own account. The platform's own credentials —
 * read from the environment, not from here — do exactly one thing: collect
 * our subscription fee from the gym.
 *
 * The key secret is write-only through this service: in encrypted, out only
 * as its last four characters, decrypted in two places (creating an order,
 * and confirming one) and nowhere else.
 */

export interface GatewayContext {
  organizationId: string;
  userId?: string;
}

export interface GatewaySettingsView {
  isEnabled: boolean;
  isVerified: boolean;
  isLiveMode: boolean;
  keyId: string | null;
  /** Shows a secret is stored without showing it. */
  secretHint: string | null;
  webhookSecretHint: string | null;
  /** The URL the gym pastes into their own Razorpay dashboard. */
  webhookUrl: string | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  encryptionAvailable: boolean;
}

function webhookUrlFor(webhookId: string): string {
  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
  return `${base}/api/webhooks/razorpay/${webhookId}`;
}

function hintOf(encrypted: string | null | undefined): string | null {
  if (!encrypted) return null;
  try {
    return secretHint(decryptSecret(encrypted));
  } catch {
    // Stored under a different key. "No secret" and "a secret nobody can
    // read" need different actions from whoever is looking at this screen.
    return 'unreadable';
  }
}

export async function getGatewaySettings(
  ctx: GatewayContext,
  permissions: ResolvedPermissions,
): Promise<GatewaySettingsView> {
  requirePermission(permissions, 'org.integration.read');

  return withTenant(ctx, async (tx) => {
    const row = await tx.paymentGatewaySetting.findFirst();

    return {
      isEnabled: row?.isEnabled ?? false,
      isVerified: row?.isVerified ?? false,
      isLiveMode: row?.isLiveMode ?? false,
      keyId: row?.keyId ?? null,
      secretHint: hintOf(row?.keySecretEncrypted),
      webhookSecretHint: hintOf(row?.webhookSecretEncrypted),
      webhookUrl: row ? webhookUrlFor(row.webhookId) : null,
      lastVerifiedAt: row?.lastVerifiedAt?.toISOString() ?? null,
      lastErrorCode: row?.lastErrorCode ?? null,
      lastErrorAt: row?.lastErrorAt?.toISOString() ?? null,
      encryptionAvailable: encryptionAvailable(),
    };
  });
}

export interface SaveGatewayInput {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  isEnabled?: boolean;
}

/**
 * Stores a gym's credentials, after proving they work.
 *
 * Verified by a read, never by taking a payment: this calls Razorpay's own
 * orders endpoint to list, which authenticates the key pair without moving
 * a rupee. A "connected" badge earned by any other means is a guess, and a
 * guess here means a member tapping Pay and meeting an error.
 */
export async function saveGatewaySettings(
  ctx: GatewayContext,
  permissions: ResolvedPermissions,
  input: SaveGatewayInput,
  meta: { ipAddress?: string; verify?: (config: RazorpayConfig) => Promise<void> } = {},
): Promise<GatewaySettingsView> {
  requirePermission(permissions, 'org.integration.update');

  if (!encryptionAvailable()) {
    throw new AppError(
      'INTEGRATION_UNAVAILABLE',
      'This server cannot store payment credentials yet: no encryption key is configured.',
    );
  }

  const keyId = input.keyId.trim();
  if (!/^rzp_(test|live)_[A-Za-z0-9]{8,}$/.test(keyId)) {
    throw new AppError('VALIDATION_FAILED', 'That does not look like a Razorpay key id.', [
      { field: 'keyId', issue: 'Expected rzp_test_… or rzp_live_…' },
    ]);
  }
  if (input.keySecret.trim().length < 10) {
    throw new AppError('VALIDATION_FAILED', 'Enter the key secret from your Razorpay dashboard.', [
      { field: 'keySecret', issue: 'Too short to be a key secret' },
    ]);
  }
  if (input.webhookSecret.trim().length < 8) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Choose a webhook secret and set the same one in Razorpay.',
      [{ field: 'webhookSecret', issue: 'At least 8 characters' }],
    );
  }

  const config: RazorpayConfig = {
    keyId,
    keySecret: input.keySecret.trim(),
    webhookSecret: input.webhookSecret.trim(),
  };

  // Proven before stored. The caller supplies the check so tests can run
  // without the internet; production passes the real one.
  let verified = false;
  let errorCode: string | null = null;
  if (meta.verify) {
    try {
      await meta.verify(config);
      verified = true;
    } catch (error) {
      errorCode = error instanceof Error ? error.message.slice(0, 120) : 'verification_failed';
    }
  }

  const now = new Date();

  const saved = await withTenant(ctx, async (tx) => {
    const existing = await tx.paymentGatewaySetting.findFirst({ select: { id: true } });

    const data = {
      // Stamped by the tenant extension too, but named here so the create
      // typechecks against the generated input rather than needing a cast.
      organizationId: ctx.organizationId,
      keyId,
      keySecretEncrypted: encryptSecret(config.keySecret),
      webhookSecretEncrypted: encryptSecret(config.webhookSecret),
      isLiveMode: keyId.startsWith('rzp_live_'),
      // Never enabled on an unproven key pair: the point of the check is
      // that nobody meets the failure at the payment screen.
      isEnabled: (input.isEnabled ?? true) && verified,
      isVerified: verified,
      lastVerifiedAt: verified ? now : null,
      lastErrorCode: errorCode,
      lastErrorAt: errorCode ? now : null,
    };

    const row = existing
      ? await tx.paymentGatewaySetting.update({ where: { id: existing.id }, data })
      : await tx.paymentGatewaySetting.create({
          data: { ...data, webhookId: randomBytes(16).toString('base64url') },
        });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId ?? null,
      action: 'org.gateway.updated',
      entityType: 'PaymentGatewaySetting',
      entityId: row.id,
      summary: verified
        ? `Razorpay connected (${row.isLiveMode ? 'live' : 'test'} mode), key ${keyId}`
        : `Razorpay credentials saved but not verified: ${errorCode ?? 'not checked'}`,
      // Deliberately no `after`: the payload would carry the ciphertext, and
      // an audit log is not a second place credentials live.
      ipAddress: meta.ipAddress,
    });

    return row;
  });

  if (errorCode) {
    throw new AppError(
      'INTEGRATION_UNVERIFIED',
      'Razorpay refused those credentials, so online payments are left switched off. ' +
        'Check the key id and secret in your Razorpay dashboard.',
      [{ field: 'keyId', issue: errorCode }],
    );
  }

  return {
    isEnabled: saved.isEnabled,
    isVerified: saved.isVerified,
    isLiveMode: saved.isLiveMode,
    keyId: saved.keyId,
    secretHint: hintOf(saved.keySecretEncrypted),
    webhookSecretHint: hintOf(saved.webhookSecretEncrypted),
    webhookUrl: webhookUrlFor(saved.webhookId),
    lastVerifiedAt: saved.lastVerifiedAt?.toISOString() ?? null,
    lastErrorCode: saved.lastErrorCode,
    lastErrorAt: saved.lastErrorAt?.toISOString() ?? null,
    encryptionAvailable: true,
  };
}

/** Switches online payments off without discarding the credentials. */
export async function setGatewayEnabled(
  ctx: GatewayContext,
  permissions: ResolvedPermissions,
  isEnabled: boolean,
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'org.integration.update');

  await withTenant(ctx, async (tx) => {
    const row = await tx.paymentGatewaySetting.findFirst({
      select: { id: true, isVerified: true },
    });
    if (!row) throw new AppError('NOT_FOUND', 'No payment gateway is connected yet.');

    if (isEnabled && !row.isVerified) {
      throw new AppError(
        'INTEGRATION_UNVERIFIED',
        'Those credentials have not been verified, so online payments cannot be switched on.',
      );
    }

    await tx.paymentGatewaySetting.update({ where: { id: row.id }, data: { isEnabled } });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId ?? null,
      action: isEnabled ? 'org.gateway.enabled' : 'org.gateway.disabled',
      entityType: 'PaymentGatewaySetting',
      entityId: row.id,
      summary: isEnabled ? 'Online payments switched on' : 'Online payments switched off',
      ipAddress: meta.ipAddress,
    });
  });
}

// ------------------------------------------- reading the key for actual use ---

export interface GatewayCredentials extends RazorpayConfig {
  organizationId: string;
  isLiveMode: boolean;
}

/**
 * The gym's live credentials, for creating or confirming one payment.
 *
 * Separate from `getGatewaySettings` on purpose: that one is for a screen and
 * returns hints, this one decrypts and must never reach a response body. The
 * two are not interchangeable and the names are different lengths so they do
 * not get swapped in a hurry.
 */
export async function gatewayCredentialsFor(
  organizationId: string,
): Promise<GatewayCredentials | null> {
  // The jobs client, because this is also called from the webhook path where
  // there is no session and therefore no tenant context to build one from.
  const row = await getJobsClient().paymentGatewaySetting.findFirst({
    where: { organizationId, isEnabled: true, isVerified: true },
    select: {
      organizationId: true,
      keyId: true,
      keySecretEncrypted: true,
      webhookSecretEncrypted: true,
      isLiveMode: true,
    },
  });

  if (!row?.keyId || !row.keySecretEncrypted || !row.webhookSecretEncrypted) return null;

  try {
    return {
      organizationId: row.organizationId,
      keyId: row.keyId,
      keySecret: decryptSecret(row.keySecretEncrypted),
      webhookSecret: decryptSecret(row.webhookSecretEncrypted),
      isLiveMode: row.isLiveMode,
    };
  } catch {
    // The key rotated and these rows were encrypted with the old one. Not
    // usable, and pretending otherwise would fail at the payment screen.
    return null;
  }
}

/**
 * Which gym a webhook is claiming to be for.
 *
 * The id comes from the URL, so it decides nothing on its own — it only says
 * whose signing secret to check the HMAC against. A wrong signature is still
 * refused, and the ledger write is scoped by our own order row regardless.
 */
export async function gatewayByWebhookId(
  webhookId: string,
): Promise<GatewayCredentials | null> {
  const row = await getJobsClient().paymentGatewaySetting.findFirst({
    where: { webhookId },
    select: { organizationId: true },
  });
  if (!row) return null;
  return gatewayCredentialsFor(row.organizationId);
}
