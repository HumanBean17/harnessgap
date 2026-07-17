// Cmd-class and file-class pure classifiers for the Diagnoser (Slice 4, Task 2).
// Two small fixed-catalog lookups consumed by evidence projection (Task 3):
//   - classifyCmd: buckets a failed exec cmd into test | config | build | other
//   - classifyFile: buckets an edited file path into test | code | other
// No I/O, no mutation. Catalogs and precedence are pinned to the task brief.

import type { CmdClass, FileClass } from '../types.js';

// Re-export so callers can import the bucket types alongside the classifiers.
export type { CmdClass, FileClass };

/**
 * Config-class cmd substrings (brief §classifyCmd). Order does not matter —
 * `config` is a single rank; any hit yields `config`.
 */
const CMD_CONFIG_CATALOG: readonly string[] = [
  'install',
  'migrate',
  'seed',
  'db:',
  'docker compose',
  'docker-compose',
  'psql',
  'mysql',
  'createdb',
  'alembic',
  'prisma',
  'setup',
  'configure',
  ':env',
  'env ',
  'dotenv',
];

/**
 * Build-class cmd substrings (brief §classifyCmd).
 */
const CMD_BUILD_CATALOG: readonly string[] = [
  'tsc',
  'webpack',
  'esbuild',
  'vite build',
  'rollup',
  'cargo build',
  'go build',
  'npm run build',
  'yarn build',
  'pnpm build',
  'mvn',
  'gradle',
  'make build',
];

/**
 * Test-file substrings (brief §classifyFile). Path-segment matches
 * (`test`/`tests`/`__tests__`) are checked separately.
 */
const FILE_TEST_SUBSTRINGS: readonly string[] = [
  '.test.',
  '.spec.',
  '_test.',
  'test_',
  '__tests__',
  '.tests.',
];

/**
 * Path segments that mark a file as a test file (brief §classifyFile).
 */
const FILE_TEST_SEGMENTS: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
]);

/**
 * `other`-class file extensions (brief §classifyFile). Stored without the
 * leading dot for `endsWith` checks; the dot is re-added at lookup time.
 */
const FILE_OTHER_EXTENSIONS: readonly string[] = [
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.env',
  '.lock',
  '.md',
  '.txt',
  '.rst',
  '.ini',
  '.conf',
  '.cfg',
];

/**
 * `other`-class file basenames (brief §classifyFile). Exact match only.
 */
const FILE_OTHER_BASENAMES: ReadonlySet<string> = new Set([
  'Dockerfile',
  'Makefile',
  'package.json',
  'package-lock.json',
  '.env',
  '.gitignore',
]);

function containsAny(haystack: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (haystack.includes(n)) return true;
  }
  return false;
}

/**
 * Classify a failed-exec command into a cmd-class bucket.
 *
 * Precedence (brief, verbatim): **test > config > build > other**.
 * - `test`: `cmd` contains any of `testCmdPatterns` as a substring (these are
 *   the live `cfg.areas.test_cmd_patterns`).
 * - `config`: `cmd` contains any `CMD_CONFIG_CATALOG` substring.
 * - `build`: `cmd` contains any `CMD_BUILD_CATALOG` substring.
 * - Empty / whitespace-only `cmd` short-circuits to `other` before any catalog
 *   is consulted (so a blank cmd can never match the `env ` pattern's trailing
 *   space or similar edge cases).
 */
export function classifyCmd(
  cmd: string,
  testCmdPatterns: string[],
): CmdClass {
  if (cmd.trim() === '') return 'other';
  if (containsAny(cmd, testCmdPatterns)) return 'test';
  if (containsAny(cmd, CMD_CONFIG_CATALOG)) return 'config';
  if (containsAny(cmd, CMD_BUILD_CATALOG)) return 'build';
  return 'other';
}

/**
 * Classify an edited-file path into a file-class bucket.
 *
 * Precedence (brief, verbatim): **test > other > code**.
 * - `test`: path contains any `FILE_TEST_SUBSTRINGS` substring, OR has a path
 *   segment in `FILE_TEST_SEGMENTS` (`test`/`tests`/`__tests__`).
 * - `other`: file extension is in `FILE_OTHER_EXTENSIONS`, OR basename is in
 *   `FILE_OTHER_BASENAMES` (config/doc/lockfile shape).
 * - Otherwise `code`.
 */
export function classifyFile(path: string): FileClass {
  if (isTestFile(path)) return 'test';
  if (isOtherFile(path)) return 'other';
  return 'code';
}

function isTestFile(path: string): boolean {
  if (containsAny(path, FILE_TEST_SUBSTRINGS)) return true;
  const segments = path.split('/');
  for (const seg of segments) {
    if (FILE_TEST_SEGMENTS.has(seg)) return true;
  }
  return false;
}

function isOtherFile(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  if (FILE_OTHER_BASENAMES.has(base)) return true;
  const lower = path.toLowerCase();
  for (const ext of FILE_OTHER_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}
