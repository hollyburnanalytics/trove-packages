import { defineConfig } from 'vitest/config';

/**
 * Test configuration for `@ontrove/cli`.
 *
 * This suite runs under Node so the v8 coverage provider instruments correctly.
 * All tests mock `fetch`/filesystem — no network and no credentials. The
 * `*.smoke.test.ts` suite is excluded here: it exercises the real Bun
 * loader/bundler and must run under Bun (`test:smoke`), where v8 coverage does
 * not apply.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/**/*.smoke.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/types.ts',
        'src/operations.ts',
        // Bun-runtime shim: types only, no runnable code under Node.
        'src/bun-env.d.ts',
        'src/vendor/**',
        // The one genuinely-unrunnable seam: opens the system browser and binds
        // a real loopback socket then waits for the user to authorize in Clerk.
        // Its pure flow logic is fully covered in oauth.ts/oauth.test.ts.
        'src/commands/login-live.ts',
      ],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
