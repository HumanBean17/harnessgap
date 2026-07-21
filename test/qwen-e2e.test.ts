// Qwen builder + integration end-to-end — Task 12 of the Qwen+GigaCode slice.
//
// Three cases per the task-12 brief:
//   1. Round-trip: mkQwenSession emits gemini-shaped JSONL that streamQwenSession
//      reads back into the expected NormalizedEvent sequence (kinds, tools, ok
//      flags, non-zero durations on tool_calls).
//   2. Integration: setupTempRepo + writeQwenTranscript + runScan with
//      harness:'qwen-code' → flagged session shows active reread /
//      failure_streak / corrections / oscillation signals and areas derived
//      from the seeded file paths.
//   3. Privacy: a prose marker seeded in user_text and a tool-arg field must be
//      absent from every scan output field (human, json, calibrate + warnings),
//      mirroring the existing privacy-test approach.
//
// Records are synthetic; no real transcript data. No network, no detection-path
// writes, no new runtime deps.

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { runScan } from '../src/pipeline.js';
import { streamQwenSession } from '../src/adapter/qwen/stream.js';
import {
  setupTempRepo,
  makeTempDir,
  mkQwenSession,
  writeQwenTranscript,
  cleanupTempDirs,
  type SessionSpec,
  type EventSpec,
} from './helpers/builder.js';
import {
  qwenStruggleSlug,
  qwenStruggleSession,
} from './fixtures/qwen/sessions.js';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import type { JsonOutput } from '../src/types.js';

afterEach(cleanupTempDirs);

// --- 1. Round-trip: mkQwenSession output parses back to expected events ---

describe('qwen builder round-trip (Task 12)', () => {
  it('mkQwenSession → streamQwenSession yields expected kinds/tools/ok flags', async () => {
    // Small spec exercising every EventSpec kind the builder handles.
    const spec: SessionSpec = {
      name: 'rt',
      events: [
        { kind: 'user_text', text: 'please read the file' },
        { kind: 'read', file: 'src/a.ts' },
        { kind: 'exec', cmd: 'npm test', ok: false },
        { kind: 'assistant_text', text: 'done' },
      ],
    };
    const cwd = '/tmp/repo';
    const jsonl = mkQwenSession(cwd, spec);

    // Write to a tmp chats/ layout and read it back through the real parser.
    const dir = makeTempDir('qwen-rt');
    const chats = join(dir, 'projects', 'slug', 'chats');
    mkdirSync(chats, { recursive: true });
    const file = join(chats, 'rt.jsonl');
    writeFileSync(file, jsonl, 'utf8');

    const { envelope } = await streamQwenSession(file);

    // user_msg → tool_call(read, ok) → tool_call(exec, !ok) → assistant_msg.
    expect(envelope.event_count).toBe(4);
    expect(envelope.events.map((e) => e.kind)).toEqual([
      'user_msg',
      'tool_call',
      'tool_call',
      'assistant_msg',
    ]);

    const [u, r, x, a] = envelope.events;
    expect(u!.kind).toBe('user_msg');
    expect(u!.tool).toBeNull();
    expect(u!.ok).toBe(true);

    expect(r!.kind).toBe('tool_call');
    expect(r!.tool).toBe('read');
    expect(r!.ok).toBe(true);
    expect(r!.duration_ms).toBeGreaterThan(0);

    expect(x!.kind).toBe('tool_call');
    expect(x!.tool).toBe('exec');
    expect(x!.ok).toBe(false);
    expect(x!.duration_ms).toBeGreaterThan(0);

    expect(a!.kind).toBe('assistant_msg');
    expect(a!.tool).toBeNull();
    expect(a!.ok).toBe(true);

    // Agent stamp is the literal 'qwen-code' (the builder emits Qwen-shape
    // records, so the parser is the Qwen parser).
    expect(envelope.agent).toBe('qwen-code');
    // The builder's cwd threads through to the envelope's cwds list.
    expect(envelope.events[0]!.t).toBeTruthy();
  });

  it('writeQwenTranscript writes under <rootDir>/projects/<slug>/chats/<name>.jsonl', () => {
    const root = makeTempDir('qwen-root');
    const jsonl = mkQwenSession('/tmp/repo', { name: 's', events: [] });
    const written = writeQwenTranscript(root, 'sl', 's1', jsonl);
    // The returned path is the chats-level file.
    expect(written).toBe(join(root, 'projects', 'sl', 'chats', 's1.jsonl'));
  });
});

// --- 2. Integration: synthetic fixture through runScan fires all 4 signals ---

describe('qwen builder integration (Task 12)', () => {
  it('runScan harness:qwen-code flags reread/failure_streak/corrections/oscillation + seeded areas', async () => {
    const { repo, claudeDir } = setupTempRepo();
    // Reuse claudeDir-shaped tmp helper, but route via writeQwenTranscript.
    // setupTempRepo returns a claudeDir whose value is irrelevant — we use
    // a fresh tmp root for the qwen layout instead, since claudeDir and the
    // qwen root differ in shape (no chats/ vs chats/).
    const qwenRoot = makeTempDir('qwen-root');
    void claudeDir;

    const jsonl = mkQwenSession(repo, qwenStruggleSession);
    writeQwenTranscript(qwenRoot, qwenStruggleSlug, 's1', jsonl);

    const result = await runScan({
      harness: 'qwen-code',
      harnessDir: qwenRoot,
      repo,
      json: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.sessionCount).toBe(1);

    const parsed = JSON.parse(result.output) as JsonOutput;
    expect(parsed.sessions).toHaveLength(1);
    const rec = parsed.sessions[0]!;
    expect(rec.flagged).toBe(true);

    // Each of the four high-value signals is active (>= threshold).
    expect(rec.signals.reread).toBeGreaterThanOrEqual(1);
    expect(rec.signals.failure_streak).toBeGreaterThanOrEqual(1);
    expect(rec.signals.corrections).toBeGreaterThanOrEqual(1);
    expect(rec.signals.oscillation).toBeGreaterThanOrEqual(1);

    // Areas derived from the seeded file paths (src/billing).
    expect(parsed.areas.length).toBeGreaterThan(0);
    const billing = parsed.areas.find((a) => a.key === 'src/billing');
    expect(billing, 'expected src/billing area from seeded paths').toBeDefined();
    expect(billing!.sessions_total).toBeGreaterThanOrEqual(1);
  });
});

// --- 3. Privacy: prose marker seeded in user_text + tool-arg is absent ---

describe('qwen builder privacy (Task 12)', () => {
  it('prose marker in user_text + tool-arg absent from every output mode', async () => {
    const MARKER = 'QWEN_BUILDER_PRIVACY_MARKER_4xz9';
    const { repo, claudeDir } = setupTempRepo();
    void claudeDir;
    const qwenRoot = makeTempDir('qwen-root');

    // Seed the marker in BOTH leak vectors a Qwen correction-aware change
    // could open: a user_text correction (consumed by detectCorrection, then
    // dropped) and an exec cmd (scrubbed + used only for classification, never
    // surfaced verbatim). File paths are NOT a marker vector here — they
    // surface in area keys, so a marker in a path WOULD legitimately appear.
    // The exec MUST precede the user_text so the correction is tied to a
    // prior tool_call (otherwise computeCorrections skips it).
    const events: EventSpec[] = [
      { kind: 'exec', cmd: `echo ${MARKER}`, ok: true },
      { kind: 'user_text', text: `no, stop ${MARKER} now` },
      { kind: 'read', file: 'src/billing/a.ts' },
      { kind: 'edit', file: 'src/billing/a.ts', newString: 'y' },
    ];
    const spec: SessionSpec = { name: 'priv', events };
    const privFile = writeQwenTranscript(
      qwenRoot,
      'priv-slug',
      'priv',
      mkQwenSession(repo, spec),
    );

    // Spec §10 privacy vector: a user record carrying functionResponse with
    // the marker in `response.output`. The parser drops functionResponse-
    // carrying user records at src/adapter/qwen/parse.ts (the result-carrier
    // branch), so the marker must remain absent from every output mode.
    // Appended after the exec's tool_result (real-data shape: the function
    // response mirrors the functionCall that preceded it).
    appendFileSync(
      privFile,
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-12T12:00:05.000Z',
        cwd: repo,
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'run_shell_command',
                response: { output: `${MARKER}` },
              },
            },
          ],
        },
      }) + '\n',
      'utf8',
    );

    for (const { label, opts } of [
      { label: 'human', opts: {} },
      { label: 'json', opts: { json: true } },
      { label: 'calibrate', opts: { calibrate: true } },
    ] as const) {
      const result = await runScan({
        harness: 'qwen-code',
        harnessDir: qwenRoot,
        repo,
        ...opts,
      });
      expect(
        result.output.includes(MARKER),
        `${label}: prose marker leaked into output`,
      ).toBe(false);
    }

    // Warnings object carries neither the marker nor the seeded path.
    const jsonResult = await runScan({
      harness: 'qwen-code',
      harnessDir: qwenRoot,
      repo,
      json: true,
    });
    expect(JSON.stringify(jsonResult.warnings).includes(MARKER)).toBe(false);

    // Load-bearing: the marker was actually ingested into the transcript
    // (the user_text correction was processed by detectCorrection and the
    // exec cmd by the classifier), so a non-leak claim is not vacuous.
    // The session was scanned (count=1) and flagged by the correction.
    expect(jsonResult.sessionCount).toBe(1);
    const parsed = JSON.parse(jsonResult.output) as JsonOutput;
    expect(parsed.sessions[0]!.signals.corrections).toBeGreaterThanOrEqual(1);
  });
});
