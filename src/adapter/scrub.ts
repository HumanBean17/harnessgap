// Pattern-catalog secret scrubber — the privacy backbone for slice-2 persistence.
// Pure functions, no I/O, no entropy heuristic. Seven rules applied in a fixed
// order so earlier rules (heredoc blocks) are not partially mangled by later
// ones (env-var). The same sentinel literal is used everywhere.

const SENTINEL = '***REDACTED***';
const MAX_CMD_QUERY = 512;
const MAX_FILES = 50;

/**
 * Apply the full 7-rule pattern catalog to a command/query string. Rules run in
 * the documented order: heredoc keys → env-vars → auth headers → URL creds →
 * flag secrets → credential-file paths → known-format tokens.
 */
function scrubCatalog(s: string): string {
  // (1) Heredoc / inline private keys — replace the entire PEM block (BEGIN
  //     through END, inclusive) with the sentinel.
  s = s.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*-----/g,
    SENTINEL,
  );

  // (2) Env-var assignments — keep KEY= when KEY is UPPERCASE_WITH_UNDERSCORES;
  //     redact the value. Optional export/set/env prefix is preserved.
  s = s.replace(
    /(^|\s)((?:export|set|env)\s+)?([A-Z][A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/g,
    (_m, pre: string, prefix: string | undefined, key: string) =>
      `${pre}${prefix ?? ''}${key}=${SENTINEL}`,
  );

  // (3) Authorization headers and bare Bearer tokens. Case-insensitive: HTTP
  //     headers are case-insensitive (RFC 7230), so `authorization: bearer`
  //     must scrub the same as the canonical form.
  s = s.replace(/Authorization:\s*[^\n'"]*/gi, `Authorization: ${SENTINEL}`);
  s = s.replace(/Bearer\s+[A-Za-z0-9._+/=-]+/gi, `Bearer ${SENTINEL}`);

  // (4) URL-embedded credentials — ://user:pass@, ://token@, or ://:pass@
  //     (empty username, e.g. redis://:s3cr3t@host) → ://***REDACTED***@.
  //     Host/scheme kept; rejects a bare ://@ with no credential component.
  s = s.replace(/(:\/\/)(?:[^\s/@:]+(?::[^\s/@]+)?|:[^\s/@]+)@/g, `$1${SENTINEL}@`);

  // (5) Flag secrets — -p <val>, -u <user:pass>, --password/--secret/--token/
  //     --api-key/--access-key (case-insensitive). Value redacted, flag kept.
  s = s.replace(
    /(^|\s)(--password|--secret|--token|--api-key|--access-key|-p|-u)\s+(\S+)/gi,
    (_m, pre: string, flag: string) => `${pre}${flag} ${SENTINEL}`,
  );
  s = s.replace(
    /(^|\s)(--password|--secret|--token|--api-key|--access-key)=("[^"]*"|'[^']*'|\S+)/gi,
    (_m, pre: string, flag: string) => `${pre}${flag}=${SENTINEL}`,
  );

  // (6) Credential-file path globs — check each whitespace/quote-delimited
  //     token; if it is a credential-file path, replace with sentinel.
  s = s.replace(/[^\s'"]+/g, (token: string) =>
    isCredentialFile(token) ? SENTINEL : token,
  );

  // (7) Known-format tokens — AWS access-key IDs, GitHub tokens, Slack tokens,
  //     JWTs.
  s = s.replace(/AKIA[0-9A-Z]{16}/g, SENTINEL);
  s = s.replace(/gh[oprs]_[A-Za-z0-9]{36}/g, SENTINEL);
  s = s.replace(/xox[baprs]-[A-Za-z0-9-]+/g, SENTINEL);
  s = s.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, SENTINEL);

  return s;
}

/**
 * Test whether a path matches a credential-file glob from the catalog.
 * Globs (basename unless a directory suffix is noted): .env, *.pem, *.key,
 * .aws/credentials (path suffix), .npmrc, id_rsa*, .pgpass, .htpasswd,
 * service-account*.json, credentials.json.
 */
function isCredentialFile(p: string): boolean {
  const base = p.split('/').pop() ?? p;
  if (base === '.env') return true;
  if (base.endsWith('.pem')) return true;
  if (base.endsWith('.key')) return true;
  if (p.endsWith('.aws/credentials')) return true;
  if (base === '.npmrc') return true;
  if (base.startsWith('id_rsa')) return true;
  if (base === '.pgpass') return true;
  if (base === '.htpasswd') return true;
  if (/^service-account.*\.json$/.test(base)) return true;
  if (base === 'credentials.json') return true;
  return false;
}

/**
 * Scrub an exec command string: apply the full catalog, then truncate to 512
 * chars (no marker). Replacements use the fixed sentinel `***REDACTED***`.
 */
export function scrubCmd(cmd: string): string {
  return scrubCatalog(cmd).slice(0, MAX_CMD_QUERY);
}

/**
 * Scrub a search/query string: same catalog and length cap as `scrubCmd`.
 */
export function scrubQuery(q: string): string {
  return scrubCatalog(q).slice(0, MAX_CMD_QUERY);
}

/**
 * Scrub multi-line repo file content (Synthesizer, Task 9). Applies the SAME
 * 7-rule catalog as `scrubCmd`/`scrubQuery` but WITHOUT the 512-char truncation
 * — the caller owns the size cap (e.g. `synthesizer.max_file_head_bytes`), so a
 * 4 KiB source head keeps its full redacted length rather than being cut to 512.
 * Used by `src/synthesizer/bundle.ts` to scrub source-file heads fed to the
 * backend; the existing `scrubCmd`/`scrubQuery` paths are unchanged.
 */
export function scrubContent(s: string): string {
  return scrubCatalog(s);
}

/**
 * Scrub a list of file paths: replace any path matching a credential-file glob
 * with the sentinel, leave others unchanged, then drop entries beyond 50 (no
 * marker). Only the credential-file rule applies here — not the full catalog.
 */
export function scrubFiles(files: string[]): string[] {
  return files
    .map((f) => (isCredentialFile(f) ? SENTINEL : f))
    .slice(0, MAX_FILES);
}
