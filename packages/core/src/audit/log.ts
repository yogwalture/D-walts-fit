import { withTenant } from '@gym/db';
import { requirePermission, type ResolvedPermissions } from '../rbac/engine';

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

// ------------------------------------------------- reading it back ---

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string | null;
  /** Who did it, in words. 'Platform support' when it was us. */
  actor: string;
  isPlatformActor: boolean;
  ipAddress: string | null;
  at: string;
}

export interface AuditQuery {
  page?: number;
  pageSize?: number;
  /** Only what platform staff did. This is the view a gym owner cares about. */
  platformOnly?: boolean;
  action?: string;
  entityType?: string;
  entityId?: string;
}

/**
 * A gym reading its own audit log.
 *
 * This is what makes the platform-access promise inspectable rather than
 * rhetorical. Every row written by platform staff — entering the gym,
 * extending a trial, agreeing a limit — lands in the gym's own log, and this
 * is where they read it. Without this, "the gym owner can see it" was a
 * sentence in a comment.
 *
 * before/after payloads are deliberately NOT returned: they can hold a
 * member's own details, and the point of this view is accountability for
 * actions, not a second place to browse people's records. Anybody who needs
 * the payload has the database.
 */
export async function listAudit(
  ctx: { organizationId: string; userId?: string },
  permissions: ResolvedPermissions,
  query: AuditQuery = {},
): Promise<{ rows: AuditEntry[]; total: number }> {
  requirePermission(permissions, 'org.audit.read');

  const page = query.page ?? 1;
  const pageSize = Math.min(query.pageSize ?? 50, 200);

  return withTenant(ctx, async (tx) => {
    const where = {
      ...(query.platformOnly ? { isPlatformActor: true } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
    };

    const [rows, total] = await Promise.all([
      tx.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          summary: true,
          isPlatformActor: true,
          actorRoleKey: true,
          ipAddress: true,
          createdAt: true,
          actor: { select: { fullName: true, email: true } },
        },
      }),
      tx.auditLog.count({ where }),
    ]);

    return {
      total,
      rows: rows.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        summary: row.summary,
        // Platform staff are named as such rather than by name: who at the
        // vendor pressed the button is our business, that the vendor did it
        // is theirs.
        actor: row.isPlatformActor
          ? 'Platform support'
          : (row.actor?.fullName ?? row.actor?.email ?? 'System'),
        isPlatformActor: row.isPlatformActor,
        ipAddress: row.ipAddress,
        at: row.createdAt.toISOString(),
      })),
    };
  });
}
