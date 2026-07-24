// Packaging audit: locks the package.json shape and confirms the runtime
// dependency tree is exactly `commander` + `yaml` — both no-egress per the
// §11 audit. `npm ls` is run via execFile with no shell (never a command
// string); stderr warnings are ignored, only stdout JSON is parsed.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

const pkgUrl = fileURLToPath(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as {
  name: string;
  version: string;
  description: string;
  bin?: Record<string, string>;
  engines?: { node?: string };
  files?: string[];
};

describe('packaging (package.json + runtime dep tree)', () => {
  it('bin.harnessgap points at dist/cli.js', () => {
    expect(pkg.bin?.harnessgap).toBe('dist/cli.js');
  });

  it('engines.node declares a floor of >= 22.12 (commander@15 requirement)', () => {
    const range = pkg.engines?.node;
    expect(typeof range).toBe('string');
    const m = /^>=(\d+)(?:\.(\d+))?/.exec(range as string);
    expect(m).not.toBeNull();
    const major = Number(m![1]);
    const minor = Number(m![2] ?? 0);
    // commander@15.0.0 requires Node >= 22.12.0; floor must be at least 22.12
    const floorMinor = major * 100 + minor;
    expect(floorMinor).toBeGreaterThanOrEqual(2212);
  });

  it('files includes dist', () => {
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain('dist');
  });

  it('runtime dependencies are exactly commander + yaml (no others)', async () => {
    const { stdout } = await execFileP(
      'npm',
      ['ls', '--all', '--omit=dev', '--json'],
      { shell: false },
    );
    const tree = JSON.parse(stdout) as {
      dependencies?: Record<string, unknown>;
    };
    const deps = tree.dependencies ?? {};
    // Exclude the package itself: dogfooding the CLI (`npm install -g .` /
    // `npm link` from this repo) leaves an extraneous `node_modules/harnessgap`
    // copy that `npm ls` reports as a top-level dependency. That is a local dev
    // artifact, not a runtime/egress dependency — this audit guards against
    // third-party deps the shipped package pulls in, so a self-entry is filtered
    // out. A real undeclared dep (e.g. `axios`) is NOT the package name and is
    // still caught here.
    const runtimeDeps = Object.keys(deps).filter((k) => k !== pkg.name).sort();
    expect(runtimeDeps).toEqual(['commander', 'yaml']);
  });
});
