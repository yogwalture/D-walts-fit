'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Membership {
  organizationId: string;
  name: string;
  slug: string;
  roleKey: string;
}

/**
 * Switching gyms.
 *
 * The request names an organization; the server verifies membership against
 * org_users and rewrites the session row. Nothing here is trusted — this
 * control is a convenience, and picking an id it was never given would be
 * refused exactly the same way.
 */
export function OrganizationSwitcher({
  memberships,
  currentId,
}: {
  memberships: Membership[];
  currentId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const current = memberships.find((m) => m.organizationId === currentId);

  if (memberships.length <= 1) {
    return <p className="truncate text-base font-medium text-ink">{current?.name ?? ''}</p>;
  }

  async function switchTo(organizationId: string) {
    if (organizationId === currentId) return;
    setBusy(true);

    const response = await fetch('/api/v1/session/organization', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId }),
    });

    setBusy(false);
    if (response.ok) {
      router.replace('/dashboard');
      router.refresh();
    }
  }

  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">Switch gym</span>
      <select
        value={currentId ?? ''}
        disabled={busy}
        onChange={(event) => switchTo(event.target.value)}
        className="input max-w-[16rem] py-1.5"
      >
        {memberships.map((membership) => (
          <option key={membership.organizationId} value={membership.organizationId}>
            {membership.name}
          </option>
        ))}
      </select>
    </label>
  );
}
