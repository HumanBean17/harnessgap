// §11 egress guard. Single source of truth shared by the egress audit
// (test/egress.test.ts) and its unit tests. Two gates:
//
// 1. No-network gate (default path). The CLI's default path — scan / reflect /
//    init / review / explain without `synthesize` — is stateless and offline
//    (§11): no src/ file may import a network module (http, https, net,
//    node:net, node:http, node:https, undici, fetch) or invoke the global
//    fetch. FORBIDDEN_IMPORT + FORBIDDEN_FETCH_CALL encode what counts as
//    "forbidden" so the scan and the unit tests cannot drift apart.
//
// 2. child_process confinement gate. `node:child_process` is the closed-loop
//    MVP's only subprocess egress: imported in src/synthesizer/backend.ts
//    (shells out to the agent print-mode CLI) and in src/git.ts (Task 7
//    `isValidSha`). Every other src/ module must remain subprocess-free.
//    CHILD_PROCESS_IMPORT + CHILD_PROCESS_ALLOWLIST / isChildProcessAllowed
//    encode the allowlist.
//
// The DEFAULT PATH is subprocess-free except for the two allowlisted modules;
// the opt-in `synthesize` egress is bounded by child_process + the trusted
// agent CLI, NOT by network imports (there are none anywhere in src/).

// Matches four import shapes whose specifier is a forbidden network module
// (http, https, net, node:net, node:http, node:https, undici, fetch — the
// `node:` prefix is optional and `https?` collapses http/https):
//   1. static import with a binding list (possibly multi-line): import … from 'spec'
//      — `[\s\S]*?` matches across newlines so multi-line named imports are caught.
//   2. side-effect import: bare import 'spec' (no `from`).
//   3. dynamic import: import('spec').
//   4. CommonJS require: require('spec').
// Errs toward flagging (matches inside comments/strings too) — acceptable for a
// security control; the scan asserts zero offenders in src/.
export const FORBIDDEN_IMPORT =
  /(?:import\s+[\s\S]*?\s+from\s+|import\s*|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?(?:https?|net|undici|fetch)['"]/;

// Matches a call to the global fetch — a network API available as a global in
// Node 18+ (this project targets Node >=22.12), so an import is not required to
// use it. Catches a fetch invocation with any arguments. Case-sensitive so it
// does not match `WebFetch` or `hasFetchCall`; a locally-defined fetch function
// would still match, which is acceptable in a no-network codebase where no such
// local binding exists. Errs toward flagging (matches inside comments/strings).
export const FORBIDDEN_FETCH_CALL = /\bfetch\s*\(/;

/** True if `content` contains a forbidden network-module import. */
export function hasForbiddenImport(content: string): boolean {
  return FORBIDDEN_IMPORT.test(content);
}

/** True if `content` invokes the global fetch. */
export function hasFetchCall(content: string): boolean {
  return FORBIDDEN_FETCH_CALL.test(content);
}

/** True if `content` has any forbidden network egress (import or fetch call). */
export function hasForbiddenEgress(content: string): boolean {
  return hasForbiddenImport(content) || hasFetchCall(content);
}

// §11 child_process confinement detector. Mirrors the FORBIDDEN_IMPORT shape
// (static / side-effect / dynamic import + CommonJS require) but is anchored to
// column 0 with the `m` flag. The column-0 anchor is load-bearing: it excludes
// the indented `    var cp = require('child_process');` line that
// src/init/claude.ts emits INSIDE its wrapper template literal — that line is
// runtime wrapper source written to .claude/harnessgap-stop-hook.js, not a
// src/ import. Every real ESM `import` in this codebase lives at column 0
// (static imports are top-level only); every realistic top-level CommonJS
// require does too. A dynamic `import(...)` nested inside a function body would
// be indented and slip past this regex — acceptable because the codebase is
// ESM-only and such a call has never appeared; the static + top-level require
// shapes are the ones that matter.
export const CHILD_PROCESS_IMPORT =
  /^(?:import\s+[\s\S]*?\s+from\s+|import\s+|import\s*\(\s*|(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*|require\s*\(\s*)['"](?:node:)?child_process['"]/m;

/**
 * Relative src/ paths permitted to import child_process — the single source of
 * truth the audit walks. Entries ending in `/` are prefix matches (so any file
 * under src/synthesizer/** qualifies); other entries are exact path matches.
 * Allowlist is exactly:
 *   - src/synthesizer/** (opt-in synthesize egress; only backend.ts imports it
 *     today, but the whole package is cleared for it).
 *   - src/git.ts (Task 7 `isValidSha` — shells out to `git cat-file`).
 * Nowhere else. Not src/cli.ts, src/pipeline.ts, src/detector/*, src/adapter/*,
 * src/review.ts, src/explain.ts, src/init/*, etc.
 */
export const CHILD_PROCESS_ALLOWLIST: readonly string[] = [
  'synthesizer/', // prefix: any file under src/synthesizer/**
  'git.ts', // exact: src/git.ts (Task 7 isValidSha)
];

/** True if `content` contains a top-level child_process import/require. */
export function hasChildProcessImport(content: string): boolean {
  return CHILD_PROCESS_IMPORT.test(content);
}

/**
 * True if `relPath` (a src/-relative path like `synthesizer/backend.ts` or
 * `git.ts`) is on the child_process allowlist. Mirrors the allowlist rules:
 * `synthesizer/` is a prefix; `git.ts` is exact.
 */
export function isChildProcessAllowed(relPath: string): boolean {
  return CHILD_PROCESS_ALLOWLIST.some((p) =>
    p.endsWith('/') ? relPath.startsWith(p) : relPath === p,
  );
}
