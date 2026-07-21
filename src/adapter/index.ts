// Multi-harness dispatcher — Task 7 of the Qwen+GigaCode slice.
//
// This module is the architectural seam that wires a `HarnessId` to the
// adapter + init + walk triples built in earlier tasks. It exports the three
// `HarnessSpec`s (CLAUDE_SPEC, QWEN_SPEC, GIGACODE_SPEC), `resolveHarness(id)`,
// and `discoverForSpec(spec, rootDirOverride?)`. No new detection logic lives
// here — the dispatcher is pure assembly, with exactly two pieces of mapping
// logic explicitly permitted by the task brief:
//
//   (1) GIGACODE_SPEC.streamSession delegates to `streamQwenSession` then
//       rewrites the returned envelope's `agent` from `'qwen-code'` (the
//       qwen parser's stamp) to `'gigacode'`. Same parser, different agent
//       stamp — GigaCode is a Qwen Code derivative and shares the transcript
//       format byte-for-byte.
//   (2) CLAUDE_SPEC.installHook delegates to `initClaude` and maps the
//       Claude-specific `InitClaudeResult` (paths only) to the harness-agnostic
//       `InitResult` contract (artifacts[], settingsBackupPath, degraded,
//       message). Qwen + GigaCode's `initQwen`/`initGigacode` already return
//       `InitResult` and attach unchanged.
//
// Capability matrices: the spec §5.2 table originally marked qwen/gigacode
// `finalizationSignal` + `perPromptContextInjection` as `'pending'` pending
// Task 6's verification of Qwen's Stop-hook contract. Task 6 confirmed full
// parity (Qwen's Stop hook is a byte-identical Claude Code fork — same
// settings shape, stdin fields, and `{decision:'block', reason}` return), so
// the spec's "collapse to supported once §8 known unknowns are resolved"
// clause has fired. ALL capability cells are `'supported'` for ALL three
// specs. GigaCode inherits Qwen's parity via the shared installer.
//
// Constraints: no network, no detection-path writes, no git, no new runtime
// deps. ESM, Node ≥ 22.12, TS7.

import type {
  CapabilityMatrix,
  HarnessId,
  HarnessSpec,
  InitResult,
  NormalizedEnvelope,
  TranscriptLayout,
} from '../types.js';
import { defaultRootDir, discoverTranscripts } from '../walk.js';
import { streamSession as claudeStreamSession } from './stream.js';
import { streamQwenSession } from './qwen/stream.js';
import { initClaude } from '../init/claude.js';
import { initGigacode, initQwen } from '../init/qwen.js';

// --- Layouts (pinned to the spec §5.2 table) ---

/** Claude Code: `<root>/projects/<slug>/*.jsonl` — no session subdir. */
const CLAUDE_LAYOUT: TranscriptLayout = {
  projectsSegment: 'projects',
  extension: '.jsonl',
};

/** Qwen Code + GigaCode: `<root>/projects/<slug>/chats/*.jsonl`. */
const CHATS_LAYOUT: TranscriptLayout = {
  projectsSegment: 'projects',
  sessionSubdir: 'chats',
  extension: '.jsonl',
};

// --- Capability matrix: all-supported for all three specs (see header) ---

const ALL_SUPPORTED: CapabilityMatrix = {
  sessionDiscovery: 'supported',
  streamFormat: 'supported',
  finalizationSignal: 'supported',
  interruption: 'supported',
  fileChangeEvidence: 'supported',
  resume: 'supported',
  perPromptContextInjection: 'supported',
};

// --- CLAUDE_SPEC: two mapping wrappers (streamSession + installHook) ---

/**
 * Spec-facing Claude streamSession. Wraps the existing `streamSession` (which
 * returns a richer `{envelope, cwd, cwds, warnings}` shape that
 * `src/pipeline.ts` consumes directly) and reduces it to the envelope, so
 * CLAUDE_SPEC.streamSession has the same `Promise<NormalizedEnvelope>` shape
 * as QWEN_SPEC / GIGACODE_SPEC. The cwd/warnings path is unchanged for direct
 * callers — only the spec field sees the reduced shape.
 */
async function claudeStreamForSpec(
  filePath: string,
): Promise<NormalizedEnvelope> {
  const { envelope } = await claudeStreamSession(filePath);
  return envelope;
}

/**
 * Spec-facing Claude installHook. Delegates to `initClaude` and maps
 * `InitClaudeResult` → `InitResult`:
 *   - `artifacts`: the three written paths (wrapper, settings, command).
 *   - `settingsBackupPath`: carried through when a pre-existing settings.json
 *     was unparseable and got backed up to `.bak`; `undefined` otherwise.
 *   - `degraded`: always `false` for Claude (the verified branch).
 *   - `message`: one-line human-readable status, mirroring `initQwen`'s shape.
 */
function claudeInstallHook(opts: { cwd: string }): InitResult {
  const r = initClaude(opts);
  return {
    harness: 'claude-code',
    artifacts: [r.wrapperPath, r.settingsPath, r.commandPath],
    settingsBackupPath: r.settingsBackupPath,
    degraded: false,
    message: `installed harnessgap for Claude Code: ${r.wrapperPath} | ${r.settingsPath} | ${r.commandPath}`,
  };
}

// --- GIGACODE_SPEC streamSession: the agent-rewrite ---

/**
 * Spec-facing GigaCode streamSession. Delegates to `streamQwenSession` (GigaCode
 * shares Qwen Code's transcript format byte-for-byte) and rewrites the returned
 * envelope's `agent` from the parser's `'qwen-code'` stamp to `'gigacode'`.
 * Every other envelope field is passed through unchanged. This is the load-
 * bearing piece of GigaCode-specific logic in the dispatcher: same parser,
 * different agent stamp.
 */
async function gigacodeStreamForSpec(
  filePath: string,
): Promise<NormalizedEnvelope> {
  const envelope = await streamQwenSession(filePath);
  return { ...envelope, agent: 'gigacode' };
}

// --- The three specs ---

export const CLAUDE_SPEC: HarnessSpec = {
  id: 'claude-code',
  displayName: 'Claude Code',
  defaultRootDir: () => defaultRootDir('claude-code'),
  layout: CLAUDE_LAYOUT,
  streamSession: claudeStreamForSpec,
  installHook: claudeInstallHook,
  capabilities: ALL_SUPPORTED,
};

export const QWEN_SPEC: HarnessSpec = {
  id: 'qwen-code',
  displayName: 'Qwen Code',
  defaultRootDir: () => defaultRootDir('qwen-code'),
  layout: CHATS_LAYOUT,
  streamSession: streamQwenSession,
  installHook: initQwen,
  capabilities: ALL_SUPPORTED,
};

export const GIGACODE_SPEC: HarnessSpec = {
  id: 'gigacode',
  displayName: 'GigaCode',
  defaultRootDir: () => defaultRootDir('gigacode'),
  layout: CHATS_LAYOUT,
  streamSession: gigacodeStreamForSpec,
  installHook: initGigacode,
  capabilities: ALL_SUPPORTED,
};

// --- Dispatchers ---

/**
 * Resolve a `HarnessSpec` by its id. Throws an `Error` with a clear message on
 * an unknown id. The `HarnessId` union makes the throw unreachable at compile
 * time, but this function sits at the runtime boundary where `id` arrives from
 * CLI/config strings — the defensive throw turns a malformed value into a
 * legible error rather than a silent fall-through.
 */
export function resolveHarness(id: HarnessId): HarnessSpec {
  if (id === 'claude-code') return CLAUDE_SPEC;
  if (id === 'qwen-code') return QWEN_SPEC;
  if (id === 'gigacode') return GIGACODE_SPEC;
  throw new Error(`Unknown harness id: ${id as string}`);
}

/**
 * Discover transcripts for a spec. Thin wrapper over `discoverTranscripts`:
 * uses `rootDirOverride` when provided, otherwise falls back to the spec's
 * `defaultRootDir()`. Threads the spec's `layout` so the chats/ subdir
 * (Qwen/GigaCode) or its absence (Claude) is honored.
 */
export function discoverForSpec(
  spec: HarnessSpec,
  rootDirOverride?: string,
): { files: string[]; symlinks_rejected: number } {
  return discoverTranscripts(
    rootDirOverride ?? spec.defaultRootDir(),
    spec.layout,
  );
}
