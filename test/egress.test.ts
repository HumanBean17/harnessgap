// §11 egress audit: assert no src/**/*.ts file imports a network module.
// This is the automated egress guard — the CLI must be stateless and offline.
// Forbidden specifiers: http, https, net, node:net (and node: variants of
// http/https), undici, fetch. Allowed: node:fs, node:path, node:process,
// node:child_process, node:os, node:url, commander, yaml, and relative ./ paths.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Matches static imports (`import ... from 'mod'`), dynamic imports
// (`import('mod')`), and require (`require('mod')`) whose specifier is a
// network module (with or without the `node:` prefix). Non-greedy so it stays
// on one line.
const FORBIDDEN_IMPORT =
  /(?:import\s+.*?\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?(?:http|https|net|undici|fetch)['"]/;

describe('egress guard (§11 no-network audit)', () => {
  it('no src/**/*.ts file imports a network module (http/https/net/undici/fetch)', () => {
    const files = listTsFiles(SRC_DIR);
    // Sanity: the src tree is non-empty (otherwise the guard is vacuous).
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (FORBIDDEN_IMPORT.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
