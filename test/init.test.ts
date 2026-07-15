// Tests for `harnessgap init claude` (Task 5): the installer writes three
// artifacts under <cwd>/.claude/ — a fail-open Stop-hook wrapper, an idempotent
// settings.json Stop-array merge, and the /reflect agent-guidance command — and
// the `init` CLI subcommand wires it up. Mirrors the spawn/build pattern from
// cli.reflect.test.ts (dist/ built once in beforeAll) and reuses its fixture
// shapes (TRIP_EVENTS / CLEAN_EVENTS) so the wrapper exercises real detection.
//
// Wrapper fail-open contract under test: any fault (stop_hook_active
// short-circuit, missing/nonexistent transcript, spawn failure, throw) yields
// `{}` + exit 0 — Claude Code must never read a wrapper fault as a block.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initClaude, buildWrapperSource } from '../src/init/claude.js';
import {
  mkSession,
  setupTempRepo,
  makeTempDir,
  cleanupTempDirs,
} from './helpers/builder.js';
import type { EventSpec } from './helpers/builder.js';

// Absolute path to the built CLI. beforeAll builds dist/ first; the wrapper
// embeds this same path so its spawn resolves to a runnable binary.
const CLI_PATH = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

afterEach(cleanupTempDirs);

// Build once before the suite. The wrapper spawns dist/cli.js, so it must exist.
beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { stdio: 'pipe' });
}, 30_000);

// A tripping transcript: 1 edit (1 line) + 3 consecutive failed execs. Mirrors
// cli.reflect.test.ts — failure_streak=3 + inflated wall_clock_per_line_ms →
// flagged; the edit makes zero_edit=false → trip=true.
const TRIP_EVENTS: EventSpec[] = [
  { kind: 'edit', file: 'src/x/a.ts', newString: 'y' },
  { kind: 'exec', cmd: './run.sh', ok: false },
  { kind: 'exec', cmd: './run.sh', ok: false },
  { kind: 'exec', cmd: './run.sh', ok: false },
];

// A clean transcript: one read + one multi-line edit. No signals trip →
// trip=false; hook-stop formatter yields {}.
const CLEAN_EVENTS: EventSpec[] = [
  { kind: 'read', file: 'src/app/main.ts' },
  { kind: 'edit', file: 'src/app/main.ts', newString: 'a\nb\nc' },
];

/** Write a .jsonl transcript into a temp dir backed by a fresh git repo. */
function fixture(events: EventSpec[], stem: string): string {
  const { repo } = setupTempRepo();
  const dir = makeTempDir('init-transcript');
  const file = join(dir, `${stem}.jsonl`);
  writeFileSync(file, mkSession(repo, { name: stem, stepMs: 200_000, events }), 'utf8');
  return file;
}

/** Run the emitted wrapper with the given stdin payload; assert exit 0 always. */
function runWrapper(wrapperPath: string, stdin: string): string {
  // execFileSync throws on non-zero exit; the wrapper is fail-open (always 0),
  // so a throw here is a real contract break worth failing loudly on.
  return execFileSync('node', [wrapperPath], {
    input: stdin,
    encoding: 'utf8',
    maxBuffer: 1e7,
  });
}

/** Spawn the built CLI with given args + optional cwd; resolve stdout/stderr/code. */
function runCli(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'node',
      [CLI_PATH, ...args],
      { maxBuffer: 1e7, cwd: opts.cwd },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

/** Read + parse <cwd>/.claude/settings.json (throws if missing/invalid). */
function readSettings(cwd: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'),
  ) as Record<string, unknown>;
}

describe('initClaude — artifact writes', () => {
  it('writes wrapper, command, and settings.json under <cwd>/.claude/', () => {
    const cwd = makeTempDir('init');
    const { wrapperPath, settingsPath, commandPath } = initClaude({ cwd });

    expect(existsSync(wrapperPath)).toBe(true);
    expect(existsSync(commandPath)).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);
    // Paths are exactly where the brief specifies.
    expect(wrapperPath).toBe(join(cwd, '.claude', 'harnessgap-stop-hook.js'));
    expect(commandPath).toBe(join(cwd, '.claude', 'commands', 'reflect.md'));
    expect(settingsPath).toBe(join(cwd, '.claude', 'settings.json'));
  });

  it('settings.json has a hooks.Stop array with one node <wrapper> command entry', () => {
    const cwd = makeTempDir('init');
    const { wrapperPath } = initClaude({ cwd });
    const settings = readSettings(cwd);

    const hooks = settings.hooks as { Stop: unknown[] } | undefined;
    expect(hooks).toBeDefined();
    expect(Array.isArray(hooks!.Stop)).toBe(true);
    expect(hooks!.Stop).toHaveLength(1);

    const entry = hooks!.Stop[0] as {
      matcher: string;
      hooks: { type: string; command: string }[];
    };
    expect(entry.matcher).toBe('');
    expect(Array.isArray(entry.hooks)).toBe(true);
    expect(entry.hooks).toHaveLength(1);
    const cmd = entry.hooks[0].command;
    expect(cmd.startsWith('node ')).toBe(true);
    expect(cmd.endsWith('harnessgap-stop-hook.js')).toBe(true);
    // The wrapper path embedded in the command is the absolute path we wrote.
    expect(cmd).toBe(`node ${wrapperPath}`);
  });
});

describe('emitted wrapper — fail-open behavior', () => {
  it('stop_hook_active:true → {} and exits 0 (no spawn)', () => {
    const cwd = makeTempDir('init');
    const { wrapperPath } = initClaude({ cwd });
    const out = runWrapper(wrapperPath, JSON.stringify({ stop_hook_active: true }));
    expect(JSON.parse(out)).toEqual({});
  });

  it('stop_hook_active:false + clean transcript → {} (forwards binary trip:false output)', () => {
    const cwd = makeTempDir('init');
    const { wrapperPath } = initClaude({ cwd });
    const transcript = fixture(CLEAN_EVENTS, 'clean');
    const out = runWrapper(
      wrapperPath,
      JSON.stringify({ stop_hook_active: false, transcript_path: transcript }),
    );
    expect(JSON.parse(out)).toEqual({});
  });

  it('stop_hook_active:false + tripping transcript → forwards {decision:"block",reason}', () => {
    const cwd = makeTempDir('init');
    const { wrapperPath } = initClaude({ cwd });
    const transcript = fixture(TRIP_EVENTS, 'trip');
    const out = runWrapper(
      wrapperPath,
      JSON.stringify({ stop_hook_active: false, transcript_path: transcript }),
    );
    const parsed = JSON.parse(out) as { decision?: string; reason?: string };
    expect(parsed.decision).toBe('block');
    expect(typeof parsed.reason).toBe('string');
    expect(parsed.reason!.length).toBeGreaterThan(0);
  });

  it('nonexistent transcript_path → {} (binary errors, wrapper swallows)', () => {
    const cwd = makeTempDir('init');
    const { wrapperPath } = initClaude({ cwd });
    const out = runWrapper(
      wrapperPath,
      JSON.stringify({
        stop_hook_active: false,
        transcript_path: join(cwd, 'does-not-exist.jsonl'),
      }),
    );
    expect(JSON.parse(out)).toEqual({});
  });

  it('missing/unresolvable CLI binary → {} and exits 0 (spawn-result fail-open)', () => {
    // Distinct from the "nonexistent transcript" case above: that exercises the
    // *binary's own* fail-open to {} (the binary runs fine, streamSession fails
    // open). This one bakes a wrapper whose embedded CLI path does not exist, so
    // the spawned `node <bogusCli>` exits non-zero (cannot find the module) and
    // the WRAPPER's spawn-result guard — not the binary — must synthesize {} +
    // exit 0. Discriminating: drop the `else { emit('{}\\n'); }` fail-open (i.e.
    // forward `result.stdout` unconditionally) and the wrapper emits empty stdout
    // instead of {}.
    const tmp = makeTempDir('init-missing-bin');
    const bogusCli = join(tmp, 'no-such-binary.js'); // path does not exist
    const wrapperFile = join(tmp, 'wrapper.js');
    writeFileSync(
      wrapperFile,
      buildWrapperSource({ cliPath: bogusCli }),
      'utf8',
    );

    const out = runWrapper(
      wrapperFile,
      JSON.stringify({ stop_hook_active: false, transcript_path: '/any.jsonl' }),
    );
    expect(JSON.parse(out)).toEqual({});
  });

  it('missing transcript_path field → {} (no spawn)', () => {
    const cwd = makeTempDir('init');
    const { wrapperPath } = initClaude({ cwd });
    const out = runWrapper(wrapperPath, JSON.stringify({ stop_hook_active: false }));
    expect(JSON.parse(out)).toEqual({});
  });

  it('malformed stdin → {} (top-level try/catch fail-open)', () => {
    const cwd = makeTempDir('init');
    const { wrapperPath } = initClaude({ cwd });
    const out = runWrapper(wrapperPath, 'this is not json');
    expect(JSON.parse(out)).toEqual({});
  });
});

describe('initClaude — settings.json merge + idempotency', () => {
  it('preserves an existing user Stop entry and an unrelated top-level key; appends harnessgap', () => {
    const cwd = makeTempDir('init');
    const userCmd = 'echo user-stop-hook';
    const seed = {
      permissions: { allow: ['Bash(npm:*)'] },
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: userCmd }] }],
      },
    };
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify(seed));

    initClaude({ cwd });
    const settings = readSettings(cwd);

    // Unrelated key preserved.
    expect(settings.permissions).toEqual({ allow: ['Bash(npm:*)'] });
    // Stop array has both the user entry and the harnessgap entry.
    const stop = (settings.hooks as { Stop: { hooks: { command: string }[] }[] }).Stop;
    expect(stop).toHaveLength(2);
    const commands = stop.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toContain(userCmd);
    expect(commands.some((c) => c.startsWith('node ') && c.endsWith('harnessgap-stop-hook.js'))).toBe(true);
  });

  it('invalid existing settings.json is replaced with a valid merge (does not throw)', () => {
    const cwd = makeTempDir('init');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.json'), 'not valid json {');

    expect(() => initClaude({ cwd })).not.toThrow();
    const settings = readSettings(cwd);
    const stop = (settings.hooks as { Stop: unknown[] }).Stop;
    expect(Array.isArray(stop)).toBe(true);
    expect(stop).toHaveLength(1);
  });

  it('re-running initClaude keeps exactly one harnessgap Stop entry (idempotent)', () => {
    const cwd = makeTempDir('init');
    initClaude({ cwd });
    initClaude({ cwd });
    initClaude({ cwd });

    const settings = readSettings(cwd);
    const stop = (settings.hooks as { Stop: { hooks: { command: string }[] }[] }).Stop;
    const harnessEntries = stop.flatMap((e) =>
      e.hooks.filter((h) => h.command.endsWith('harnessgap-stop-hook.js')),
    );
    expect(harnessEntries).toHaveLength(1);
  });

  it('idempotent re-run still dedupes against a pre-existing user Stop entry', () => {
    const cwd = makeTempDir('init');
    const userCmd = 'echo user';
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: userCmd }] }] },
      }),
    );

    initClaude({ cwd });
    initClaude({ cwd });

    const stop = (readSettings(cwd).hooks as { Stop: { hooks: { command: string }[] }[] }).Stop;
    // user entry preserved exactly once, harnessgap entry exactly once → 2 total.
    expect(stop).toHaveLength(2);
    const commands = stop.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands.filter((c) => c === userCmd)).toHaveLength(1);
    expect(commands.filter((c) => c.endsWith('harnessgap-stop-hook.js'))).toHaveLength(1);
  });
});

describe('init CLI subcommand', () => {
  it('--help mentions init', async () => {
    const { stdout, code } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('init');
  });

  it('init claude writes the three artifacts into the cwd and exits 0', async () => {
    const cwd = makeTempDir('init-cli');
    const { code, stdout } = await runCli(['init', 'claude'], { cwd });

    expect(code).toBe(0);
    expect(stdout).toContain('harnessgap-stop-hook.js');
    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(cwd, '.claude', 'harnessgap-stop-hook.js'))).toBe(true);
    expect(existsSync(join(cwd, '.claude', 'commands', 'reflect.md'))).toBe(true);
  });

  it('init <unknown> → non-zero exit, stderr mentions the agent', async () => {
    const { stderr, code } = await runCli(['init', 'cursor']);
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
