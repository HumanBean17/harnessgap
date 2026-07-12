// Snapshot test: runs runScan (human output) over the fixed corpus and
// snapshots the leaderboard. The snapshot captures the human-readable output
// (header, area table, summary, warnings line) so future scoring or format
// drift updates the snapshot deliberately.
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
});
