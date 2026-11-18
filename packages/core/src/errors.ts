/**
 * The error taxonomy.
 *
 * Error codes are stable strings, not sentences, so the interface can
 * localise them and the mobile app can branch on them. HTTP status is used
 * honestly — and 404 is returned for both "missing" and "not yours", because
 * telling an attacker that a record exists but belongs to someone else is
 * itself a leak.
 */

export type ErrorCode =
  // 401
  | 'UNAUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'MFA_REQUIRED'
  | 'INVALID_CREDENTIALS'
  // 403
  | 'FORBIDDEN'
  | 'PERMISSION_DENIED'
  | 'BRANCH_OUT_OF_SCOPE'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_DISABLED'
  | 'ORGANIZATION_SUSPENDED'
  | 'ORGANIZATION_READ_ONLY'
  | 'PLAN_LIMIT_REACHED'
  | 'FEATURE_NOT_IN_PLAN'
  // 404
  | 'NOT_FOUND'
  // 409
  | 'CONFLICT'
  | 'DUPLICATE_MEMBER'
  | 'DUPLICATE_LEAD'
  | 'ALREADY_CHECKED_IN'
  | 'SUBSCRIPTION_EXPIRED'
  | 'SUBSCRIPTION_NOT_ACTIVE'
  | 'CLASS_FULL'
  | 'INVOICE_ALREADY_PAID'
  // 422
  | 'VALIDATION_FAILED'
  // 429
  | 'RATE_LIMITED'
  // 500 / 502
  | 'INTERNAL_ERROR'
  | 'INTEGRATION_UNAVAILABLE'
  | 'INTEGRATION_NOT_CONFIGURED';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  MFA_REQUIRED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  PERMISSION_DENIED: 403,
  BRANCH_OUT_OF_SCOPE: 403,
  ACCOUNT_LOCKED: 403,
  ACCOUNT_DISABLED: 403,
  ORGANIZATION_SUSPENDED: 403,
  ORGANIZATION_READ_ONLY: 403,
  PLAN_LIMIT_REACHED: 403,
  FEATURE_NOT_IN_PLAN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE_MEMBER: 409,
  DUPLICATE_LEAD: 409,
  ALREADY_CHECKED_IN: 409,
  SUBSCRIPTION_EXPIRED: 409,
  SUBSCRIPTION_NOT_ACTIVE: 409,
  CLASS_FULL: 409,
  INVOICE_ALREADY_PAID: 409,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  INTEGRATION_UNAVAILABLE: 502,
  INTEGRATION_NOT_CONFIGURED: 503,
};

export interface ErrorDetail {
  field: string;
  issue: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetail[];
  /** Safe to show the user. Internal errors deliberately say little. */
  readonly publicMessage: string;

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
    this.publicMessage =
      this.status >= 500 ? 'Something went wrong on our side. Please try again.' : message;
  }

  toResponseBody() {
    return {
      error: {
        code: this.code,
        message: this.publicMessage,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const unauthenticated = (m = 'Sign in to continue') =>
  new AppError('UNAUTHENTICATED', m);

export const permissionDenied = (permission: string) =>
  new AppError('PERMISSION_DENIED', `You do not have permission to ${permission}.`);

/**
 * The plan does not include this. Named after the feature rather than the
 * permission, because the feature is what the gym would be buying.
 */
export const featureNotInPlan = (feature: string) =>
  new AppError(
    'FEATURE_NOT_IN_PLAN',
    `Your current plan does not include ${FEATURE_LABEL[feature] ?? feature}.`,
  );

/** Plain-language names for the plan features, for messages people read. */
export const FEATURE_LABEL: Record<string, string> = {
  crm: 'enquiry and lead management',
  classes: 'classes and scheduling',
  workouts: 'workout plans',
  inventory: 'inventory and point of sale',
  video: 'the video library',
  whatsapp: 'WhatsApp messaging',
  reports: 'reports',
  payroll: 'payroll',
  advanced_analytics: 'advanced analytics',
  white_label: 'white labelling',
  custom_domain: 'a custom domain',
  api_access: 'API access',
};

export const notFound = (what = 'Record') => new AppError('NOT_FOUND', `${what} not found.`);

export const validationFailed = (details: ErrorDetail[]) =>
  new AppError('VALIDATION_FAILED', 'Please correct the highlighted fields.', details);

export const conflict = (code: ErrorCode, message: string) => new AppError(code, message);
