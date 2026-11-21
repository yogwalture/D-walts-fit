/**
 * Shared ESLint configuration.
 *
 * The rules below are not style preferences. Each one closes a hole that
 * tenant isolation depends on, so a violation fails the build rather than
 * waiting to be caught in review.
 */

export default [
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@gym/db/client',
              message:
                'The raw Prisma client carries no tenant context. Use withTenant() ' +
                'from @gym/db, or withPlatform() for platform-owned tables.',
            },
            {
              name: '@prisma/client',
              importNames: ['PrismaClient'],
              message:
                'Do not construct a PrismaClient in application code. Use withTenant() ' +
                'from @gym/db so the database sees the tenant context too.',
            },
          ],
        },
      ],

      // A findMany with no take is how a 50,000-row table reaches the browser
      // and how a 120-second request timeout gets hit on shared hosting.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='findMany']:not(:has(Property[key.name='take']))",
          message:
            'findMany without take: every list endpoint must paginate. Pass take, or ' +
            'use the paginate() helper in @gym/core.',
        },
        {
          /**
           * Raw SQL whose text is built by substitution.
           *
           * `$queryRawUnsafe` itself is not the problem and cannot be
           * avoided: `SELECT … FOR UPDATE` is how class capacity and stock
           * are held under concurrent writes, and Prisma's typed API cannot
           * express it. Those calls pass `$1`, `$2` and let the driver bind
           * the values, which is parameterised and safe.
           *
           * What is never safe is a template literal with an expression in
           * it, because then the value becomes part of the statement. So
           * the rule matches that shape and nothing else — the first
           * version matched every `$queryRawUnsafe` and would have been
           * silenced wholesale the first time somebody needed a row lock.
           */
          selector:
            "CallExpression[callee.property.name='$queryRawUnsafe'] > TemplateLiteral:has(TemplateLiteral > *.expressions)",
          message:
            'Raw SQL built by string interpolation: the value becomes part of the ' +
            'statement. Pass it as $1, $2 and let the driver bind it, or use $queryRaw ' +
            'with a tagged template.',
        },
        {
          // The same shape, one level out: `$executeRawUnsafe`.
          selector:
            "CallExpression[callee.property.name='$executeRawUnsafe'] > TemplateLiteral:has(TemplateLiteral > *.expressions)",
          message:
            'Raw SQL built by string interpolation. Pass values as $1, $2 so the driver ' +
            'binds them.',
        },
      ],

      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // `== null` is the idiomatic test for "null or undefined" and reads
      // better than spelling both out. Every other loose comparison is an
      // error.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // The isolation suite exists precisely to run the queries the rules above
    // forbid elsewhere.
    // Also .mjs: the operator scripts in packages/db/scripts connect as the
    // owner on purpose, and the first version of this exemption matched only
    // TypeScript — so `platform-admin.mjs` was told to use withTenant(),
    // which is the one thing it cannot do.
    files: ['tests/**/*.ts', 'tests/**/*.mjs', 'packages/db/**/*.ts', 'packages/db/**/*.mjs', 'scripts/**/*.mjs'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];
