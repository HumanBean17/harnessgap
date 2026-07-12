import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { discoverTranscripts, defaultClaudeDir } from '../src/walk.js';

// discoverTranscripts must list every *.jsonl under
// <claudeDir>/projects/*/*.jsonl (exactly one session-dir level under
// projects/), reject symlinked transcripts (lstat, never follow), skip
// symlinked session-dirs entirely, and fail open when projects/ is missing.
// These tests build a real tmpdir tree with real symlinks (no mocking).

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harnessgap-walk-'));
}

function mkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

describe('discoverTranscripts', () => {
  it('1. returns real .jsonl files, rejects a symlinked .jsonl, symlinks_rejected===1', () => {
    const dir = tmpDir();
    const slug = path.join(dir, 'projects', 'slug1');
    mkdir(slug);
    fs.writeFileSync(path.join(slug, 'a.jsonl'), '{}\n');
    fs.writeFileSync(path.join(slug, 'b.jsonl'), '{}\n');
    // Symlink target OUTSIDE projects/ — must never be read or followed.
    const outside = path.join(dir, 'outside-target.txt');
    fs.writeFileSync(outside, 'secret\n');
    fs.symlinkSync(outside, path.join(slug, 'c.jsonl'));

    const { files, symlinks_rejected } = discoverTranscripts(dir);

    expect([...files].sort()).toEqual([
      path.join(dir, 'projects', 'slug1', 'a.jsonl'),
      path.join(dir, 'projects', 'slug1', 'b.jsonl'),
    ]);
    expect(symlinks_rejected).toBe(1);
    // The symlink path itself must not appear in the results.
    expect(files.some((f) => f.endsWith('c.jsonl'))).toBe(false);
  });

  it('2. non-.jsonl files are ignored (not returned, not counted)', () => {
    const dir = tmpDir();
    const slug = path.join(dir, 'projects', 'slug2');
    mkdir(slug);
    fs.writeFileSync(path.join(slug, 'a.jsonl'), '{}\n');
    fs.writeFileSync(path.join(slug, 'notes.txt'), 'hi\n');
    fs.writeFileSync(path.join(slug, 'log.json'), '{}\n');
    fs.writeFileSync(path.join(slug, 'b.jsonl.bak'), 'x\n');

    const { files, symlinks_rejected } = discoverTranscripts(dir);

    expect(files).toEqual([path.join(dir, 'projects', 'slug2', 'a.jsonl')]);
    expect(symlinks_rejected).toBe(0);
  });

  it('3. a symlinked session-dir is not traversed', () => {
    const dir = tmpDir();
    // A real directory OUTSIDE projects/ holding a .jsonl. If discoverTranscripts
    // (incorrectly) followed the symlinked session-dir, this file would leak in.
    const realOutside = path.join(dir, 'real-outside');
    mkdir(realOutside);
    fs.writeFileSync(path.join(realOutside, 'sneak.jsonl'), '{}\n');
    // Symlink a session-dir name under projects/ → realOutside.
    mkdir(path.join(dir, 'projects'));
    fs.symlinkSync(realOutside, path.join(dir, 'projects', 'linkslug'));

    const { files, symlinks_rejected } = discoverTranscripts(dir);

    expect(files).toEqual([]);
    // symlinks_rejected counts .jsonl symlink candidates (lstat'd at file
    // level); a symlinked dir is rejected at the directory level and never
    // reaches lstat, so it does not increment the counter.
    expect(symlinks_rejected).toBe(0);
  });

  it('4. defaultClaudeDir() returns <homedir>/.claude', () => {
    expect(defaultClaudeDir()).toBe(path.join(os.homedir(), '.claude'));
  });

  it('5. missing projects/ dir → fail open with empty result (no throw)', () => {
    const dir = tmpDir(); // no projects/ subdir created
    const { files, symlinks_rejected } = discoverTranscripts(dir);
    expect(files).toEqual([]);
    expect(symlinks_rejected).toBe(0);
  });
});
