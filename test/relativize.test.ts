import { describe, it, expect } from 'vitest';
import {
  relativizeFilePath,
  stripWorktreePrefix,
  relativizeEnvelopeFiles,
} from '../src/relativize.js';
import type { NormalizedEnvelope } from '../src/types.js';

const REPO = '/Users/x/code/myrepo';

describe('stripWorktreePrefix', () => {
  it('strips .claude/worktrees/<name>/ prefix', () => {
    expect(stripWorktreePrefix('.claude/worktrees/feat-xyz/src/foo.ts')).toBe(
      'src/foo.ts',
    );
  });

  it('strips .agents/worktrees/<name>/ prefix', () => {
    expect(stripWorktreePrefix('.agents/worktrees/dev-deps-guard/src/x')).toBe(
      'src/x',
    );
  });

  it('strips .git/worktrees/<name>/ prefix', () => {
    expect(stripWorktreePrefix('.git/worktrees/abc/a.ts')).toBe('a.ts');
  });

  it('strips .worktrees/<name>/ prefix (hidden dir named worktrees itself — issue #30)', () => {
    // The layout `.worktrees/feat-add-service-logging-discovery/…` seen in real
    // transcripts: `worktrees` is the hidden checkout dir, not a subdir of one.
    expect(
      stripWorktreePrefix('.worktrees/feat-add-service-logging-discovery/src/a.ts'),
    ).toBe('src/a.ts');
  });

  it('passes a plain repo-relative path through', () => {
    expect(stripWorktreePrefix('src/billing/charge.ts')).toBe(
      'src/billing/charge.ts',
    );
  });

  it('does NOT strip a real source dir named worktrees (no leading dot-segment)', () => {
    // `src/worktrees/...` has no leading hidden dir → not a worktree checkout.
    expect(stripWorktreePrefix('src/worktrees/foo.ts')).toBe(
      'src/worktrees/foo.ts',
    );
  });

  it('passes a worktree root (no trailing path) through unchanged', () => {
    expect(stripWorktreePrefix('.claude/worktrees/feat-xyz')).toBe(
      '.claude/worktrees/feat-xyz',
    );
  });
});

describe('relativizeFilePath', () => {
  it('strips the repoRoot prefix from an absolute path', () => {
    expect(relativizeFilePath(`${REPO}/src/foo.ts`, REPO)).toBe('src/foo.ts');
  });

  it('strips repoRoot then a worktree prefix (the real fragmentation case)', () => {
    // Session cwd was the main repo, but the agent edited a file inside a
    // worktree checkout. Relativizing against the main repo leaves the worktree
    // prefix, which must then be stripped so it aggregates with the main copy.
    expect(
      relativizeFilePath(`${REPO}/.claude/worktrees/feat-xyz/src/foo.ts`, REPO),
    ).toBe('src/foo.ts');
  });

  it('strips a different tooling worktree prefix (.agents)', () => {
    expect(
      relativizeFilePath(`${REPO}/.agents/worktrees/dg/src/a.ts`, REPO),
    ).toBe('src/a.ts');
  });

  it('strips a .worktrees/<name>/ prefix (issue #30 layout)', () => {
    // The main repo's `.worktrees/<name>/` checkout must collapse so it
    // aggregates with the main copy — otherwise the prefix survives as the area.
    expect(
      relativizeFilePath(`${REPO}/.worktrees/feat-add/src/billing/charge.ts`, REPO),
    ).toBe('src/billing/charge.ts');
  });

  it('passes an already-relative path through (worktree-stripped only)', () => {
    expect(relativizeFilePath('src/app/main.ts', REPO)).toBe('src/app/main.ts');
  });

  it('worktree-strips an already-relative worktree path', () => {
    expect(
      relativizeFilePath('.claude/worktrees/zz/src/a.ts', REPO),
    ).toBe('src/a.ts');
  });

  it('passes an absolute path outside repoRoot through unchanged', () => {
    expect(relativizeFilePath('/etc/hosts', REPO)).toBe('/etc/hosts');
  });

  it('strips a SIBLING-worktree checkout root when provided', () => {
    // The cwd lived in a SIBLING worktree (`<parent>/myrepo-wt-cli` beside
    // `<parent>/myrepo`), so file paths are absolute and OUTSIDE the repo prefix.
    // Without the checkout root they'd survive as absolute paths; with it they
    // collapse onto the same repo-relative areas as the main checkout.
    const checkoutRoot = '/Users/x/code/myrepo-wt-cli';
    expect(
      relativizeFilePath(`${checkoutRoot}/src/billing/charge.ts`, REPO, checkoutRoot),
    ).toBe('src/billing/charge.ts');
  });

  it('leaves a sibling-worktree file absolute when no checkout root is given', () => {
    // Proves the checkout-root strip is load-bearing: the absolute path sits
    // outside the repo prefix (`myrepo-wt-cli`, not `myrepo/...`), so without the
    // checkout root it passes through unchanged.
    expect(
      relativizeFilePath('/Users/x/code/myrepo-wt-cli/src/billing/charge.ts', REPO),
    ).toBe('/Users/x/code/myrepo-wt-cli/src/billing/charge.ts');
  });

  it('handles repoRoot without trailing slash and exact-root file', () => {
    // repoRoot itself (degenerate) falls back to the original.
    expect(relativizeFilePath(REPO, REPO)).toBe(REPO);
  });

  it('with empty repoRoot, still worktree-strips relative paths', () => {
    expect(relativizeFilePath('.claude/worktrees/zz/src/a.ts', '')).toBe(
      'src/a.ts',
    );
  });
});

describe('relativizeEnvelopeFiles', () => {
  function env(files: string[][]): NormalizedEnvelope {
    return {
      schema_version: 1,
      session_id: 's',
      agent: 'claude-code',
      repo: REPO,
      started_at: '',
      duration_ms: 0,
      truncated: false,
      event_count: files.length,
      events: files.map((fs) => ({
        t: '',
        kind: 'tool_call',
        tool: 'edit',
        input_digest: {
          files: fs,
          cmd: null,
          query: null,
          lines_changed: 1,
        },
        ok: true,
        interrupted: false,
        duration_ms: 0,
        correction: null,
      })),
    };
  }

  it('relativizes every file across every event in place', () => {
    const e = env([
      [`${REPO}/src/a.ts`, `${REPO}/.claude/worktrees/z/src/b.ts`],
      [`src/c.ts`],
    ]);
    relativizeEnvelopeFiles(e, REPO);
    expect(e.events[0]!.input_digest.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(e.events[1]!.input_digest.files).toEqual(['src/c.ts']);
  });

  it('skips events with no files', () => {
    const e = env([[]]);
    relativizeEnvelopeFiles(e, REPO);
    expect(e.events[0]!.input_digest.files).toEqual([]);
  });

  it('collapses main + worktree paths onto the same canonical path', () => {
    // The core aggregation guarantee: the same file in the main checkout and in
    // any worktree relativizes to the identical string.
    const main = relativizeFilePath(`${REPO}/src/billing/charge.ts`, REPO);
    const wt1 = relativizeFilePath(
      `${REPO}/.claude/worktrees/feat-a/src/billing/charge.ts`,
      REPO,
    );
    const wt2 = relativizeFilePath(
      `${REPO}/.agents/worktrees/dg/src/billing/charge.ts`,
      REPO,
    );
    // ...and the `.worktrees/<name>/` layout (issue #30) collapses too.
    const wt3 = relativizeFilePath(
      `${REPO}/.worktrees/feat-add/src/billing/charge.ts`,
      REPO,
    );
    // ...and a SIBLING worktree (outside the repo prefix) collapses too, given
    // the checkout root the resolver surfaces.
    const sibling = relativizeFilePath(
      '/Users/x/code/myrepo-wt-cli/src/billing/charge.ts',
      REPO,
      '/Users/x/code/myrepo-wt-cli',
    );
    expect(wt1).toBe(main);
    expect(wt2).toBe(main);
    expect(wt3).toBe(main);
    expect(sibling).toBe(main);
  });
});
