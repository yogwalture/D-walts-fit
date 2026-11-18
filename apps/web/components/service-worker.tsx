'use client';

import { useEffect } from 'react';

/**
 * Registers the member app's service worker.
 *
 * Only on the member side: staff work at a desk on a real connection, and a
 * cached staff screen showing yesterday's takings would be a liability
 * rather than a convenience.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (!window.location.pathname.startsWith('/my')) return;

    const timer = setTimeout(() => {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }, 1_000);

    return () => clearTimeout(timer);
  }, []);

  return null;
}
