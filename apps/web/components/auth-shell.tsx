import Link from 'next/link';

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  width = 'sm',
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'sm' | 'md';
}) {
  const appName = process.env.NEXT_PUBLIC_APP_NAME ?? 'Gym Cloud';

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className={`w-full animate-fade-in ${width === 'md' ? 'max-w-md' : 'max-w-sm'}`}>
        <div className="mb-8 text-center">
          <Link
            href="/"
            className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-card bg-accent text-lg font-semibold text-white"
            aria-label={appName}
          >
            {appName.charAt(0)}
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-1 text-base text-ink-muted">{subtitle}</p>}
        </div>

        <div className="card p-6">{children}</div>

        {footer && <div className="mt-6 text-center text-base text-ink-muted">{footer}</div>}
      </div>
    </main>
  );
}
