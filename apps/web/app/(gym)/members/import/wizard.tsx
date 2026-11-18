'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Upload, check, import.
 *
 * Three deliberate choices:
 *
 *   1. Nothing is created until the gym has seen the counts. An import that
 *      silently made four hundred half-right members would be worse than no
 *      import at all.
 *   2. Problems are listed against the row number in their own spreadsheet,
 *      so they can be fixed in Excel rather than guessed at.
 *   3. The commit loops in batches while the server says there is more. A
 *      file of two thousand members would otherwise be killed by Hostinger's
 *      120-second request limit, every time, with no way to make progress.
 */

const FIELDS: Array<{ value: string; label: string }> = [
  { value: '', label: '— skip this column —' },
  { value: 'fullName', label: 'Full name' },
  { value: 'firstName', label: 'First name' },
  { value: 'lastName', label: 'Last name' },
  { value: 'phone', label: 'Mobile number' },
  { value: 'altPhone', label: 'Alternate number' },
  { value: 'email', label: 'Email' },
  { value: 'memberCode', label: 'Member code' },
  { value: 'dateOfBirth', label: 'Date of birth' },
  { value: 'gender', label: 'Gender' },
  { value: 'joiningDate', label: 'Joining date' },
  { value: 'addressLine1', label: 'Address' },
  { value: 'city', label: 'City' },
  { value: 'state', label: 'State' },
  { value: 'postalCode', label: 'PIN code' },
  { value: 'emergencyContactName', label: 'Emergency contact' },
  { value: 'emergencyContactPhone', label: 'Emergency number' },
  { value: 'occupation', label: 'Occupation' },
  { value: 'notes', label: 'Notes' },
];

interface Preview {
  importId: string;
  filename: string;
  headers: string[];
  columnMap: Record<string, string>;
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  invalidRows: number;
  truncated: boolean;
  sample: Array<{
    rowNumber: number;
    status: string;
    parsed: Record<string, string>;
    issues: Array<{ field: string; issue: string }>;
    duplicateOf: { id: string; name: string; memberCode: string } | null;
  }>;
}

export function ImportWizard() {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [columnMap, setColumnMap] = useState<Record<string, string>>({});
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ created: number; remaining: number } | null>(null);
  const [done, setDone] = useState<{ created: number; skipped: number } | null>(null);

  async function upload(chosen: File, map?: Record<string, string>) {
    setBusy(true);
    setMessage(null);

    const body = new FormData();
    body.set('file', chosen);
    if (map) body.set('columnMap', JSON.stringify(map));

    const response = await fetch('/api/v1/members/import', { method: 'POST', body });
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setMessage(payload?.error?.message ?? 'That file could not be read.');
      setPreview(null);
      return;
    }

    setPreview(payload.data);
    setColumnMap(payload.data.columnMap ?? {});
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    setMessage(null);

    // Keep going while the server says there is more. Each call is short
    // enough to finish well inside a shared-hosting request limit.
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 500) {
        setMessage('That is taking longer than expected. Reload to see what was imported.');
        break;
      }

      const response = await fetch(`/api/v1/members/import/${preview.importId}/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ includeDuplicates, batchSize: 200 }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setMessage(
          payload?.error?.message ??
            'The import stopped. Anything already brought in has been kept.',
        );
        break;
      }

      const result = payload.data;
      setProgress({ created: result.created, remaining: result.remaining });

      if (!result.hasMore) {
        setDone({ created: result.created, skipped: result.skipped });
        break;
      }
    }

    setBusy(false);
    startTransition(() => router.refresh());
  }

  // ------------------------------------------------------------- done ---
  if (done) {
    return (
      <div className="card p-5">
        <h2 className="text-lg font-semibold text-ink">
          {done.created.toLocaleString('en-IN')} members imported
        </h2>
        <p className="mt-1 text-base text-ink-muted">
          They are on your members list now, marked inactive until you sell them a membership —
          so your dashboard shows what people have actually paid for.
          {done.skipped > 0 && ` ${done.skipped} rows were skipped.`}
        </p>
        <div className="mt-4 flex items-center gap-3">
          <Link href="/members" className="btn-primary">
            See the members
          </Link>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setDone(null);
              setPreview(null);
              setFile(null);
              setProgress(null);
            }}
          >
            Import another file
          </button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------- preview ---
  if (preview) {
    const willImport = preview.validRows + (includeDuplicates ? preview.duplicateRows : 0);

    return (
      <div className="space-y-4">
        {message && (
          <p
            role="alert"
            className="rounded-control bg-rose-50 px-3.5 py-2.5 text-base text-rose-800 ring-1 ring-inset ring-rose-200"
          >
            {message}
          </p>
        )}

        <div className="card p-5">
          <h2 className="text-base font-semibold text-ink">{preview.filename}</h2>
          <p className="mt-0.5 text-base text-ink-muted">
            {preview.totalRows.toLocaleString('en-IN')} rows read. Nothing has been created yet.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Count label="Ready to import" value={preview.validRows} tone="good" />
            <Count label="Already members" value={preview.duplicateRows} tone="warn" />
            <Count label="Need fixing" value={preview.invalidRows} tone="bad" />
          </div>

          {preview.truncated && (
            <p className="mt-3 text-sm text-amber-700">
              That file is longer than this can take in one go. The first 20,000 rows were read.
            </p>
          )}
        </div>

        <div className="card p-5">
          <h3 className="text-base font-semibold text-ink">Which column is which</h3>
          <p className="mt-0.5 text-base text-ink-muted">
            Checked from the headings in your file. Correct anything that is wrong.
          </p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {preview.headers.map((header, index) => (
              <label key={index} className="text-sm text-ink-muted">
                <span className="block truncate font-medium text-ink">{header || `Column ${index + 1}`}</span>
                <select
                  className="input mt-1 py-1.5"
                  value={columnMap[String(index)] ?? ''}
                  onChange={(event) =>
                    setColumnMap((current) => ({
                      ...current,
                      [String(index)]: event.target.value,
                    }))
                  }
                >
                  {FIELDS.map((field) => (
                    <option key={field.value} value={field.value}>
                      {field.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <button
            type="button"
            className="btn-ghost mt-3"
            disabled={busy || !file}
            onClick={() => file && upload(file, columnMap)}
          >
            {busy ? 'Checking…' : 'Check again with these columns'}
          </button>
        </div>

        <div className="card" >
          <header className="border-b border-line px-5 py-3.5">
            <h3 className="text-base font-semibold text-ink">
              The first {Math.min(preview.sample.length, 25)} rows, as they would be imported
            </h3>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="px-5 py-2 text-sm font-semibold text-ink-muted">Row</th>
                  <th className="px-5 py-2 text-sm font-semibold text-ink-muted">Name</th>
                  <th className="px-5 py-2 text-sm font-semibold text-ink-muted">Mobile</th>
                  <th className="px-5 py-2 text-sm font-semibold text-ink-muted">Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((row) => (
                  <tr key={row.rowNumber} className="border-b border-line last:border-0">
                    <td className="px-5 py-2 tabular-nums text-ink-muted">{row.rowNumber}</td>
                    <td className="px-5 py-2 text-ink">
                      {[row.parsed.firstName, row.parsed.lastName].filter(Boolean).join(' ') || (
                        <span className="text-ink-subtle">—</span>
                      )}
                    </td>
                    <td className="px-5 py-2 tabular-nums text-ink">
                      {row.parsed.phone ?? <span className="text-ink-subtle">—</span>}
                    </td>
                    <td className="px-5 py-2">
                      {row.status === 'VALID' ? (
                        <span className="text-sm text-emerald-700">Ready</span>
                      ) : (
                        <span className="text-sm text-amber-700">
                          {row.issues[0]?.issue ?? row.status.toLowerCase()}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {preview.duplicateRows > 0 && (
          <label className="card flex items-start gap-2.5 p-5 text-base text-ink">
            <input
              type="checkbox"
              className="mt-1"
              checked={includeDuplicates}
              onChange={(event) => setIncludeDuplicates(event.target.checked)}
            />
            <span>
              Import the {preview.duplicateRows} rows whose number is already on file.
              <span className="block text-sm text-ink-muted">
                Families and couples often share one number, so these are flagged rather than
                blocked — but ticking this can create the same person twice.
              </span>
            </span>
          </label>
        )}

        {busy && progress && (
          <p className="text-base text-ink-muted" aria-live="polite">
            Imported {progress.created.toLocaleString('en-IN')}…{' '}
            {progress.remaining.toLocaleString('en-IN')} to go.
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="btn-primary"
            disabled={busy || willImport === 0}
            onClick={commit}
          >
            {busy
              ? 'Importing…'
              : `Import ${willImport.toLocaleString('en-IN')} ${willImport === 1 ? 'member' : 'members'}`}
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() => {
              setPreview(null);
              setFile(null);
              setMessage(null);
            }}
          >
            Choose a different file
          </button>
        </div>
      </div>
    );
  }

  // ----------------------------------------------------------- upload ---
  return (
    <div className="card p-5">
      {message && (
        <p
          role="alert"
          className="mb-4 rounded-control bg-rose-50 px-3.5 py-2.5 text-base text-rose-800 ring-1 ring-inset ring-rose-200"
        >
          {message}
        </p>
      )}

      <label htmlFor="import-file" className="block text-sm font-medium text-ink">
        Your member list
      </label>
      <input
        id="import-file"
        type="file"
        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="input mt-1.5"
        disabled={busy}
        onChange={(event) => {
          const chosen = event.target.files?.[0] ?? null;
          setFile(chosen);
          if (chosen) void upload(chosen);
        }}
      />

      <p className="mt-2 text-base text-ink-muted">
        A CSV or Excel file with one member per row. It needs a name and a mobile number; anything
        else it finds — email, joining date, address — comes across too.
      </p>
      <p className="mt-1 text-sm text-ink-subtle">
        Export from your current software, or save your spreadsheet as CSV. Up to 10 MB.
      </p>

      {busy && (
        <p className="mt-3 text-base text-ink-muted" aria-live="polite">
          Reading the file…
        </p>
      )}
    </div>
  );
}

function Count({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'good' | 'warn' | 'bad';
}) {
  const colour =
    tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : 'text-rose-700';

  return (
    <div className="rounded-control bg-canvas p-3.5">
      <p className="text-sm font-medium text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${colour}`}>
        {value.toLocaleString('en-IN')}
      </p>
    </div>
  );
}
