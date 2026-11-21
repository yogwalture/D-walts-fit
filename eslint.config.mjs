import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import isolationRules from './packages/config/eslint.config.mjs';

/**
 * The root ESLint configuration.
 *
 * It exists because the isolation rules in `packages/config` had never run.
 * They were written to "fail the build rather than wait to be caught in
 * review", nothing referenced them, no package had a lint script that used
 * them, and `apps/web` ran `next lint` — which, with no config to find,
 * drops into an interactive prompt and exits non-zero. `pnpm lint` had
 * therefore never linted a line of this codebase, and read as passing
 * because the failure prints no word any of my greps looked for.
 */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/.turbo/**',
      'packages/db/prisma/migrations/**',
      // Generated: base64 font blobs, megabytes of it.
      'packages/integrations/src/pdf/fonts.ts',
      // Next writes this, with a triple-slash reference it owns.
      'apps/web/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // The rules that matter, from the shared config.
  ...isolationRules,

  {
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        ReadableStream: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        __dirname: 'readonly',
        require: 'readonly',
        module: 'writable',
        structuredClone: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        URLSearchParams: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
      },
    },
    rules: {
      // The codebase uses `any` deliberately for Prisma transaction clients,
      // which have no exported type that survives the tenant extension.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // The service worker, which has its own globals and no DOM.
    files: ['apps/web/public/sw.js', 'apps/web/**/sw.js'],
    languageOptions: {
      globals: { self: 'readonly', caches: 'readonly', clients: 'readonly' },
    },
  },

  {
    // Browser and React files.
    files: ['apps/web/**/*.tsx', 'apps/web/**/*.ts', 'apps/web/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        HTMLFormElement: 'readonly',
        HTMLScriptElement: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        URLSearchParams: 'readonly',
        React: 'readonly',
      },
    },
  },

  {
    // Vitest's globals, and the test files' freedom to do what the isolation
    // rules forbid elsewhere — which is the whole point of the suite.
    files: ['tests/**/*.ts', 'tests/**/*.mjs'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  {
    // Scripts and e2e harnesses run on Node directly. The browser suite also
    // ships functions into the page through `evaluate`, where `document` is
    // the page's, not Node's.
    files: ['scripts/**/*.mjs', 'tests/e2e/**/*.mjs'],
    languageOptions: {
      globals: { document: 'readonly', window: 'readonly', navigator: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },
];
