// HarnessSpec dispatcher + the three specs — Task 7 of the Qwen+GigaCode slice.
//
// `src/adapter/index.ts` exports the three HarnessSpecs (CLAUDE_SPEC,
// QWEN_SPEC, GIGACODE_SPEC), `resolveHarness(id)`, and `discoverForSpec(spec,
// rootOverride?)`. This suite verifies the assembly:
//   1. resolveHarness returns each spec by id (identity) and the three layouts
//      carry the expected sessionSubdir (none for claude; 'chats' for qwen/gc).
//   2. ALL capability matrices are ALL-'supported' for ALL three specs. The
//      spec's §5.2 table marked qwen/gigacode finalizationSignal +
//      perPromptContextInjection as 'pending', but Task 6 confirmed full Qwen
//      hook parity (Stop hook is a byte-identical Claude fork). The spec's
//      "collapse to supported once §8 known unknowns are resolved" clause has
//      fired — every pending cell is now 'supported'.
//   3. GIGACODE_SPEC.streamSession on a qwen-shaped file rewrites the parsed
//      envelope's `agent` from 'qwen-code' (the parser's stamp) to 'gigacode'.
//   4. resolveHarness throws on an unknown id (defensive at the runtime
//      boundary where id comes from CLI/config strings).
//   5. discoverForSpec(QWEN_SPEC, rootOverride) threads the chats/ layout
//      through discoverTranscripts and returns the .jsonl files under it.
//
// No network, no git, no detection-path writes. Synthetic transcript content.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CLAUDE_SPEC,
  QWEN_SPEC,
  GIGACODE_SPEC,
  resolveHarness,
  discoverForSpec,
} from '../src/adapter/index.js';
import type { CapabilityKey, HarnessId } from '../src/types.js';

// --- tmp dir helpers (mirrors walk.test.ts / qwen-stream.test.ts) ---

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harnessgap-dispatch-'));
}

function mkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function writeJsonl(dir: string, name: string, lines: string[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

const TS1 = '2026-07-21T04:22:16.401Z';
const TS2 = '2026-07-21T04:22:26.401Z'; // +10s

// The seven capability keys every HarnessSpec.capabilities must surface.
const CAPABILITY_KEYS: CapabilityKey[] = [
  'sessionDiscovery',
  'streamFormat',
  'finalizationSignal',
  'interruption',
  'fileChangeEvidence',
  'resume',
  'perPromptContextInjection',
];

describe('resolveHarness + the three specs', () => {
  it('1. resolveHarness(id) returns the pinned spec; layouts match the spec table', () => {
    expect(resolveHarness('claude-code')).toBe(CLAUDE_SPEC);
    expect(resolveHarness('qwen-code')).toBe(QWEN_SPEC);
    expect(resolveHarness('gigacode')).toBe(GIGACODE_SPEC);

    // id + displayName are pinned.
    expect(CLAUDE_SPEC.id).toBe('claude-code');
    expect(QWEN_SPEC.id).toBe('qwen-code');
    expect(GIGACODE_SPEC.id).toBe('gigacode');

    // Claude layout has NO sessionSubdir; Qwen + GigaCode carry 'chats'.
    expect(CLAUDE_SPEC.layout.sessionSubdir).toBeUndefined();
    expect('sessionSubdir' in CLAUDE_SPEC.layout).toBe(false);
    expect(QWEN_SPEC.layout.sessionSubdir).toBe('chats');
    expect(GIGACODE_SPEC.layout.sessionSubdir).toBe('chats');

    // extension + projectsSegment are pinned for all three.
    for (const spec of [CLAUDE_SPEC, QWEN_SPEC, GIGACODE_SPEC]) {
      expect(spec.layout.projectsSegment).toBe('projects');
      expect(spec.layout.extension).toBe('.jsonl');
    }
  });

  it('2. ALL capability matrices are all-supported for ALL three specs (Task 6 confirmed Qwen hook parity)', () => {
    // The spec §5.2 table originally marked qwen/gigacode finalizationSignal +
    // perPromptContextInjection as 'pending' pending Task 6's verification.
    // Task 6 confirmed Qwen's Stop hook is a byte-identical Claude fork, so the
    // two pending columns collapse to 'supported' per the spec's own clause.
    // GigaCode reuses Qwen's adapter, so it inherits the same parity.
    for (const spec of [CLAUDE_SPEC, QWEN_SPEC, GIGACODE_SPEC]) {
      for (const key of CAPABILITY_KEYS) {
        expect(
          spec.capabilities[key],
          `${spec.id}.capabilities.${key}`,
        ).toBe('supported');
      }
      // No 'pending' anywhere.
      expect(Object.values(spec.capabilities)).not.toContain('pending');
      // Every key is present (Record<CapabilityKey, ...> exhaustiveness).
      expect(Object.keys(spec.capabilities).sort()).toEqual(
        [...CAPABILITY_KEYS].sort(),
      );
    }
  });

  it('3. GIGACODE_SPEC.streamSession on a qwen-shaped file rewrites envelope.agent to gigacode', async () => {
    const dir = tmpDir();
    const sessionId = 'gc-rewrite-test-session';
    // Minimal qwen-shaped file: one user text record. The qwen parser emits
    // agent:'qwen-code' on its envelope; GIGACODE_SPEC.streamSession must
    // override that to 'gigacode' while leaving every other field intact.
    const lines = [
      JSON.stringify({
        type: 'user',
        timestamp: TS1,
        cwd: '/repo',
        message: { role: 'user', parts: [{ text: 'hello there' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: TS2,
        cwd: '/repo',
        message: { role: 'model', parts: [{ text: 'hi back', thought: false }] },
      }),
    ];
    const filePath = writeJsonl(dir, `${sessionId}.jsonl`, lines);

    const envelope = await GIGACODE_SPEC.streamSession(filePath);

    // The agent-rewrite is the load-bearing assertion.
    expect(envelope.agent).toBe('gigacode');
    // The rest of the envelope is the qwen parser's output unchanged.
    expect(envelope.schema_version).toBe(1);
    expect(envelope.session_id).toBe(sessionId);
    expect(envelope.started_at).toBe(TS1);
    expect(envelope.duration_ms).toBe(10_000); // TS2 - TS1
    expect(envelope.events.map((e) => e.kind)).toEqual(['user_msg', 'assistant_msg']);
    expect(envelope.event_count).toBe(2);
    expect(envelope.truncated).toBe(false);
  });

  it('4. resolveHarness throws on an unknown id (defensive at runtime boundary)', () => {
    // The HarnessId union makes this unreachable at compile time, but the
    // dispatcher is the runtime boundary where id comes from CLI/config
    // strings — a bad value must produce a clear error, never fall through.
    expect(() => resolveHarness('foo' as HarnessId)).toThrow(/unknown harness id/i);
    expect(() => resolveHarness('' as HarnessId)).toThrow();
    expect(() => resolveHarness('CLAUDE-CODE' as HarnessId)).toThrow();
  });

  it('5. discoverForSpec(QWEN_SPEC, rootOverride) returns [a.jsonl] on a chats-layout tree', () => {
    const dir = tmpDir();
    const slug = path.join(dir, 'projects', 'slug1');
    const chats = path.join(slug, 'chats');
    mkdir(chats);
    fs.writeFileSync(path.join(chats, 'a.jsonl'), '{}\n');
    // Sibling non-.jsonl artifacts must be excluded by the extension filter.
    fs.writeFileSync(path.join(chats, 'a.runtime.json'), '{}\n');
    fs.writeFileSync(path.join(chats, 'meta.json'), '{}\n');
    // A Claude-layout file (no chats/) must NOT appear when the spec's layout
    // has sessionSubdir:'chats'.
    mkdir(slug);
    fs.writeFileSync(path.join(slug, 'stray.jsonl'), '{}\n');

    const { files, symlinks_rejected } = discoverForSpec(QWEN_SPEC, dir);

    expect(files).toEqual([
      path.join(dir, 'projects', 'slug1', 'chats', 'a.jsonl'),
    ]);
    expect(symlinks_rejected).toBe(0);
    // The Claude-layout stray must NOT leak in.
    expect(files.some((f) => f.endsWith('stray.jsonl'))).toBe(false);
  });
});
