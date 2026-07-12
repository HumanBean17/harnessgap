// §11 egress audit: assert no src/**/*.ts file imports a network module.
// This is the automated egress guard — the CLI must be stateless and offline.
// Forbidden specifiers: http, https, net, node:net (and node: variants of
// http/https), undici, fetch. Allowed: node:fs, node:path, node:process,
// node:child_process, node:os, node:url, commander, yaml, and relative ./ paths.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasForbiddenImport } from '../src/egress.js';

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

describe('egress guard (§11 no-network audit)', () => {
  it('no src/**/*.ts file imports a network module (http/https/net/undici/fetch)', () => {
    const files = listTsFiles(SRC_DIR);
    // Sanity: the src tree is non-empty (otherwise the guard is vacuous).
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (hasForbiddenImport(src)) offenders.push(f);
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
