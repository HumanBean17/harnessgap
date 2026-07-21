// vitest globalSetup: build dist/ ONCE before all test files. Spawn-based
// suites (cli/cli-harness/cli.reflect/init) each `execFileSync('npm', ['run',
// 'build'])` in their own beforeAll; without a globalSetup the first file's
// build runs concurrently with others and races on dist/. Running the build
// here serializes the FIRST build before any test file starts; combined with
// `fileParallelism: false` in vitest.config.ts, the per-file beforeAll
// re-builds cannot race each other either.
//
// The build is allowed to fail loudly (non-zero exit propagates as a setup
// error and fails the whole suite before any test runs) — that matches the
// existing per-suite semantics where a build failure fails every CLI test.

import { execFileSync } from 'node:child_process';

export default function setup(): void {
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
}
