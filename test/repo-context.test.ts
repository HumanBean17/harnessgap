import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { gatherRepoContext } from '../src/diagnoser/repo-context.js';

// gatherRepoContext probes the repo for an existing doc for one unit. It must:
//   - match a doc whose path contains the unit's leaf token (as a path segment
//     OR as a substring of the filename stem);
//   - never follow symlinks (mirror src/walk.ts: Dirent.isDirectory() is false
//     for symlinked dirs, so they are skipped; each file candidate is lstat'd,
//     so a symlink doc file is rejected);
//   - path-confine to repoRoot (reject `..`-style docsDirs that escape);
//   - fail-open (never throw; a missing/unreadable/escaping dir still appears
//     in `checked`).
// Tests build a real tmpdir tree with real symlinks (no mocking), mirroring
// the style of test/walk.test.ts.

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harnessgap-repoctx-'));
}

function mkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

describe('gatherRepoContext', () => {
  it('1. doc present (stem substring) → docExists true, matchedPath endswith billing.md', () => {
    const tmp = tmpRepo();
    mkdir(path.join(tmp, 'docs', 'architecture'));
    fs.writeFileSync(
      path.join(tmp, 'docs', 'architecture', 'billing.md'),
      '# billing\n',
    );

    const r = gatherRepoContext('src/billing', tmp, ['docs']);
    expect(r.docExists).toBe(true);
    expect(r.matchedPath).toBeTruthy();
    expect(r.matchedPath!.endsWith('billing.md')).toBe(true);
    // matchedPath is repo-relative (POSIX separators on this platform).
    expect(r.matchedPath).toBe('docs/architecture/billing.md');
    expect(r.checked).toEqual(['docs']);
  });

  it('2. no matching doc → docExists false, matchedPath null, checked includes docs', () => {
    const tmp = tmpRepo();
    mkdir(path.join(tmp, 'docs'));
    fs.writeFileSync(path.join(tmp, 'docs', 'README.md'), '# readme\n');

    const r = gatherRepoContext('src/billing', tmp, ['docs']);
    expect(r.docExists).toBe(false);
    expect(r.matchedPath).toBe(null);
    expect(r.checked).toEqual(['docs']);
  });

  it('3. missing docs dir → no throw, docExists false, checked includes docs', () => {
    const tmp = tmpRepo(); // no docs/ subdir created
    const r = gatherRepoContext('src/billing', tmp, ['docs']);
    expect(r.docExists).toBe(false);
    expect(r.matchedPath).toBe(null);
    expect(r.checked).toEqual(['docs']);
  });

  it('4. a symlinked doc file is NOT followed (no match)', () => {
    const tmp = tmpRepo();
    mkdir(path.join(tmp, 'docs'));
    // Real file OUTSIDE the repo; symlink points to it. Must never be read or
    // counted as a match, regardless of its target.
    const outside = path.join(
      os.tmpdir(),
      `harnessgap-repoctx-outside-${process.pid}-${Date.now()}.md`,
    );
    fs.writeFileSync(outside, 'secret\n');
    try {
      fs.symlinkSync(outside, path.join(tmp, 'docs', 'billing.md'));

      const r = gatherRepoContext('src/billing', tmp, ['docs']);
      expect(r.docExists).toBe(false);
      expect(r.matchedPath).toBe(null);
      expect(r.checked).toEqual(['docs']);
    } finally {
      try {
        fs.unlinkSync(outside);
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it('5. path-confinement: ../escape docsDir is rejected (no throw, no match)', () => {
    const tmp = tmpRepo();
    const r = gatherRepoContext('src/billing', tmp, ['../escape']);
    expect(r.docExists).toBe(false);
    expect(r.matchedPath).toBe(null);
    // The attempted docsDir still appears in checked.
    expect(r.checked).toEqual(['../escape']);
  });

  it('6. leaf-token substring: docs/notes/billing-overview.md matches src/billing', () => {
    const tmp = tmpRepo();
    mkdir(path.join(tmp, 'docs', 'notes'));
    fs.writeFileSync(
      path.join(tmp, 'docs', 'notes', 'billing-overview.md'),
      '# overview\n',
    );

    const r = gatherRepoContext('src/billing', tmp, ['docs']);
    expect(r.docExists).toBe(true);
    expect(r.matchedPath).toBe('docs/notes/billing-overview.md');
  });

  // Extra coverage for the "never follow symlinks" security property: a
  // symlinked directory under docs/ is not traversed (Dirent.isDirectory() is
  // false for symlinks), so a matching file inside its target never leaks in.
  // Mirrors walk.test.ts test 3.
  it('7. a symlinked directory is not traversed (target file does not leak)', () => {
    const tmp = tmpRepo();
    // Real dir OUTSIDE docs/ holding what would be a matching file.
    const realOutside = path.join(
      os.tmpdir(),
      `harnessgap-repoctx-realdir-${process.pid}-${Date.now()}`,
    );
    mkdir(path.join(realOutside, 'sub'));
    fs.writeFileSync(path.join(realOutside, 'sub', 'billing.md'), 'secret\n');
    try {
      mkdir(path.join(tmp, 'docs'));
      // Symlink a dir name under docs/ → realOutside. If gatherRepoContext
      // incorrectly followed it, docs/billing/sub/billing.md would match.
      fs.symlinkSync(realOutside, path.join(tmp, 'docs', 'billing'));

      const r = gatherRepoContext('src/billing', tmp, ['docs']);
      expect(r.docExists).toBe(false);
      expect(r.matchedPath).toBe(null);
    } finally {
      try {
        fs.rmSync(realOutside, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it('8. segment match: docs/billing/guide.md matches leaf billing via path segment', () => {
    const tmp = tmpRepo();
    mkdir(path.join(tmp, 'docs', 'billing'));
    fs.writeFileSync(path.join(tmp, 'docs', 'billing', 'guide.md'), '# guide\n');

    const r = gatherRepoContext('src/billing', tmp, ['docs']);
    expect(r.docExists).toBe(true);
    expect(r.matchedPath).toBe('docs/billing/guide.md');
  });

  it('9. multiple docsDirs: all appear in checked (input order); first dir hit wins', () => {
    const tmp = tmpRepo();
    mkdir(path.join(tmp, 'docs', 'architecture'));
    fs.writeFileSync(
      path.join(tmp, 'docs', 'architecture', 'billing.md'),
      '# billing\n',
    );
    mkdir(path.join(tmp, 'wiki'));

    const r = gatherRepoContext('src/billing', tmp, ['docs', 'wiki']);
    expect(r.docExists).toBe(true);
    expect(r.matchedPath).toBe('docs/architecture/billing.md');
    expect(r.checked).toEqual(['docs', 'wiki']);
  });
});
