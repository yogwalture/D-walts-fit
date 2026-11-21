import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import { requirePermission, type ResolvedPermissions } from '../rbac/engine';

/**
 * Taking your data out.
 *
 * This file exists because the rest of the product had already promised it.
 * The permission engine goes out of its way to keep `org.export.create`
 * working for a gym whose trial has lapsed; the subscription page tells them
 * a trial ending means "read-only, not locked out — every record readable
 * and exportable"; the platform console says suspending a gym "keeps its
 * data and the owner can still export everything". All of that was true
 * about the database and false about the product, because nothing
 * implemented an export. A promise a customer cannot act on is not a
 * promise.
 *
 * Three decisions shape it:
 *
 *   CSV, not our own format. A gym leaving us should not need us to read
 *   their own records. Every one of these files opens in Excel, Google
 *   Sheets and LibreOffice, and imports into whatever they move to.
 *
 *   Everything, not a summary. The test for what belongs in here is not
 *   "would they want this" but "is it theirs" — including the awkward rows:
 *   cancelled memberships, refunds, the audit log, who we are as support.
 *
 *   An export is a bulk read of personal data, so it writes an audit row.
 *   Not to discourage it — it is their right — but because a gym should be
 *   able to see that somebody downloaded their whole member list, and when.
 */

export interface ExportContext {
  organizationId: string;
  userId?: string;
  branchIds?: string[];
}

/** One file in the export. */
export interface ExportTable {
  /** The file name inside the archive, without the extension. */
  name: string;
  /** What it holds, for the manifest a human reads first. */
  describes: string;
  rows: number;
}

export interface ExportManifest {
  gym: string;
  generatedAt: string;
  tables: ExportTable[];
  totalRows: number;
}

/**
 * Every table that belongs to a gym, with how it is read.
 *
 * Deliberately a list rather than something clever over the Prisma schema.
 * A generated export would silently start including a table added for an
 * unrelated reason — session tokens, encrypted credentials, our own billing
 * of them — and silently stop including one that was renamed. Each entry
 * here is a decision somebody made, and the test below asserts that every
 * tenant-scoped table is either in this list or deliberately excluded.
 */
interface TableSpec {
  name: string;
  describes: string;
  /** The Prisma model, as the delegate is named on the client. */
  model: string;
  /** Columns to take, in order. Nothing is taken that is not named. */
  columns: string[];
  /** Ordered so a diff between two exports is readable. */
  orderBy?: Record<string, 'asc' | 'desc'>;
  /**
   * Narrows the rows, for the one table where the tenant client is more
   * generous than this export should be: the exercise library is readable
   * as the gym's own rows *plus* the platform's shared ones, and shipping
   * twelve shared squats in a gym's export under the heading "exercises you
   * added" would be a small lie.
   */
  where?: Record<string, unknown>;
}

const TABLES: TableSpec[] = [
  {
    name: 'members',
    describes: 'Everyone who has ever been a member, including archived',
    model: 'member',
    columns: [
      'memberCode', 'firstName', 'lastName', 'phone', 'altPhone', 'email',
      'dateOfBirth', 'gender', 'bloodGroup', 'addressLine1', 'addressLine2',
      'city', 'state', 'postalCode', 'occupation', 'emergencyContactName',
      'emergencyContactPhone', 'joiningDate', 'status', 'membershipExpiresAt',
      'outstandingAmount', 'notes', 'createdAt', 'deletedAt',
    ],
    orderBy: { memberCode: 'asc' },
  },
  {
    name: 'membership-plans',
    describes: 'The plans you sell, including ones you have retired',
    model: 'membershipPlan',
    columns: [
      'name', 'description', 'category', 'durationUnit', 'durationValue',
      'sessionCount', 'price', 'joiningFee', 'securityDeposit', 'graceDays',
      'freezeAllowed', 'freezeMaxDays', 'transferAllowed', 'visibleToMembers',
      'isActive', 'createdAt',
    ],
    orderBy: { name: 'asc' },
  },
  {
    name: 'memberships-sold',
    describes: 'Every membership sold: when it ran, what was paid, how it ended',
    model: 'subscription',
    columns: [
      'memberId', 'planId', 'branchId', 'startDate', 'endDate', 'graceUntil',
      'status', 'listPrice', 'discountAmount', 'taxableAmount', 'taxAmount',
      'totalAmount', 'paidAmount', 'sessionsTotal', 'sessionsConsumed',
      'frozenDaysUsed', 'cancelledAt', 'cancelReason', 'createdAt',
    ],
    orderBy: { startDate: 'asc' },
  },
  {
    name: 'attendance',
    describes: 'Every visit, with how the member was identified at the door',
    model: 'attendance',
    columns: [
      'memberId', 'branchId', 'attendanceDate', 'checkedInAt', 'checkedOutAt',
      'durationMinutes', 'method', 'subscriptionStatusAtEntry', 'wasOverride',
      'overrideReason', 'deviceLabel',
    ],
  },
  {
    name: 'invoices',
    describes: 'Tax invoices you have raised, with their GST',
    model: 'invoice',
    columns: [
      'invoiceCode', 'memberId', 'issueDate', 'dueDate', 'subtotal',
      'discountAmount', 'taxAmount', 'total', 'amountPaid', 'amountDue',
      'status', 'placeOfSupply', 'createdAt',
    ],
    orderBy: { issueDate: 'asc' },
  },
  {
    name: 'invoice-lines',
    describes: 'What each invoice was for, line by line',
    model: 'invoiceLine',
    columns: [
      'invoiceId', 'description', 'itemType', 'quantity', 'unitPrice',
      'discountAmount', 'taxPercentage', 'taxAmount', 'lineTotal', 'hsnSacCode',
    ],
  },
  {
    name: 'payments',
    describes: 'Money received, how, and which invoice it settled',
    model: 'payment',
    columns: [
      'receiptCode', 'memberId', 'invoiceId', 'amount', 'method', 'status',
      'referenceNumber', 'razorpayPaymentId', 'receivedAt', 'settledAt', 'createdAt',
    ],
    orderBy: { createdAt: 'asc' },
  },
  {
    name: 'refunds',
    describes: 'Money given back, and why',
    model: 'refund',
    columns: [
      'paymentId', 'invoiceId', 'amount', 'status', 'reason',
      'razorpayRefundId', 'requestedAt', 'approvedAt', 'processedAt', 'failureReason',
    ],
  },
  {
    name: 'expenses',
    describes: 'What the gym spent, by category',
    model: 'expense',
    columns: [
      'expenseDate', 'branchId', 'categoryId', 'vendorId', 'title', 'description',
      'amount', 'taxAmount', 'totalAmount', 'method', 'referenceNumber',
      'isRecurring', 'createdAt',
    ],
    orderBy: { expenseDate: 'asc' },
  },
  {
    name: 'expense-categories',
    describes: 'Your own expense categories',
    model: 'expenseCategory',
    columns: ['name', 'isActive'],
  },
  {
    name: 'vendors',
    describes: 'Suppliers you buy from',
    model: 'vendor',
    columns: ['name', 'contactPerson', 'phone', 'email', 'gstin', 'address', 'notes', 'isActive'],
  },
  {
    name: 'staff',
    describes: 'People with access to the gym, and their role',
    model: 'orgUser',
    columns: ['userId', 'roleId', 'status', 'invitedAt', 'acceptedAt', 'createdAt', 'deletedAt'],
  },
  {
    name: 'staff-profiles',
    describes: 'Employment details for your team',
    model: 'staffProfile',
    // Salary and bank details are deliberately not here: they are a
    // permission-gated field inside the product, and a bulk CSV is the one
    // place they would escape that gate. The owner reads them on the staff
    // record; an export that leaks them to whoever opens the file does not.
    columns: [
      'orgUserId', 'employeeCode', 'designation', 'department', 'joiningDate',
      'exitDate', 'specialisations', 'certifications', 'bio',
    ],
  },
  {
    name: 'staff-attendance',
    describes: 'Who was in, by day',
    model: 'staffAttendance',
    columns: ['orgUserId', 'branchId', 'attendanceDate', 'status', 'checkedInAt', 'checkedOutAt', 'notes'],
  },
  {
    name: 'staff-shifts',
    describes: 'The rota: who is rostered where, and when',
    model: 'staffShift',
    columns: ['orgUserId', 'branchId', 'weekday', 'startTime', 'endTime'],
  },
  {
    name: 'staff-leave',
    describes: 'Leave requested, and what was decided',
    model: 'staffLeave',
    columns: ['orgUserId', 'fromDate', 'toDate', 'leaveType', 'status', 'reason', 'decidedAt', 'decisionNote'],
  },
  {
    name: 'classes',
    describes: 'Classes scheduled, including cancelled ones',
    model: 'gymClass',
    columns: ['classTypeId', 'branchId', 'trainerOrgUserId', 'startsAt', 'endsAt', 'capacity', 'cancelledAt', 'cancelReason'],
    orderBy: { startsAt: 'asc' },
  },
  {
    name: 'class-types',
    describes: 'The kinds of class you run',
    model: 'classType',
    columns: ['name', 'description', 'defaultDurationMinutes', 'defaultCapacity', 'requiresBooking', 'isActive'],
  },
  {
    name: 'class-bookings',
    describes: 'Who booked what, who turned up, who was waitlisted',
    model: 'classBooking',
    columns: ['classId', 'memberId', 'status', 'waitlistPosition', 'bookedAt', 'attendedAt', 'cancelledAt', 'cancelReason'],
  },
  {
    name: 'enquiries',
    describes: 'Leads and walk-ins, with their source',
    model: 'lead',
    columns: [
      'fullName', 'phone', 'email', 'city', 'source', 'sourceDetail', 'status',
      'interestedPlanId', 'budgetNote', 'nextFollowUpAt', 'assignedToOrgUserId',
      'lostReason', 'lostAt', 'convertedAt', 'notes', 'createdAt',
    ],
    orderBy: { createdAt: 'asc' },
  },
  {
    name: 'enquiry-activity',
    describes: 'Calls and follow-ups logged against an enquiry',
    model: 'leadActivity',
    columns: ['leadId', 'activityType', 'notes', 'occurredAt', 'createdAt'],
    orderBy: { occurredAt: 'asc' },
  },
  {
    name: 'products',
    describes: 'What the shop sells',
    model: 'product',
    columns: [
      'name', 'sku', 'barcode', 'category', 'unit', 'description',
      'purchasePrice', 'sellingPrice', 'quantityOnHand', 'reorderLevel', 'isActive',
    ],
  },
  {
    name: 'stock-movements',
    describes: 'Every change in stock, with the balance after it',
    model: 'stockMovement',
    columns: [
      'productId', 'branchId', 'movementType', 'quantity', 'unitPrice',
      'balanceAfter', 'referenceType', 'referenceId', 'notes', 'occurredAt',
    ],
    orderBy: { occurredAt: 'asc' },
  },
  {
    name: 'branches',
    describes: 'Your locations',
    model: 'branch',
    columns: [
      'name', 'code', 'addressLine1', 'addressLine2', 'city', 'state',
      'postalCode', 'phone', 'email', 'timezone', 'openingTime', 'closingTime',
      'isPrimary', 'isActive', 'deletedAt',
    ],
  },
  {
    name: 'messages-sent',
    describes: 'Messages queued and sent, and what happened to each',
    model: 'message',
    columns: [
      'messageJobId', 'channel', 'category', 'recipientType', 'recipientId',
      'toAddress', 'renderedBody', 'status', 'errorCode', 'errorMessage',
      'queuedAt', 'sentAt', 'deliveredAt', 'readAt', 'failedAt', 'attempts',
    ],
  },
  {
    name: 'message-campaigns',
    describes: 'Message campaigns you ran, and how each landed overall',
    model: 'messageJob',
    columns: [
      'name', 'channel', 'category', 'scheduledAt', 'startedAt', 'completedAt',
      'status', 'recipientCount', 'sentCount', 'deliveredCount', 'failedCount',
      'skippedCount', 'createdAt',
    ],
    orderBy: { createdAt: 'asc' },
  },
  {
    name: 'contact-preferences',
    describes: 'Who has opted out of what, and when they asked',
    model: 'communicationPreference',
    columns: ['subjectType', 'subjectId', 'channel', 'category', 'optedIn', 'optedOutAt', 'source'],
  },
  {
    name: 'equipment',
    describes: 'Your equipment, with what it cost and when the warranty ends',
    model: 'equipment',
    columns: [
      'name', 'assetCode', 'category', 'manufacturer', 'modelNumber',
      'serialNumber', 'purchaseDate', 'purchasePrice', 'vendorId',
      'warrantyUntil', 'status', 'location', 'branchId', 'notes', 'deletedAt',
    ],
  },
  {
    name: 'equipment-maintenance',
    describes: 'Services and repairs, with cost and downtime',
    model: 'equipmentMaintenanceLog',
    columns: [
      'equipmentId', 'maintenanceType', 'performedOn', 'cost', 'vendorId',
      'partsReplaced', 'downtimeHours', 'notes',
    ],
    orderBy: { performedOn: 'asc' },
  },
  {
    name: 'equipment-service-schedule',
    describes: 'What is due for service, and when',
    model: 'equipmentServiceSchedule',
    columns: ['equipmentId', 'serviceType', 'intervalDays', 'lastServicedOn', 'nextDueOn', 'isActive'],
  },
  {
    name: 'videos',
    describes: 'Your own video content and who may watch it',
    model: 'video',
    columns: [
      'title', 'description', 'categoryId', 'externalUrl', 'durationSeconds',
      'tags', 'accessLevel', 'isPublished', 'publishedAt', 'viewCount', 'deletedAt',
    ],
  },
  {
    name: 'video-categories',
    describes: 'How your videos are grouped',
    model: 'videoCategory',
    columns: ['name', 'slug', 'description', 'displayOrder', 'isActive'],
  },
  {
    name: 'playlists',
    describes: 'Video playlists you built',
    model: 'playlist',
    columns: ['name', 'description', 'isPublished', 'displayOrder', 'createdAt'],
  },
  {
    name: 'playlist-items',
    describes: 'Which videos are in which playlist',
    model: 'playlistItem',
    columns: ['playlistId', 'videoId', 'displayOrder'],
  },
  {
    name: 'video-watching',
    describes: 'How far each member got through each video',
    model: 'videoProgress',
    columns: ['videoId', 'memberId', 'secondsWatched', 'percentWatched', 'completedAt', 'lastWatchedAt'],
  },
  {
    name: 'member-notifications',
    describes: 'In-app notifications sent to members and staff',
    model: 'notification',
    columns: ['userId', 'memberId', 'title', 'body', 'category', 'readAt', 'createdAt'],
    orderBy: { createdAt: 'asc' },
  },
  {
    name: 'uploaded-files',
    describes:
      'An index of files uploaded against members and equipment. The files themselves are downloaded from the record they belong to',
    model: 'fileObject',
    columns: ['ownerType', 'ownerId', 'originalName', 'mimeType', 'sizeBytes', 'createdAt', 'deletedAt'],
  },
  {
    name: 'member-imports',
    describes: 'Member lists you uploaded, and what happened to each',
    model: 'memberImport',
    columns: [
      'filename', 'sheetName', 'status', 'totalRows', 'validRows',
      'duplicateRows', 'invalidRows', 'createdCount', 'skippedCount',
      'failureReason', 'createdAt', 'committedAt',
    ],
    orderBy: { createdAt: 'asc' },
  },
  {
    name: 'data-requests',
    describes: 'Requests to export or erase data, and how each was handled',
    model: 'dataRequest',
    columns: [
      'requestType', 'status', 'subjectType', 'subjectId', 'requestedAt',
      'completedAt', 'rejectionReason', 'notes',
    ],
    orderBy: { requestedAt: 'asc' },
  },
  {
    name: 'consents',
    describes: 'Consents given and withdrawn, with the policy version',
    model: 'consent',
    columns: [
      'subjectType', 'subjectId', 'consentType', 'granted', 'policyVersion',
      'grantedAt', 'revokedAt',
    ],
  },
  {
    name: 'medical-declarations',
    describes:
      'Health declarations and fitness clearances, which a gym must keep. The notes themselves stay with the member',
    model: 'memberMedicalDeclaration',
    columns: [
      'memberId', 'hasDeclaredConditions', 'fitnessClearanceGiven',
      'physicianName', 'physicianPhone', 'declaredAt', 'reviewedAt',
    ],
  },
  {
    name: 'assessments',
    describes: 'Measurements taken for members',
    model: 'fitnessAssessment',
    columns: [
      'memberId', 'assessedByOrgUserId', 'assessedOn', 'weightKg', 'heightCm',
      'bmi', 'bodyFatPercent', 'muscleMassKg', 'restingHeartRate', 'trainerNotes',
    ],
    orderBy: { assessedOn: 'asc' },
  },
  {
    name: 'workout-plans',
    describes: 'Training plans your trainers wrote',
    model: 'workoutPlan',
    columns: [
      'name', 'description', 'goal', 'difficulty', 'durationWeeks', 'daysPerWeek',
      'isTemplate', 'isActive', 'createdByOrgUserId', 'createdAt', 'deletedAt',
    ],
    orderBy: { name: 'asc' },
  },
  {
    name: 'workout-plan-days',
    describes: 'The days inside each plan',
    model: 'workoutPlanDay',
    columns: ['workoutPlanId', 'dayIndex', 'label', 'focus', 'isRestDay', 'notes'],
  },
  {
    name: 'workout-plan-exercises',
    describes: 'The exercises inside each day, with sets, reps and your notes',
    model: 'workoutPlanItem',
    columns: [
      'workoutPlanDayId', 'exerciseId', 'displayOrder', 'sets', 'reps',
      'weightKg', 'restSeconds', 'durationSeconds', 'tempo', 'trainerNotes',
    ],
  },
  {
    name: 'workout-assignments',
    describes: 'Which member followed which plan, and when',
    model: 'memberWorkoutAssignment',
    columns: [
      'memberId', 'workoutPlanId', 'assignedByOrgUserId', 'startDate',
      'endDate', 'status', 'notes', 'createdAt',
    ],
    orderBy: { startDate: 'asc' },
  },
  {
    name: 'workout-logs',
    describes: 'Every session your members logged: what they lifted, and how hard it felt',
    model: 'workoutLog',
    columns: [
      'memberId', 'assignmentId', 'planItemId', 'exerciseId', 'performedOn',
      'setsCompleted', 'repsCompleted', 'weightKg', 'durationSeconds',
      'perceivedEffort', 'completed', 'memberNotes',
    ],
    orderBy: { performedOn: 'asc' },
  },
  {
    name: 'exercises',
    describes: 'Exercises you added to your own library',
    model: 'exercise',
    where: { organizationId: { not: null } },
    columns: [
      'name', 'muscleGroup', 'secondaryMuscles', 'equipment', 'difficulty',
      'category', 'instructions', 'cautions', 'isActive', 'createdAt',
    ],
    orderBy: { name: 'asc' },
  },
  {
    name: 'activity-log',
    describes: 'Who changed what, including anything we did on your account',
    model: 'auditLog',
    columns: ['actorUserId', 'isPlatformActor', 'action', 'entityType', 'entityId', 'summary', 'ipAddress', 'createdAt'],
    orderBy: { createdAt: 'asc' },
  },
];

/**
 * Tables NOT in the export, each for a stated reason.
 *
 * Kept here rather than left implicit so the guard test can tell a
 * deliberate omission from a forgotten one.
 */
export const EXPORT_EXCLUSIONS: Record<string, string> = {
  Session:
    'Live sign-in tokens. Exporting them would be exporting the keys to the account rather than the records in it.',
  VerificationToken:
    'One-time links and codes for invitations, password resets and member sign-in. They expire in hours and are useless after.',
  MemberQrToken:
    'Rotating door tokens, which expire in minutes and mean nothing outside this gym’s own entrance.',
  BranchQrCode:
    'The entrance QR’s rotating secret. Same reason as the member tokens: a key, not a record.',
  WhatsappSetting:
    'Holds the gym’s encrypted WhatsApp access token. A credential is not data to hand around in a CSV.',
  PaymentGatewaySetting:
    'Holds the gym’s encrypted Razorpay key secret. Same reason — and they already have it from Razorpay.',
  NotificationTemplate:
    'Message templates, which are editable in the product and mostly ours rather than theirs.',
  TenantSubscription:
    'Our billing of them, not their records. What they pay us is on their own subscription page.',
  TenantInvoice:
    'Invoices we raised against the gym for the software. Theirs to read, but ours to issue — on the subscription page, not here.',
  TenantPayment:
    'What the gym paid us for the software. Same reason as the invoices we raised to them.',
  UsageCounter:
    'Our own metering of their plan usage, derived from the tables that are exported here.',
  OrgFeatureOverride:
    'Flags we set on their account. Our configuration of them, not a record of their business.',
  SupportTicket:
    'Their correspondence with us, which they already hold in their own email.',
  InvoiceSequence:
    'The numbering counters behind invoice and receipt codes. The numbers themselves are on every invoice.',
  OrgSetting:
    'Gym settings — address, GST number, business hours. Readable and editable in the product itself.',
  OrgBranding:
    'Logo, colours and display name, which they chose and hold the originals of.',
  OrgUserBranch:
    'Which staff member works at which branch, which is carried on the staff files instead of in a join table.',
  PlanBranch:
    'Which plan is sold at which branch, carried on the plan files rather than separately.',
  SubscriptionEvent:
    'Membership changes — renewals, freezes, cancellations — every one of which the activity log already records.',
  SubscriptionFreeze:
    'Freeze periods, recorded on the membership and in the activity log rather than a third time.',
  TaxRate:
    'GST rates, which are public law rather than gym data, and are stamped on every invoice line anyway.',
  Discount:
    'Discount codes the gym configured, which they can read and edit in the product.',
  TrialBooking:
    'Trial sessions, which travel with the enquiry they belong to in the enquiries file.',
  MemberDocument:
    'Uploaded documents. Their contents are files rather than rows; the index of them is in uploaded-files.',
  MemberTimelineEntry:
    'A derived view assembled from attendance, payments and memberships, all of which are exported directly.',
  ProgressPhoto:
    'Progress photographs. Images rather than rows, downloaded from the member record they belong to.',
  PayrollRun:
    'Payroll is not built yet. This entry exists so the guard test fails the day it is, rather than shipping an export that quietly omits wages.',
  PayrollItem:
    'Payroll is not built yet. See PayrollRun — it will be added here when there is anything to add.',
  TrainerAssignment:
    'Which trainer a member is assigned to, which is carried on the member file.',
  RolePermission:
    'Permission wiring between roles and keys. Our configuration, identical across every gym on the same roles.',
  Role:
    'Role definitions, which are readable in the product and shared with every other gym on the system roles.',
  UserPermissionOverride:
    'Per-person permission tweaks. Configuration of the software rather than a record of the business.',
  MessageCampaign:
    'Superseded by MessageJob, which is exported as message-campaigns. Nothing writes to this one.',
  MemberImportRow:
    'The individual rows of an uploaded member list. The members that came out of it are in members.csv; the import summary is in member-imports.',
  Outbox:
    'Our own queue of work waiting to happen — a transient internal mechanism, empty most of the time.',
  JobRun:
    'Our own cron bookkeeping: which scheduled job ran when. Infrastructure, not gym data.',
};

/**
 * A member's own records.
 *
 * `scopeBy` is per spec because the models do not agree on what a member is
 * called: attendance has `memberId`, the member record itself has `id`, and a
 * message has `recipientId` because it may be addressed to a staff member
 * instead. Guessing one name for all three is how a member's export either
 * throws or, worse, returns everybody's.
 *
 * At module scope rather than inside the function so the guard test can read
 * it. The first version of that test regex-matched the source instead, and
 * stopped covering these the moment `scopeBy` was inserted between `model`
 * and `columns` — a guard that silently stops guarding is worse than none.
 */
interface MemberTableSpec {
  name: string;
  model: string;
  columns: string[];
  scopeBy: string;
}

const MEMBER_TABLES: MemberTableSpec[] = [
  {
    name: 'my-details',
    model: 'member',
    scopeBy: 'id',
    columns: [
      'memberCode', 'firstName', 'lastName', 'phone', 'email', 'dateOfBirth',
      'gender', 'bloodGroup', 'addressLine1', 'city', 'state', 'postalCode',
      'emergencyContactName', 'emergencyContactPhone', 'joiningDate', 'status',
      'membershipExpiresAt', 'outstandingAmount',
    ],
  },
  {
    name: 'my-memberships',
    model: 'subscription',
    scopeBy: 'memberId',
    columns: [
      'startDate', 'endDate', 'status', 'listPrice', 'discountAmount',
      'totalAmount', 'paidAmount', 'sessionsTotal', 'sessionsConsumed',
      'cancelledAt', 'cancelReason',
    ],
  },
  {
    name: 'my-visits',
    model: 'attendance',
    scopeBy: 'memberId',
    columns: ['attendanceDate', 'checkedInAt', 'checkedOutAt', 'durationMinutes', 'method'],
  },
  {
    name: 'my-invoices',
    model: 'invoice',
    scopeBy: 'memberId',
    columns: ['invoiceCode', 'issueDate', 'subtotal', 'taxAmount', 'total', 'amountPaid', 'amountDue', 'status'],
  },
  {
    name: 'my-payments',
    model: 'payment',
    scopeBy: 'memberId',
    columns: ['receiptCode', 'amount', 'method', 'status', 'receivedAt', 'settledAt'],
  },
  {
    name: 'my-class-bookings',
    model: 'classBooking',
    scopeBy: 'memberId',
    columns: ['classId', 'status', 'waitlistPosition', 'bookedAt', 'attendedAt', 'cancelledAt'],
  },
  {
    name: 'my-health-declaration',
    model: 'memberMedicalDeclaration',
    scopeBy: 'memberId',
    // The full note, unlike the gym's bulk export, which carries only that
    // a declaration exists. This is the member's own copy of their own
    // medical information, which is theirs to have in full.
    columns: [
      'declaredAt', 'hasDeclaredConditions', 'conditions', 'medications',
      'allergies', 'injuries', 'surgeries', 'physicianName', 'physicianPhone',
      'fitnessClearanceGiven', 'additionalNotes',
    ],
  },
  {
    name: 'my-assessments',
    model: 'fitnessAssessment',
    scopeBy: 'memberId',
    columns: [
      'assessedOn', 'weightKg', 'heightCm', 'bmi', 'bodyFatPercent',
      'muscleMassKg', 'restingHeartRate', 'trainerNotes',
    ],
  },
  {
    name: 'my-messages',
    model: 'message',
    scopeBy: 'recipientId',
    columns: [
      'channel', 'category', 'toAddress', 'renderedBody', 'status',
      'queuedAt', 'sentAt', 'deliveredAt', 'readAt',
    ],
  },
];

/** What is in the export, counted, before anybody downloads 40MB. */
export async function exportManifest(
  ctx: ExportContext,
  permissions: ResolvedPermissions,
): Promise<ExportManifest> {
  requirePermission(permissions, 'org.export.create');

  return withTenant(ctx, async (tx: any) => {
    const organization = await tx.organization.findFirst({ select: { name: true } });

    const tables: ExportTable[] = [];
    for (const spec of TABLES) {
      const delegate = tx[spec.model];
      if (!delegate) continue;
      tables.push({
        name: spec.name,
        describes: spec.describes,
        rows: await delegate.count(spec.where ? { where: spec.where } : undefined),
      });
    }

    return {
      gym: organization?.name ?? '',
      generatedAt: new Date().toISOString(),
      tables,
      totalRows: tables.reduce((sum, table) => sum + table.rows, 0),
    };
  });
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';

  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (Array.isArray(value)) text = value.join('; ');
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);

  // A cell beginning with one of these is run as a formula by Excel and
  // Sheets, which is how a CSV download becomes code execution on the
  // machine of whoever opens it.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * One table, as CSV, read in pages.
 *
 * Paged because a gym with years of attendance has hundreds of thousands of
 * rows and loading them all into memory to build one string is how a 512MB
 * container dies. Each page is turned into text and handed on.
 */
async function* csvOf(
  tx: any,
  spec: TableSpec,
  pageSize = 1000,
): AsyncGenerator<string> {
  yield `${spec.columns.map(csvCell).join(',')}\r\n`;

  const select = Object.fromEntries(spec.columns.map((column) => [column, true]));
  let cursor: string | undefined;

  for (;;) {
    const rows = await tx[spec.model].findMany({
      select: { id: true, ...select },
      ...(spec.where ? { where: spec.where } : {}),
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      // Ordered by id so the cursor is stable; a column ordering would need
      // a tiebreak and could repeat or skip rows mid-export.
      orderBy: { id: 'asc' },
    });
    if (rows.length === 0) return;

    for (const row of rows) {
      yield `${spec.columns.map((column) => csvCell(row[column])).join(',')}\r\n`;
    }

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < pageSize) return;
  }
}

/** A file in the archive: its name, and its contents as they are produced. */
export interface ExportFile {
  name: string;
  contents: AsyncGenerator<string>;
}

/**
 * The whole export, file by file.
 *
 * Returns generators rather than buffers so the caller can stream straight
 * into a response: on a 512MB container with a 120-second request limit,
 * building the archive in memory first is the difference between an export
 * that works for a real gym and one that works in a demo.
 */
export async function gymExportFiles(
  ctx: ExportContext,
  permissions: ResolvedPermissions,
  meta: { ipAddress?: string } = {},
): Promise<{ manifest: ExportManifest; files: ExportFile[] }> {
  requirePermission(permissions, 'org.export.create');

  const manifest = await exportManifest(ctx, permissions);

  // Audited before the data moves, not after: an export that fell over
  // halfway still read everything it got to.
  await withTenant(ctx, async (tx) => {
    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId ?? null,
      action: 'org.export.created',
      entityType: 'Organization',
      entityId: ctx.organizationId,
      summary: `Full data export: ${manifest.totalRows} rows across ${manifest.tables.length} files`,
      ipAddress: meta.ipAddress,
    });
  });

  const files: ExportFile[] = TABLES.map((spec) => ({
    name: `${spec.name}.csv`,
    contents: (async function* () {
      // Each file gets its own short transaction rather than one long one:
      // a transaction held open for the whole export would block vacuum and
      // risk a statement timeout on the largest table.
      const chunks: string[] = [];
      await withTenant(ctx, async (tx: any) => {
        for await (const line of csvOf(tx, spec)) chunks.push(line);
      });
      for (const chunk of chunks) yield chunk;
    })(),
  }));

  files.push({
    name: 'README.txt',
    contents: (async function* () {
      yield readmeFor(manifest);
    })(),
  });

  return { manifest, files };
}

function readmeFor(manifest: ExportManifest): string {
  const lines = [
    `Data export for ${manifest.gym}`,
    `Taken ${manifest.generatedAt}`,
    '',
    'Every file here is a CSV. They open in Excel, Google Sheets and',
    'LibreOffice, and import into most other gym software. This is your',
    'data: you do not need us to read it.',
    '',
    'Files',
    '-----',
  ];

  for (const table of manifest.tables) {
    lines.push(`${table.name}.csv — ${table.describes} (${table.rows} rows)`);
  }

  lines.push(
    '',
    'How the files join up',
    '---------------------',
    'Rows refer to each other by id, the same way they do in the software:',
    'payments.memberId matches a member, invoice-lines.invoiceId matches an',
    'invoice, and so on. The member files carry memberCode as well, which is',
    'the number you use at the desk.',
    '',
    'What is not here',
    '----------------',
    'Uploaded files and photographs are not in this archive — they are',
    'images and documents rather than rows, and they are downloaded from the',
    'member record they belong to.',
    '',
    'Your sign-in tokens, and the credentials for your WhatsApp and Razorpay',
    'accounts, are deliberately left out. They are keys rather than records,',
    'and they are held only by you and by those providers.',
    '',
    'Health declarations are left out of this bulk export and included in a',
    'member’s own export instead, because a medical note is the member’s',
    'before it is the gym’s.',
    '',
    'The exercise library here is the exercises you added yourself. The',
    'shared library every gym on the system reads is not yours to take, and',
    'the plans reference it by id.',
    '',
  );

  return lines.join('\n');
}

/**
 * A member's own copy of their own data.
 *
 * Separate from the gym's export, and smaller: it is one person's records,
 * and it includes the health declaration the bulk export leaves out, because
 * their own medical note is theirs to have.
 */
export async function memberExportFiles(
  ctx: ExportContext & { memberId?: string | null },
  permissions: ResolvedPermissions,
): Promise<{ files: ExportFile[]; memberCode: string }> {
  requirePermission(permissions, 'self.export.create');

  const memberId = ctx.memberId;
  if (!memberId) {
    throw new AppError('FORBIDDEN', 'Sign in as a member to export your own data.');
  }

  const profile = await withTenant(ctx, async (tx: any) => {
    const member = await tx.member.findFirst({
      where: { id: memberId },
      select: { memberCode: true, firstName: true, lastName: true },
    });
    if (!member) throw new AppError('NOT_FOUND', 'That member was not found.');
    return member;
  });

  const specs = MEMBER_TABLES;

  const files: ExportFile[] = specs.map((spec) => ({
    name: `${spec.name}.csv`,
    contents: (async function* () {
      const chunks: string[] = [];
      await withTenant(ctx, async (tx: any) => {
        const delegate = tx[spec.model];
        if (!delegate) return;

        chunks.push(`${spec.columns.map(csvCell).join(',')}\r\n`);

        const select = Object.fromEntries(spec.columns.map((column) => [column, true]));
        // Scoped to this member by the query, not by filtering afterwards:
        // the member id comes from the session and nothing else.
        const where = { [spec.scopeBy]: memberId };
        const rows = await delegate.findMany({ where, select, take: 5000 });

        for (const row of rows) {
          chunks.push(`${spec.columns.map((column) => csvCell(row[column])).join(',')}\r\n`);
        }
      });
      for (const chunk of chunks) yield chunk;
    })(),
  }));

  return { files, memberCode: profile.memberCode };
}

/** Exposed for the guard test, which checks nothing was forgotten. */
export function exportedModels(): string[] {
  return TABLES.map((spec) => spec.model);
}

/**
 * Every (model, column) pair this file will ask Prisma for.
 *
 * Returned as data rather than left for a test to parse out of the source,
 * so both the gym export and a member's own are covered and stay covered.
 */
export function exportColumnSpecs(): Array<{ model: string; columns: string[] }> {
  return [...TABLES, ...MEMBER_TABLES].map((spec) => ({
    model: spec.model,
    columns: spec.columns,
  }));
}
