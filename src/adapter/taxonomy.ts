// Claude Code tool-name → ToolKind map. Pure lookup, no I/O.
// Pinned to the six ToolKind values in src/types.ts. Unknown / empty → 'other'.

import type { ToolKind } from '../types.js';

const TOOL_KIND_MAP: Record<string, ToolKind> = {
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  LS: 'list',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'exec',
};

/**
 * Map a Claude Code tool name to a ToolKind.
 * Unknown names (Task*, WebSearch, WebFetch, mcp__*, etc.) and empty strings
 * map to 'other'. Case-sensitive: Claude Code tool names are PascalCase.
 */
export function mapToolKind(ccToolName: string): ToolKind {
  return TOOL_KIND_MAP[ccToolName] ?? 'other';
}
