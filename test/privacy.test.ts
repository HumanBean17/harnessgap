// Privacy + safety assertions: cross-cutting tests that no secrets or raw prose
// leak into any output path (stdout human, --json, --calibrate), and that safety
// fixtures (symlinks, unresolvable cwd, oversized lines) are correctly rejected
// and counted in warnings.
//
// Three sections:
//   (a) Secret-shape: each scrubber pattern through streamSession → ***REDACTED***
//       present in input_digest; through runScan --json → original secret absent.
//   (b) Malformed: prose markers absent from all 3 output modes + warnings.
//   (c) Safety: symlinks rejected, unresolvable cwd skipped, oversized lines
//       skipped. Warnings are integers with no path/prose.
//   (d) Baseline/finding/calibrate surfaces prose-free at ≥min_sessions: forces
//       the ambient finding to fire (single-session fixtures cannot), then
//       asserts no prose marker reaches repo_findings, baseline, or calibrate.

import { describe, it, expect, afterEach } from 'vitest';
import { runScan } from '../src/pipeline.js';
import { streamSession } from '../src/adapter/stream.js';
import type { JsonOutput } from '../src/types.js';
import {
  setupTempRepo,
  writeTranscript,
  mkSession,
  makeTempDir,
  cleanupTempDirs,
  type EventSpec,
} from './helpers/builder.js';
import {
  secretShapeSlug,
  secretShapeSessions,
  SECRET_STRINGS,
} from './fixtures/secret-shape/sessions.js';
import {
  malformedSlug,
  malformedTranscript,
  PROSE_MARKER,
  PROSE_MARKER_2,
} from './fixtures/malformed/sessions.js';
import { writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

afterEach(cleanupTempDirs);

// --- (a) Secret-shape: scrubber patterns survive neither in events nor output ---

describe('privacy (a): secret-shape through pipeline', () => {
  it('each secret is ***REDACTED*** in normalized events and absent from --json output', async () => {
    const { repo, claudeDir } = setupTempRepo();

    // Write each secret-shape fixture.
    for (const spec of secretShapeSessions) {
      writeTranscript(claudeDir, secretShapeSlug, spec.name, mkSession(repo, spec));
    }

    // Check normalized events: ***REDACTED*** present, original secret absent.
    for (const spec of secretShapeSessions) {
      const filePath = join(claudeDir, 'projects', secretShapeSlug, `${spec.name}.jsonl`);
      const { envelope } = await streamSession(filePath);

      // Collect all input_digest strings from the envelope's events.
      const digestStrings: string[] = [];
      for (const ev of envelope.events) {
        if (ev.input_digest.cmd) digestStrings.push(ev.input_digest.cmd);
        for (const f of ev.input_digest.files) digestStrings.push(f);
        if (ev.input_digest.query) digestStrings.push(ev.input_digest.query);
      }

      // At least one digest string should contain ***REDACTED*** (the scrubber
      // replaced the secret). The cred-file fixture redacts file paths.
      const hasRedacted = digestStrings.some((s) => s.includes('***REDACTED***'));
      expect(
        hasRedacted,
        `${spec.name}: expected ***REDACTED*** in some input_digest (got: ${digestStrings.join(' | ')})`,
      ).toBe(true);

      // No original secret string should survive in any digest string.
      for (const secret of SECRET_STRINGS) {
        const leaked = digestStrings.some((s) => s.includes(secret));
        expect(
          leaked,
          `${spec.name}: secret "${secret}" survived in input_digest`,
        ).toBe(false);
      }
    }

    // Check runScan --json output: no original secret string appears.
    const result = await runScan({ repo, claudeDir, json: true });
    for (const secret of SECRET_STRINGS) {
      expect(
        result.output.includes(secret),
        `secret "${secret}" leaked into --json output`,
      ).toBe(false);
    }
  });
});

// --- (b) Malformed: raw prose absent from all output modes + warnings ---

describe('privacy (b): malformed transcript prose does not leak', () => {
  it('prose markers absent from human, json, and calibrate output', async () => {
    const { repo, claudeDir } = setupTempRepo();
    writeTranscript(claudeDir, malformedSlug, 'malformed', malformedTranscript(repo));

    const modes = [
      { label: 'human', opts: {} },
      { label: 'json', opts: { json: true } },
      { label: 'calibrate', opts: { calibrate: true } },
    ] as const;

    for (const { label, opts } of modes) {
      const result = await runScan({ repo, claudeDir, ...opts });
      expect(
        result.output.includes(PROSE_MARKER),
        `${label}: prose marker "${PROSE_MARKER}" leaked into output`,
      ).toBe(false);
      expect(
        result.output.includes(PROSE_MARKER_2),
        `${label}: prose marker "${PROSE_MARKER_2}" leaked into output`,
      ).toBe(false);
    }
  });

  it('prose markers absent from warnings object (stringified)', async () => {
    const { repo, claudeDir } = setupTempRepo();
    writeTranscript(claudeDir, malformedSlug, 'malformed', malformedTranscript(repo));
    const result = await runScan({ repo, claudeDir, json: true });
    const warningsStr = JSON.stringify(result.warnings);
    expect(warningsStr.includes(PROSE_MARKER)).toBe(false);
    expect(warningsStr.includes(PROSE_MARKER_2)).toBe(false);
  });
});

// --- (c) Warnings are integers + safety fixtures ---

describe('privacy (c): warnings are integers with no path/prose; safety fixtures', () => {
  it('warnings fields are integers (no path or prose leaks)', async () => {
    const { repo, claudeDir } = setupTempRepo();
    // Mix malformed + normal to get a mix of warnings.
    writeTranscript(claudeDir, malformedSlug, 'malformed', malformedTranscript(repo));
    const result = await runScan({ repo, claudeDir, json: true });
    const parsed = JSON.parse(result.output) as JsonOutput;
    const w = parsed.warnings;
    const wKeys = Object.keys(w) as (keyof typeof w)[];
    for (const k of wKeys) {
      expect(typeof w[k], `warnings.${k} must be a number`).toBe('number');
      expect(Number.isInteger(w[k]), `warnings.${k} must be an integer`).toBe(true);
    }
    // The warnings line in human output should not contain the repo path or prose.
    const humanResult = await runScan({ repo, claudeDir });
    expect(humanResult.output.includes(PROSE_MARKER)).toBe(false);
  });

  it('symlinked transcript → symlinks_rejected >= 1, file not scanned', async () => {
    const { repo, claudeDir } = setupTempRepo();
    const slug = join(claudeDir, 'projects', 'symlink-slug');
    mkdirSync(slug, { recursive: true });

    // Create a real transcript outside claudeDir, then symlink it inside.
    const realFile = makeTempDir('symlink-target');
    const realPath = join(realFile, 'real.jsonl');
    writeFileSync(realPath, mkSession(repo, {
      name: 'real',
      events: [
        { kind: 'edit', file: 'src/app/a.ts', newString: 'y' },
      ],
    }), 'utf8');

    const linkPath = join(slug, 'link.jsonl');
    symlinkSync(realPath, linkPath);

    const result = await runScan({ repo, claudeDir });
    expect(result.warnings.symlinks_rejected).toBeGreaterThanOrEqual(1);
    // The symlinked session should not be scanned (session count excludes it).
    expect(result.sessionCount).toBe(0);
  });

  it('unresolvable cwd → unresolvable_cwd >= 1, session skipped', async () => {
    const { repo, claudeDir } = setupTempRepo();
    // Write a transcript with cwd pointing to a nonexistent path.
    const badCwd = '/nonexistent/harnessgap/privacy-test-' + Date.now();
    writeTranscript(claudeDir, 'bad-cwd-slug', 'bad', mkSession(badCwd, {
      name: 'bad',
      events: [
        { kind: 'edit', file: 'src/app/a.ts', newString: 'y' },
      ],
    }));

    const result = await runScan({ repo, claudeDir });
    expect(result.warnings.unresolvable_cwd).toBeGreaterThanOrEqual(1);
    // The unresolvable reason is counted once; skipped_sessions is reserved for
    // other skip reasons (no double-count in the warnings line).
    expect(result.warnings.skipped_sessions).toBe(0);
    expect(result.sessionCount).toBe(0);
  });

  it('oversized line (>1MB) → oversized_lines >= 1, line not parsed', async () => {
    const { repo, claudeDir } = setupTempRepo();
    const slug = join(claudeDir, 'projects', 'oversized-slug');
    mkdirSync(slug, { recursive: true });

    // Build a transcript with one oversized line (>1MB) + one valid line.
    // The oversized line is a JSON object with a huge string field.
    const hugePayload = 'x'.repeat(1_100_000); // >1MB
    const oversizedLine = JSON.stringify({
      type: 'user',
      timestamp: '2026-07-12T12:00:00.000Z',
      cwd: repo,
      message: { role: 'user', content: hugePayload },
    });
    const validLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-12T12:00:01.000Z',
      cwd: repo,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/app/a.ts', old_string: 'x', new_string: 'y' } }],
      },
    });
    const validResult = JSON.stringify({
      type: 'user',
      timestamp: '2026-07-12T12:00:02.000Z',
      cwd: repo,
      message: { role: 'user', content: [{ type: 'tool_result', is_error: false }] },
    });

    writeFileSync(
      join(slug, 'oversized.jsonl'),
      `${oversizedLine}\n${validLine}\n${validResult}\n`,
      'utf8',
    );

    const result = await runScan({ repo, claudeDir, json: true });
    expect(result.warnings.oversized_lines).toBeGreaterThanOrEqual(1);
    // The valid line should still be parsed (session scanned).
    expect(result.sessionCount).toBe(1);
  });
});

// --- (d) Baseline/finding/calibrate surfaces prose-free at ≥min_sessions ---
//
// Sections (a)/(b) write a SINGLE session, which can never trip the ambient
// finding (min_sessions=10). The new RepoFinding, the baseline block in human
// output, and the calibrate BASELINE line are therefore unexercised by those
// fixtures. This section builds ≥min_sessions where each pre-edit read spans
// ≥breadth_floor distinct depth-2 dirs so the orientation path fires and the
// finding becomes non-null — then asserts no prose marker reaches any output.

describe('privacy (d): baseline/finding surfaces carry no prose', () => {
  it('repo_findings, baseline block, and calibrate line stay prose-free', async () => {
    // Scoped name: PROSE_MARKER is already imported at module scope (sections
    // a/b/c) — defining it again here would shadow that import.
    const BASELINE_PROSE_MARKER = 'Q9bKxe_secret_prose_marker';
    const { repo, claudeDir } = setupTempRepo();

    // Fixture: 12 sessions (≥ min_sessions=10). Each session pre-edit reads
    // files across 5 distinct depth-2 dirs (src/a1..a5) → dirBreadth=5 ≥
    // breadth_floor=4, so the median dir-breadth across sessions trips the
    // orientation path → state 'elevated' → finding non-null. Half the sessions
    // also plant the marker inside a user_text and an exec cmd (the events a
    // prose leak would originate from). Each session ends with one edit so it
    // counts as a with-edit session (orientation metric defined).
    const dirs = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const readFiles = dirs.map((d) => `src/${d}/f.ts`);
    const N_SESSIONS = 12;
    const slug = 'baseline-prose-slug';

    for (let i = 0; i < N_SESSIONS; i++) {
      const events: EventSpec[] = [];
      // 5 reads across 5 distinct depth-2 dirs (orientation breadth = 5).
      for (const f of readFiles) {
        events.push({ kind: 'read', file: f });
      }
      // Every other session carries the marker in user_text + exec cmd.
      if (i % 2 === 0) {
        events.push({ kind: 'user_text', text: BASELINE_PROSE_MARKER });
        events.push({ kind: 'exec', cmd: 'echo ' + BASELINE_PROSE_MARKER });
      }
      // First edit after the reads → orientation metric computed over reads.
      events.push({ kind: 'edit', file: 'src/target/app.ts', newString: 'y' });

      const name = `session-${i}`;
      writeTranscript(claudeDir, slug, name, mkSession(repo, { name, events }));
    }

    // --- JSON output: finding fired + no marker anywhere ---
    const jsonResult = await runScan({ repo, claudeDir, json: true });
    const parsed = JSON.parse(jsonResult.output) as JsonOutput;
    // Load-bearing: confirms the new RepoFinding surface is genuinely exercised
    // (not vacuously prose-free because the finding never fired).
    expect(
      parsed.repo_findings.length,
      'ambient finding should fire at n≥min_sessions with elevated orientation',
    ).toBe(1);
    expect(
      JSON.stringify(parsed.repo_findings).includes(BASELINE_PROSE_MARKER),
      'prose marker leaked into repo_findings',
    ).toBe(false);
    expect(
      JSON.stringify(parsed).includes(BASELINE_PROSE_MARKER),
      'prose marker leaked into --json output',
    ).toBe(false);

    // --- Human output: no marker (covers the BASELINE block) ---
    const humanResult = await runScan({ repo, claudeDir });
    expect(
      humanResult.output.includes(BASELINE_PROSE_MARKER),
      'prose marker leaked into human output',
    ).toBe(false);

    // --- Calibrate output: no marker (covers the BASELINE summary line) ---
    const calibrateResult = await runScan({ repo, claudeDir, calibrate: true });
    expect(
      calibrateResult.output.includes(BASELINE_PROSE_MARKER),
      'prose marker leaked into calibrate output',
    ).toBe(false);

    // --- Positive enum check: severity + paths are fixed literals ---
    const finding = parsed.repo_findings[0]!;
    expect(['high', 'medium', 'low', 'unrated']).toContain(finding.severity);
    for (const p of finding.paths) {
      expect(['orientation', 'acute']).toContain(p);
    }
  });
});
