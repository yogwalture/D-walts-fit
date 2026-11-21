import { PrismaClient } from '@prisma/client';

/**
 * Clears the throttle counters this suite's own addresses accumulate.
 *
 * `throttle_hits` rows live for 24 hours, so without this the suite poisons
 * its own next run: registration allows ten gyms an hour per address, and
 * a few runs in one afternoon exhaust the allowance. The failure then lands
 * on whichever test happens to register the eleventh gym — a different one
 * each time, which is how this took three attempts to pin down.
 *
 * Only the ranges reserved for documentation and benchmarking are cleared.
 * A real address is somebody's, and nothing here should touch a counter
 * that is doing its job.
 */
export default async function setup() {
  const db = new PrismaClient({
    datasources: { db: { url: process.env.JOBS_DATABASE_URL } },
  });

  try {
    const removed = await db.throttleHit.deleteMany({
      where: {
        OR: [
          // RFC 2544 benchmarking, used by nextTestAddress().
          { key: { startsWith: '198.18.' } },
          { key: { startsWith: '198.19.' } },
          // RFC 5737 documentation, used where a test asserts the address.
          { key: { startsWith: '198.51.100.' } },
          { key: { startsWith: '203.0.113.' } },
          { key: { startsWith: '192.0.2.' } },
        ],
      },
    });

    if (removed.count > 0) {
      process.stdout.write(`\ncleared ${removed.count} throttle counters from earlier runs\n`);
    }
  } finally {
    await db.$disconnect();
  }
}
