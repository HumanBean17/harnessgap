// §11 egress audit. Two gates, both automated:
//
// 1. No-network (default path). Asserts no src/**/*.ts file imports a network
//    module (http, https, net, node:net + node: variants, undici, fetch) or
//    invokes the global fetch — the CLI's default path is stateless and
//    offline. fetch is a Node global, so an import is not required to egress.
//    Allowed elsewhere: node:fs, node:path, node:process, node:os, node:url,
//    commander, yaml, and relative ./ paths.
//
// 2. child_process confinement. Asserts any `node:child_process` /
//    `child_process` import or `require('child_process')` in src/ occurs ONLY
//    in src/synthesizer/** or src/git.ts — nowhere else. The closed-loop MVP's
//    only subprocess egress is the opt-in `synthesize` path (synthesizer +
//    trusted agent CLI) and `isValidSha` in git.ts.
//
// The DEFAULT PATH is subprocess-free except for the two allowlisted modules;
// opt-in `synthesize` egress is bounded by child_process + the trusted agent
// CLI, NOT by network imports (there are none anywhere in src/).

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hasForbiddenImport,
  hasFetchCall,
  hasForbiddenEgress,
  hasChildProcessImport,
  isChildProcessAllowed,
} from '../src/egress.js';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/** Recursively list every .ts file under `dir`. */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('egress guard (§11 src/ audit)', () => {
  it('no src/**/*.ts file imports a network module or calls fetch()', () => {
    const files = listTsFiles(SRC_DIR);
    // Sanity: the src tree is non-empty (otherwise the guard is vacuous).
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (hasForbiddenEgress(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  // DEFAULT-PATH child_process confinement: the only src/ modules allowed to
  // touch child_process are src/synthesizer/** (opt-in synthesize egress) and
  // src/git.ts (Task 7 isValidSha). Every other src/ file must stay
  // subprocess-free — that is what keeps the default path offline-by-default.
  it('child_process is imported only in src/synthesizer/** or src/git.ts', () => {
    const files = listTsFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (hasChildProcessImport(src)) {
        const rel = relative(SRC_DIR, f);
        if (!isChildProcessAllowed(rel)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// Unit tests that lock the FORBIDDEN_IMPORT regex behavior against string
// fixtures (no src/ pollution). Guards against regressions in the multi-line
// and side-effect import shapes — the gaps a reviewer flagged.
describe('FORBIDDEN_IMPORT regex (string fixtures)', () => {
  it('matches single-line static imports', () => {
    expect(hasForbiddenImport(`import http from 'node:http'`)).toBe(true);
  });

  it('matches multi-line named imports', () => {
    const src = `import {\n  http,\n} from 'node:http'`;
    expect(hasForbiddenImport(src)).toBe(true);
  });

  it('matches side-effect imports (bare import, no from)', () => {
    expect(hasForbiddenImport(`import 'http'`)).toBe(true);
  });

  it('matches dynamic imports', () => {
    expect(hasForbiddenImport(`await import('net')`)).toBe(true);
  });

  it('matches require calls', () => {
    expect(hasForbiddenImport(`require('https')`)).toBe(true);
  });

  it('matches undici imports', () => {
    expect(hasForbiddenImport(`import { fetch } from 'undici'`)).toBe(true);
  });

  it('allows non-network imports', () => {
    expect(hasForbiddenImport(`import { readFileSync } from 'node:fs'`)).toBe(false);
    expect(hasForbiddenImport(`import { join } from 'node:path'`)).toBe(false);
    expect(hasForbiddenImport(`import commander from 'commander'`)).toBe(false);
  });

  it('does not flag a comment that merely mentions import + from', () => {
    // `// do not import from 'http'` has only one `from`, so neither the
    // static-import nor the side-effect alternative matches. A bare
    // `// import 'http'` WOULD match (errs toward fail) — acceptable per §11.
    expect(hasForbiddenImport(`// do not import from 'http'`)).toBe(false);
  });
});

// Unit tests for the global fetch() call detector — closes the blind spot that
// fetch is a Node global (no import needed to egress). Live in test/ (not
// scanned by the src/ audit), so the fetch( fixtures here are safe.
describe('FORBIDDEN_FETCH_CALL regex (string fixtures)', () => {
  it('matches a fetch call with a URL', () => {
    expect(hasFetchCall(`fetch('https://example.com')`)).toBe(true);
  });

  it('matches an awaited fetch call with options', () => {
    expect(hasFetchCall(`await fetch(url, { method: 'POST' })`)).toBe(true);
  });

  it('does not match WebFetch (capital F, no word boundary before fetch)', () => {
    expect(hasFetchCall(`WebFetch('https://x')`)).toBe(false);
  });

  it('does not match fetched() or myfetch()', () => {
    expect(hasFetchCall(`fetched()`)).toBe(false);
    expect(hasFetchCall(`myfetch(url)`)).toBe(false);
  });

  it('errs toward flagging: a comment containing a fetch call is flagged', () => {
    // Consistent with the import guard — fail-safe for a security control.
    expect(hasFetchCall(`// TODO: replace the fetch(url) call`)).toBe(true);
  });
});

// Unit tests for the child_process confinement detector. Locks the column-0
// anchor behavior: real ESM imports + top-level CommonJS requires are caught,
// but the indented `var cp = require('child_process')` text src/init/claude.ts
// emits inside its wrapper template literal is NOT (it is runtime wrapper
// source written to .claude/, not a src/ import). This is the load-bearing
// edge case — without the anchor, the audit would false-positive on init.
describe('CHILD_PROCESS_IMPORT regex (string fixtures)', () => {
  it('matches single-line ESM static imports', () => {
    expect(hasChildProcessImport(`import { spawn } from 'node:child_process'`)).toBe(true);
    expect(hasChildProcessImport(`import { execFileSync } from 'child_process'`)).toBe(true);
  });

  it('matches ESM type-only imports', () => {
    expect(hasChildProcessImport(`import type { SpawnOptions } from 'node:child_process'`)).toBe(true);
  });

  it('matches multi-line named imports', () => {
    const src = `import {\n  spawn,\n  type SpawnOptions,\n} from 'node:child_process'`;
    expect(hasChildProcessImport(src)).toBe(true);
  });

  it('matches side-effect imports', () => {
    expect(hasChildProcessImport(`import 'node:child_process'`)).toBe(true);
  });

  it('matches dynamic imports at column 0', () => {
    expect(hasChildProcessImport(`import('node:child_process')`)).toBe(true);
  });

  it('matches CommonJS require at column 0', () => {
    expect(hasChildProcessImport(`const cp = require('child_process')`)).toBe(true);
    expect(hasChildProcessImport(`let cp = require('node:child_process')`)).toBe(true);
    expect(hasChildProcessImport(`var cp = require('child_process')`)).toBe(true);
    expect(hasChildProcessImport(`require('child_process')`)).toBe(true);
  });

  it('does NOT match an indented require inside an emitted wrapper template', () => {
    // src/init/claude.ts emits this block as a template literal; every line is
    // indented (≥2 spaces), so the column-0 anchor rejects it. This is what
    // keeps init's wrapper-emission from tripping the confinement gate.
    const wrapperSnippet = [
      '  if (doSpawn) {',
      "    var cp = require('child_process');",
      '    result = cp.spawnSync(process.execPath, [CLI, "reflect"]);',
      '  }',
    ].join('\n');
    expect(hasChildProcessImport(wrapperSnippet)).toBe(false);
  });

  it('does not match comments that merely mention child_process', () => {
    expect(hasChildProcessImport(`// child_process is imported only in backend.ts`)).toBe(false);
    expect(hasChildProcessImport(`// do not import from 'child_process' here`)).toBe(false);
    expect(hasChildProcessImport(`// require('child_process') is forbidden in src/`)).toBe(false);
  });

  it('does not match imports of unrelated modules', () => {
    expect(hasChildProcessImport(`import { readFileSync } from 'node:fs'`)).toBe(false);
    expect(hasChildProcessImport(`import { exec } from 'node:child_process/spawn'`)).toBe(false);
  });

  it('WOULD flag a stray import outside the allowlist (negative guard)', () => {
    // Proves the src/ scan is not vacuous: if someone added this line to
    // src/cli.ts, the confinement `it` above would list cli.ts as an offender.
    expect(hasChildProcessImport(`import { spawn } from 'node:child_process'`)).toBe(true);
    expect(isChildProcessAllowed('cli.ts')).toBe(false);
  });
});

describe('isChildProcessAllowed (allowlist predicate)', () => {
  it('allows src/synthesizer/** and src/git.ts', () => {
    expect(isChildProcessAllowed('synthesizer/backend.ts')).toBe(true);
    expect(isChildProcessAllowed('synthesizer/index.ts')).toBe(true);
    expect(isChildProcessAllowed('synthesizer/sub/dir/deep.ts')).toBe(true);
    expect(isChildProcessAllowed('git.ts')).toBe(true);
  });

  it('rejects every other src/ path named in the global constraint', () => {
    expect(isChildProcessAllowed('cli.ts')).toBe(false);
    expect(isChildProcessAllowed('pipeline.ts')).toBe(false);
    expect(isChildProcessAllowed('detector/oscillation.ts')).toBe(false);
    expect(isChildProcessAllowed('adapter/claude.ts')).toBe(false);
    expect(isChildProcessAllowed('review.ts')).toBe(false);
    expect(isChildProcessAllowed('explain.ts')).toBe(false);
    expect(isChildProcessAllowed('init/claude.ts')).toBe(false);
    // Edge: a sibling whose name merely starts with the allowlisted stems.
    expect(isChildProcessAllowed('synthesizer.test.ts')).toBe(false);
    expect(isChildProcessAllowed('git.ts.bak')).toBe(false);
  });
});
