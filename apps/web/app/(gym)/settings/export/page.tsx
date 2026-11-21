import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { exportManifest } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import { ExportButton } from './button';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Export your data' };

/**
 * Taking your data out.
 *
 * Deliberately not buried, and deliberately not a support request. A gym
 * that wants to leave should be able to, in one click, without asking us —
 * which is the only version of "your data is yours" that means anything. It
 * also keeps working when a trial has lapsed and the gym is read-only, which
 * is exactly when somebody is most likely to want it.
 */
export default async function ExportPage() {
  const { session, actor, ctx } = await requireActor('/settings/export');
  if (!holds(session, 'org.export.create')) notFound();

  const manifest = await exportManifest(ctx, actor.permissions);
  const withRows = manifest.tables.filter((table) => table.rows > 0);
  const empty = manifest.tables.length - withRows.length;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Export your data</h1>
        <p className="mt-1 text-base text-ink-muted">
          Everything this gym holds, as spreadsheets you can open anywhere. No request to us,
          no waiting, and nothing is removed from here by taking a copy.
        </p>
      </div>

      <section className="card p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-ink-muted">In this export</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-ink">
              {manifest.totalRows.toLocaleString('en-IN')}
            </p>
            <p className="mt-1 text-sm text-ink-subtle">
              rows across {withRows.length} {withRows.length === 1 ? 'file' : 'files'}
              {empty > 0 ? `, plus ${empty} empty` : ''}
            </p>
          </div>
          <ExportButton rows={manifest.totalRows} />
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-lg font-semibold text-ink">What is in it</h2>
        </div>
        <ul className="divide-y divide-line">
          {manifest.tables.map((table) => (
            <li key={table.name} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
              <div className="min-w-0">
                <p className="text-base text-ink">{table.name}.csv</p>
                <p className="text-sm text-ink-muted">{table.describes}</p>
              </div>
              <span className="shrink-0 text-sm tabular-nums text-ink-subtle">
                {table.rows.toLocaleString('en-IN')}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-semibold text-ink">What is not in it</h2>
        <ul className="mt-2 space-y-2 text-base text-ink-muted">
          <li>
            Uploaded documents and progress photographs. They are files rather than rows, and
            they download from the member record they belong to. The archive lists them so you
            know what exists.
          </li>
          <li>
            Your sign-in tokens, and the credentials for your WhatsApp and Razorpay accounts.
            Those are keys rather than records — you hold them already, and a copy in a
            spreadsheet is a copy that can be lost.
          </li>
          <li>
            Members&rsquo; medical notes in full. The archive records that a declaration exists
            and whether clearance was given; the note itself goes to the member in their own
            export, because it is theirs before it is yours.
          </li>
          <li>
            Staff salaries and bank details. They are permission-gated inside the product, and a
            bulk spreadsheet is the one place that gate would not hold.
          </li>
          <li>
            The shared exercise library every gym on this system reads. Your own exercises, your
            training plans and every session your members logged are all included.
          </li>
        </ul>
      </section>

      <p className="text-sm text-ink-subtle">
        Taking an export is recorded in your activity log, with who did it and when — because a
        download of your whole member list is worth being able to see.
      </p>
    </div>
  );
}
