import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

config({ path: '.env' });

// The generated Prisma client lives in packages/db, where the schema is.
// Resolve it from there so tests outside that package use the same client
// the application uses, not a second, ungenerated copy.
const requireFromDb = createRequire(
  new URL('./packages/db/package.json', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      '@prisma/client': requireFromDb.resolve('@prisma/client'),
      '@gym/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@gym/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@gym/contracts': new URL('./packages/contracts/src/index.ts', import.meta.url).pathname,
      '@gym/integrations': new URL(
        './packages/integrations/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    // Isolation tests share one database and assert exact row counts, so
    // they must not race each other.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['verbose'],
  },
});
