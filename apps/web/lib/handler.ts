import { NextResponse } from 'next/server';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { basePrismaForAuth } from './db';
import {
  AppError,
  resolveSession,
  requirePermission,
  unauthenticated,
  type ActorContext,
} from '@gym/core';
import { readBearerToken, readSessionToken } from './session-cookie';

/**
 * The route handler wrapper.
 *
 * Every API route goes through here, and the order is deliberate:
 *
 *   origin check → session → permission → validation → the handler
 *
 * A handler therefore only ever runs with an authenticated actor who holds
 * the required permission and input that has already been parsed. It cannot
 * forget a check, because there is nowhere to forget it.
 */

export interface HandlerContext<TInput> {
  input: TInput;
  actor: ActorContext;
  request: Request;
  params: Record<string, string>;
  requestId: string;
  ipAddress?: string;
  userAgent?: string;
}

interface RouteOptions<TInput> {
  /** Omit for a public route such as login or registration. */
  permission?: string;
  /** Typed on the schema's OUTPUT, so defaults and transforms are applied
   *  before the handler ever sees the value. */
  schema?: ZodType<TInput, ZodTypeDef, unknown>;
  /** Public routes skip session resolution entirely. */
  public?: boolean;
  /** Where the input comes from. Defaults to the JSON body. */
  source?: 'body' | 'query';
}

function clientIp(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? undefined;
}

/**
 * CSRF: a SameSite=Lax cookie already blocks cross-site POSTs from a form,
 * and this closes the remaining gap for requests that carry an Origin.
 * Bearer-token clients are exempt — they do not send cookies, so there is
 * nothing for a third-party site to ride on.
 */
function assertSameOrigin(request: Request): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  if (readBearerToken(request)) return;

  const origin = request.headers.get('origin');
  if (!origin) return;

  const allowed = new Set(
    [process.env.APP_URL, process.env.NEXT_PUBLIC_APP_URL].filter(Boolean) as string[],
  );
  allowed.add(new URL(request.url).origin);

  const originHost = new URL(origin).host;
  const permitted = [...allowed].some((value) => {
    try {
      return new URL(value).host === originHost;
    } catch {
      return false;
    }
  });

  if (!permitted) {
    throw new AppError('FORBIDDEN', 'Request origin is not allowed.');
  }
}

export function route<TInput = unknown, TOutput = unknown>(
  options: RouteOptions<TInput>,
  handler: (ctx: HandlerContext<TInput>) => Promise<TOutput | NextResponse>,
) {
  return async function handle(
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ): Promise<NextResponse> {
    const requestId = crypto.randomUUID();

    try {
      assertSameOrigin(request);

      // --- session -------------------------------------------------------
      let actor: ActorContext | undefined;
      if (!options.public) {
        const token = readBearerToken(request) ?? (await readSessionToken());
        if (!token) throw unauthenticated();
        const resolved = await resolveSession(basePrismaForAuth(), token);
        actor = resolved.actor;

        if (options.permission) {
          requirePermission(actor.permissions, options.permission);
        }
      }

      // --- input ---------------------------------------------------------
      let input = {} as TInput;
      if (options.schema) {
        const raw =
          options.source === 'query'
            ? Object.fromEntries(new URL(request.url).searchParams)
            : await request.json().catch(() => ({}));
        input = options.schema.parse(raw);
      }

      const params = context?.params ? await context.params : {};

      const result = await handler({
        input,
        actor: actor as ActorContext,
        request,
        params,
        requestId,
        ipAddress: clientIp(request),
        userAgent: request.headers.get('user-agent') ?? undefined,
      });

      if (result instanceof NextResponse) return result;

      return NextResponse.json(
        { data: result },
        { status: request.method === 'POST' ? 201 : 200, headers: { 'x-request-id': requestId } },
      );
    } catch (error) {
      return toErrorResponse(error, requestId);
    }
  };
}

export function toErrorResponse(error: unknown, requestId: string): NextResponse {
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      issue: issue.message,
    }));
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Please correct the highlighted fields.',
          details,
        },
      },
      { status: 422, headers: { 'x-request-id': requestId } },
    );
  }

  if (error instanceof AppError) {
    return NextResponse.json(error.toResponseBody(), {
      status: error.status,
      headers: { 'x-request-id': requestId },
    });
  }

  // Unexpected: log it with the request id, tell the user nothing useful to
  // an attacker, and give them the id so support can find it.
  console.error(`[${requestId}]`, error);
  return NextResponse.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong on our side. Please try again.',
      },
    },
    { status: 500, headers: { 'x-request-id': requestId } },
  );
}

/** Pagination envelope, so every list endpoint answers in the same shape. */
export function paged<T>(
  rows: T[],
  total: number,
  page: number,
  pageSize: number,
): { data: T[]; meta: { page: number; pageSize: number; total: number; totalPages: number } } {
  return {
    data: rows,
    meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}
