// Baseline calibration fixtures: three synthetic repo-class session sets that
// encode the spec's success criterion as an automated gate (Task 10).
//
// Mirrors the corpus fixture pattern (test/fixtures/corpus/sessions.ts): each
// export is a SessionSpec[] that mkSession (test/helpers/builder.ts) converts
// to valid JSONL at test time. The depth-2 prefix rule (src/d1/f.ts → prefix
// `src/d1`) is what makes spread reads across N distinct dirs produce
// per-session `dirBreadth=N`.
//
// Three repo classes:
//   1. Unharnessed (FIRES, severity high, paths includes 'orientation'):
//      20 sessions × (6 reads across 6 distinct depth-2 dirs + 1 edit).
//      Per-session dirBreadth=6, fileDepth=6; median 6/6.
//      orientationRatio = max(6/4, 6/12) = max(1.5, 0.5) = 1.5 ≥ 1.5 → high.
//      n=20 = severity_min_sessions → not unrated.
//   2. Well-harnessed (SILENT):
//      10 sessions × (2 reads in ONE dir + 1 edit).
//      Per-session dirBreadth=1, fileDepth=2; median 1/2. Both below floors.
//   3. Brownfield-shaped + stability (FIRES stably via breadth path;
//      ~37.5% zero-edit):
//      16 sessions = 10 with-edit (6 reads across 6 distinct dirs + 1 edit) +
//      6 zero-edit (Q&A/exploration only, orientation=null).
//      Median over the 10 with-edit: dirBreadth=6, fileDepth=6.
//      Stable at file_depth_floor 10/12/14 because dirBreadth=6 ≥ breadth_floor=4
//      keeps the orientation path firing regardless of file_depth_floor.
//      The BREADTH path carries the finding (not file_depth).

import type { SessionSpec } from '../../helpers/builder.js';

// --- Slugs (one per fixture set / variant) ---

export const unharnessedSlug = 'baseline-unharnessed';
export const harnessedSlug = 'baseline-harnessed';
export const brownfieldSlug = 'baseline-brownfield';
export const brownfieldWithEditOnlySlug = 'baseline-brownfield-with-edit-only';

// --- 1. Unharnessed: 20 sessions, broad orientation (dirBreadth=6) ---------

// 6 distinct depth-2 dirs. Each session: read one file in each dir (6 reads
// across 6 distinct prefixes → dirBreadth=6, fileDepth=6), then 1 edit.
const unharnessedDirs = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
const unharnessedReadFiles = unharnessedDirs.map((d) => `src/${d}/f.ts`);

export const unharnessedSessions: SessionSpec[] = Array.from(
  { length: 20 },
  (_, i) => ({
    name: `unharnessed-${i}`,
    events: [
      ...unharnessedReadFiles.map((f) => ({
        kind: 'read' as const,
        file: f,
      })),
      { kind: 'edit' as const, file: 'src/d1/f.ts', newString: 'y' },
    ],
  }),
);

// --- 2. Well-harnessed: 10 sessions, tight orientation (dirBreadth=1) ------

// 2 files in ONE depth-2 dir → dirBreadth=1, fileDepth=2. Both below floors
// (breadth_floor=4, file_depth_floor=12). Acute path stays cold too: each
// session has only 2 reads + 1 edit, so no bootstrap signal trips.
export const harnessedSessions: SessionSpec[] = Array.from(
  { length: 10 },
  (_, i) => ({
    name: `harnessed-${i}`,
    events: [
      { kind: 'read', file: 'src/app/a.ts' },
      { kind: 'read', file: 'src/app/b.ts' },
      { kind: 'edit', file: 'src/app/a.ts', newString: 'y' },
    ],
  }),
);

// --- 3. Brownfield-shaped: 16 sessions (10 with-edit + 6 zero-edit) -------

// With-edit: 6 reads across 6 distinct depth-2 dirs + 1 edit → dirBreadth=6,
// fileDepth=6. Zero-edit: Q&A/exploration only (1 search + 1 read of one file,
// NO edit) → orientation=null (zero-edit session). 6/16 = 0.375 ≈ 38% zero-edit
// (close to the reference brownfield repo's 36%).
const brownfieldDirs = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
const brownfieldReadFiles = brownfieldDirs.map((d) => `src/${d}/f.ts`);

export const brownfieldWithEditSessions: SessionSpec[] = Array.from(
  { length: 10 },
  (_, i) => ({
    name: `brownfield-edit-${i}`,
    events: [
      ...brownfieldReadFiles.map((f) => ({
        kind: 'read' as const,
        file: f,
      })),
      { kind: 'edit' as const, file: 'src/b1/f.ts', newString: 'y' },
    ],
  }),
);

export const brownfieldZeroEditSessions: SessionSpec[] = Array.from(
  { length: 6 },
  (_, i) => ({
    name: `brownfield-qa-${i}`,
    events: [
      { kind: 'user_text', text: 'how does the billing module fit together?' },
      { kind: 'search', pattern: 'billing' },
      { kind: 'read', file: 'src/b1/f.ts' },
    ],
  }),
);

// Full brownfield set: 10 with-edit + 6 zero-edit = 16 sessions.
export const brownfieldSessions: SessionSpec[] = [
  ...brownfieldWithEditSessions,
  ...brownfieldZeroEditSessions,
];
