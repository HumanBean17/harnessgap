// Two-repo-class calibration gate (Task 10). Encodes the spec's success
// criterion as an automated gate: the ambient finding must FIRE on an
// unharnessed repo, stay SILENT on a well-harnessed repo, and be STABLE under
// ±20% floor perturbation on a brownfield-shaped repo.
//
// Three fixture sets live in test/fixtures/baseline/sessions.ts. Each is
// scanned end-to-end with runScan({ repo, claudeDir, json: true }) — the same
// pipeline the real CLI uses — and the parsed `repo_findings` are asserted on.
//
// TEST-ONLY: this file never tunes `assessAmbient` logic or DEFAULT_CONFIG
// floors to make a gate pass. If a gate fails on a correct implementation, the
// FIXTURE values are what gets adjusted.

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { runScan } from '../src/pipeline.js';
import type { JsonOutput } from '../src/types.js';
import {
  setupTempRepo,
  writeTranscript,
  mkSession,
  makeTempDir,
  cleanupTempDirs,
  type SessionSpec,
} from './helpers/builder.js';
import {
  unharnessedSlug,
  unharnessedSessions,
  harnessedSlug,
  harnessedSessions,
  brownfieldSlug,
  brownfieldSessions,
  brownfieldWithEditOnlySlug,
  brownfieldWithEditSessions,
} from './fixtures/baseline/sessions.js';

afterEach(cleanupTempDirs);

// Helper: write a full fixture set under one slug, scan it, return parsed JSON.
async function scanFixture(
  slug: string,
  sessions: SessionSpec[],
  configPath?: string,
): Promise<JsonOutput> {
  const { repo, claudeDir } = setupTempRepo();
  for (const spec of sessions) {
    writeTranscript(claudeDir, slug, spec.name, mkSession(repo, spec));
  }
  const result = await runScan({ repo, claudeDir, json: true, configPath });
  return JSON.parse(result.output) as JsonOutput;
}

// --- 1. Unharnessed repo: finding FIRES (severity high/medium, orientation) --

describe('baseline gate (1): unharnessed repo FIRES', () => {
  it('fires exactly one finding, severity high/medium, paths includes orientation', async () => {
    const parsed = await scanFixture(unharnessedSlug, unharnessedSessions);

    // Exactly one repo finding (the ambient elevated-baseline finding).
    expect(
      parsed.repo_findings.length,
      'unharnessed set must trip exactly one repo finding',
    ).toBe(1);

    const finding = parsed.repo_findings[0]!;

    // n=20 ≥ severity_min_sessions=20 → not 'unrated'. orientationRatio =
    // max(6/4, 6/12) = 1.5 ≥ 1.5 → 'high'.
    expect(
      ['high', 'medium'],
      `severity must escape 'unrated' (n=20); got ${finding.severity}`,
    ).toContain(finding.severity);

    // Orientation path is what fires (median dirBreadth=6 ≥ breadth_floor=4).
    expect(
      finding.paths,
      "paths must include 'orientation'",
    ).toContain('orientation');
  });
});

// --- 2. Well-harnessed repo: SILENT (no findings) --------------------------

describe('baseline gate (2): well-harnessed repo stays SILENT', () => {
  it('emits zero repo_findings (tight orientation, below all floors)', async () => {
    const parsed = await scanFixture(harnessedSlug, harnessedSessions);

    // Per-session dirBreadth=1 (< 4), fileDepth=2 (< 12) → orientation cold.
    // Each session has 2 reads + 1 edit, no bootstrap signal trips → acute cold.
    // n=10 ≥ min_sessions=10 → state='within-norms', finding=null.
    expect(
      parsed.repo_findings.length,
      'harnessed set must not trip any finding',
    ).toBe(0);
  });
});

// --- 3. Brownfield-shaped: FIRES STABLY under perturbation -----------------

describe('baseline gate (3): brownfield repo FIRES stably', () => {
  // (a) Deterministic: two runScan runs produce identical repo_findings.
  it('(a) deterministic — two runs produce identical repo_findings', async () => {
    const run1 = await scanFixture(brownfieldSlug, brownfieldSessions);
    const run2 = await scanFixture(brownfieldSlug, brownfieldSessions);

    // Must fire in both runs.
    expect(
      run1.repo_findings.length,
      'brownfield set must trip a finding (run 1)',
    ).toBe(1);
    expect(
      run2.repo_findings.length,
      'brownfield set must trip a finding (run 2)',
    ).toBe(1);

    // Identical serialized form (stable severity, paths, orientation, acute).
    expect(
      JSON.stringify(run1.repo_findings),
      'two runs must produce identical repo_findings',
    ).toBe(JSON.stringify(run2.repo_findings));
  });

  // (b) Zero-edit-neutral: dropping the 6 zero-edit sessions yields the SAME
  //     fire/no-fire decision (the median is computed over with-edit sessions
  //     only, so zero-edit sessions cannot move it).
  it('(b) zero-edit-neutral — with-edit-only fires the same as full set', async () => {
    const fullRun = await scanFixture(brownfieldSlug, brownfieldSessions);
    const withEditOnlyRun = await scanFixture(
      brownfieldWithEditOnlySlug,
      brownfieldWithEditSessions,
    );

    // Both must fire (the median over the 10 with-edit sessions is unaffected
    // by the presence of the 6 zero-edit sessions).
    expect(
      fullRun.repo_findings.length,
      'full brownfield set must fire',
    ).toBe(1);
    expect(
      withEditOnlyRun.repo_findings.length,
      'with-edit-only brownfield set must fire (zero-edit sessions do not carry the finding)',
    ).toBe(1);

    // Both findings fire via the orientation path (median dirBreadth=6 ≥ 4).
    expect(fullRun.repo_findings[0]!.paths).toContain('orientation');
    expect(withEditOnlyRun.repo_findings[0]!.paths).toContain('orientation');
  });

  // (c) ±20% stability: perturb file_depth_floor 12 → 10 (×0.8) and → 14
  //     (×1.2); the fire/no-fire outcome must not flip. breadth_floor=4 ± 20%
  //     is a no-op (Math.ceil(4*0.8)=Math.floor(4*1.2)=4), so the load-bearing
  //     perturbation is file_depth_floor. The finding is carried by the BREADTH
  //     path (median dirBreadth=6 ≥ breadth_floor=4 at every perturbation),
  //     which keeps firing regardless of file_depth_floor — stable.
  it('(c) ±20% stability — file_depth_floor 10/14 does not flip the outcome', async () => {
    // Helper: write a YAML override and return its path.
    const writeConfig = (fileDepthFloor: number): string => {
      const dir = makeTempDir('cfg');
      const yaml = `detector:\n  ambient:\n    file_depth_floor: ${fileDepthFloor}\n`;
      const path = `${dir}/.harnessgap.yml`;
      writeFileSync(path, yaml, 'utf8');
      return path;
    };

    // Baseline floor 12 (default), -20% → 10, +20% → 14.
    const floors = [
      { label: 'default(12)', fileDepthFloor: 12 },
      { label: '-20%(10)', fileDepthFloor: 10 },
      { label: '+20%(14)', fileDepthFloor: 14 },
    ];

    const counts: number[] = [];
    for (const { label, fileDepthFloor } of floors) {
      const cfgPath = writeConfig(fileDepthFloor);
      const parsed = await scanFixture(brownfieldSlug, brownfieldSessions, cfgPath);
      counts.push(parsed.repo_findings.length);
      // Each perturbation must keep firing (outcome stable = all fire).
      expect(
        parsed.repo_findings.length,
        `${label}: brownfield finding must stay firing (dirBreadth=6 ≥ breadth_floor=4 carries it)`,
      ).toBe(1);
    }

    // Belt-and-braces: all three perturbations produced the same outcome.
    expect(
      new Set(counts).size,
      'all perturbations must agree on fire/no-fire',
    ).toBe(1);
  });
});
