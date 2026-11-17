import Link from 'next/link';
import { requireSession, holds } from '@/lib/current-session';
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
  permission: string;
}

interface NavSection {
  heading: string | null;
  items: NavItem[];
}

const NAVIGATION: NavSection[] = [
  {
    heading: null,
    items: [{ href: '/dashboard', label: 'Dashboard', permission: 'analytics.dashboard.read' }],
  },
  {
    heading: 'Members',
    items: [
      { href: '/members', label: 'Members', permission: 'members.member.read' },
      { href: '/memberships/plans', label: 'Plans', permission: 'memberships.plan.read' },
      {
        href: '/memberships/subscriptions',
        label: 'Subscriptions',
        permission: 'memberships.subscription.read',
      },
      { href: '/attendance/today', label: 'Attendance', permission: 'attendance.record.read' },
    ],
  },
  {
    heading: 'Money',
    items: [
      { href: '/finance/payments', label: 'Payments', permission: 'finance.payment.read' },
      { href: '/finance/invoices', label: 'Invoices', permission: 'finance.invoice.read' },
      { href: '/finance/expenses', label: 'Expenses', permission: 'finance.expense.read' },
      { href: '/reports', label: 'Reports', permission: 'finance.report.read' },
    ],
  },
  {
    heading: 'Growth',
    items: [
      { href: '/crm/leads', label: 'Leads', permission: 'crm.lead.read' },
      { href: '/communication/compose', label: 'Messages', permission: 'comms.message.send' },
    ],
  },
  {
    heading: 'Operations',
    items: [
      { href: '/staff', label: 'Staff', permission: 'staff.profile.read' },
      { href: '/fitness/workout-plans', label: 'Workouts', permission: 'fitness.workout.read' },
      { href: '/classes/schedule', label: 'Classes', permission: 'classes.class.read' },
      { href: '/inventory/products', label: 'Inventory', permission: 'inventory.product.read' },
    ],
  },
  {
    heading: null,
    items: [{ href: '/settings/general', label: 'Settings', permission: 'org.settings.read' }],
  },
];

export default async function GymLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession('/dashboard');

  const sections = NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => holds(session, item.permission)),
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
                    <Link href={item.href} className="nav-item">
                      {item.label}
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
