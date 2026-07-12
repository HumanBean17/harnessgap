// §11 egress guard: forbidden network-egress detection. Single source of truth
// shared by the no-network audit (test/egress.test.ts) and its unit tests.
//
// The CLI must be stateless and offline (§11): no src file may import a network
// module or invoke the global fetch. This module encodes what counts as
// "forbidden" so the scan and the unit tests cannot drift apart.

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
