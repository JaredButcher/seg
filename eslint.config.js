// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Boundary enforcement lives here rather than in convention, because both of these
 * constraints are cheap now and unenforceable later. See planning/10 §3.
 *
 *   1. `@seg/shared` must run identically in Node and the browser — no I/O, no Node
 *      builtins, no DOM. It is the package both the server and the client import.
 *   2. The simulation must be deterministic given (seed, initial state, command stream),
 *      which is what makes replays, regression tests, and bug reproduction possible.
 *      That means no `Math.random()` and no wall-clock time inside `sim/`.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.config.js'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // ── @seg/shared: no I/O, no Node, no DOM ──────────────────────────────────────
  {
    files: ['packages/shared/**/*.ts'],
    languageOptions: {
      globals: {}, // deliberately empty: neither Node nor browser globals exist here
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'path',
                'http',
                'https',
                'net',
                'crypto',
                'os',
                'worker_threads',
              ],
              message: '@seg/shared must run in the browser. Node builtins belong in @seg/server.',
            },
            {
              group: ['ws', 'better-sqlite3', 'pino', 'express'],
              message: '@seg/shared must not depend on server infrastructure.',
            },
            {
              group: ['react', 'react-dom', 'pixi.js', 'zustand'],
              message: '@seg/shared must not depend on client rendering or UI.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: '@seg/shared must run in Node. No DOM access.' },
        { name: 'document', message: '@seg/shared must run in Node. No DOM access.' },
        { name: 'localStorage', message: '@seg/shared must run in Node. No DOM access.' },
        { name: 'process', message: '@seg/shared must run in the browser. No Node globals.' },
        { name: '__dirname', message: '@seg/shared must run in the browser. No Node globals.' },
      ],
    },
  },

  // ── The simulation must be deterministic ──────────────────────────────────────
  {
    // `map/` is here as well as `sim/`: a generator that reached for Math.random() would
    // break replays exactly as silently as the simulation doing it, because a replay stores
    // a map's seed rather than its geometry (planning/04 §9).
    files: [
      'packages/shared/src/sim/**/*.ts',
      'packages/shared/src/map/**/*.ts',
      'packages/shared/src/mapgen/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            'The simulation must be deterministic. Use the injected seeded PRNG, not Math.random().',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            'The simulation must be deterministic. `tick` is the only clock — no wall-clock time.',
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            'The simulation must be deterministic. `tick` is the only clock — no wall-clock time.',
        },
        {
          selector: "CallExpression[callee.object.name='performance'][callee.property.name='now']",
          message:
            'The simulation must be deterministic. `tick` is the only clock — no wall-clock time.',
        },
      ],
    },
  },

  // ── @seg/server: Node environment ─────────────────────────────────────────────
  // `.mjs` as well as `.ts`, for the one file in the server that cannot be TypeScript:
  // `match/worker/boot.mjs`, which turns the tsx loader on inside a worker thread and so has to
  // be something Node can already load. See its header.
  {
    files: ['packages/server/**/*.ts', 'packages/server/**/*.mjs', 'packages/tools/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // ── @seg/client: browser environment ──────────────────────────────────────────
  {
    files: ['packages/client/**/*.ts', 'packages/client/**/*.tsx'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // ── Tests may use anything ────────────────────────────────────────────────────
  {
    files: ['**/test/**/*.ts', '**/*.test.ts', '**/*.test.tsx'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
