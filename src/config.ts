import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { Config, HarnessId } from './types.js';

/**
 * Typed error for config problems. Carries a clean human-readable message only;
 * the CLI is responsible for printing the message without leaking the stack.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * The exact §7 defaults. Later tasks depend on these values verbatim.
 */
export const DEFAULT_CONFIG: Config = {
  // Qwen+GigaCode slice Task 8: default to the Claude Code adapter so
  // pre-slice behavior is preserved bit-for-bit. `'qwen-code'` / `'gigacode'`
  // opt into the new adapters once their HarnessSpec is registered.
  harness: 'claude-code',
  detector: {
    thresholds_as: 'percentile',
    flag_pct: 90,
    bootstrap_session_floor: 30,
    bootstrap_flag_pct: 70,
    reread_threshold: 5,
    correction_window_ms: 120000,
    signal_weights: {
      explore_ratio: 1,
      reread: 1,
      failure_streak: 1,
      corrections: 1,
      abandonment: 0.5,
      oscillation: 1.2,
      wall_clock_per_line: 1,
    },
    bootstrap_thresholds: {
      explore_ratio: 10,
      reread: 5,
      failure_streak: 3,
      corrections: 2,
      abandonment: true,
      oscillation: 2,
      wall_clock_per_line_ms: 300000,
    },
    ambient: {
      breadth_floor: 4,
      file_depth_floor: 12,
      struggle_rate_threshold: 0.3,
      min_sessions: 10,
      severity_min_sessions: 20,
    },
  },
  areas: {
    ignore: ['node_modules', 'build', 'target', 'dist', '.git', '.next', 'vendor'],
    min_weight: 0.4,
    min_depth: 2,
    touch_weights: { edit: 3, read: 2, exec: 1 },
    tail_fraction: 0.25,
    explore_ratio_min: 0.8,
    suppress_abandonment_when_no_exec: true,
    test_cmd_patterns: [
      'test',
      'spec',
      'pytest',
      'npm test',
      'npm run test',
      'make',
      'cargo test',
      'go test',
      'jest',
      'vitest',
    ],
  },
  docs_dirs: ['docs'],
  diagnose: {
    confidence_floor: 0.5,
    config_share_floor: 0.5,
    test_share_floor: 0.5,
    code_share_floor: 0.5,
    score_floor: 70,
    // Closed-loop MVP: pinned to 0.6 by the plan (§5.2/§9) — below this
    // confidence, doc/config-doc causes downgrade to a digest card with no
    // prose. Range check (∈ [0,1]) is enforced in `validateConfig`.
    confidence_floor_for_prose: 0.6,
  },
  // Closed-loop MVP (Synthesizer) defaults, pinned verbatim by the plan.
  // `backend`/`model` are null so the default path makes no external call
  // (structure-only / no network); `dedupe:'none'` skips near-duplicate
  // search; `top_n:3` caps the areas synthesized per run. Range/enum checks
  // (dedupe ∈ {none,tfidf}, max_file_head_bytes >= 1, top_n >= 1, backend is
  // string|null) are enforced in `validateConfig`; `'synthesizer'` is in
  // `KNOWN_TOP_KEYS`.
  synthesizer: {
    backend: null,
    model: null,
    structure_only: false,
    max_file_head_bytes: 4096,
    dedupe: 'none',
    top_n: 3,
  },
};

const DURATION_RE = /^(\d+)([dhms])$/;

/**
 * Parse a duration string like "30d" / "12h" / "5m" / "10s" into milliseconds.
 * `undefined` and empty string mean "no window" and return `Infinity`.
 * Throws `ConfigError` on unparseable input.
 */
export function parseDuration(s: string | undefined): number {
  if (s === undefined || s === '') return Infinity;
  const m = DURATION_RE.exec(s);
  if (!m) throw new ConfigError(`Invalid duration: ${JSON.stringify(s)}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case 'd':
      return n * 24 * 60 * 60 * 1000;
    case 'h':
      return n * 60 * 60 * 1000;
    case 'm':
      return n * 60 * 1000;
    case 's':
      return n * 1000;
    default:
      // Unreachable: regex guarantees one of d/h/m/s.
      throw new ConfigError(`Invalid duration: ${JSON.stringify(s)}`);
  }
}

// Qwen+GigaCode slice Task 8: `'harness'` joins the strict allowlist. Unknown
// top-level keys are STILL rejected — this is an enumeration, not a wildcard.
// Closed-loop MVP Task 2: `'synthesizer'` joins the allowlist; its sub-fields
// are range/enum-checked in `validateConfig` below.
const KNOWN_TOP_KEYS = new Set([
  'harness',
  'detector',
  'areas',
  'docs_dirs',
  'diagnose',
  'synthesizer',
]);

const HARNESS_IDS: readonly HarnessId[] = [
  'claude-code',
  'qwen-code',
  'gigacode',
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isEnoent(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code: unknown }).code === 'ENOENT'
  );
}

/**
 * Deep-merge `override` over `base`. Objects merge recursively; arrays and
 * primitives replace (arrays do NOT concatenate).
 */
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) {
    return override as T;
  }
  if (!isPlainObject(base)) {
    return { ...override } as T;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (k in base && isPlainObject(base[k]) && isPlainObject(v)) {
      result[k] = deepMerge(base[k], v);
    } else {
      result[k] = v;
    }
  }
  return result as T;
}

function validateConfig(cfg: Config): void {
  // Qwen+GigaCode slice Task 8: `harness` must be one of the closed
  // {@link HarnessId} union. The allowlist + deep-merge already guarantees the
  // key is present (DEFAULT_CONFIG.harness), but a user-supplied scalar like
  // `wat` would otherwise slip through as a string and break dispatch later.
  if (!HARNESS_IDS.includes(cfg.harness)) {
    throw new ConfigError(
      `harness must be one of ${HARNESS_IDS.join(', ')}, got ${JSON.stringify(cfg.harness)}`,
    );
  }
  const d = cfg.detector;
  if (d.flag_pct < 0 || d.flag_pct > 100) {
    throw new ConfigError(
      `detector.flag_pct must be in [0,100], got ${d.flag_pct}`,
    );
  }
  if (d.bootstrap_session_floor < 1) {
    throw new ConfigError(
      `detector.bootstrap_session_floor must be >= 1, got ${d.bootstrap_session_floor}`,
    );
  }
  for (const [k, v] of Object.entries(d.signal_weights)) {
    if (v < 0) {
      throw new ConfigError(
        `detector.signal_weights.${k} must be >= 0, got ${v}`,
      );
    }
  }
  const a = d.ambient;
  if (a.breadth_floor < 1) {
    throw new ConfigError(
      `detector.ambient.breadth_floor must be >= 1, got ${a.breadth_floor}`,
    );
  }
  if (a.file_depth_floor < 1) {
    throw new ConfigError(
      `detector.ambient.file_depth_floor must be >= 1, got ${a.file_depth_floor}`,
    );
  }
  if (a.struggle_rate_threshold < 0 || a.struggle_rate_threshold > 1) {
    throw new ConfigError(
      `detector.ambient.struggle_rate_threshold must be in [0,1], got ${a.struggle_rate_threshold}`,
    );
  }
  if (a.min_sessions < 1) {
    throw new ConfigError(
      `detector.ambient.min_sessions must be >= 1, got ${a.min_sessions}`,
    );
  }
  if (a.severity_min_sessions < a.min_sessions) {
    throw new ConfigError(
      `detector.ambient.severity_min_sessions must be >= min_sessions, got ${a.severity_min_sessions}`,
    );
  }
  const tw = cfg.areas.touch_weights;
  for (const [k, v] of Object.entries(tw)) {
    if (v < 0) {
      throw new ConfigError(`areas.touch_weights.${k} must be >= 0, got ${v}`);
    }
  }
  const mw = cfg.areas.min_weight;
  if (mw < 0 || mw > 1) {
    throw new ConfigError(`areas.min_weight must be in [0,1], got ${mw}`);
  }
  // docs_dirs: must be an array of strings. The deep-merge replaces (not
  // concatenates) arrays, so a scalar or non-string element would silently
  // replace the default `['docs']` and surface later as a confusing internal
  // error inside gatherRepoContext. Catch it here at the boundary.
  if (!Array.isArray(cfg.docs_dirs)) {
    throw new ConfigError(
      `docs_dirs must be an array of strings, got ${typeof cfg.docs_dirs}`,
    );
  }
  for (const d of cfg.docs_dirs) {
    if (typeof d !== 'string') {
      throw new ConfigError(
        `docs_dirs must be an array of strings, found non-string element: ${JSON.stringify(d)}`,
      );
    }
  }
  const dg = cfg.diagnose;
  if (dg.confidence_floor < 0 || dg.confidence_floor > 1) {
    throw new ConfigError(
      `diagnose.confidence_floor must be in [0,1], got ${dg.confidence_floor}`,
    );
  }
  if (dg.config_share_floor < 0 || dg.config_share_floor > 1) {
    throw new ConfigError(
      `diagnose.config_share_floor must be in [0,1], got ${dg.config_share_floor}`,
    );
  }
  if (dg.test_share_floor < 0 || dg.test_share_floor > 1) {
    throw new ConfigError(
      `diagnose.test_share_floor must be in [0,1], got ${dg.test_share_floor}`,
    );
  }
  if (dg.code_share_floor < 0 || dg.code_share_floor > 1) {
    throw new ConfigError(
      `diagnose.code_share_floor must be in [0,1], got ${dg.code_share_floor}`,
    );
  }
  if (dg.score_floor < 0 || dg.score_floor > 100) {
    throw new ConfigError(
      `diagnose.score_floor must be in [0,100], got ${dg.score_floor}`,
    );
  }
  // Closed-loop MVP Task 2: prose-emission confidence floor. Mirrors the other
  // diagnose share-floors (range ∈ [0,1]) — causes below this floor produce
  // frontmatter-only proposals with no body.
  if (dg.confidence_floor_for_prose < 0 || dg.confidence_floor_for_prose > 1) {
    throw new ConfigError(
      `diagnose.confidence_floor_for_prose must be in [0,1], got ${dg.confidence_floor_for_prose}`,
    );
  }
  // Closed-loop MVP Task 2: synthesizer block validation. `dedupe` is a closed
  // enum; `max_file_head_bytes`/`top_n` are positive integers; `backend` must
  // be a string or null (deep-merge would otherwise let a YAML number slip
  // through as the backend id and break dispatch in a later task). `model` is
  // not range-checked (free-form string|null) — it is only forwarded to the
  // backend selected by `backend`.
  const syn = cfg.synthesizer;
  if (syn.dedupe !== 'none' && syn.dedupe !== 'tfidf') {
    throw new ConfigError(
      `synthesizer.dedupe must be one of none, tfidf, got ${JSON.stringify(syn.dedupe)}`,
    );
  }
  if (syn.max_file_head_bytes < 1) {
    throw new ConfigError(
      `synthesizer.max_file_head_bytes must be >= 1, got ${syn.max_file_head_bytes}`,
    );
  }
  if (syn.top_n < 1) {
    throw new ConfigError(
      `synthesizer.top_n must be >= 1, got ${syn.top_n}`,
    );
  }
  if (syn.backend !== null && typeof syn.backend !== 'string') {
    throw new ConfigError(
      `synthesizer.backend must be a string or null, got ${typeof syn.backend}`,
    );
  }
}

/**
 * Load and validate a config. With no `path`, looks for `.harnessgap.yml` in
 * the cwd; if absent, returns `DEFAULT_CONFIG`. Deep-merges the file over the
 * defaults (arrays replace). Throws `ConfigError` on: unreadable file, YAML
 * parse error, unknown top-level keys, or out-of-range numeric fields.
 */
export function loadConfig(path?: string): Config {
  const target = path ?? resolve('.harnessgap.yml');
  let raw: string;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (e) {
    // No path given and default file absent -> fail-open with defaults.
    if (path === undefined && isEnoent(e)) {
      return structuredClone(DEFAULT_CONFIG);
    }
    throw new ConfigError(
      `Cannot read config file: ${path ?? '.harnessgap.yml'}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (e) {
    throw new ConfigError(
      `YAML parse error in ${path ?? '.harnessgap.yml'}: ${(e as Error).message}`,
    );
  }

  // Empty file -> nothing to override -> defaults.
  if (parsed === null || parsed === undefined) {
    return structuredClone(DEFAULT_CONFIG);
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError('Config must be a YAML object at the top level');
  }

  for (const k of Object.keys(parsed)) {
    if (!KNOWN_TOP_KEYS.has(k)) {
      throw new ConfigError(`Unknown config key: ${k}`);
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG, parsed);
  validateConfig(merged);
  return structuredClone(merged);
}
