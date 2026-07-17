// Snapshot tests: runs runScan (human output) over the fixed corpus and
// snapshots the leaderboard. The snapshot captures the human-readable output
// (header, area table, summary, warnings line) so future scoring or format
// drift updates the snapshot deliberately.
//
// Two snapshots are locked:
//   (1) DEFAULT scan — byte-identical invariant carried over from Slice 1/2/3.
//       The original test case is preserved verbatim so its snapshot key in
//       `snapshot.test.ts.snap` stays byte-identical (no `-u` needed there).
//   (2) `scan --diagnose` — locks the new CAUSE column added in Slice 4. A new
//       snapshot entry is written under a separate key alongside the original.
//
// The temp repo path is normalized to <REPO> before snapshotting (it changes
// per run but does not affect the leaderboard content). Everything else
// (session count, mode, areas, signals, warnings) is deterministic given the
// fixed corpus.

import { describe, it, expect, afterEach } from 'vitest';
import { runScan } from '../src/pipeline.js';
import {
  setupTempRepo,
  writeTranscript,
  mkSession,
  cleanupTempDirs,
} from './helpers/builder.js';
import { corpusSlug, corpusSessions } from './fixtures/corpus/sessions.js';

afterEach(cleanupTempDirs);

describe('snapshot: human leaderboard over fixed corpus', () => {
  it('matches the committed snapshot', async () => {
    const { repo, claudeDir } = setupTempRepo();
    for (const spec of corpusSessions) {
      writeTranscript(claudeDir, corpusSlug, spec.name, mkSession(repo, spec));
    }

    const result = await runScan({ repo, claudeDir });

    // Normalize the temp repo path (changes per run) to a stable placeholder.
    const normalized = result.output.replaceAll(repo, '<REPO>');

    expect(normalized).toMatchSnapshot();
  });

  it('scan --diagnose matches the committed snapshot (CAUSE column locked)', async () => {
    const { repo, claudeDir } = setupTempRepo();
    for (const spec of corpusSessions) {
      writeTranscript(claudeDir, corpusSlug, spec.name, mkSession(repo, spec));
    }

    const result = await runScan({ repo, claudeDir, diagnose: true });

    // Same path normalization as the default case — the temp repo path is the
    // only run-to-run variable. The CAUSE column is rendered by formatHuman
    // when at least one Diagnosis is produced (7 flagged areas → 7 diagnoses).
    const normalized = result.output.replaceAll(repo, '<REPO>');

    expect(normalized).toMatchSnapshot();
  });
});
