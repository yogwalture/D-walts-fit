import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorker } from '@/components/service-worker';

export const metadata: Metadata = {
  // The product name is configuration, never a literal in the code: a
  // white-label tenant renames the whole application from the environment.
  title: {
    default: process.env.NEXT_PUBLIC_APP_NAME ?? 'Gym Management & Fitness Cloud',
    template: `%s · ${process.env.NEXT_PUBLIC_APP_NAME ?? 'Gym Cloud'}`,
  },
  description:
    'Run your gym: members, memberships, attendance, payments and reminders in one place.',
  robots: { index: true, follow: true },
  applicationName: process.env.NEXT_PUBLIC_APP_NAME ?? 'Gym Cloud',
  formatDetection: { telephone: false },
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: process.env.NEXT_PUBLIC_APP_NAME ?? 'Gym Cloud',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#020617' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" suppressHydrationWarning>
      <body className="min-h-screen">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
