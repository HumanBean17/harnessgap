// Pure area localization: clusters a session's touched files into path-prefix
// areas using touch-weights, rolls up to ancestor directories, and returns the
// deepest qualifying directories (each capturing >= min_weight of the session's
// total touch-weight, at depth >= min_depth). No I/O, no mutation of inputs.

import type { Config, NormalizedEvent, ToolKind } from '../types.js';

interface Area {
  key: string;
  weight: number;
}

/**
 * Localize the areas touched by a session. See task-12 brief for the 5-step
 * algorithm. Returns the deepest qualifying directories (repo-relative,
 * forward-slash paths), each with `weight` = dir weight / total touch-weight in
 * [0,1]. Returns `[]` when no directory qualifies (session is unlocalized).
 */
export function localizeAreas(events: NormalizedEvent[], cfg: Config): Area[] {
  const tw = cfg.areas.touch_weights;
  const ignore = new Set(cfg.areas.ignore);

  // Step 1: accumulate touch-weight per non-ignored file. Ignored paths
  // (first segment in cfg.areas.ignore) contribute 0 weight — to files AND
  // to the session total.
  const fileWeights = new Map<string, number>();
  let total = 0;
  for (const e of events) {
    const w = touchWeight(e.tool, tw);
    if (w === 0) continue;
    for (const f of e.input_digest.files) {
      if (isIgnored(f, ignore)) continue;
      fileWeights.set(f, (fileWeights.get(f) ?? 0) + w);
      total += w;
    }
  }
  if (total === 0) return [];

  // Step 2: roll up to ancestor directories. Each ancestor dir's weight = sum
  // of weights of all files beneath it (transitively). For a file with segments
  // [s0, s1, ..., sN], the ancestor dirs are s0, s0/s1, ..., s0/.../s(N-1).
  const dirWeights = new Map<string, number>();
  for (const [file, w] of fileWeights) {
    const segs = file.split('/');
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/');
      dirWeights.set(dir, (dirWeights.get(dir) ?? 0) + w);
    }
  }

  // Step 3: candidates = dirs at depth >= min_depth capturing >= min_weight of
  // total. Depth = number of `/`-separated segments from repo root.
  const minWeight = cfg.areas.min_weight;
  const minDepth = cfg.areas.min_depth;
  const candidates: Area[] = [];
  for (const [dir, w] of dirWeights) {
    if (dir.split('/').length < minDepth) continue;
    const fraction = w / total;
    if (fraction < minWeight) continue;
    candidates.push({ key: dir, weight: fraction });
  }
  if (candidates.length === 0) return [];

  // Step 4: deepest pruning — drop any candidate that has a qualifying
  // descendant. A descendant of D is any other candidate whose key starts with
  // `D + '/'`. Siblings (no ancestor relationship) are both kept.
  const result: Area[] = [];
  for (const c of candidates) {
    const prefix = c.key + '/';
    let hasDescendant = false;
    for (const other of candidates) {
      if (other.key !== c.key && other.key.startsWith(prefix)) {
        hasDescendant = true;
        break;
      }
    }
    if (!hasDescendant) result.push(c);
  }

  result.sort((a, b) => a.key.localeCompare(b.key));
  return result;
}

/** Touch-weight for a tool kind: edit→3, read→2, exec→1; null/other→0. */
function touchWeight(
  tool: ToolKind | null,
  tw: Config['areas']['touch_weights'],
): number {
  switch (tool) {
    case 'edit':
      return tw.edit;
    case 'read':
      return tw.read;
    case 'exec':
      return tw.exec;
    default:
      return 0;
  }
}

/** True when the path's first `/`-separated segment is in the ignore set. */
function isIgnored(path: string, ignore: Set<string>): boolean {
  const first = path.split('/', 1)[0] ?? '';
  return ignore.has(first);
}
