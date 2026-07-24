// Pure pointer renderer. Produces human-readable navigation suggestions
// for repo areas (files or directories). Pure function: no I/O, no mutations,
// no network calls. Shared by the explain CLI and (future) Router hook.

/**
 * Render a pointer string for an area unit with optional documentation path.
 *
 * - When `docPath` is provided: returns a navigation prompt with the backticked
 *   area key (trailing slash added) and the doc path, e.g. "Before editing
 *   `src/billing/`, read `docs/architecture/billing.md`."
 * - When `docPath` is null: returns a suggestion string naming the unit and
 *   proposing synthesis, e.g. "For `src/billing/`, consider synthesizing
 *   documentation."
 *
 * Pure function: deterministic output, no I/O, no mutations.
 *
 * @param unit - The area unit to render.
 * @param docPath - Optional documentation path; null suggests synthesis.
 * @returns A human-readable pointer string.
 */
export function renderPointer(
  unit: { kind: 'area'; key: string },
  docPath: string | null,
): string {
  const areaKeyWithSlash = unit.key.endsWith('/') ? unit.key : unit.key + '/';

  if (docPath === null) {
    return `For \`${areaKeyWithSlash}\`, consider running synthesize to generate documentation.`;
  }

  return `Before editing \`${areaKeyWithSlash}\`, read \`${docPath}\`.`;
}
