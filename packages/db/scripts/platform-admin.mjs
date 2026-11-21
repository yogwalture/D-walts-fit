#!/usr/bin/env node
/**
 * Promote (or demote) a platform administrator.
 *
 *   pnpm platform:admin --email you@example.com
 *   pnpm platform:admin --email ex@example.com --revoke
 *   pnpm platform:admin --list
 *
 * Deliberately a script an operator runs on the server, not a seeded
 * account. A super admin shipped in the repository with a known password is
 * the first thing anybody would try on a new deployment, so there is no such
 * account: you register through the normal sign-up, then promote yourself
 * once, here, with database access you already had.
 *
 * It never creates a user and never sets a password. The person must already
 * have an account, which means they chose their own password and nobody —
 * including whoever runs this — has ever seen it.
 */

import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? null : (args[at + 1] ?? null);
};

const email = flag('email')?.trim().toLowerCase() ?? null;
const revoke = args.includes('--revoke');
const list = args.includes('--list');

// The owner role, because this writes to a column the runtime role is not
// permitted to change.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run this where the server runs.');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

try {
  if (list) {
    const admins = await prisma.user.findMany({
      // Bounded: more than 1,000 users for one gym is a data
      // problem, and a truncated list beats a request that times out.
      take: 1000,
      where: { isPlatformAdmin: true },
      select: { email: true, fullName: true, status: true, lastLoginAt: true },
      orderBy: { email: 'asc' },
    });

    if (admins.length === 0) {
      console.log('No platform administrators. Nobody can open the console.');
    } else {
      console.log(`${admins.length} platform administrator(s):\n`);
      for (const admin of admins) {
        const seen = admin.lastLoginAt
          ? admin.lastLoginAt.toISOString().slice(0, 10)
          : 'never signed in';
        console.log(`  ${admin.email.padEnd(40)} ${admin.status.padEnd(9)} ${seen}`);
      }
    }
    process.exit(0);
  }

  if (!email) {
    console.error('Usage: platform-admin --email <address> [--revoke] | --list');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, fullName: true, status: true, isPlatformAdmin: true },
  });

  if (!user) {
    console.error(
      `No account for ${email}. Register through the normal sign-up first, then run this.`,
    );
    process.exit(1);
  }

  if (user.isPlatformAdmin === !revoke) {
    console.log(
      `${user.email} is already ${revoke ? 'not ' : ''}a platform administrator. Nothing changed.`,
    );
    process.exit(0);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { isPlatformAdmin: !revoke },
  });

  // Revoking leaves their gym access alone: platform staff and gym staff are
  // separate things, and somebody may be both.
  console.log(
    revoke
      ? `${user.email} is no longer a platform administrator. Their own gym access is unchanged.`
      : `${user.email} (${user.fullName}) is now a platform administrator.`,
  );

  if (!revoke && user.status !== 'ACTIVE') {
    console.log(
      `Note: their account status is ${user.status}, so the console stays closed until it is ACTIVE.`,
    );
  }
} finally {
  await prisma.$disconnect();
}
