// Tests for `initQwen` / `initGigacode` (Task 6): the Qwen Code + GigaCode
// session-end hook installers. Mirrors `init.test.ts` (the Claude installer)
// but asserts the `InitResult` contract from `src/types.ts` rather than the
// Claude-specific `InitClaudeResult` shape.
//
// Branch shipped: VERIFIED. The Qwen Code hook contract is a byte-identical
// Claude Code fork (confirmed from QwenLM/qwen-code docs/source — see the
// header comment in `src/init/qwen.ts`). The Stop event receives
// `transcript_path` + `stop_hook_active` on stdin and expects
// `{decision:'block', reason}` back — identical to Claude's `StopHookOutput`.
// `formatStopHookOutput` is reused as-is; `mergeStopHook` + `buildWrapperSource`
// are shared from `src/init/claude.ts`.
//
// The DEGRADE branch (contract unconfirmable → `{degraded:true, artifacts:[], ...}`)
// is kept visible via `it.todo` so the open question stays in the test record.

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initQwen, initGigacode } from '../src/init/qwen.js';
import { makeTempDir, cleanupTempDirs } from './helpers/builder.js';
import type { InitResult } from '../src/types.js';

afterEach(cleanupTempDirs);

/** Read + parse <cwd>/.qwen/settings.json (throws if missing/invalid). */
function readSettings(cwd: string, root = '.qwen'): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(cwd, root, 'settings.json'), 'utf8'),
  ) as Record<string, unknown>;
}

/** Assert the InitResult shape for the verified branch. */
function assertVerifiedResult(
  r: InitResult,
  cwd: string,
  root: string,
  harnessId: string,
): void {
  expect(r.degraded).toBe(false);
  expect(r.harness).toBe(harnessId);
  expect(r.artifacts.length).toBe(3);
  // Every artifact path is absolute and lives under <cwd>/<root>/.
  for (const p of r.artifacts) {
    expect(p.startsWith(cwd)).toBe(true);
    expect(p.includes(`${root}/`)).toBe(true);
    expect(existsSync(p)).toBe(true);
  }
  expect(typeof r.message).toBe('string');
  expect(r.message.length).toBeGreaterThan(0);
}

describe('initQwen — artifact writes + InitResult', () => {
  it('returns a verified InitResult and writes wrapper/settings/command under <cwd>/.qwen/', () => {
    const cwd = makeTempDir('init-qwen');
    const r = initQwen({ cwd });

    assertVerifiedResult(r, cwd, '.qwen', 'qwen-code');
    // The three artifacts exist at the canonical paths.
    expect(existsSync(join(cwd, '.qwen', 'harnessgap-stop-hook.js'))).toBe(true);
    expect(existsSync(join(cwd, '.qwen', 'settings.json'))).toBe(true);
    expect(existsSync(join(cwd, '.qwen', 'commands', 'reflect.md'))).toBe(true);
  });

  it('settings.json has a hooks.Stop array with one node <wrapper> command entry', () => {
    const cwd = makeTempDir('init-qwen');
    initQwen({ cwd });
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
    // The wrapper path embedded in the command points where we wrote it.
    expect(cmd).toBe(`node ${join(cwd, '.qwen', 'harnessgap-stop-hook.js')}`);
  });

  it('wrapper file embeds the package CLI path and the reflect --format hook-stop spawn', () => {
    const cwd = makeTempDir('init-qwen');
    initQwen({ cwd });
    const src = readFileSync(
      join(cwd, '.qwen', 'harnessgap-stop-hook.js'),
      'utf8',
    );
    // The wrapper spawns the binary's reflect subcommand with hook-stop format.
    expect(src).toContain("'reflect'");
    expect(src).toContain("'--transcript'");
    expect(src).toContain("'--format'");
    expect(src).toContain("'hook-stop'");
    // transcript_path is the stdin field consumed (mirrors Claude's wrapper).
    expect(src).toContain('transcript_path');
    expect(src).toContain('stop_hook_active');
  });

  it('reflect command references QWEN.md (harness memory file)', () => {
    const cwd = makeTempDir('init-qwen');
    initQwen({ cwd });
    const cmd = readFileSync(
      join(cwd, '.qwen', 'commands', 'reflect.md'),
      'utf8',
    );
    expect(cmd).toContain('QWEN.md');
  });
});

describe('initQwen — settings.json merge + idempotency', () => {
  it('preserves an existing user Stop entry and an unrelated top-level key; appends harnessgap', () => {
    const cwd = makeTempDir('init-qwen');
    const userCmd = 'echo user-qwen-hook';
    const seed = {
      model: 'qwen3-coder',
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: userCmd }] }],
      },
    };
    mkdirSync(join(cwd, '.qwen'), { recursive: true });
    writeFileSync(join(cwd, '.qwen', 'settings.json'), JSON.stringify(seed));

    const r = initQwen({ cwd });
    const settings = readSettings(cwd);

    // A valid existing file needs no backup.
    expect(r.settingsBackupPath).toBeUndefined();
    expect(existsSync(join(cwd, '.qwen', 'settings.json.bak'))).toBe(false);
    // Unrelated user key preserved.
    expect(settings.model).toBe('qwen3-coder');
    // Stop array has both the user entry and the harnessgap entry.
    const stop = (settings.hooks as { Stop: { hooks: { command: string }[] }[] }).Stop;
    expect(stop).toHaveLength(2);
    const commands = stop.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toContain(userCmd);
    expect(
      commands.some((c) => c.startsWith('node ') && c.endsWith('harnessgap-stop-hook.js')),
    ).toBe(true);
  });

  it('invalid existing settings.json is backed up verbatim, then replaced with a valid merge', () => {
    const cwd = makeTempDir('init-qwen');
    const invalid = 'not valid json {';
    mkdirSync(join(cwd, '.qwen'), { recursive: true });
    writeFileSync(join(cwd, '.qwen', 'settings.json'), invalid);

    const r = initQwen({ cwd });

    const bakPath = join(cwd, '.qwen', 'settings.json.bak');
    expect(existsSync(bakPath)).toBe(true);
    expect(readFileSync(bakPath, 'utf8')).toBe(invalid);
    expect(r.settingsBackupPath).toBe(bakPath);
    // The new settings.json is valid with exactly one harnessgap Stop entry.
    const stop = (readSettings(cwd).hooks as { Stop: unknown[] }).Stop;
    expect(Array.isArray(stop)).toBe(true);
    expect(stop).toHaveLength(1);
  });

  it('missing settings.json starts fresh with no backup', () => {
    const cwd = makeTempDir('init-qwen');
    const r = initQwen({ cwd });

    expect(r.settingsBackupPath).toBeUndefined();
    expect(existsSync(join(cwd, '.qwen', 'settings.json.bak'))).toBe(false);
    const stop = (readSettings(cwd).hooks as { Stop: unknown[] }).Stop;
    expect(Array.isArray(stop)).toBe(true);
    expect(stop).toHaveLength(1);
  });

  it('re-running initQwen keeps exactly one harnessgap Stop entry (idempotent)', () => {
    const cwd = makeTempDir('init-qwen');
    initQwen({ cwd });
    initQwen({ cwd });
    initQwen({ cwd });

    const stop = (readSettings(cwd).hooks as { Stop: { hooks: { command: string }[] }[] }).Stop;
    const harnessEntries = stop.flatMap((e) =>
      e.hooks.filter((h) => h.command.endsWith('harnessgap-stop-hook.js')),
    );
    expect(harnessEntries).toHaveLength(1);
  });

  it('idempotent re-run still dedupes against a pre-existing user Stop entry', () => {
    const cwd = makeTempDir('init-qwen');
    const userCmd = 'echo user-qwen';
    mkdirSync(join(cwd, '.qwen'), { recursive: true });
    writeFileSync(
      join(cwd, '.qwen', 'settings.json'),
      JSON.stringify({
        hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: userCmd }] }] },
      }),
    );

    initQwen({ cwd });
    initQwen({ cwd });

    const stop = (readSettings(cwd).hooks as { Stop: { hooks: { command: string }[] }[] }).Stop;
    // user entry preserved exactly once, harnessgap entry exactly once → 2 total.
    expect(stop).toHaveLength(2);
    const commands = stop.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands.filter((c) => c === userCmd)).toHaveLength(1);
    expect(commands.filter((c) => c.endsWith('harnessgap-stop-hook.js'))).toHaveLength(1);
  });
});

describe('initGigacode — .gigacode root + GIGACODE.md', () => {
  it('writes under <cwd>/.gigacode/ and returns harness:"gigacode"', () => {
    const cwd = makeTempDir('init-giga');
    const r = initGigacode({ cwd });

    assertVerifiedResult(r, cwd, '.gigacode', 'gigacode');
    expect(existsSync(join(cwd, '.gigacode', 'harnessgap-stop-hook.js'))).toBe(true);
    expect(existsSync(join(cwd, '.gigacode', 'settings.json'))).toBe(true);
    expect(existsSync(join(cwd, '.gigacode', 'commands', 'reflect.md'))).toBe(true);
  });

  it('reflect command references GIGACODE.md (not QWEN.md)', () => {
    const cwd = makeTempDir('init-giga');
    initGigacode({ cwd });
    const cmd = readFileSync(
      join(cwd, '.gigacode', 'commands', 'reflect.md'),
      'utf8',
    );
    expect(cmd).toContain('GIGACODE.md');
  });

  it('settings.json has exactly one harnessgap Stop entry (idempotent)', () => {
    const cwd = makeTempDir('init-giga');
    initGigacode({ cwd });
    initGigacode({ cwd });

    const stop = (readSettings(cwd, '.gigacode').hooks as {
      Stop: { hooks: { command: string }[] }[];
    }).Stop;
    const harnessEntries = stop.flatMap((e) =>
      e.hooks.filter((h) => h.command.endsWith('harnessgap-stop-hook.js')),
    );
    expect(harnessEntries).toHaveLength(1);
  });
});

// The DEGRADE branch is NOT shipped (contract was confirmed — see header).
// Kept as `it.todo` so the fallback contract stays visible if the Qwen hook
// shape is ever re-evaluated and found insufficient.
describe('DEGRADE branch (not shipped — contract confirmed)', () => {
  it.todo('initQwen returns {degraded:true, artifacts:[], message} when contract is unconfirmable');
  it.todo('initGigacode returns {degraded:true, artifacts:[], message} when contract is unconfirmable');
});
