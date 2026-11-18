import Link from 'next/link';
import { requireSession, holds, planLock } from '@/lib/current-session';
import { SignOutButton } from '@/components/sign-out-button';
import { OrganizationSwitcher } from '@/components/organization-switcher';

/**
 * The gym portal shell.
 *
 * One portal for all five staff roles. Navigation items appear only where
 * the resolved permission set allows them, so a receptionist sees four items
 * and an owner sees all of them — without a single role check in the markup.
 */

interface NavItem {
  href: string;
  label: string;
  /** Omitted for a page any signed-in user may open, such as their own security settings. */
  permission?: string;
  /**
   * Whether the page behind this link exists yet.
   *
   * A navigation item for an unbuilt page is a button that does nothing: the
   * user clicks it, gets a 404, and learns not to trust the menu. Items are
   * flipped to `true` as their phase lands, so the sidebar always describes
   * what the product can actually do today.
   */
  built: boolean;
}

interface NavSection {
  heading: string | null;
  items: NavItem[];
}

const NAVIGATION: NavSection[] = [
  {
    heading: null,
    items: [
      {
        href: '/dashboard',
        label: 'Dashboard',
        permission: 'analytics.dashboard.read',
        built: true,
      },
    ],
  },
  {
    heading: 'Members',
    items: [
      { href: '/members', label: 'Members', permission: 'members.member.read', built: true },
      {
        href: '/memberships/plans',
        label: 'Plans',
        permission: 'memberships.plan.read',
        built: true,
      },
      {
        href: '/attendance/today',
        label: 'Attendance',
        permission: 'attendance.record.read',
        built: true,
      },
      {
        href: '/memberships/subscriptions',
        label: 'Subscriptions',
        permission: 'memberships.subscription.read',
        built: true,
      },
    ],
  },
  {
    heading: 'Money',
    items: [
      {
        href: '/finance/payments',
        label: 'Payments',
        permission: 'finance.payment.read',
        built: true,
      },
      {
        href: '/finance/invoices',
        label: 'Invoices',
        permission: 'finance.invoice.read',
        built: true,
      },
      {
        href: '/finance/expenses',
        label: 'Expenses',
        permission: 'finance.expense.read',
        built: true,
      },
      { href: '/reports', label: 'Reports', permission: 'finance.report.read', built: true },
    ],
  },
  {
    heading: 'Growth',
    items: [
      { href: '/crm/leads', label: 'Enquiries', permission: 'crm.lead.read', built: true },
      {
        href: '/communication/compose',
        label: 'Messages',
        permission: 'comms.message.send',
        built: true,
      },
    ],
  },
  {
    heading: 'Operations',
    items: [
      { href: '/staff', label: 'Team', permission: 'staff.profile.read', built: true },
      { href: '/staff/rota', label: 'Rota', permission: 'staff.attendance.read', built: true },
      {
        href: '/fitness/workout-plans',
        label: 'Workouts',
        permission: 'fitness.workout.read',
        built: false,
      },
      {
        href: '/classes/schedule',
        label: 'Classes',
        permission: 'classes.class.read',
        built: true,
      },
      {
        href: '/inventory/products',
        label: 'Shop',
        permission: 'inventory.product.read',
        built: true,
      },
    ],
  },
  {
    heading: 'Settings',
    items: [
      { href: '/settings/users', label: 'Access', permission: 'org.user.read', built: true },
      {
        href: '/settings/branches',
        label: 'Branches',
        permission: 'org.branch.read',
        built: true,
      },
      {
        href: '/settings/whatsapp',
        label: 'WhatsApp',
        permission: 'comms.template.read',
        built: true,
      },
      { href: '/settings/security', label: 'Security', built: true },
    ],
  },
];

export default async function GymLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession('/dashboard');

  /**
   * Three states per item, not two.
   *
   * Hidden: the role does not allow it, or the page does not exist yet.
   * Open: allowed and built.
   * Locked: allowed by the role, built, and held back only by the plan — so
   * it stays in the sidebar with a lock, because a gym cannot ask for a
   * feature it has never seen, and the page itself explains the plan.
   */
  const sections = NAVIGATION.map((section) => ({
    ...section,
    items: section.items
      .filter((item) => item.built)
      .map((item) => ({
        ...item,
        locked: item.permission ? planLock(session, item.permission) !== null : false,
      }))
      .filter(
        (item) => item.locked || !item.permission || holds(session, item.permission),
      ),
  })).filter((section) => section.items.length > 0);

  const gymName = session.organization?.branding.displayName ?? session.organization?.name ?? '';

  return (
    <div className="flex min-h-screen bg-canvas">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-accent text-sm font-semibold text-white">
            {gymName.charAt(0) || 'G'}
          </div>
          <span className="truncate text-base font-semibold text-ink">{gymName}</span>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto p-3" aria-label="Main">
          {sections.map((section, index) => (
            <div key={section.heading ?? `section-${index}`}>
              {section.heading && (
                <p className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
                  {section.heading}
                </p>
              )}
              <ul className="space-y-0.5">
                {section.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="nav-item flex items-center justify-between gap-2"
                    >
                      <span className="truncate">{item.label}</span>
                      {item.locked && (
                        <span
                          className="shrink-0 rounded-full bg-canvas px-1.5 py-0.5 text-[11px] font-medium text-ink-subtle"
                          title="Included in a higher plan"
                        >
                          Locked
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-line p-3">
          <div className="px-3 py-2">
            <p className="truncate text-base font-medium text-ink">{session.user.fullName}</p>
            <p className="truncate text-sm text-ink-muted">{session.role?.name}</p>
          </div>
          <SignOutButton />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4 lg:px-6">
          <OrganizationSwitcher
            memberships={session.memberships}
            currentId={session.organization?.id ?? null}
          />
          {session.organization?.status === 'TRIAL' && (
            <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">
              Trial
            </span>
          )}
        </header>

        <main className="min-w-0 flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
