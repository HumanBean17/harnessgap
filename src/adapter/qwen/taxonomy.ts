// Qwen Code tool-name → ToolKind map. Pure lookup, no I/O.
// Pinned to the six ToolKind values in src/types.ts. Unknown / empty → 'other'.

import type { ToolKind } from '../../types.js';

const TOOL_KIND_MAP: Record<string, ToolKind> = {
  read_file: 'read',
  list_directory: 'list',
  edit: 'edit',
  write_file: 'edit',
  run_shell_command: 'exec',
  grep_search: 'search',
  glob: 'search',
};

/**
 * Map a Qwen Code tool name to a ToolKind.
 * Unknown names (agent, todo_write, ask_user_question, skill, mcp__*, etc.)
 * and empty strings map to 'other'. Case-sensitive: Qwen Code tool names are
 * snake_case.
 */
export function mapQwenToolKind(qwenToolName: string): ToolKind {
  return TOOL_KIND_MAP[qwenToolName] ?? 'other';
}
