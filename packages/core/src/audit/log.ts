/**
 * Audit logging.
 *
 * Written inside the same transaction as the change it records, so the log
 * and the data cannot disagree. A change that rolls back takes its audit row
 * with it; a change that commits can never be missing one.
 */

export interface AuditInput {
  organizationId: string | null;
  actorUserId: string | null;
  actorRoleKey?: string | null;
  isPlatformActor?: boolean;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

/** Field names whose values never reach the audit log. */
const REDACTED = new Set([
  'password', 'passwordHash', 'mfaSecret', 'mfaRecoveryCodes', 'tokenHash',
  'refreshTokenHash', 'accessTokenEncrypted', 'webhookVerifyToken',
  'razorpaySignature', 'bankAccountMasked', 'bankIfsc', 'panMasked',
]);

/**
 * Keeps the shape of a change while removing anything that would turn the
 * audit log into a second place credentials live.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED.has(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return out;
}

export async function writeAudit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  input: AuditInput,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      actorRoleKey: input.actorRoleKey ?? null,
      isPlatformActor: input.isPlatformActor ?? false,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: input.summary,
      beforeData: input.before === undefined ? undefined : (redact(input.before) as object),
      afterData: input.after === undefined ? undefined : (redact(input.after) as object),
      ipAddress: input.ipAddress,
      userAgent: input.userAgent?.slice(0, 500),
      requestId: input.requestId,
    },
  });
}

/** Records platform staff entering a tenant. The gym owner can see this. */
export async function auditPlatformAccess(
  tx: any,
  input: { organizationId: string; actorUserId: string; reason?: string; ipAddress?: string },
): Promise<void> {
  await writeAudit(tx, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    isPlatformActor: true,
    action: 'platform.tenant.accessed',
    entityType: 'Organization',
    entityId: input.organizationId,
    summary: input.reason ?? 'Platform support access',
    ipAddress: input.ipAddress,
  });
}
