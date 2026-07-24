// Per-harness subprocess adapter (Synthesizer, Task 8). The closed-loop MVP's
// only egress path: shells out to the agent print-mode CLI (`claude -p` /
// `qwen -p` / `gigacode -p`) with JSON output, captures stdout, and unwraps
// the harness-specific envelope into a plain value the shared Proposal
// validator (Task 6) checks. Claude and Qwen wrap results in DIFFERENT envelope
// shapes — that is why `extractProposal` is per-harness, not shared.
//
// Three exports, pinned to the Task 8 brief:
//   - resolveBackend(harness, cfg): PURE. Picks cmd+args from config or the
//     per-harness default; appends `-m <model>` when a model is set.
//   - runBackend({...}): EFFECTFUL. Spawns `cmd args` via node:child_process
//     (NO shell), writes the prompt to stdin, returns stdout. Throws on
//     non-zero exit, ENOENT (child 'error' event), or empty stdout. Accepts
//     an injectable `spawnFn` (defaults to a wrapper over child_process.spawn)
//     so tests never fire a real model call.
//   - extractProposal(stdout, harness): PURE. Per-harness envelope unwrap.
//
// `child_process` is imported ONLY in this file (under src/synthesizer/*),
// satisfying the §11 egress guard — test/egress.test.ts scans src/ for network
// modules and child_process is the allowed-but-confinement-checked one.
//
// Real envelope shapes were observed by running (single tiny call each):
//   claude -p '...' --output-format json
//     → {"type":"result","subtype":"success","result":"<JSON string>",...}
//       (single JSON object; `.result` is a JSON string of the actual payload)
//   qwen  -p '...' -o json
//     → [ {"type":"system",...}, {"type":"assistant",...}, {"type":"result","result":"<JSON string>",...} ]
//       (JSON ARRAY of records; the `result` record's `.result` is the payload,
//        same field name as claude — only the outer container differs)
//   gigacode — binary not installable in this env; assumed qwen-parity
//     (documented as UNVERIFIED; same code path as qwen).

import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { Config, HarnessId } from '../types.js';

// Re-export so callers can import the config + harness types alongside.
export type { Config, HarnessId };

/** Per-harness resolution result: a command and its argv. */
export interface ResolvedBackend {
  cmd: string;
  args: string[];
}

/**
 * Structural subset of node's `ChildProcess` that `runBackend` consumes. The
 * real `child_process.spawn` return value satisfies this (with `stdio:'pipe'`,
 * stdin/stdout/stderr are non-null). Tests pass a fake implementing only these
 * three streams plus an `on` for the `'error'`/`'close'` events.
 */
export interface SpawnedChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Injectable spawn seam. Same shape as `child_process.spawn` but narrowed to
 * the structural `SpawnedChild` return so tests can substitute a fake without
 * firing a real subprocess. Defaults to a wrapper over the real spawn.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedChild;

/**
 * Wrap node's real `child_process.spawn` to satisfy `SpawnFn`. Forces
 * `stdio:'pipe'` so stdin/stdout/stderr are present (asserted for the type
 * system; unreachable otherwise). The returned `on` is `child.on` bound to the
 * real child so `'error'`/`'close'`/signal events propagate unchanged.
 */
const defaultSpawn: SpawnFn = (command, args, options) => {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    // Unreachable with stdio:'pipe'; guard for the type checker.
    throw new Error('child_process.spawn did not return piped stdio');
  }
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    on: child.on.bind(child) as SpawnedChild['on'],
  };
};

/**
 * Per-harness default `{cmd, args}` for the print-mode JSON invocation. Kept as
 * a tuple so `resolveBackend` can destructure without `let`-before-assign.
 *
 *  - claude-code: `claude -p --output-format json`
 *  - qwen-code:   `qwen -p -o json`
 *  - gigacode:    `gigacode -p -o json` (unverified; qwen-parity)
 */
function defaultCmdArgs(harness: HarnessId): readonly [string, string[]] {
  switch (harness) {
    case 'claude-code':
      return ['claude', ['-p', '--output-format', 'json']];
    case 'qwen-code':
      return ['qwen', ['-p', '-o', 'json']];
    case 'gigacode':
      return ['gigacode', ['-p', '-o', 'json']];
  }
}

/**
 * Resolve the cmd+args to invoke for `harness` under `cfg`.
 *
 * Resolution order (brief, verbatim):
 *  1. If `cfg.synthesizer.backend` is non-null and non-empty, it WINS and fully
 *     replaces the cmd+args base — split on whitespace into `[cmd, ...args]`.
 *     The override REPLACES the per-harness default entirely; the caller owns
 *     any output-format flags (e.g. include `--output-format json` in the
 *     override if the backend needs it). Runs of whitespace are collapsed and
 *     leading/trailing space is trimmed.
 *  2. Otherwise the per-harness default from `defaultCmdArgs`.
 *  3. If `cfg.synthesizer.model` is non-null and non-empty, `-m <model>` is
 *     APPENDED to the args (after either path above). `-m` is the default model
 *     flag for all three harnesses; an override may need a different flag, in
 *     which case the caller leaves `model` null and puts the flag in `backend`.
 */
export function resolveBackend(harness: HarnessId, cfg: Config): ResolvedBackend {
  const syn = cfg.synthesizer;
  const override = syn.backend?.trim();
  const [defaultCmd, defaultArgs] = defaultCmdArgs(harness);
  const [cmd, baseArgs] =
    override && override.length > 0 ? splitBackend(override) : [defaultCmd, defaultArgs];
  const args =
    syn.model !== null && syn.model.trim() !== ''
      ? [...baseArgs, '-m', syn.model]
      : baseArgs;
  return { cmd, args };
}

/** Split a backend override string into `[cmd, ...args]` on whitespace. */
function splitBackend(s: string): readonly [string, string[]] {
  const parts = s.split(/\s+/).filter((p) => p !== '');
  // Caller guards against empty `s`; defensive check for the type system.
  if (parts.length === 0) {
    throw new Error('backend override is empty after splitting on whitespace');
  }
  return [parts[0], parts.slice(1)];
}

/**
 * Spawn `cmd args` (NO shell), write `prompt` to stdin, return stdout. Rejects
 * on any of:
 *   - the child emitting an `'error'` event (e.g. ENOENT — binary not found);
 *   - non-zero exit code (or null — signal-killed);
 *   - empty stdout on a 0-exit (treated as a backend malfunction).
 *
 * Stderr is captured and folded into the non-zero-exit error message so a
 * rate-limited or misconfigured backend surfaces a useful diagnostic. The
 * optional `spawnFn` seam defaults to the real `child_process.spawn` wrapper;
 * tests pass a fake to avoid firing a real model call.
 */
export function runBackend(opts: {
  cmd: string;
  args: readonly string[];
  prompt: string;
  cwd: string;
  spawnFn?: SpawnFn;
}): Promise<string> {
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  return new Promise<string>((resolve, reject) => {
    let child: SpawnedChild;
    try {
      child = spawnFn(opts.cmd, opts.args, { cwd: opts.cwd });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stderrText = '';
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const ok = (stdout: string): void => {
      if (settled) return;
      settled = true;
      resolve(stdout);
    };

    // Collect stdout bytes; collect stderr text for the error message.
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    child.stdout.on('error', (err: Error) => fail(err));
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrText += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });

    // Terminal events. 'error' (ENOENT etc.) fires before 'close'; the
    // `settled` guard makes only the first of error/non-zero-close win.
    child.on('error', (err: unknown) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });
    child.on('close', (code: unknown) => {
      const exitCode = typeof code === 'number' ? code : null;
      if (exitCode !== 0) {
        const where = exitCode === null ? 'killed by signal' : `exited with code ${exitCode}`;
        const detail = stderrText ? `: ${stderrText}` : '';
        fail(new Error(`${opts.cmd} ${where}${detail}`));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      if (stdout === '') {
        const detail = stderrText ? `: ${stderrText}` : '';
        fail(new Error(`${opts.cmd} produced empty stdout${detail}`));
        return;
      }
      ok(stdout);
    });

    // Feed the prompt and close stdin so the backend can respond.
    try {
      child.stdin.write(opts.prompt);
      child.stdin.end();
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/**
 * Per-harness envelope unwrap. Returns `unknown` because the two harness
 * lineages produce different value shapes by design:
 *
 *  - `claude-code`: outer stdout is `JSON.parse`'d to an envelope object; the
 *    envelope's `.result` is a JSON STRING of the actual payload, which is
 *    `JSON.parse`'d again. Returns the inner PARSED OBJECT — ready for the
 *    Proposal validator.
 *  - `qwen-code` / `gigacode`: outer stdout is a JSON ARRAY of records
 *    (system/assistant/result). The `result` record's `.result` field is the
 *    model's TEXT output (a JSON string of the payload). This function returns
 *    that TEXT STRING; the caller JSON-parses it as the proposal object. (The
 *    asymmetry is deliberate: the qwen envelope may carry non-JSON assistant
 *    text, so the caller owns the final parse decision.)
 *
 * `gigacode` reuses the qwen path unchanged; its envelope is UNVERIFIED (binary
 * not installable in this environment) — documented here and in the report.
 *
 * Throws on any malformed shape (non-JSON outer, wrong inner type, missing
 * result record); the orchestrator catches and degrades.
 */
export function extractProposal(stdout: string, harness: HarnessId): unknown {
  switch (harness) {
    case 'claude-code': {
      const envelope = JSON.parse(stdout) as { result?: unknown };
      if (typeof envelope.result !== 'string') {
        throw new Error(
          `claude envelope .result must be a JSON string (got ${typeof envelope.result})`,
        );
      }
      return JSON.parse(envelope.result);
    }
    case 'qwen-code':
    case 'gigacode': {
      const records = JSON.parse(stdout) as unknown;
      if (!Array.isArray(records)) {
        throw new Error(`${harness} envelope must be a JSON array (got ${typeof records})`);
      }
      const resultRecord = records.find(
        (r): r is { result?: unknown } =>
          typeof r === 'object' && r !== null && (r as { type?: unknown }).type === 'result',
      );
      if (!resultRecord) {
        throw new Error(`${harness} envelope has no record with type:'result'`);
      }
      if (typeof resultRecord.result !== 'string') {
        throw new Error(
          `${harness} result.result must be a string (got ${typeof resultRecord.result})`,
        );
      }
      return resultRecord.result;
    }
  }
}
