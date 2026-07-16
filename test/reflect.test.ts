// Task 2: runReflect (--transcript mode) — the n=1 single-session analog of
// runScan. These tests drive the REAL pipeline (real streaming, real git
// stat-walk, real detection) over minimal .jsonl fixtures built with mkSession.
//
// Fixture shapes follow the record contract confirmed in test/parse.test.ts:
// real Claude Code jsonl (type/timestamp/cwd + message.content tool_use &
// tool_result pairs). mkSession (test/helpers/builder.ts) emits those pairs.
//
// Signal trips referenced below (DEFAULT_CONFIG bootstrap thresholds):
//   failure_streak >= 3, wall_clock_per_line_ms >= 300000, reread >= 5.
// `flagged` in bootstrap mode = composite >= 70 OR >= 2 signals trip.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runReflect } from '../src/pipeline.js';
import {
  mkSession,
  setupTempRepo,
  makeTempDir,
  cleanupTempDirs,
  writeTranscript,
} from './helpers/builder.js';
import type { EventSpec } from './helpers/builder.js';
import type { ReflectFinding, StopHookOutput } from '../src/types.js';

// --- module-level mock toggle for the detector-error fail-open test (below) ---
// vi.mock is hoisted above every import, so this factory runs before
// pipeline.ts loads and all consumers (runReflect included) get the wrapper.
// It delegates to the real detector unless the toggle is on, in which case
// runDetector throws — exercising the guarded detect step. Default off, so the
// other (real-pipeline) tests are unaffected.
const detectorThrows = vi.hoisted(() => ({ now: false }));
vi.mock('../src/detector/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/detector/index.js')>();
  return {
    ...actual,
    runDetector: (...args: Parameters<typeof actual.runDetector>) => {
      if (detectorThrows.now) {
        throw new Error('forced detector failure (fail-open test)');
      }
      return actual.runDetector(...args);
    },
  };
});

afterEach(cleanupTempDirs);

/** Write a .jsonl string to a temp file and return its path. */
function writeTempTranscript(jsonl: string, stem = 'session'): string {
  const dir = makeTempDir('reflect');
  const file = join(dir, `${stem}.jsonl`);
  writeFileSync(file, jsonl, 'utf8');
  return file;
}

// A tripping transcript: 1 edit (1 line) + 3 consecutive failed execs. The 3
// back-to-back failed execs give failure_streak=3 (bootstrap trip); the large
// step inflates wall_clock_per_line_ms over its threshold, so two signals trip
// and `flagged` is true. The edit makes zero_edit=false → trip=true.
const TRIP_EVENTS: EventSpec[] = [
  { kind: 'edit', file: 'src/x/a.ts', newString: 'y' },
  { kind: 'exec', cmd: './run.sh', ok: false },
  { kind: 'exec', cmd: './run.sh', ok: false },
  { kind: 'exec', cmd: './run.sh', ok: false },
];

describe('runReflect — --transcript single-session detection', () => {
  it('tripping transcript (json): trip=true, zero_edit=false, mode=bootstrap, flagged=true', async () => {
    const { repo } = setupTempRepo();
    const file = writeTempTranscript(
      mkSession(repo, { name: 'trip', stepMs: 200_000, events: TRIP_EVENTS }),
    );

    const result = await runReflect({ transcript: file, format: 'json' });
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.output) as ReflectFinding;
    expect(parsed.trip).toBe(true);
    expect(parsed.zero_edit).toBe(false);
    expect(parsed.mode).toBe('bootstrap');
    expect(parsed.record.flagged).toBe(true);
    // The brief frames this fixture around a failed-exec streak ≥ 3.
    expect(parsed.record.signals.failure_streak).toBeGreaterThanOrEqual(3);
  });

  it('zero-edit transcript (only reads): zero_edit=true, trip=false', async () => {
    const { repo } = setupTempRepo();
    // 6 reads of one file, no edits → zero_edit=true. trip is therefore false
    // regardless of any flagging (trip = flagged && !zero_edit).
    const file = writeTempTranscript(
      mkSession(repo, {
        name: 'reads-only',
        events: Array.from({ length: 6 }, () => ({
          kind: 'read' as const,
          file: 'src/x/a.ts',
        })),
      }),
    );

    const result = await runReflect({ transcript: file, format: 'json' });
    const parsed = JSON.parse(result.output) as ReflectFinding;
    expect(parsed.zero_edit).toBe(true);
    expect(parsed.trip).toBe(false);
  });

  it('tripping transcript (hook-stop, stopHookActive=false): {decision:"block", reason}', async () => {
    const { repo } = setupTempRepo();
    const file = writeTempTranscript(
      mkSession(repo, { name: 'trip', stepMs: 200_000, events: TRIP_EVENTS }),
    );

    const result = await runReflect({
      transcript: file,
      format: 'hook-stop',
      stopHookActive: false,
    });

    const parsed = JSON.parse(result.output) as StopHookOutput;
    expect(Object.keys(parsed).sort()).toEqual(['decision', 'reason']);
    expect(parsed.decision).toBe('block');
    expect(typeof parsed.reason).toBe('string');
    expect(parsed.reason!.length).toBeGreaterThan(0);
  });

  it('tripping transcript (hook-stop, stopHookActive=true): {}', async () => {
    const { repo } = setupTempRepo();
    const file = writeTempTranscript(
      mkSession(repo, { name: 'trip', stepMs: 200_000, events: TRIP_EVENTS }),
    );

    const result = await runReflect({
      transcript: file,
      format: 'hook-stop',
      stopHookActive: true,
    });

    const parsed = JSON.parse(result.output) as StopHookOutput;
    expect(parsed).toEqual({});
    expect(Object.keys(parsed).length).toBe(0);
  });

  it('clean transcript: trip=false; hook-stop yields {}', async () => {
    const { repo } = setupTempRepo();
    const file = writeTempTranscript(
      mkSession(repo, {
        name: 'clean',
        events: [
          { kind: 'read', file: 'src/app/main.ts' },
          { kind: 'edit', file: 'src/app/main.ts', newString: 'a\nb\nc' },
        ],
      }),
    );

    const jsonResult = await runReflect({ transcript: file, format: 'json' });
    const jsonParsed = JSON.parse(jsonResult.output) as ReflectFinding;
    expect(jsonParsed.trip).toBe(false);

    const hookResult = await runReflect({
      transcript: file,
      format: 'hook-stop',
      stopHookActive: false,
    });
    expect(JSON.parse(hookResult.output)).toEqual({});
  });

  it('unresolvable cwd (no ancestor .git): hook-stop yields {} and never throws', async () => {
    // A temp dir with no .git anywhere up the tree — repo resolution fails.
    const noGitCwd = makeTempDir('no-git-cwd');
    const file = writeTempTranscript(
      mkSession(noGitCwd, {
        name: 'trip',
        stepMs: 200_000,
        events: TRIP_EVENTS,
      }),
    );

    const result = await runReflect({
      transcript: file,
      format: 'hook-stop',
      stopHookActive: false,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual({});
  });
});

describe('runReflect — argument handling', () => {
  it('throws a clear error when no transcript and no latest given', async () => {
    await expect(runReflect({ format: 'json' })).rejects.toThrow(/transcript/i);
  });

  it('latest resolves instead of throwing once Task 3 implements it', async () => {
    // --latest with no matching session must fail open (trip:false), not throw.
    // (Task 2 stubbed this as "not implemented"; Task 3 implements --latest.)
    const { repo, claudeDir } = setupTempRepo();
    const result = await runReflect({
      latest: true,
      repo,
      claudeDir,
      format: 'json',
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output) as ReflectFinding;
    expect(parsed.trip).toBe(false);
  });

  it('honors transcript even when latest is also set', async () => {
    const { repo } = setupTempRepo();
    const file = writeTempTranscript(
      mkSession(repo, { name: 'trip', stepMs: 200_000, events: TRIP_EVENTS }),
    );
    // latest is ignored in Task 2; transcript wins. Should not throw.
    const result = await runReflect({
      transcript: file,
      latest: true,
      format: 'json',
    });
    const parsed = JSON.parse(result.output) as ReflectFinding;
    expect(parsed.trip).toBe(true);
  });
});

describe('runReflect — --latest --repo most-recent-session resolution', () => {
  // Fixture: one claudeDir holding 3 transcripts for the target repo (distinct
  // started_at, via distinct startMs) + 1 transcript for a DIFFERENT repo that is
  // NEWER than all target sessions (proves the repo filter excludes it). Each
  // session has one read so started_at is set and the session is well-formed.
  // session_id is the filename stem (writeTranscript's `name`).
  function setupMultiSession(): {
    targetRepo: string;
    claudeDir: string;
    newest: string;
    secondNewest: string;
  } {
    const target = setupTempRepo();
    const other = setupTempRepo();
    const claudeDir = target.claudeDir;
    const oneRead: EventSpec[] = [{ kind: 'read', file: 'src/a.ts' }];
    writeTranscript(
      claudeDir,
      'proj',
      't1',
      mkSession(target.repo, { name: 't1', startMs: 1_000, events: oneRead }),
    );
    writeTranscript(
      claudeDir,
      'proj',
      't2',
      mkSession(target.repo, { name: 't2', startMs: 2_000, events: oneRead }),
    );
    writeTranscript(
      claudeDir,
      'proj',
      't3',
      mkSession(target.repo, { name: 't3', startMs: 3_000, events: oneRead }),
    );
    // Other repo, NEWER than every target session → must NOT be picked.
    writeTranscript(
      claudeDir,
      'proj',
      'o1',
      mkSession(other.repo, { name: 'o1', startMs: 9_000, events: oneRead }),
    );
    return {
      targetRepo: target.repo,
      claudeDir,
      newest: 't3',
      secondNewest: 't2',
    };
  }

  it('returns the newest session for the target repo (not the other repo, not older)', async () => {
    const { targetRepo, claudeDir, newest } = setupMultiSession();
    const result = await runReflect({
      latest: true,
      repo: targetRepo,
      claudeDir,
      format: 'json',
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output) as ReflectFinding;
    expect(parsed.session_id).toBe(newest);
  });

  it('excludeSession skips the newest and returns the second-newest', async () => {
    const { targetRepo, claudeDir, newest, secondNewest } = setupMultiSession();
    const result = await runReflect({
      latest: true,
      repo: targetRepo,
      claudeDir,
      excludeSession: newest,
      format: 'json',
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output) as ReflectFinding;
    expect(parsed.session_id).toBe(secondNewest);
  });

  it('no matching session for the repo → hook-stop yields {} (no throw)', async () => {
    // target repo has NO transcripts in this claudeDir (only the other repo).
    const target = setupTempRepo();
    const other = setupTempRepo();
    writeTranscript(
      other.claudeDir,
      'proj',
      'o1',
      mkSession(other.repo, {
        name: 'o1',
        startMs: 9_000,
        events: [{ kind: 'read', file: 'src/a.ts' }],
      }),
    );
    const result = await runReflect({
      latest: true,
      repo: target.repo,
      claudeDir: other.claudeDir,
      format: 'hook-stop',
      stopHookActive: false,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual({});
  });
});

describe('runReflect — detector errors fail open to trip:false', () => {
  // runDetector is pure and no real input throws, so the guard is exercised by
  // forcing the detector to throw via the module-level mock toggle. The
  // TRIP_EVENTS fixture would normally trip (flagged:true → trip:true); with the
  // detector throwing, the guarded detect step must degrade to a degenerate
  // trip:false finding and never reject — the Stop-hook safety contract.
  afterEach(() => {
    detectorThrows.now = false;
  });

  it('detector throws (hook-stop): exitCode 0, output parses to {}', async () => {
    detectorThrows.now = true;
    const { repo } = setupTempRepo();
    const file = writeTempTranscript(
      mkSession(repo, { name: 'trip', stepMs: 200_000, events: TRIP_EVENTS }),
    );

    const result = await runReflect({
      transcript: file,
      format: 'hook-stop',
      stopHookActive: false,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual({});
  });

  it('detector throws (json): parsed trip === false', async () => {
    detectorThrows.now = true;
    const { repo } = setupTempRepo();
    const file = writeTempTranscript(
      mkSession(repo, { name: 'trip', stepMs: 200_000, events: TRIP_EVENTS }),
    );

    const result = await runReflect({ transcript: file, format: 'json' });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output) as ReflectFinding;
    expect(parsed.trip).toBe(false);
  });
});

// --- privacy: the reflect path's no-prose guarantee, end-to-end --------------
//
// Mirrors the PROSE-absence + primitives-only pattern in test/privacy.test.ts
// (b) and test/hook.test.ts (7), but drives the FULL runReflect path (real
// streaming + real detection over a transcript fixture) in BOTH output forms.
// The hook.test.ts (7) case covers formatStopHookOutput alone with a hand-built
// record; this one proves the guarantee survives the whole pipeline and the
// nested StruggleRecord the json finding carries through.

// A prose marker seeded into a USER-MESSAGE field. The adapter consumes the
// sentence (classifies a correction shape, then discards the text) and it must
// never reach either output form.
const REFLECT_PROSE = 'please help me debug the flaky payments webhook retry logic';

// A tripping transcript that ALSO carries prose in a user message: a user prompt
// (prose), then 1 edit, then 3 consecutive failed execs. The 3 failed execs give
// failure_streak=3 (bootstrap trip); the large step inflates
// wall_clock_per_line_ms over its threshold → two signals trip → flagged=true;
// the edit makes zero_edit=false → trip=true. So hook-stop emits a NON-empty
// {decision:"block", reason} and json emits a populated finding — the privacy
// assertions below are non-vacuous (they run against real content, not {}).
const TRIP_WITH_PROSE_EVENTS: EventSpec[] = [
  { kind: 'user_text', text: REFLECT_PROSE },
  { kind: 'edit', file: 'src/payments/webhook.ts', newString: 'retry\n' },
  { kind: 'exec', cmd: './test.sh', ok: false },
  { kind: 'exec', cmd: './test.sh', ok: false },
  { kind: 'exec', cmd: './test.sh', ok: false },
];

/** Recursively collect every leaf value of a parsed JSON value (objects + arrays descended). */
function leafValues(v: unknown): unknown[] {
  if (Array.isArray(v)) return v.flatMap(leafValues);
  if (v !== null && typeof v === 'object') {
    return Object.values(v).flatMap(leafValues);
  }
  return [v];
}

describe('runReflect — privacy: transcript prose never leaks; primitives + closed enums only', () => {
  it('json + hook-stop outputs omit the seeded user-message prose and carry only primitive/enum leaves', async () => {
    const { repo } = setupTempRepo();
    const file = writeTempTranscript(
      mkSession(repo, {
        name: 'prose-trip',
        stepMs: 200_000,
        events: TRIP_WITH_PROSE_EVENTS,
      }),
    );

    for (const format of ['json', 'hook-stop'] as const) {
      const result = await runReflect({ transcript: file, format });

      // (1) Raw output string carries no transcript prose — covers the nested
      //     record too, not just the top-level fields.
      expect(
        result.output.includes(REFLECT_PROSE),
        `${format}: prose marker leaked into output`,
      ).toBe(false);

      const parsed: unknown = JSON.parse(result.output);

      // (2) Every leaf value is a primitive (string|number|boolean|null) — no
      //     nested object/array survives that could hold raw message text. The
      //     nested StruggleRecord the json finding carries is composed entirely
      //     of derived primitives.
      for (const leaf of leafValues(parsed)) {
        const t = typeof leaf;
        expect(
          t === 'string' || t === 'number' || t === 'boolean' || leaf === null,
          `${format}: non-primitive leaf ${JSON.stringify(leaf)}`,
        ).toBe(true);
      }

      if (format === 'hook-stop') {
        const out = parsed as StopHookOutput;
        // (3) Closed enum: decision ∈ {undefined, "block"}; reason is a string.
        expect(out.decision === undefined || out.decision === 'block').toBe(true);
        expect(out.reason === undefined || typeof out.reason === 'string').toBe(true);
        // Non-vacuous: this tripping session MUST block (else the assertions
        // above passed against an empty {}).
        expect(out.decision).toBe('block');
        expect(typeof out.reason).toBe('string');
        expect(out.reason!.length).toBeGreaterThan(0);
      } else {
        const finding = parsed as ReflectFinding;
        // Closed enum: mode (top-level + within record) ∈ ScoringMode.
        expect(['percentile', 'bootstrap']).toContain(finding.mode);
        expect(['percentile', 'bootstrap']).toContain(finding.record.mode);
        expect(finding.schema_version).toBe(1);
        // Non-vacuous: this session trips.
        expect(finding.trip).toBe(true);
        expect(finding.zero_edit).toBe(false);
      }
    }
  });
});
