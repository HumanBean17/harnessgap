import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScan } from '../src/pipeline.js';
import { runDetector } from '../src/detector/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  setupTempRepo,
  writeTranscript,
  mkSession,
  cleanupTempDirs,
} from './helpers/builder.js';
import { corpusSlug, corpusSessions } from './fixtures/corpus/sessions.js';
import type {
  Diagnosis,
  JsonOutput,
  NormalizedEnvelope,
  NormalizedEvent,
} from '../src/types.js';

// Pipeline orchestration tests: build a real temp claudeDir + temp git repo,
// write real .jsonl transcripts, and exercise runScan end-to-end. No mocking —
// real filesystem, real git, real streaming, real detection.

const TS1 = '2026-07-12T12:00:00.000Z';
const TS2 = '2026-07-12T12:00:01.000Z';
const TS3 = '2026-07-12T12:00:02.000Z';
const TS4 = '2026-07-12T12:00:03.000Z';
const TS5 = '2026-07-12T12:00:04.000Z';

const tmpDirs: string[] = [];

/** Create a temp dir, tracked for cleanup. */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harnessgap-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
  // Also clear dirs tracked by the shared builder helper (used by the corpus
  // fixture in the diagnose tests below).
  cleanupTempDirs();
});

// --- Transcript record builders (valid Claude Code JSONL shapes) ---

function userText(ts: string, cwd: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    cwd,
    message: { role: 'user', content: text },
  });
}

function assistantToolUse(
  ts: string,
  cwd: string,
  name: string,
  input: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    cwd,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name, input }],
    },
  });
}

function userToolResult(ts: string, cwd: string, isError = false): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    cwd,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', is_error: isError }],
    },
  });
}

/**
 * Build a 5-line transcript: user text → Read → result → Edit → result.
 * Produces a read + edit under `src/billing/<file>`, giving the detector
 * an area (src/billing) and non-trivial signals.
 */
function billingTranscript(cwd: string, filePath: string): string {
  return [
    userText(TS1, cwd, 'read and edit the file'),
    assistantToolUse(TS2, cwd, 'Read', { file_path: filePath }),
    userToolResult(TS3, cwd, false),
    assistantToolUse(TS4, cwd, 'Edit', {
      file_path: filePath,
      old_string: 'x',
      new_string: 'y\nz',
    }),
    userToolResult(TS5, cwd, false),
  ].join('\n') + '\n';
}

/** Fixture: temp git repo + claudeDir with 2 well-formed transcripts. */
function setupFixture(): { repo: string; claudeDir: string } {
  const repoDir = makeTempDir('pipe-repo');
  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
  const repo = realpathSync(repoDir);

  const claudeDir = makeTempDir('pipe-claude');
  const slug = join(claudeDir, 'projects', 'test-slug');
  mkdirSync(slug, { recursive: true });
  writeFileSync(join(slug, 'sess1.jsonl'), billingTranscript(repoDir, 'src/billing/a.ts'), 'utf8');
  writeFileSync(join(slug, 'sess2.jsonl'), billingTranscript(repoDir, 'src/billing/b.ts'), 'utf8');

  return { repo, claudeDir };
}

/** Fixture: 1 valid + 1 unresolvable-cwd transcript. */
function setupUnresolvableFixture(): { repo: string; claudeDir: string } {
  const repoDir = makeTempDir('pipe-repo-bad');
  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
  const repo = realpathSync(repoDir);

  const claudeDir = makeTempDir('pipe-claude-bad');
  const slug = join(claudeDir, 'projects', 'mixed-slug');
  mkdirSync(slug, { recursive: true });
  // Valid session.
  writeFileSync(join(slug, 'good.jsonl'), billingTranscript(repoDir, 'src/billing/a.ts'), 'utf8');
  // Invalid session: cwd points at a non-existent directory.
  const badCwd = '/nonexistent/harnessgap/test-' + Date.now();
  writeFileSync(join(slug, 'bad.jsonl'), billingTranscript(badCwd, 'src/billing/b.ts'), 'utf8');

  return { repo, claudeDir };
}

describe('runScan (pipeline orchestration)', () => {
  it('1. basic scan → 2 sessions, exitCode 0, human output with areas', async () => {
    const { repo, claudeDir } = setupFixture();
    const result = await runScan({ repo, claudeDir });

    expect(result.exitCode).toBe(0);
    expect(result.sessionCount).toBe(2);
    expect(result.mode).toBe('bootstrap');
    expect(result.warnings.unresolvable_cwd).toBe(0);
    expect(result.warnings.skipped_sessions).toBe(0);
    expect(result.warnings.symlinks_rejected).toBe(0);
    expect(result.output).toContain('harnessgap scan');
    // Output includes the area or a "no flagged" line.
    expect(result.output).toMatch(/src\/billing|No flagged areas/);
  });

  it('2. --json → output parses as JsonOutput, mode reflects session count (2 → bootstrap)', async () => {
    const { repo, claudeDir } = setupFixture();
    const result = await runScan({ repo, claudeDir, json: true });

    expect(result.sessionCount).toBe(2);
    const parsed = JSON.parse(result.output) as JsonOutput;
    expect(parsed.schema_version).toBe(1);
    expect(parsed.repo).toBe(repo);
    expect(parsed.mode).toBe('bootstrap');
    expect(parsed.session_count).toBe(2);
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions.length).toBe(2);
    expect(Array.isArray(parsed.areas)).toBe(true);
    // Warnings are projected into the JSON envelope.
    expect(parsed.warnings).toEqual(result.warnings);
    // Within-norms fixture (2 sessions < min_sessions): no elevated baseline,
    // no finding → repo_findings is projected as the empty array.
    expect(parsed.repo_findings).toEqual([]);
  });

  it('3. --bootstrap → mode==="bootstrap" (flag threaded, sessions scanned)', async () => {
    const { repo, claudeDir } = setupFixture();
    const result = await runScan({ repo, claudeDir, bootstrap: true });

    expect(result.mode).toBe('bootstrap');
    expect(result.sessionCount).toBe(2);
  });

  it('4. --limit 1 → sessionCount===1 (cap applied after filtering)', async () => {
    const { repo, claudeDir } = setupFixture();
    const result = await runScan({ repo, claudeDir, limit: 1 });

    expect(result.sessionCount).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it('5. unresolvable cwd → warnings.unresolvable_cwd===1, NOT double-counted in skipped_sessions', async () => {
    const { repo, claudeDir } = setupUnresolvableFixture();
    const result = await runScan({ repo, claudeDir });

    expect(result.warnings.unresolvable_cwd).toBe(1);
    // The specific reason is counted once; skipped_sessions is reserved for
    // other skip reasons and stays 0 (no double-count in the warnings line).
    expect(result.warnings.skipped_sessions).toBe(0);
    expect(result.sessionCount).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it('6. empty claudeDir → sessionCount===0, exitCode===0, output says no sessions', async () => {
    const claudeDir = makeTempDir('pipe-empty');
    const result = await runScan({ claudeDir });

    expect(result.sessionCount).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.mode).toBe('bootstrap');
    expect(result.output).toContain('0 sessions');
  });

  it('7. --calibrate → calibrate table (and JSON object with --json)', async () => {
    const { repo, claudeDir } = setupFixture();

    // Human table.
    const tableResult = await runScan({ repo, claudeDir, calibrate: true });
    expect(tableResult.output).toContain('harnessgap calibrate');
    expect(tableResult.output).toContain('SIGNAL');
    expect(tableResult.output).toContain('reread');
    expect(tableResult.sessionCount).toBe(2);

    // JSON object (NOT the scan envelope).
    const jsonResult = await runScan({ repo, claudeDir, calibrate: true, json: true });
    const parsed = JSON.parse(jsonResult.output) as {
      mode: string;
      session_count: number;
      flag_pct: number;
      signals: Record<string, unknown>;
    };
    expect(parsed.mode).toBe('bootstrap');
    expect(parsed.session_count).toBe(2);
    expect(parsed.flag_pct).toBe(90);
    expect(parsed.signals).toBeDefined();
    expect(parsed.signals.reread).toBeDefined();
    // Must NOT be the scan envelope shape.
    expect(parsed).not.toHaveProperty('schema_version');
    expect(parsed).not.toHaveProperty('sessions');
    expect(parsed).not.toHaveProperty('areas');
  });

  // --- Task 9: --diagnose wiring (byte-identical default) ---
  //
  // The load-bearing invariant: turning --diagnose OFF must produce output that
  // is byte-identical to Slice 3 (no `diagnoses` field on the result, no
  // `.evidence` on records, no change to the human/json/calibrate branches).
  // Turning --diagnose ON populates `result.diagnoses` (an array, possibly empty)
  // and threads `.evidence` through records. The default path is what the
  // snapshot test guards — these tests assert the wiring at the pipeline layer.

  it('8. diagnose:true → result.diagnoses is an array of Diagnosis shape (corpus has flagged areas)', async () => {
    const { repo, claudeDir } = setupTempRepo();
    for (const spec of corpusSessions) {
      writeTranscript(claudeDir, corpusSlug, spec.name, mkSession(repo, spec));
    }

    const result = await runScan({ repo, claudeDir, diagnose: true });

    // diagnoses is always an array when diagnose is on (even if no units were
    // flagged — empty `[]` is the contract for "nothing to explain").
    expect(Array.isArray(result.diagnoses)).toBe(true);

    // The corpus has flagged areas (snapshot shows 7 flagged), so we expect a
    // non-empty diagnosis set. Each item must match the Diagnosis shape.
    expect(result.diagnoses.length).toBeGreaterThan(0);
    for (const d of result.diagnoses as Diagnosis[]) {
      expect(d.unit).toEqual({ kind: 'area', key: expect.any(String) });
      expect(typeof d.cause).toBe('string');
      expect(typeof d.confidence).toBe('number');
      expect(d.confidence).toBeGreaterThanOrEqual(0);
      expect(d.confidence).toBeLessThanOrEqual(1);
      expect(typeof d.rationale).toBe('string');
      expect(Array.isArray(d.evidence_refs)).toBe(true);
    }
    // Diagnoses are sorted by unit.key ascending (diagnoseUnits contract).
    const keys = (result.diagnoses as Diagnosis[]).map((d) => d.unit.key);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it('9. no diagnose → result.diagnoses===undefined AND output byte-identical to diagnose:false', async () => {
    const { repo, claudeDir } = setupFixture();

    const withoutOpt = await runScan({ repo, claudeDir });
    const withFalse = await runScan({ repo, claudeDir, diagnose: false });

    // `diagnoses` is unset on the result when diagnose is not true — both the
    // value is undefined AND the key is absent from the result object (matches
    // the Slice-3 ScanResult shape exactly).
    expect(withoutOpt.diagnoses).toBeUndefined();
    expect(withFalse.diagnoses).toBeUndefined();
    expect(withoutOpt).not.toHaveProperty('diagnoses');
    expect(withFalse).not.toHaveProperty('diagnoses');

    // Byte-identical output between "no opt" and "diagnose:false" — the default
    // path is unchanged by the wiring. (Cross-check against the snapshot test,
    // which pins the actual Slice-3 string.)
    expect(withoutOpt.output).toBe(withFalse.output);
    expect(withoutOpt.mode).toBe(withFalse.mode);
    expect(withoutOpt.sessionCount).toBe(withFalse.sessionCount);
    expect(withoutOpt.warnings).toEqual(withFalse.warnings);

    // Also assert the corpus default-path output is unchanged by the wiring:
    // turning --diagnose on must not change the human output (diagnoses only
    // surface on `result.diagnoses`, NOT in the human/json/calibrate string).
    const corpusRepo = setupTempRepo();
    for (const spec of corpusSessions) {
      writeTranscript(corpusRepo.claudeDir, corpusSlug, spec.name, mkSession(corpusRepo.repo, spec));
    }
    const corpusOff = await runScan({ repo: corpusRepo.repo, claudeDir: corpusRepo.claudeDir });
    const corpusOn = await runScan({
      repo: corpusRepo.repo,
      claudeDir: corpusRepo.claudeDir,
      diagnose: true,
    });
    expect(corpusOn.output).toBe(corpusOff.output);
  });

  it('10. records carry .evidence ONLY when diagnose is true (verified via --json sessions)', async () => {
    const { repo, claudeDir } = setupTempRepo();
    for (const spec of corpusSessions) {
      writeTranscript(claudeDir, corpusSlug, spec.name, mkSession(repo, spec));
    }

    // diagnose ON → every session record carries `.evidence`.
    const onResult = await runScan({ repo, claudeDir, diagnose: true, json: true });
    const onJson = JSON.parse(onResult.output) as JsonOutput;
    expect(onJson.sessions.length).toBeGreaterThan(0);
    for (const s of onJson.sessions) {
      expect(s.evidence).toBeDefined();
      expect(typeof s.evidence).toBe('object');
      expect(s.evidence!.failures).toEqual({
        config: expect.any(Number),
        test: expect.any(Number),
        build: expect.any(Number),
        other: expect.any(Number),
      });
      expect(s.evidence!.edit_kinds).toEqual({
        test: expect.any(Number),
        code: expect.any(Number),
        other: expect.any(Number),
      });
    }

    // diagnose OFF (no opt) → no session record carries `.evidence`.
    const offResult = await runScan({ repo, claudeDir, json: true });
    const offJson = JSON.parse(offResult.output) as JsonOutput;
    expect(offJson.sessions.length).toBeGreaterThan(0);
    for (const s of offJson.sessions) {
      expect(s.evidence).toBeUndefined();
    }
  });
});

// Pure-detector smoke test for the ambient finding + baseline wiring
// (Slice 2, Task 5). Builds NormalizedEnvelope[] directly — no I/O — and
// exercises the runDetector → assessAmbient path end-to-end. The corpus is
// ten high-orientation sessions (each reads files across 5 distinct depth-2
// dirs, then edits), which trips the orientation path of assessAmbient and
// produces an elevated baseline.

describe('runDetector (ambient finding + baseline)', () => {
  it('emits a RepoFinding on the orientation path + elevated baseline for 10 high-orientation sessions', () => {
    // Each session: 5 dirs × 3 distinct files = 15 reads (dirBreadth=5,
    // fileDepth=15), then one edit. Both medians clear the §7 floors
    // (breadth_floor=4, file_depth_floor=12).
    const envelopes: NormalizedEnvelope[] = Array.from({ length: 10 }, (_, i) => {
      const events: NormalizedEvent[] = [];
      let ms = 0;
      for (let d = 0; d < 5; d++) {
        for (let f = 0; f < 3; f++) {
          events.push({
            t: new Date(ms).toISOString(),
            kind: 'tool_call',
            tool: 'read',
            input_digest: {
              files: [`src/dir${d}/file${f}.ts`],
              cmd: null,
              query: null,
              lines_changed: null,
            },
            ok: true,
            interrupted: false,
            duration_ms: 0,
            correction: null,
          });
          ms += 1000;
        }
      }
      // First edit comes after orientation → computePreEditOrientation is non-null.
      events.push({
        t: new Date(ms).toISOString(),
        kind: 'tool_call',
        tool: 'edit',
        input_digest: {
          files: ['src/dir0/file0.ts'],
          cmd: null,
          query: null,
          lines_changed: 5,
        },
        ok: true,
        interrupted: false,
        duration_ms: 0,
        correction: null,
      });

      return {
        schema_version: 1 as const,
        session_id: `s${i}`,
        agent: 'claude-code' as const,
        repo: 'test/repo',
        started_at: events[0]!.t,
        duration_ms: ms,
        events,
        truncated: false,
        event_count: events.length,
      };
    });

    const result = runDetector(envelopes, structuredClone(DEFAULT_CONFIG), false);

    // Records: one per envelope, byte-identical to Slice 1 behaviour.
    expect(result.records.length).toBe(10);

    // Finding: orientation path fires (median_dir_breadth=5 >= 4), so the
    // finding is populated and carries 'orientation' in its paths.
    expect(result.finding).not.toBeNull();
    expect(result.finding!.paths).toContain('orientation');

    // Baseline: 10 sessions ≥ min_sessions=10, orientation path fired → elevated.
    expect(result.baseline.state).toBe('elevated');
  });
});
