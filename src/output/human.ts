// Pure human-readable leaderboard formatter (the §8 table). Turns area rows +
// summary + warnings into a column-aligned string. No I/O, no raw prose — only
// area keys, counts, scores, and signal display strings appear in the output.

import * as os from 'node:os';
import type {
  AreaRow,
  BaselineAssessment,
  Diagnosis,
  RepoFinding,
  ScoringMode,
  Warnings,
} from '../types.js';

/** Inputs to `formatHuman`. */
interface HumanInput {
  repo: string;
  mode: ScoringMode;
  sessionCount: number;
  areas: AreaRow[];
  summary: { flagged: number; unflagged: number; unlocalized: number };
  warnings: Warnings;
  /** Always-populated ambient baseline (Slice 2). */
  baseline: BaselineAssessment;
  /** Ambient repo-level finding — non-null only when `baseline.state === 'elevated'`. */
  finding: RepoFinding | null;
  /**
   * Diagnoser output (Slice 4). When `undefined` or empty, the table is
   * byte-identical to Slice 3 (no CAUSE column). When non-empty, an extra
   * `CAUSE` column renders on each flagged row showing `cause(confidence)`
   * — e.g. `doc(0.78)`; unmatched or `unclassified` rows render `-`.
   */
  diagnoses?: Diagnosis[];
}

// Fixed column widths for the leaderboard table. AREA is the exception: its
// width is computed per-render as max(AREA_MIN_W, longest flagged key) so area
// keys are NEVER truncated (issue #34 — a truncated AREA column hid which path
// was actually struggling). AREA_MIN_W only sets a comfortable floor so repos
// with short keys keep the familiar aligned layout (and the corpus snapshot
// stays byte-identical: every corpus key is shorter than this floor).
const AREA_MIN_W = 32;
const FLAGGED_W = 8;
const MEAN_W = 11;
// Wide enough for the longest cause (`inherent-complexity`) + `(0.99)` = 25.
const CAUSE_W = 25;

// Fixed canonical order + human labels for the warnings line. Zero-count
// categories are omitted from the output.
const WARNING_PARTS: ReadonlyArray<{ key: keyof Warnings; label: string }> = [
  { key: 'malformed_lines', label: 'malformed lines' },
  { key: 'oversized_lines', label: 'oversized lines' },
  { key: 'skipped_sessions', label: 'skipped sessions' },
  { key: 'truncated_sessions', label: 'truncated sessions' },
  { key: 'symlinks_rejected', label: 'symlinks rejected' },
  { key: 'unresolvable_cwd', label: 'unresolvable cwd' },
];

/**
 * Format the scan leaderboard as a human-readable string. Pure.
 *
 * Layout: header line, BASELINE section (always printed — one line, plus a
 * 3-line detail block when `baseline.state === 'elevated'`), blank line,
 * column-aligned table (or a "no flagged areas" line when empty), summary
 * line, and a warnings line (only non-zero categories). The bootstrap count in
 * the summary line is `sessionCount` when mode is bootstrap, else 0.
 *
 * The BASELINE line/block is FIXED LITERALS ONLY — state/severity enums,
 * numeric medians/floors/rates, and the fixed "cause undiagnosed"
 * interpretation string. No session content, no file paths.
 */
export function formatHuman(input: HumanInput): string {
  const { repo, mode, sessionCount, areas, summary, warnings, baseline, finding, diagnoses } =
    input;
  const lines: string[] = [];

  lines.push(
    `harnessgap scan — repo: ${tilde(repo)} · ${sessionCount} sessions · mode: ${mode}`,
  );

  // BASELINE section (always printed) — between header and area table.
  for (const line of baselineLines(baseline, finding)) {
    lines.push(line);
  }
  // Blank line separates the baseline section from the area table.
  lines.push('');

  // CAUSE column renders ONLY when the Diagnoser produced at least one
  // diagnosis (`--diagnose` on + flagged areas). When `diagnoses` is
  // undefined or empty, the table is byte-identical to Slice 3.
  const hasCause = diagnoses !== undefined && diagnoses.length > 0;

  // Only FLAGGED areas get table rows (spec §8). Unflagged areas are noise;
  // the summary line reports their count. When nothing is flagged, print a
  // clear no-flagged-areas line instead of an empty table.
  const flaggedAreas = areas.filter((a) => a.sessions_flagged > 0);
  if (flaggedAreas.length === 0) {
    lines.push('No flagged areas.');
  } else {
    // AREA column widens to fit the longest flagged key (issue #34): full keys
    // are always visible, never `...`-truncated. AREA_MIN_W is just the floor.
    const areaWidth = Math.max(
      AREA_MIN_W,
      ...flaggedAreas.map((a) => a.key.length),
    );
    lines.push(tableHeader(hasCause, areaWidth));
    for (const area of flaggedAreas) {
      lines.push(tableRow(area, hasCause ? (diagnoses as Diagnosis[]) : [], areaWidth));
    }
  }

  const bootCount = mode === 'bootstrap' ? sessionCount : 0;
  lines.push(
    `${summary.flagged} areas flagged · ${summary.unflagged} unflagged · ${summary.unlocalized} unlocalized · bootstrap: ${bootCount} sessions`,
  );

  const wLine = warningsLine(warnings);
  if (wLine !== null) lines.push(wLine);

  return lines.join('\n');
}

/**
 * Build the BASELINE section: exactly one line per state, plus a 3-line detail
 * block when `state === 'elevated'` (the 2nd detail line is omitted when the
 * finding's orientation block is null — the acute-only path). Fixed literals
 * only — no session content, no file paths. Caller appends the trailing blank
 * line that separates this section from the area table.
 */
function baselineLines(baseline: BaselineAssessment, finding: RepoFinding | null): string[] {
  const out: string[] = [];
  const pct = (x: number) => (x * 100).toFixed(0);

  switch (baseline.state) {
    case 'elevated': {
      // Detector contract: `finding` is non-null iff state === 'elevated'.
      const f = finding as RepoFinding;
      out.push(`BASELINE — elevated (${f.paths.join('/')}) · severity: ${f.severity}`);
      if (f.orientation !== null) {
        const o = f.orientation;
        out.push(
          `  orientation ${o.median_dir_breadth} dirs / ${o.median_file_depth} files (floors ${o.breadth_floor} / ${o.file_depth_floor}) · over ${o.with_edit_sessions} with-edit sessions`,
        );
      }
      out.push(
        `  zero-edit (Q&A) sessions: ${pct(f.zero_edit_fraction)}% · acute struggle rate: ${pct(f.acute.struggle_rate)}% (threshold ${pct(f.acute.struggle_rate_threshold)}%)`,
      );
      out.push(
        '  the typical session orients broadly before acting — worth investigating (cause undiagnosed)',
      );
      break;
    }
    case 'within-norms': {
      const orient =
        baseline.orientation !== null
          ? `orientation ${baseline.orientation.median_dir_breadth} dirs / ${baseline.orientation.median_file_depth} files`
          : 'orientation n/a';
      out.push(
        `BASELINE — within norms · ${orient} · zero-edit ${pct(baseline.zero_edit_fraction)}% · acute ${pct(baseline.acute.struggle_rate)}%`,
      );
      break;
    }
    case 'too-few-sessions': {
      out.push(`BASELINE — too few sessions (${baseline.sessions_sampled}) to assess`);
      break;
    }
    case 'orientation-undefined': {
      out.push(
        `BASELINE — within norms · all sessions exploration-only; orientation metric undefined · acute ${pct(baseline.acute.struggle_rate)}%`,
      );
      break;
    }
  }
  return out;
}

/** The column-header row, aligned to match the data rows. */
function tableHeader(hasCause: boolean, areaWidth: number): string {
  const base = `${'AREA'.padEnd(areaWidth)} | ${'FLAGGED'.padStart(FLAGGED_W)} | ${'MEAN SCORE'.padStart(MEAN_W)}`;
  if (!hasCause) return `${base} | TOP SIGNALS`;
  return `${base} | ${'CAUSE'.padStart(CAUSE_W)} | TOP SIGNALS`;
}

/** One area row, column-aligned. `diagnoses` is `[]` when the cause column is off. */
function tableRow(area: AreaRow, diagnoses: Diagnosis[], areaWidth: number): string {
  const areaCol = area.key.padEnd(areaWidth);
  const flaggedCol = String(area.sessions_flagged).padStart(FLAGGED_W);
  const meanCol = area.mean_score.toFixed(1).padStart(MEAN_W);
  const signalsCol = area.top_signals.map((t) => t.display).join(', ');
  if (diagnoses.length === 0) {
    return `${areaCol} | ${flaggedCol} | ${meanCol} | ${signalsCol}`;
  }
  const causeCol = causeCell(area.key, diagnoses).padStart(CAUSE_W);
  return `${areaCol} | ${flaggedCol} | ${meanCol} | ${causeCol} | ${signalsCol}`;
}

/**
 * Render the cause cell for a flagged area: `cause(confidence)` (confidence to
 * 2 decimals) when a matching diagnosis exists with a non-`unclassified`
 * cause; `-` otherwise. Matched by `diagnosis.unit.key === areaKey`.
 */
function causeCell(areaKey: string, diagnoses: Diagnosis[]): string {
  const d = diagnoses.find((x) => x.unit.key === areaKey);
  if (d === undefined || d.cause === 'unclassified') return '-';
  return `${d.cause}(${d.confidence.toFixed(2)})`;
}

/** Replace a `$HOME` prefix with `~` for a shorter, readable repo header. */
function tilde(repo: string): string {
  if (repo === '') return '';
  const home = os.homedir();
  if (home !== '' && repo === home) return '~';
  if (home !== '' && repo.startsWith(home + '/')) return '~' + repo.slice(home.length);
  return repo;
}

/**
 * Build the warnings line as `warnings: <n> <label>, <n> <label>`, omitting any
 * category whose count is 0. Returns null when every category is 0 (line
 * omitted entirely).
 */
function warningsLine(warnings: Warnings): string | null {
  const parts: string[] = [];
  for (const { key, label } of WARNING_PARTS) {
    const count = warnings[key];
    if (count > 0) parts.push(`${count} ${label}`);
  }
  if (parts.length === 0) return null;
  return `warnings: ${parts.join(', ')}`;
}
