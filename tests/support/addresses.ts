/**
 * A forwarded address no other test will use.
 *
 * Registration is throttled at ten gyms an hour per address, which is right
 * for a public signup form and wrong for a suite that registers thirty gyms
 * in a minute. Several suites had used a random address from a small range,
 * so collisions exhausted the allowance and the failure landed on whichever
 * test ran after the tenth gym — a different one each run.
 *
 * Uniqueness has to hold across test FILES, not just within one. The first
 * attempt kept a counter per module, so every file started at the same
 * address and the second file collided with the first immediately.
 *
 * So: the third octet is the worker process id, which differs between
 * vitest workers, and the fourth is a counter on `globalThis`, shared by
 * every module inside one worker. Addresses come from 198.18.0.0/15, which
 * RFC 2544 reserves for benchmarking and which therefore belongs to nobody.
 */

const KEY = '__gymTestAddressCounter';

export function nextTestAddress(): string {
  const store = globalThis as Record<string, unknown>;
  const next = ((store[KEY] as number | undefined) ?? 0) + 1;
  store[KEY] = next;

  // Two /16s give 512 worker-and-counter combinations before anything
  // repeats, against a suite that registers well under a hundred gyms.
  const pid = typeof process !== 'undefined' ? process.pid : 0;
  return `198.${18 + (Math.floor(pid / 256) % 2)}.${pid % 256}.${(next % 254) + 1}`;
}
