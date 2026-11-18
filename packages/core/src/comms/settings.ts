import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import { requirePermission, type ResolvedPermissions } from '../rbac/engine';
import { decryptSecret, encryptSecret, encryptionAvailable, secretHint } from '../shared/crypto';
import type { CommsContext } from './templates';

/**
 * A gym's own WhatsApp Business connection.
 *
 * Each gym brings its own number and its own token: one shared number would
 * put every gym's messages — and every gym's ban risk — on one account.
 *
 * The access token is write-only through this service. It goes in
 * encrypted, it comes back only as its last four characters, and it is
 * decrypted in exactly one place: the sender.
 */

export interface WhatsappSettingsView {
  isEnabled: boolean;
  isVerified: boolean;
  wabaId: string | null;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  businessName: string | null;
  /** Shows a token is stored without showing the token. */
  tokenHint: string | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  /** Whether this server can store credentials at all. */
  encryptionAvailable: boolean;
}

export async function getWhatsappSettings(
  ctx: CommsContext,
  permissions: ResolvedPermissions,
): Promise<WhatsappSettingsView> {
  requirePermission(permissions, 'comms.template.read');

  return withTenant(ctx, async (tx) => {
    const row = await tx.whatsappSetting.findFirst();

    let tokenHint: string | null = null;
    if (row?.accessTokenEncrypted) {
      try {
        tokenHint = secretHint(decryptSecret(row.accessTokenEncrypted));
      } catch {
        // Stored under a different key: say so rather than showing nothing,
        // because "no token" and "a token nobody can read" need different
        // actions from whoever is looking.
        tokenHint = 'unreadable';
      }
    }

    return {
      isEnabled: row?.isEnabled ?? false,
      isVerified: row?.isVerified ?? false,
      wabaId: row?.wabaId ?? null,
      phoneNumberId: row?.phoneNumberId ?? null,
      displayPhoneNumber: row?.displayPhoneNumber ?? null,
      businessName: row?.businessName ?? null,
      tokenHint,
      lastVerifiedAt: row?.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
      lastErrorCode: row?.lastErrorCode ?? null,
      lastErrorAt: row?.lastErrorAt ? row.lastErrorAt.toISOString() : null,
      encryptionAvailable: encryptionAvailable(),
    };
  });
}

/**
 * Stores the credentials and checks them in the same breath.
 *
 * The check is a read of the gym's own number, never a send: verifying a
 * connection should not message anybody. The connection is only switched on
 * if that read succeeds — a connection marked live that has never worked is
 * the thing a gym finds out about at the worst moment.
 */
export async function saveWhatsappSettings(
  ctx: CommsContext,
  permissions: ResolvedPermissions,
  input: {
    wabaId?: string;
    phoneNumberId: string;
    accessToken?: string;
    businessName?: string;
    webhookVerifyToken?: string;
  },
  meta: { ipAddress?: string } = {},
): Promise<{ verified: boolean; displayPhoneNumber: string | null; message: string }> {
  requirePermission(permissions, 'comms.template.manage');

  if (input.accessToken && !encryptionAvailable()) {
    throw new AppError(
      'INTEGRATION_NOT_CONFIGURED',
      'This server has no encryption key, so a WhatsApp token cannot be stored safely. Set ENCRYPTION_KEY first.',
    );
  }

  const { verifyWhatsappCredentials } = await import('@gym/integrations');

  return withTenant(ctx, async (tx) => {
    const existing = await tx.whatsappSetting.findFirst();

    const token = input.accessToken
      ? input.accessToken
      : existing?.accessTokenEncrypted
        ? decryptSecret(existing.accessTokenEncrypted)
        : null;

    if (!token) {
      throw new AppError('VALIDATION_FAILED', 'An access token is needed to connect WhatsApp.', [
        { field: 'accessToken', issue: 'Required' },
      ]);
    }

    const check = await verifyWhatsappCredentials({
      phoneNumberId: input.phoneNumberId.trim(),
      accessToken: token,
    });

    const data = {
      organizationId: ctx.organizationId,
      wabaId: input.wabaId?.trim() || existing?.wabaId || null,
      phoneNumberId: input.phoneNumberId.trim(),
      businessName: input.businessName?.trim() || existing?.businessName || null,
      webhookVerifyToken:
        input.webhookVerifyToken?.trim() || existing?.webhookVerifyToken || null,
      ...(input.accessToken ? { accessTokenEncrypted: encryptSecret(input.accessToken) } : {}),
      isVerified: check.ok,
      // Only a connection that has actually answered is switched on.
      isEnabled: check.ok,
      ...(check.ok
        ? {
            displayPhoneNumber: check.displayPhoneNumber || null,
            lastVerifiedAt: new Date(),
            lastErrorCode: null,
            lastErrorAt: null,
          }
        : { lastErrorCode: 'VERIFY_FAILED', lastErrorAt: new Date() }),
    };

    if (existing) {
      await tx.whatsappSetting.update({ where: { id: existing.id }, data });
    } else {
      await tx.whatsappSetting.create({ data });
    }

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'comms.whatsapp.configure',
      entityType: 'WhatsappSetting',
      entityId: ctx.organizationId,
      // The token never reaches the audit log, only the fact of a change.
      summary: check.ok
        ? 'Connected WhatsApp and verified the number'
        : 'Saved WhatsApp credentials; verification failed',
      after: { verified: check.ok, phoneNumberId: input.phoneNumberId.trim() },
      ipAddress: meta.ipAddress,
    });

    return {
      verified: check.ok,
      displayPhoneNumber: check.ok ? check.displayPhoneNumber : null,
      message: check.ok
        ? `Connected. Messages will send from ${check.displayPhoneNumber}.`
        : `Saved, but WhatsApp refused the credentials: ${check.message} Nothing will send until this is fixed.`,
    };
  });
}

export async function disconnectWhatsapp(
  ctx: CommsContext,
  permissions: ResolvedPermissions,
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'comms.template.manage');

  await withTenant(ctx, async (tx) => {
    const existing = await tx.whatsappSetting.findFirst({ select: { id: true } });
    if (!existing) return;

    await tx.whatsappSetting.update({
      where: { id: existing.id },
      data: {
        isEnabled: false,
        isVerified: false,
        accessTokenEncrypted: null,
        lastErrorCode: null,
        lastErrorAt: null,
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'comms.whatsapp.disconnect',
      entityType: 'WhatsappSetting',
      entityId: ctx.organizationId,
      summary: 'Disconnected WhatsApp and deleted the stored token',
      ipAddress: meta.ipAddress,
    });
  });
}
