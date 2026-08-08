import { defineConfig } from 'vitest/config';

export default defineConfig({
  // JSX is transformed by esbuild directly. The React plugin is not used here: it exists
  // for Fast Refresh, which tests do not need, and it lives in @seg/client rather than at
  // the workspace root.
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx'],
    // Node is the default; client tests opt into jsdom with a `@vitest-environment`
    // docblock, which keeps the fast majority fast.
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
    },
  },
});
