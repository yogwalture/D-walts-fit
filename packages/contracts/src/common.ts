import { z } from 'zod';

/**
 * Shared primitives. Every API route validates against schemas built from
 * these, and the client infers its types from the same objects — so a
 * mismatch between what the server accepts and what the client sends is a
 * compile error, not a production bug.
 */

export const uuid = z.string().uuid();

/** Indian mobile number, stored as 10 digits without the country code. */
export const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+91|91|0)/, ''))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'));

export const email = z.string().trim().toLowerCase().email();

export const money = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v.toFixed(2) : v))
  .pipe(z.string().regex(/^-?\d{1,10}(\.\d{1,2})?$/, 'Enter a valid amount'));

/** A business day, not an instant. */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const isoDateTime = z.string().datetime({ offset: true });

// --------------------------------------------------------- pagination ---

/**
 * Every list endpoint paginates. The default is applied server-side, so an
 * endpoint cannot accidentally return a whole table — which on shared
 * hosting is also how a 120-second request timeout gets hit.
 */
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.string().max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().trim().max(200).optional(),
});

export const cursorQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type PageQuery = z.infer<typeof pageQuery>;
export type CursorQuery = z.infer<typeof cursorQuery>;

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiSuccess<T> {
  data: T;
  meta?: PageMeta | Record<string, unknown>;
}

export interface ApiFailure {
  error: {
    code: string;
    message: string;
    details?: Array<{ field: string; issue: string }>;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
