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
          selector: "MemberExpression[property.name='$queryRawUnsafe']",
          message:
            'Raw SQL with string interpolation. Use $queryRaw with a tagged template so ' +
            'values are bound as parameters.',
        },
      ],

      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // The isolation suite exists precisely to run the queries the rules above
    // forbid elsewhere.
    files: ['tests/**/*.ts', 'packages/db/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];
