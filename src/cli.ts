#!/usr/bin/env node
// Stateless CLI bin entry for harnessgap. Parses args with commander, awaits
// runScan, writes result.output to stdout, and exits with result.exitCode.
// ConfigError (and any thrown error from runScan) is caught → a SHORT message
// to stderr (no stack, no transcript paths), exit 1.
//
// Constraints (§11 egress): no network imports. Imports limited to commander,
// ./pipeline.js, ./config.js, node:process, node:fs. The package.json version
// is read at runtime via fs + URL (no JSON import attribute, no node:path
// needed). No disk writes beyond what runScan performs (none).
//
// Qwen+GigaCode slice Task 9: the `scan`/`reflect` commands gain
// `--harness <id>` (choices claude-code|qwen-code|gigacode) and
// `--harness-dir <path>`. The legacy `--claude-dir <path>` is RETAINED as a
// deprecated alias = `--harness claude-code --harness-dir <path>`; passing it
// alongside `--harness qwen-code|gigacode` is a hard conflict (exit non-zero).
// Harness resolution precedence for scan: --harness flag → config.harness →
// 'claude-code'. The resolved `{ harness, harnessDir }` is threaded into
// runScan/runReflect as new optional fields; Task 10 wires the actual spec
// dispatch (chats/ discovery + qwen streamSession).
//
// `init <agent>` is widened from claude-only to claude | qwen | gigacode and
// now routes through `resolveHarness(id).installHook({cwd})` so the install
// lands under .claude/ / .qwen/ / .gigacode/ respectively. `init claude`
// remains behaviorally identical (artifacts + paths unchanged).

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { runScan, type ScanOptions, runReflect, type ReflectOptions } from './pipeline.js';
import { ConfigError, loadConfig } from './config.js';
import { resolveHarness } from './adapter/index.js';
import type { HarnessId, InitResult } from './types.js';

// Resolve package.json relative to this module so the version is correct
// whether run from dist/cli.js or via the installed bin symlink. URL-based
// path avoids importing node:path / node:url.
const pkgUrl = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version: string };

/** The closed set of harness backends the CLI accepts on `--harness`. */
const HARNESS_CHOICES: readonly HarnessId[] = ['claude-code', 'qwen-code', 'gigacode'];

/**
 * `init <agent>` arg → HarnessId. Each agent name maps to exactly one harness
 * backend; an unknown arg is rejected by the action with a clear error.
 */
const AGENT_TO_HARNESS: Readonly<Record<string, HarnessId>> = {
  claude: 'claude-code',
  qwen: 'qwen-code',
  gigacode: 'gigacode',
};

/** The parsed option shape commander hands to the scan action. */
interface ScanOpts {
  repo?: string;
  since?: string;
  limit?: number;
  json?: boolean;
  calibrate?: boolean;
  bootstrap?: boolean;
  diagnose?: boolean;
  config?: string;
  claudeDir?: string;
  harness?: string;
  harnessDir?: string;
}

/** The parsed option shape commander hands to the reflect action. */
interface ReflectOpts {
  transcript?: string;
  latest?: boolean;
  session?: string;
  repo?: string;
  excludeSession?: string;
  stopHookActive?: boolean;
  format?: 'json' | 'hook-stop';
  config?: string;
  claudeDir?: string;
  harness?: string;
  harnessDir?: string;
}

/**
 * Validate `--harness` against the closed HarnessId set and enforce the
 * `--claude-dir` conflict rule (the alias implies claude-code, so combining
 * it with a non-claude `--harness` is a hard error). Returns the validated
 * flag value (or `undefined` when no flag was passed). Shared by scan + reflect.
 *
 * Dir resolution: `--harness-dir` wins, else `--claude-dir` (the alias).
 *
 * Throws ConfigError on conflict or unknown harness id — the caller surfaces
 * it via the standard stderr+exit-1 path.
 */
function validateHarnessFlags(
  harnessFlag: string | undefined,
  harnessDir: string | undefined,
  claudeDir: string | undefined,
): { harness: HarnessId | undefined; harnessDir: string | undefined } {
  // Conflict: --claude-dir is an alias for --harness claude-code --harness-dir;
  // combining it with a non-claude --harness asks for two different harnesses.
  if (
    claudeDir !== undefined &&
    harnessFlag !== undefined &&
    harnessFlag !== 'claude-code'
  ) {
    throw new ConfigError(
      `conflict: --claude-dir cannot be combined with --harness ${harnessFlag} (use --harness ${harnessFlag} --harness-dir <path>)`,
    );
  }

  // Defensive: validate the flag value against the closed HarnessId set. The
  // help text lists the choices, but commander does not enforce them at parse
  // time, so a bad value reaches the action; turn it into a clear error here
  // rather than a silent fall-through or a downstream resolveHarness throw.
  if (
    harnessFlag !== undefined &&
    !HARNESS_CHOICES.includes(harnessFlag as HarnessId)
  ) {
    throw new ConfigError(
      `Unknown harness id: ${harnessFlag}. Supported: ${HARNESS_CHOICES.join(', ')}.`,
    );
  }

  return {
    harness: harnessFlag as HarnessId | undefined,
    harnessDir: harnessDir ?? claudeDir,
  };
}

/**
 * Qwen+GigaCode slice Task 9: resolve the harness id + dir per the documented
 * precedence for `scan`. Precedence for the harness id: `--harness` flag →
 * (implicit claude-code when `--claude-dir` is passed without a flag) →
 * `config.harness` → `'claude-code'` (the last is belt-and-suspenders;
 * `cfg.harness` is always populated by `loadConfig` via `DEFAULT_CONFIG`).
 * `--claude-dir` does NOT count as a harness flag for the conflict rule
 * (validateHarnessFlags enforces that), but it DOES imply claude-code for
 * resolution: a user running `scan --claude-dir /path` while their config
 * says `harness: qwen-code` almost certainly wants the Claude layout at that
 * dir, not a Qwen dispatch that finds 0 `chats/` sessions and exits 0 with
 * an empty leaderboard (silent failure). An explicit `--harness` always wins.
 */
function resolveHarnessForCommand(
  harnessFlag: string | undefined,
  harnessDir: string | undefined,
  claudeDir: string | undefined,
  cfgHarness: HarnessId,
): { harness: HarnessId; harnessDir: string | undefined } {
  const { harness, harnessDir: resolvedDir } = validateHarnessFlags(
    harnessFlag,
    harnessDir,
    claudeDir,
  );
  return {
    harness: harness ?? (claudeDir !== undefined ? 'claude-code' : cfgHarness),
    harnessDir: resolvedDir,
  };
}

/**
 * `reflect` target flags: `--session` is mutually exclusive with `--transcript`
 * and `--latest` (three different ways to pick the one session). We only guard
 * conflicts involving `--session` — the pre-existing `--transcript`/`--latest`
 * pair keeps its lenient "transcript wins" behavior unchanged. Throws
 * ConfigError so the conflict surfaces via the standard stderr+exit-1 path.
 */
function validateReflectTargetFlags(
  session: string | undefined,
  transcript: string | undefined,
  latest: boolean | undefined,
): void {
  if (session === undefined) return;
  if (transcript !== undefined) {
    throw new ConfigError(
      'conflict: --session cannot be combined with --transcript (pick one)',
    );
  }
  if (latest) {
    throw new ConfigError(
      'conflict: --session cannot be combined with --latest (pick one)',
    );
  }
}

const program = new Command();

program
  .name('harnessgap')
  .description('Stateless detection-only CLI for harness gaps')
  .version(pkg.version);

program
  .command('scan', { isDefault: true })
  .description('Scan agent transcripts (Claude Code / Qwen Code / GigaCode) for harness gaps')
  .option('--repo <path>', 'filter to a specific repo toplevel')
  .option('--since <dur>', 'only sessions within this lookback (e.g. 30d, 12h)')
  .option(
    '--limit <n>',
    'cap the number of sessions',
    (v: string) => Number.parseInt(v, 10),
  )
  .option('--json', 'emit the JSON envelope instead of a human table')
  .option('--calibrate', 'emit the calibrate signal view')
  .option('--bootstrap', 'force bootstrap scoring mode')
  .option(
    '--diagnose',
    'Classify each flagged area into a typed cause (doc/config-doc/test-gap/refactor-flag/inherent-complexity). Reads docs/ for grounding.',
  )
  .option('--config <path>', 'path to a .harnessgap.yml config file')
  .option(
    '--harness <id>',
    'harness backend to scan (claude-code | qwen-code | gigacode)',
    undefined,
  )
  .option('--harness-dir <path>', 'harness config directory (contains projects/)')
  .option(
    '--claude-dir <path>',
    '[deprecated alias for --harness claude-code --harness-dir <path>] Claude Code config directory',
  )
  .action(async (opts: ScanOpts) => {
    try {
      // Load config early to resolve harness precedence (flag → config → default).
      // runScan re-loads the same config (same path); the duplicate read is
      // bounded and keeps the pipeline's loadConfig contract unchanged.
      const cfg = loadConfig(opts.config);
      const { harness, harnessDir } = resolveHarnessForCommand(
        opts.harness,
        opts.harnessDir,
        opts.claudeDir,
        cfg.harness,
      );

      // Thread the resolved harness through to runScan. claudeDir is also set
      // (from whichever dir flag was used) so the legacy discovery path uses
      // the right root regardless of which flag the user passed. Task 10
      // consumes `harness` + `harnessDir` to dispatch through the spec.
      const scanOpts: ScanOptions = {
        repo: opts.repo,
        since: opts.since,
        limit: opts.limit,
        json: opts.json,
        calibrate: opts.calibrate,
        bootstrap: opts.bootstrap,
        diagnose: opts.diagnose,
        configPath: opts.config,
        claudeDir: opts.claudeDir ?? opts.harnessDir,
        harness,
        harnessDir,
      };
      const result = await runScan(scanOpts);
      // Write then exit in the flush callback so piped stdout is never
      // truncated by process.exit.
      process.stdout.write(result.output + '\n', () =>
        process.exit(result.exitCode),
      );
    } catch (e) {
      // ConfigError carries a clean human message; any other thrown error is
      // surfaced by message only — never the stack.
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`error: ${msg}\n`, () => process.exit(1));
    }
  });

program
  .command('reflect')
  .description('Reflect on a single session (session-end n=1 detection)')
  .option('--transcript <path>', 'reflect on one given transcript file')
  .option('--latest', 'reflect on the most-recent session for --repo')
  .option(
    '--session <id>',
    'reflect on the session whose id matches a transcript filename stem',
  )
  .option('--repo <path>', 'target repo toplevel (used with --latest)')
  .option('--exclude-session <id>', 'exclude a session id (used with --latest)')
  .option('--stop-hook-active', 'the Claude Code Stop hook is already active')
  .option(
    '--format <json|hook-stop>',
    'output form: the json finding or the Stop hook payload',
    'json',
  )
  .option('--config <path>', 'path to a .harnessgap.yml config file')
  .option(
    '--harness <id>',
    'harness backend to reflect (claude-code | qwen-code | gigacode)',
    undefined,
  )
  .option('--harness-dir <path>', 'harness config directory (contains projects/)')
  .option(
    '--claude-dir <path>',
    '[deprecated alias for --harness claude-code --harness-dir <path>] Claude Code config directory',
  )
  .action(async (opts: ReflectOpts) => {
    try {
      // Task 11: --harness flag wins; otherwise the pipeline sniffs the
      // transcript file's shape (qwen gemini parts/functionCall vs claude
      // content/tool_use) and auto-detects. Config `harness:` is NOT applied
      // here for reflect — for --transcript the file is authoritative (the
      // sniff runs inside runReflect); for --latest the pipeline falls back
      // to cfg.harness itself (no single file to sniff). validateHarnessFlags
      // still enforces the choice + the --claude-dir conflict before we
      // dispatch, so user errors surface here with the same stderr+exit-1
      // path as scan.
      loadConfig(opts.config);
      const { harness, harnessDir } = validateHarnessFlags(
        opts.harness,
        opts.harnessDir,
        opts.claudeDir,
      );
      // --session is a third target mode (besides --transcript / --latest);
      // enforce mutual exclusion up front so conflicting picks fail fast here
      // rather than as a silent precedence win inside runReflect.
      validateReflectTargetFlags(opts.session, opts.transcript, opts.latest);

      const reflectOpts: ReflectOptions = {
        transcript: opts.transcript,
        latest: opts.latest,
        session: opts.session,
        repo: opts.repo,
        excludeSession: opts.excludeSession,
        stopHookActive: opts.stopHookActive,
        format: opts.format,
        configPath: opts.config,
        claudeDir: opts.claudeDir ?? opts.harnessDir,
        harness,
        harnessDir,
      };
      const result = await runReflect(reflectOpts);
      // Write then exit in the flush callback so piped stdout is never
      // truncated by process.exit.
      process.stdout.write(result.output + '\n', () =>
        process.exit(result.exitCode),
      );
    } catch (e) {
      // Only arg/config errors throw (runReflect fails open otherwise); surface
      // by message only — never the stack.
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`error: ${msg}\n`, () => process.exit(1));
    }
  });

program
  .command('init <agent>')
  .description('Install the harnessgap Stop hook + /reflect command for an agent')
  .action((agent: string) => {
    // Qwen+GigaCode slice Task 9: widen from claude-only to claude | qwen |
    // gigacode. Each agent maps to a HarnessId, resolves the spec, and calls
    // spec.installHook({cwd}) — the spec's installHook handles the per-harness
    // artifact layout (.claude/ vs .qwen/ vs .gigacode/) and returns the
    // harness-agnostic InitResult contract.
    const harnessId = AGENT_TO_HARNESS[agent];
    if (harnessId === undefined) {
      process.stderr.write(
        `error: unsupported agent '${agent}'. Supported: claude, qwen, gigacode.\n`,
        () => process.exit(1),
      );
      return;
    }
    try {
      const spec = resolveHarness(harnessId);
      const result: InitResult = spec.installHook({ cwd: process.cwd() });
      const writeSuccess = () =>
        process.stdout.write(result.message + '\n', () => process.exit(0));
      if (result.settingsBackupPath) {
        // An existing settings.json was unparseable and got backed up before the
        // fresh Stop entry was written — surface it so the user can recover.
        // Written in a flush callback so the warning is never lost to exit.
        process.stderr.write(
          `warning: settings.json was invalid JSON — backed up to ${result.settingsBackupPath} before installing the hook\n`,
          () => writeSuccess(),
        );
      } else {
        writeSuccess();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`error: ${msg}\n`, () => process.exit(1));
    }
  });

// parseAsync returns a promise; the action handles its own errors + exit, so
// this .catch is a defensive net for anything commander itself rejects (e.g.
// unknown options — commander prints its own message and exits non-zero there).
program.parseAsync(process.argv).catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`error: ${msg}\n`, () => process.exit(1));
});
