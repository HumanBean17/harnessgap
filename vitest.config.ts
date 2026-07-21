import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Build dist/ ONCE before any test file runs. Several spawn-based suites
// (cli/cli-harness/cli.reflect/init) each call `execFileSync('npm', ['run',
// 'build'])` in their own `beforeAll`; when vitest launches files in parallel,
// concurrent `tsc` invocations race on dist/ and intermittently fail (observed:
// first run failed, subsequent passed). The globalSetup runs the build a single
// time so each suite's beforeAll re-build is a no-op `tsc` against an unchanged
// graph — and `fileParallelism: false` serializes the suites so those per-file
// re-builds cannot race each other either. The per-file `beforeAll` blocks are
// NOT touched (they remain a defensive re-build); the globalSetup makes the
// first build deterministic and the serialization removes the concurrency
// hazard. fileParallelism:false is chosen over a shared `existsSync(dist/cli.js)`
// guard because each test file inlines its own `execFileSync` (no shared
// helper exists to add the guard to) per the slice's fix-6 brief.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: [fileURLToPath(new URL('./vitest.globalSetup.ts', import.meta.url))],
    fileParallelism: false,
  },
});
