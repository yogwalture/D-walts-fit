import Link from 'next/link';

/**
 * The small pieces every Phase 2 screen is built from.
 *
 * Server components with no state, so they cost nothing on the client and
 * keep one visual language across members, money and attendance.
 */

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-base text-ink-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'warn' | 'good';
}) {
  const valueTone =
    tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-emerald-700' : 'text-ink';

  return (
    <div className="card p-5">
      <p className="text-sm font-medium text-ink-muted">{label}</p>
      <p className={`mt-2 text-3xl font-semibold tabular-nums tracking-tight ${valueTone}`}>
        {typeof value === 'number' ? value.toLocaleString('en-IN') : value}
      </p>
      {hint && <p className="mt-1 text-sm text-ink-subtle">{hint}</p>}
    </div>
  );
}

export function Card({
  title,
  description,
  action,
  children,
  padded = true,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  padded?: boolean;
}) {
  return (
    <section className="card">
      {(title || action) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-ink-muted">{description}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

const BADGE_TONES: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  expiring: 'bg-amber-50 text-amber-700 ring-amber-200',
  expired: 'bg-rose-50 text-rose-700 ring-rose-200',
  frozen: 'bg-sky-50 text-sky-700 ring-sky-200',
  neutral: 'bg-slate-50 text-slate-600 ring-slate-200',
};

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: keyof typeof BADGE_TONES;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE_TONES[tone] ?? BADGE_TONES.neutral}`}
    >
      {children}
    </span>
  );
}

/** Membership state, from an expiry date. The single source for the wording. */
export function membershipTone(expiresAt: Date | string | null): {
  tone: keyof typeof BADGE_TONES;
  label: string;
} {
  if (!expiresAt) return { tone: 'neutral', label: 'No membership' };

  const end = new Date(expiresAt);
  const days = Math.ceil((end.getTime() - Date.now()) / 86_400_000);

  if (days < 0) return { tone: 'expired', label: `Expired ${Math.abs(days)}d ago` };
  if (days === 0) return { tone: 'expiring', label: 'Expires today' };
  if (days <= 7) return { tone: 'expiring', label: `${days}d left` };
  return { tone: 'active', label: `${days}d left` };
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      <p className="mt-1 max-w-sm text-base text-ink-muted">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A table that becomes a stack of cards on a phone, where reception works. */
export function DataTable<T>({
  rows,
  columns,
  rowHref,
  empty,
}: {
  rows: T[];
  columns: Array<{
    key: string;
    header: string;
    cell: (row: T) => React.ReactNode;
    align?: 'left' | 'right';
    hideOnMobile?: boolean;
  }>;
  rowHref?: (row: T) => string;
  empty: React.ReactNode;
}) {
  if (rows.length === 0) return <>{empty}</>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-base">
        <thead>
          <tr className="border-b border-line text-left">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`px-5 py-2.5 text-sm font-semibold text-ink-muted ${
                  column.align === 'right' ? 'text-right' : ''
                } ${column.hideOnMobile ? 'hidden md:table-cell' : ''}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const href = rowHref?.(row);
            return (
              <tr
                key={index}
                className="border-b border-line last:border-0 hover:bg-canvas/60"
              >
                {columns.map((column, columnIndex) => (
                  <td
                    key={column.key}
                    className={`px-5 py-3 ${column.align === 'right' ? 'text-right' : ''} ${
                      column.hideOnMobile ? 'hidden md:table-cell' : ''
                    }`}
                  >
                    {href && columnIndex === 0 ? (
                      <Link href={href} className="font-medium text-accent hover:underline">
                        {column.cell(row)}
                      </Link>
                    ) : (
                      column.cell(row)
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Rupees, grouped the Indian way: ₹1,50,000.00 rather than ₹150,000.00.
 *
 * Takes `unknown` because Prisma hands back a Decimal for money columns and
 * a page should not have to call `.toString()` at every call site.
 */
export function rupees(amount: unknown): string {
  const value = Number(amount ?? 0);
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function shortDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}

export function timeOfDay(value: Date | string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}
