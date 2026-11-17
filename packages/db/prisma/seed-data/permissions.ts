/**
 * The permission registry.
 *
 * Permissions are data, not code. The interface hides what a user cannot do;
 * the API decides whether they may. Adding a capability means adding a row
 * here and granting it in ROLE_MATRIX below — never writing a role check
 * into a component.
 *
 * Key shape: domain.resource.action
 * Scope:     ALL (every record) | BRANCH (assigned branches) | OWN (theirs)
 */

export type PermissionScope = 'ALL' | 'BRANCH' | 'OWN';

export interface PermissionDefinition {
  key: string;
  domain: string;
  resource: string;
  action: string;
  label: string;
  /** Guards salary, medical or credential data. Audited on every read. */
  isSensitive?: boolean;
}

function p(key: string, label: string, isSensitive = false): PermissionDefinition {
  const [domain, resource, action] = key.split('.');
  if (!domain || !resource || !action) {
    throw new Error(`Malformed permission key: ${key}`);
  }
  return { key, domain, resource, action, label, isSensitive };
}

export const PERMISSIONS: PermissionDefinition[] = [
  // --- organization ---------------------------------------------------
  p('org.profile.read', 'View gym profile'),
  p('org.profile.update', 'Edit gym profile'),
  p('org.branding.read', 'View branding'),
  p('org.branding.update', 'Edit branding'),
  p('org.settings.read', 'View settings'),
  p('org.settings.update', 'Edit settings'),
  p('org.branch.read', 'View branches'),
  p('org.branch.create', 'Add a branch'),
  p('org.branch.update', 'Edit a branch'),
  p('org.branch.delete', 'Remove a branch'),
  p('org.role.read', 'View roles'),
  p('org.role.manage', 'Create and edit roles'),
  p('org.user.read', 'View staff accounts'),
  p('org.user.invite', 'Invite staff'),
  p('org.user.update', 'Edit staff accounts'),
  p('org.user.delete', 'Remove staff accounts'),
  p('org.integration.read', 'View integration settings', true),
  p('org.integration.update', 'Change integration credentials', true),
  p('org.audit.read', 'View the audit log', true),
  p('org.export.create', 'Export gym data'),
  p('org.billing.read', "View the gym's subscription"),
  p('org.billing.update', "Change the gym's subscription"),

  // --- staff ------------------------------------------------------------
  p('staff.profile.read', 'View staff profiles'),
  p('staff.profile.create', 'Add staff profiles'),
  p('staff.profile.update', 'Edit staff profiles'),
  p('staff.profile.delete', 'Remove staff profiles'),
  p('staff.salary.read', 'View salary and bank details', true),
  p('staff.salary.update', 'Edit salary and bank details', true),
  p('staff.attendance.read', 'View staff attendance'),
  p('staff.attendance.manage', 'Record staff attendance'),
  p('staff.shift.manage', 'Manage shifts'),
  p('staff.leave.read', 'View leave'),
  p('staff.leave.approve', 'Approve leave'),
  p('staff.payroll.read', 'View payroll', true),
  p('staff.payroll.manage', 'Run payroll', true),

  // --- members ------------------------------------------------------------
  p('members.member.read', 'View members'),
  p('members.member.create', 'Register members'),
  p('members.member.update', 'Edit members'),
  p('members.member.delete', 'Remove members'),
  p('members.member.export', 'Export members'),
  p('members.import.create', 'Bulk import members'),
  p('members.medical.read', 'View medical declarations', true),
  p('members.medical.update', 'Edit medical declarations', true),
  p('members.document.read', 'View member documents'),
  p('members.document.upload', 'Upload member documents'),
  p('members.document.delete', 'Delete member documents'),

  // --- memberships --------------------------------------------------------
  p('memberships.plan.read', 'View membership plans'),
  p('memberships.plan.manage', 'Create and edit plans'),
  p('memberships.subscription.read', 'View subscriptions'),
  p('memberships.subscription.create', 'Sell a membership'),
  p('memberships.subscription.renew', 'Renew a membership'),
  p('memberships.subscription.freeze', 'Freeze or unfreeze'),
  p('memberships.subscription.extend', 'Extend a membership'),
  p('memberships.subscription.transfer', 'Transfer between branches'),
  p('memberships.subscription.cancel', 'Cancel a membership'),

  // --- attendance ---------------------------------------------------------
  p('attendance.checkin.create', 'Check members in'),
  p('attendance.record.read', 'View attendance records'),
  p('attendance.record.update', 'Correct attendance records'),
  p('attendance.record.delete', 'Delete attendance records'),
  p('attendance.report.read', 'View attendance reports'),

  // --- finance ------------------------------------------------------------
  p('finance.payment.read', 'View payments'),
  p('finance.payment.create', 'Collect payments'),
  p('finance.payment.refund', 'Issue refunds'),
  p('finance.invoice.read', 'View invoices'),
  p('finance.invoice.create', 'Create invoices'),
  p('finance.invoice.update', 'Edit draft invoices'),
  p('finance.invoice.cancel', 'Cancel invoices'),
  p('finance.discount.read', 'View discounts'),
  p('finance.discount.manage', 'Create and edit discounts'),
  p('finance.tax.read', 'View tax configuration'),
  p('finance.tax.manage', 'Edit tax configuration'),
  p('finance.expense.read', 'View expenses'),
  p('finance.expense.manage', 'Record expenses'),
  p('finance.report.read', 'View financial reports'),
  p('finance.reconciliation.read', 'View reconciliation'),

  // --- CRM ----------------------------------------------------------------
  p('crm.lead.read', 'View leads'),
  p('crm.lead.create', 'Add leads'),
  p('crm.lead.update', 'Edit leads'),
  p('crm.lead.delete', 'Remove leads'),
  p('crm.followup.manage', 'Manage follow-ups'),
  p('crm.pipeline.read', 'View the sales pipeline'),

  // --- fitness ------------------------------------------------------------
  p('fitness.exercise.read', 'View the exercise library'),
  p('fitness.exercise.manage', 'Edit the exercise library'),
  p('fitness.workout.read', 'View workout plans'),
  p('fitness.workout.manage', 'Create and edit workout plans'),
  p('fitness.workout.assign', 'Assign workout plans'),
  p('fitness.assessment.read', 'View fitness assessments', true),
  p('fitness.assessment.create', 'Record fitness assessments', true),
  p('fitness.photo.read', 'View progress photographs', true),
  p('fitness.photo.upload', 'Upload progress photographs', true),

  // --- classes ------------------------------------------------------------
  p('classes.class.read', 'View classes'),
  p('classes.class.manage', 'Create and edit classes'),
  p('classes.booking.read', 'View bookings'),
  p('classes.booking.manage', 'Manage bookings'),

  // --- inventory ----------------------------------------------------------
  p('inventory.product.read', 'View products'),
  p('inventory.product.manage', 'Manage products'),
  p('inventory.stock.manage', 'Record stock movements'),
  p('inventory.equipment.read', 'View equipment'),
  p('inventory.equipment.manage', 'Manage equipment'),
  p('inventory.maintenance.manage', 'Record maintenance'),

  // --- communications -----------------------------------------------------
  p('comms.template.read', 'View message templates'),
  p('comms.template.manage', 'Create and edit templates'),
  p('comms.message.send', 'Send an individual message'),
  p('comms.campaign.create', 'Send a bulk campaign'),
  p('comms.history.read', 'View message history'),
  p('comms.preference.manage', 'Manage communication preferences'),

  // --- content ------------------------------------------------------------
  p('content.video.read', 'View the video library'),
  p('content.video.manage', 'Manage the video library'),
  p('content.playlist.manage', 'Manage playlists'),

  // --- analytics ----------------------------------------------------------
  p('analytics.dashboard.read', 'View the dashboard'),
  p('analytics.report.read', 'View reports'),

  // --- member self-service -------------------------------------------------
  p('self.profile.read', 'View own profile'),
  p('self.profile.update', 'Edit own profile'),
  p('self.membership.read', 'View own membership'),
  p('self.membership.renew', 'Renew own membership'),
  p('self.attendance.read', 'View own attendance'),
  p('self.attendance.checkin', 'Check in'),
  p('self.payment.read', 'View own payments'),
  p('self.payment.create', 'Pay online'),
  p('self.workout.read', 'View own workout plan'),
  p('self.workout.log', 'Log own workouts'),
  p('self.progress.read', 'View own progress'),
  p('self.class.read', 'View classes'),
  p('self.class.book', 'Book classes'),
  p('self.video.read', 'Watch videos'),
  p('self.notification.read', 'View own notifications'),
  p('self.export.create', 'Export own data'),

  // --- platform (super admin only) -----------------------------------------
  p('platform.gym.read', 'View all gyms'),
  p('platform.gym.create', 'Create a gym'),
  p('platform.gym.approve', 'Approve a gym'),
  p('platform.gym.suspend', 'Suspend a gym'),
  p('platform.gym.activate', 'Reactivate a gym'),
  p('platform.plan.manage', 'Manage SaaS plans and pricing'),
  p('platform.revenue.read', 'View platform revenue'),
  p('platform.feature.manage', 'Manage feature availability'),
  p('platform.support.manage', 'Handle support tickets'),
  p('platform.analytics.read', 'View platform analytics'),
  p('platform.audit.read', 'View the platform audit log', true),
  p('platform.settings.manage', 'Manage platform settings'),
  p('platform.impersonate.create', 'Enter a tenant for support', true),
];

// ------------------------------------------------------------ the roles ---

export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  rank: number;
  isPlatform?: boolean;
  /** permission key -> scope */
  grants: Record<string, PermissionScope>;
}

const all = (...keys: string[]): Record<string, PermissionScope> =>
  Object.fromEntries(keys.map((k) => [k, 'ALL' as const]));

const branch = (...keys: string[]): Record<string, PermissionScope> =>
  Object.fromEntries(keys.map((k) => [k, 'BRANCH' as const]));

const own = (...keys: string[]): Record<string, PermissionScope> =>
  Object.fromEntries(keys.map((k) => [k, 'OWN' as const]));

/** Every permission in a domain, at the given scope. */
function domain(name: string, scope: PermissionScope = 'ALL'): Record<string, PermissionScope> {
  return Object.fromEntries(
    PERMISSIONS.filter((x) => x.domain === name).map((x) => [x.key, scope]),
  );
}

const MEMBER_SELF = domain('self');

export const ROLE_MATRIX: RoleDefinition[] = [
  {
    key: 'SUPER_ADMIN',
    name: 'Super Admin',
    description:
      'Platform owner. Runs the SaaS business. Holds no standing access to a gym’s operational data — entering a tenant for support is an explicit, audited action.',
    rank: 0,
    isPlatform: true,
    grants: domain('platform'),
  },
  {
    key: 'GYM_OWNER',
    name: 'Gym Owner',
    description: 'Full control of their own gym, including finances, staff and integrations.',
    rank: 10,
    grants: {
      ...domain('org'),
      ...domain('staff'),
      ...domain('members'),
      ...domain('memberships'),
      ...domain('attendance'),
      ...domain('finance'),
      ...domain('crm'),
      ...domain('fitness'),
      ...domain('classes'),
      ...domain('inventory'),
      ...domain('comms'),
      ...domain('content'),
      ...domain('analytics'),
    },
  },
  {
    key: 'GYM_MANAGER',
    name: 'Gym Manager',
    description:
      'Runs day-to-day operations in their branches. No salary data, no integration credentials, no refunds, no audit log.',
    rank: 20,
    grants: {
      ...all('org.profile.read', 'org.branding.read', 'org.settings.read', 'org.branch.read',
             'org.role.read', 'org.user.read', 'org.user.invite', 'org.user.update'),
      ...branch('staff.profile.read', 'staff.profile.create', 'staff.profile.update',
                'staff.attendance.read', 'staff.attendance.manage', 'staff.shift.manage',
                'staff.leave.read', 'staff.leave.approve'),
      ...branch('members.member.read', 'members.member.create', 'members.member.update',
                'members.member.export', 'members.import.create', 'members.document.read',
                'members.document.upload'),
      ...all('members.medical.read'),
      ...all('memberships.plan.read'),
      ...branch('memberships.subscription.read', 'memberships.subscription.create',
                'memberships.subscription.renew', 'memberships.subscription.freeze',
                'memberships.subscription.extend', 'memberships.subscription.transfer'),
      ...branch('attendance.checkin.create', 'attendance.record.read', 'attendance.record.update',
                'attendance.report.read'),
      ...branch('finance.payment.read', 'finance.payment.create', 'finance.invoice.read',
                'finance.discount.read', 'finance.discount.manage', 'finance.expense.read',
                'finance.expense.manage'),
      ...all('finance.report.read'),
      ...branch('crm.lead.read', 'crm.lead.create', 'crm.lead.update', 'crm.followup.manage',
                'crm.pipeline.read'),
      ...all('fitness.exercise.read', 'fitness.exercise.manage', 'fitness.workout.read'),
      ...branch('fitness.workout.manage', 'fitness.workout.assign', 'fitness.assessment.read'),
      ...branch('classes.class.read', 'classes.class.manage', 'classes.booking.read',
                'classes.booking.manage'),
      ...branch('inventory.product.read', 'inventory.product.manage', 'inventory.stock.manage',
                'inventory.equipment.read', 'inventory.equipment.manage',
                'inventory.maintenance.manage'),
      ...all('comms.template.read', 'comms.template.manage', 'comms.history.read'),
      ...branch('comms.message.send', 'comms.campaign.create', 'comms.preference.manage'),
      ...all('content.video.read', 'content.video.manage', 'content.playlist.manage'),
      ...branch('analytics.dashboard.read', 'analytics.report.read'),
      ...branch('org.export.create'),
    },
  },
  {
    key: 'RECEPTIONIST',
    name: 'Receptionist',
    description:
      'Front desk. Registers members, checks them in, takes payments, handles enquiries. No reports beyond the day, no refunds, no staff data.',
    rank: 30,
    grants: {
      ...all('org.profile.read', 'org.branch.read'),
      ...branch('members.member.read', 'members.member.create', 'members.member.update',
                'members.document.read', 'members.document.upload'),
      ...all('memberships.plan.read'),
      ...branch('memberships.subscription.read', 'memberships.subscription.create',
                'memberships.subscription.renew'),
      ...branch('attendance.checkin.create', 'attendance.record.read'),
      ...branch('finance.payment.read', 'finance.payment.create', 'finance.invoice.read',
                'finance.invoice.create'),
      ...branch('crm.lead.read', 'crm.lead.create', 'crm.lead.update', 'crm.followup.manage'),
      ...branch('classes.class.read', 'classes.booking.read', 'classes.booking.manage'),
      ...branch('inventory.product.read', 'inventory.stock.manage', 'inventory.equipment.read'),
      ...branch('comms.message.send'),
      ...branch('staff.attendance.read'),
      ...branch('analytics.dashboard.read'),
    },
  },
  {
    key: 'TRAINER',
    name: 'Trainer',
    description:
      'Works with the members assigned to them. Sees their own schedule and their own members, and nothing else.',
    rank: 40,
    grants: {
      ...all('org.profile.read'),
      ...own('members.member.read', 'members.medical.read'),
      ...own('attendance.record.read', 'attendance.report.read'),
      ...branch('attendance.checkin.create'),
      ...all('fitness.exercise.read', 'fitness.exercise.manage', 'fitness.workout.read'),
      ...all('fitness.workout.manage'),
      ...own('fitness.workout.assign', 'fitness.assessment.read', 'fitness.assessment.create',
             'fitness.photo.read', 'fitness.photo.upload'),
      ...own('classes.class.read', 'classes.booking.read', 'classes.booking.manage'),
      ...own('staff.attendance.read', 'staff.shift.manage', 'staff.leave.read'),
      ...own('comms.message.send'),
      ...all('content.video.read', 'content.video.manage'),
      ...own('analytics.dashboard.read'),
    },
  },
  {
    key: 'ACCOUNTANT',
    name: 'Accountant',
    description:
      'Owns the books. Full finance, payroll visibility, no operational control over members or attendance.',
    rank: 50,
    grants: {
      ...all('org.profile.read', 'org.settings.read', 'org.branch.read', 'org.billing.read'),
      ...all('members.member.read'),
      ...all('memberships.plan.read', 'memberships.subscription.read',
             'memberships.subscription.cancel'),
      ...domain('finance'),
      ...all('staff.salary.read', 'staff.payroll.read', 'staff.payroll.manage',
             'staff.profile.read'),
      ...all('inventory.product.read', 'inventory.equipment.read'),
      ...all('analytics.dashboard.read', 'analytics.report.read', 'org.export.create'),
    },
  },
  {
    key: 'MEMBER',
    name: 'Member',
    description:
      'A gym member. Can reach their own records and nothing belonging to anyone else — enforced by member identity, not by role.',
    rank: 90,
    grants: { ...MEMBER_SELF, ...own('content.video.read') },
  },
];

export const SYSTEM_ROLE_KEYS = ROLE_MATRIX.map((r) => r.key);
