import { AppError, type ActorContext } from '@gym/core';

/**
 * The tenant context every service call takes.
 *
 * Built from the session actor and nothing else — never from a header, query
 * parameter or request body. A client cannot ask to act on another gym
 * because there is no input through which to say so.
 */
export interface TenantRequestContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

export function tenantOf(actor: ActorContext): TenantRequestContext {
  if (!actor.organizationId) {
    // A platform admin who has not selected a gym, or a half-finished
    // registration. Either way there is no tenant to operate inside.
    throw new AppError('FORBIDDEN', 'Select a gym before using this.');
  }

  return {
    organizationId: actor.organizationId,
    userId: actor.userId,
    branchIds: actor.permissions.branchIds?.length ? actor.permissions.branchIds : undefined,
  };
}
