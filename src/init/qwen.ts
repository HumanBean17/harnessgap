// `harnessgap init qwen` / `harnessgap init gigacode` installer. Writes three
// artifacts under <cwd>/.qwen/ (or <cwd>/.gigacode/) so the trip-gated Stop
// hook lands for Qwen Code / GigaCode, mirroring `initClaude`.
//
// === Qwen Code session-end hook CONTRACT (research findings) ===
//
// Source (public, primary): QwenLM/qwen-code official docs + repo.
//   - https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/
//   - https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md
//
// The contract is a byte-identical Claude Code fork (the docs still say "When
// Claude prepares to conclude response" for the `Stop` event — Qwen Code is a
// Claude Code derivative). Confirmed answers to the three known-unknowns:
//
//   (a) settings.json hook registration shape — IDENTICAL to Claude Code:
//         {
//           "hooks": {
//             "Stop": [
//               { "matcher": "", "hooks": [ { "type": "command", "command": "node ..." } ] }
//             ]
//           }
//         }
//       (Qwen also supports optional `sequential`/`name`/`description`/`timeout`
//       fields on the hook entry, but the core {matcher, hooks[].{type,command}}
//       shape matches Claude's exactly — so `mergeStopHook` is reused as-is.)
//
//   (b) stdin payload — the `Stop` event receives the SAME common fields as
//       every Qwen hook: {session_id, transcript_path, cwd, hook_event_name,
//       timestamp} plus event-specific {stop_hook_active, last_assistant_message,
//       optional context_usage/context_limit/input_tokens}. Both `transcript_path`
//       and `stop_hook_active` are present — identical field names to Claude —
//       so the wrapper reads `transcript_path` as the `--transcript` value and
//       short-circuits on `stop_hook_active === true`, exactly as Claude's does.
//
//   (c) return payload — Qwen's Stop example output is literally:
//         { "decision": "block", "reason": "Must be provided when Qwen Code is
//           blocked from stopping" }
//       Byte-identical to Claude's `StopHookOutput` (`{decision?:'block',
//       reason?}`). Exit codes also match: 0 = success (parse stdout), 2 =
//       blocking error, other = non-blocking.
//
// DECISION: VERIFIED branch. `formatStopHookOutput` in `src/output/hook.ts` is
// reused UNCHANGED (Qwen's payload matches Claude's exactly — no harness-
// parameterized renderer needed). `mergeStopHook` + `buildWrapperSource` are
// imported from `./claude.js` (shared, not duplicated) since the settings shape
// and the wrapper's stdin contract are identical. Scan parity is unaffected.
//
// GigaCode is assumed byte-identical to Qwen (full clone) and reuses this
// installer with `.gigacode` + `GIGACODE.md`. If a real `~/.gigacode` sample
// ever diverges, gigacode gets its own constants (spec §11 open question 2).

import { dirname, join } from 'node:path';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { HarnessId, InitResult } from '../types.js';
import {
  CLI_PATH,
  buildWrapperSource,
  mergeStopHook,
} from './claude.js';

/** Relative locations of the three artifacts under <cwd>/<root>/. */
function artifactPaths(cwd: string, root: string) {
  return {
    wrapperPath: join(cwd, root, 'harnessgap-stop-hook.js'),
    settingsPath: join(cwd, root, 'settings.json'),
    commandPath: join(cwd, root, 'commands', 'reflect.md'),
  };
}

/**
 * Build the `/reflect` agent-guidance prompt for a given harness. Parameterized
 * by display name + memory-file name so qwen references `QWEN.md` and gigacode
 * references `GIGACODE.md`. No detection logic — guides the agent through
 * producing one `ReflectFrame` from an already-computed `ReflectFinding`, and
 * documents how to invoke the detector manually. Mirrors the Claude command
 * source byte-for-byte except for the harness name + memory-file references.
 */
function buildCommandSource(opts: { displayName: string; memoryFile: string }): string {
  const { displayName, memoryFile } = opts;
  return `# /reflect

Reflect on a session that showed ${displayName} harness friction. This command
runs **no detection itself** — it guides you through producing one concrete
\`ReflectFrame\` from an already-computed \`ReflectFinding\`.

## When triggered by a Stop-hook block

If you are here because a Stop hook returned \`{ "decision": "block", "reason" }\`,
that \`reason\` already carries the finding summary (top friction areas + active
signals). Use it directly — do **not** re-invoke the binary.

## Otherwise, obtain the finding

Run the detector on the most recent finished session for this repo:

\`\`\`
harnessgap reflect --latest --repo . --json
\`\`\`

(\`reflect\` auto-detects ${displayName} from the transcript format.) Read the
emitted \`ReflectFinding\`. If \`trip\` is \`false\`, skip to "Clean session" below.

## Fill exactly one ReflectFrame

- **cost** — the friction cost this session, tied to the finding's top signal
  (a failure streak, a reread loop, oscillating edits, or abandonment). One
  sentence.
- **missing** — the context that would have helped avoid the friction (a doc, a
  type annotation, a missing test, an absent tool result, or an entry in
  ${memoryFile}). One sentence.
- **change** — one proposed harness change:
  - \`target_path\` — a repo-relative path to add or improve (or ${memoryFile}
    for a harness-config change).
  - \`kind\` — \`add\` | \`improve\` | \`none\`.
  - \`rationale\` — why this change targets the observed cost.
- **path_verified** — before presenting, confirm \`target_path\` (or its **parent
  directory** for an \`add\`) exists via a Read or Glob. Set \`true\` only when
  confirmed; \`false\` if you could not verify it.

## Present + offer

Present the recommendation concisely: cost → change → rationale. Then offer to
draft the change in-session (sketch the file or edit) if the user wants.

## Clean session

If \`trip === false\` or the session was clean, say so briefly and emit a frame
with \`change.kind: "none"\` (no harness change needed). Do not invent friction.
`;
}

/** Options for {@link initQwen} / {@link initGigacode}. */
export interface InitQwenOpts {
  /** Target working directory; artifacts land under <cwd>/<root>/. */
  cwd: string;
}

/**
 * Shared installer core for Qwen Code + GigaCode. Mirrors `initClaude`: writes
 * (1) a fail-open Stop-hook wrapper, (2) an idempotent `hooks.Stop` settings.json
 * merge (dedup-by-command, preserve user keys, backup unparseable files), (3) a
 * `/reflect` command. Returns the `InitResult` contract from `src/types.ts`.
 *
 * The wrapper + command are rewritten verbatim on every call (idempotent); the
 * settings merge reuses `mergeStopHook` since the Qwen Stop registration shape
 * is byte-identical to Claude's. The wrapper's `child_process` use lives inside
 * the emitted artifact string under <cwd>/<root>/ — NOT part of src/'s egress
 * surface (mirrors `init/claude.ts`).
 */
function installStopHook(
  opts: InitQwenOpts & {
    root: string;
    harness: HarnessId;
    displayName: string;
    memoryFile: string;
  },
): InitResult {
  const { cwd, root, harness, displayName, memoryFile } = opts;
  const { wrapperPath, settingsPath, commandPath } = artifactPaths(cwd, root);

  // Ensure <root>/ and <root>/commands/ exist.
  mkdirSync(dirname(wrapperPath), { recursive: true });
  mkdirSync(dirname(commandPath), { recursive: true });

  // Wrapper + command are refreshed verbatim each run (idempotent).
  writeFileSync(wrapperPath, buildWrapperSource({ cliPath: CLI_PATH }), 'utf8');
  writeFileSync(
    commandPath,
    buildCommandSource({ displayName, memoryFile }),
    'utf8',
  );

  // settings.json: read → parse-or-default → merge → write (pretty-printed).
  // A *missing* file starts fresh. An *existing-but-unparseable* file is backed
  // up byte-for-byte to settings.json.bak before being overwritten, so a broken
  // hand-edit never destroys the user's config. (copyFileSync runs before the
  // overwrite below, copying the original bytes, not the merged output.)
  let raw: Record<string, unknown> = {};
  let settingsBackupPath: string | undefined;
  let existingText = '';
  let fileExists = false;
  try {
    existingText = readFileSync(settingsPath, 'utf8');
    fileExists = true;
  } catch {
    // missing → start fresh; never throw on user's missing file.
  }
  if (fileExists) {
    try {
      const parsed = JSON.parse(existingText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // Existing file is unparseable — back it up verbatim before overwrite.
      settingsBackupPath = `${settingsPath}.bak`;
      copyFileSync(settingsPath, settingsBackupPath);
    }
  }
  const merged = mergeStopHook(raw, wrapperPath);
  writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

  const message = `installed harnessgap for ${displayName}: ${wrapperPath} | ${settingsPath} | ${commandPath}`;
  return {
    harness,
    artifacts: [wrapperPath, settingsPath, commandPath],
    settingsBackupPath,
    degraded: false,
    message,
  };
}

/**
 * Install (or refresh) the three Qwen Code artifacts under `opts.cwd/.qwen/`.
 * Idempotent: the wrapper + command are rewritten on every call, and the
 * `hooks.Stop` array is merged so the harnessgap entry appears exactly once
 * with all user settings preserved. Returns the `InitResult` contract.
 */
export function initQwen(opts: InitQwenOpts): InitResult {
  return installStopHook({
    cwd: opts.cwd,
    root: '.qwen',
    harness: 'qwen-code',
    displayName: 'Qwen Code',
    memoryFile: 'QWEN.md',
  });
}

/**
 * Install (or refresh) the three GigaCode artifacts under `opts.cwd/.gigacode/`.
 * Differs from {@link initQwen} only in root (`.gigacode`) and the project-memory
 * file name (`GIGACODE.md`) referenced in the emitted guidance text.
 */
export function initGigacode(opts: InitQwenOpts): InitResult {
  return installStopHook({
    cwd: opts.cwd,
    root: '.gigacode',
    harness: 'gigacode',
    displayName: 'GigaCode',
    memoryFile: 'GIGACODE.md',
  });
}
