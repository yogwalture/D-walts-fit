'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
}

export function InviteStaffDialog({ roles }: { roles: Role[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/v1/org/staff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: String(form.get('email') ?? ''),
        fullName: String(form.get('fullName') ?? ''),
        roleId: String(form.get('roleId') ?? ''),
        branchIds: [],
      }),
    });

    setBusy(false);
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      setError(payload?.error?.message ?? 'Could not send that invitation.');
      return;
    }

    setSentTo(payload?.data?.email ?? null);
    router.refresh();
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-primary">
        Invite staff
      </button>
    );
  }

  return (
    <div className="card w-full max-w-md animate-fade-in p-5">
      {sentTo ? (
        <div className="space-y-3">
          <p className="text-base text-ink">Invitation sent to {sentTo}.</p>
          <p className="text-base text-ink-muted">
            They choose their own password when they accept. The link expires in seven days.
          </p>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setSentTo(null);
              setOpen(false);
            }}
          >
            Done
          </button>
        </div>
      ) : (
        <form method="post" onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-ink">Invite a staff member</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="btn-ghost px-2 py-1"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"
            >
              {error}
            </div>
          )}

          <div>
            <label htmlFor="fullName" className="label">
              Their name
            </label>
            <input id="fullName" name="fullName" required autoFocus className="input mt-1.5" />
          </div>

          <div>
            <label htmlFor="email" className="label">
              Their email address
            </label>
            <input id="email" name="email" type="email" required className="input mt-1.5" />
          </div>

          <div>
            <label htmlFor="roleId" className="label">
              Role
            </label>
            <select id="roleId" name="roleId" required defaultValue="" className="input mt-1.5">
              <option value="" disabled>
                Choose a role
              </option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </div>

          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy ? 'Sending…' : 'Send invitation'}
          </button>
        </form>
      )}
    </div>
  );
}
