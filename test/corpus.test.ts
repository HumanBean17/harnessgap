// Corpus regression test: runs runScan over the labeled fixture corpus and
// asserts each session's `flagged` matches its label. Also checks that
// expected_top_signals are a subset of the flagged area's actual top_signals.
//
// Pass bar: ≥80% of fixtures must match expected_flagged (≥10 of 12). This bar
// gives latitude for v1-raw signal ranking while catching regressions. Failures
// are listed by file with expected vs actual.
//
// The corpus doubles as the seed for later percentile bootstrapping. All 12
// sessions run through the REAL pipeline (real filesystem, real git, real
// streaming, real detection) — no mocking.

import { describe, it, expect, afterEach } from 'vitest';
import { runScan } from '../src/pipeline.js';
import type { JsonOutput, SignalName } from '../src/types.js';
import {
  setupTempRepo,
  writeTranscript,
  mkSession,
  cleanupTempDirs,
} from './helpers/builder.js';
import { corpusSlug, corpusSessions, corpusLabels } from './fixtures/corpus/sessions.js';

afterEach(cleanupTempDirs);

/** Write all corpus transcripts to a temp claudeDir and run a --json scan. */
async function scanCorpus(): Promise<JsonOutput> {
  const { repo, claudeDir } = setupTempRepo();
  for (const spec of corpusSessions) {
    writeTranscript(claudeDir, corpusSlug, spec.name, mkSession(repo, spec));
  }
  const result = await runScan({ repo, claudeDir, json: true });
  return JSON.parse(result.output) as JsonOutput;
}

describe('corpus regression (labeled fixture corpus)', () => {
  it('all 12 sessions scanned (sessionCount === 12, mode === bootstrap)', async () => {
    const parsed = await scanCorpus();
    expect(parsed.session_count).toBe(12);
    expect(parsed.mode).toBe('bootstrap');
  });

  it('≥80% of fixtures match expected_flagged (pass bar: ≥10 of 12)', async () => {
    const parsed = await scanCorpus();

    // Build a lookup: session_id (filename stem) → StruggleRecord.
    const byId = new Map(parsed.sessions.map((s) => [s.session_id, s]));

    const failures: string[] = [];
    let matches = 0;

    for (const label of corpusLabels) {
      const rec = byId.get(label.file);
      if (!rec) {
        failures.push(`  ${label.file}: MISSING from scan output`);
        continue;
      }
      if (rec.flagged === label.expected_flagged) {
        matches += 1;
      } else {
        failures.push(
          `  ${label.file}: expected flagged=${label.expected_flagged}, got flagged=${rec.flagged}`,
        );
      }
    }

    // Pass bar: ≥10 of 12 (80%).
    const passBar = Math.ceil(corpusLabels.length * 0.8);
    expect(
      matches,
      `corpus match rate ${matches}/${corpusLabels.length} (bar: ≥${passBar})\nFailures:\n${failures.join('\n')}`,
    ).toBeGreaterThanOrEqual(passBar);

    // If all match, log that for visibility (no assertion needed beyond the bar).
    if (matches === corpusLabels.length) {
      expect(true).toBe(true); // all matched
    }
  });

  it('expected_top_signals are a subset of the flagged area\'s top_signals', async () => {
    const parsed = await scanCorpus();

    // Build area lookup: area key → AreaRow.
    const areaByKey = new Map(parsed.areas.map((a) => [a.key, a]));

    for (const label of corpusLabels) {
      if (!label.expected_flagged) continue;
      if (label.expected_top_signals.length === 0) continue;

      // Find the session to get its areas.
      const rec = parsed.sessions.find((s) => s.session_id === label.file);
      expect(rec, `session ${label.file} not found`).toBeDefined();
      if (!rec) continue;

      // The session's first area is its primary area.
      const areaKey = rec.areas[0]?.key;
      expect(areaKey, `session ${label.file} has no area`).toBeDefined();
      if (!areaKey) continue;

      const area = areaByKey.get(areaKey);
      expect(area, `area ${areaKey} not found in leaderboard`).toBeDefined();
      if (!area) continue;

      // expected_top_signals must be a SUBSET of the area's top_signal names.
      const actualNames = new Set(area.top_signals.map((s) => s.name as string));
      for (const expected of label.expected_top_signals as SignalName[]) {
        expect(
          actualNames.has(expected),
          `session ${label.file}: expected top_signal "${expected}" not in area ${areaKey} top_signals (got: ${[...actualNames].join(', ')})`,
        ).toBe(true);
      }
    }
  });
});
