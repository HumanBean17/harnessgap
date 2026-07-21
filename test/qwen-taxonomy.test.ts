// Qwen tool-name → ToolKind taxonomy tests. Pure lookup, no I/O.

import { describe, it, expect } from 'vitest';
import { mapQwenToolKind } from '../src/adapter/qwen/taxonomy.js';

describe('mapQwenToolKind', () => {
  it('maps read_file to read', () => {
    expect(mapQwenToolKind('read_file')).toBe('read');
  });

  it('maps list_directory to list', () => {
    expect(mapQwenToolKind('list_directory')).toBe('list');
  });

  it('maps edit and write_file to edit', () => {
    expect(mapQwenToolKind('edit')).toBe('edit');
    expect(mapQwenToolKind('write_file')).toBe('edit');
  });

  it('maps run_shell_command to exec', () => {
    expect(mapQwenToolKind('run_shell_command')).toBe('exec');
  });

  it('maps grep_search and glob to search', () => {
    expect(mapQwenToolKind('grep_search')).toBe('search');
    expect(mapQwenToolKind('glob')).toBe('search');
  });

  it('maps agent, todo_write, ask_user_question, and skill to other', () => {
    expect(mapQwenToolKind('agent')).toBe('other');
    expect(mapQwenToolKind('todo_write')).toBe('other');
    expect(mapQwenToolKind('ask_user_question')).toBe('other');
    expect(mapQwenToolKind('skill')).toBe('other');
  });

  it('maps unknown names, empty string, and undefined to other', () => {
    expect(mapQwenToolKind('mcp__x')).toBe('other');
    expect(mapQwenToolKind('')).toBe('other');
    expect(mapQwenToolKind(undefined as any)).toBe('other');
  });
});
