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

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { runScan, type ScanOptions } from './pipeline.js';
import { ConfigError } from './config.js';

// Resolve package.json relative to this module so the version is correct
// whether run from dist/cli.js or via the installed bin symlink. URL-based
// path avoids importing node:path / node:url.
const pkgUrl = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version: string };

/** The parsed option shape commander hands to the scan action. */
interface ScanOpts {
  repo?: string;
  since?: string;
  limit?: number;
  json?: boolean;
  calibrate?: boolean;
  bootstrap?: boolean;
  config?: string;
  claudeDir?: string;
}

const program = new Command();

program
  .name('harnessgap')
  .description('Stateless detection-only CLI for harness gaps')
  .version(pkg.version);

program
  .command('scan', { isDefault: true })
  .description('Scan Claude Code transcripts for harness gaps')
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
  .option('--config <path>', 'path to a .harnessgap.yml config file')
  .option('--claude-dir <path>', 'Claude Code config directory (contains projects/)')
  .action(async (opts: ScanOpts) => {
    const scanOpts: ScanOptions = {
      repo: opts.repo,
      since: opts.since,
      limit: opts.limit,
      json: opts.json,
      calibrate: opts.calibrate,
      bootstrap: opts.bootstrap,
      configPath: opts.config,
      claudeDir: opts.claudeDir,
    };
    try {
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

// parseAsync returns a promise; the action handles its own errors + exit, so
// this .catch is a defensive net for anything commander itself rejects (e.g.
// unknown options — commander prints its own message and exits non-zero there).
program.parseAsync(process.argv).catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`error: ${msg}\n`, () => process.exit(1));
});
