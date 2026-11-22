import { config as loadEnv } from 'dotenv';
import type { NextConfig } from 'next';

/**
 * One environment file for the whole repository.
 *
 * Next reads `.env*` from the app directory, so without this the app would
 * need its own copy of every secret — two files that drift, and a key
 * rotated in one place that still fails in the other. Anything already set
 * in the real environment wins, which is what production does.
 */
loadEnv({ path: new URL('../../.env', import.meta.url).pathname });

const config: NextConfig = {
  reactStrictMode: true,

  // Workspace packages ship TypeScript source, not a build artefact, so Next
  // compiles them alongside the app. One less build step to go stale.
  transpilePackages: ['@gym/core', '@gym/db', '@gym/contracts', '@gym/ui', '@gym/integrations'],

  // The hosting plan runs the app as a persistent Node process, so the
  // standalone output is what gets started. It bundles only what is reached,
  // which keeps the deployed inode count down on a plan capped at 600,000.
  output: 'standalone',

  poweredByHeader: false,

  serverExternalPackages: ['@prisma/client', '@node-rs/argon2'],

  /**
   * Native modules are loaded by Node at runtime, not bundled.
   *
   * serverExternalPackages alone is not enough here: the import reaches
   * argon2 through a transpiled workspace package, so webpack follows it in
   * and then meets a .node binary it cannot parse. Marking it external on
   * the server build leaves the require() for Node to resolve, which is what
   * we want anyway — the prebuilt binary must be loaded, not inlined.
   */
  webpack(config, { isServer }) {
    if (isServer) {
      const externals = Array.isArray(config.externals) ? config.externals : [config.externals];
      config.externals = [
        ...externals.filter(Boolean),
        ({ request }: { request?: string }, callback: (err?: unknown, result?: string) => void) => {
          if (request && /^@node-rs\/argon2/.test(request)) {
            return callback(undefined, `commonjs ${request}`);
          }
          return callback();
        },
      ];
    }
    return config;
  },

  experimental: {
    // Request bodies are small; the large files go straight to object
    // storage with a presigned URL and never pass through this process.
    serverActions: { bodySizeLimit: '2mb' },

    // Shared hosting caps how many processes and threads an account may hold
    // open at once. Next spawns a build worker per CPU, and each worker starts
    // a Rust thread pool sized to the core count of the machine rather than the
    // share the account gets, so thread creation fails with EAGAIN partway
    // through collecting page data. One in-process worker stays under the cap,
    // at the cost of build time nobody is waiting on.
    cpus: 1,
    workerThreads: false,
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(), geolocation=(), payment=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default config;
