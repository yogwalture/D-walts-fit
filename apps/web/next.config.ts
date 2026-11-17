import type { NextConfig } from 'next';

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
