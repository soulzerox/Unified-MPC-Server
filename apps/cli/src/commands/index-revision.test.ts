import { describe, expect, it } from 'vitest';
import type { GitRevisionAdvanceResult } from '@unified-mpc/workspace';
import {
  DEFAULT_CANONICAL_REF,
  formatIndexRevisionAdvance,
  indexRevisionAdvanceExitCode,
  parseIndexRevisionArgs,
} from './index-revision.js';

const promoted: GitRevisionAdvanceResult = {
  status: 'promoted',
  repositoryId: 'repo:v1:abc',
  targetRef: DEFAULT_CANONICAL_REF,
  commitSha: 'c'.repeat(40),
  gitTreeOid: 'd'.repeat(40),
  unifiedTreeOid: 'e'.repeat(64),
  revisionId: 'rev:v1:f',
  manifestId: 'man:v1:1',
  reuse: {
    reusedPaths: ['a.ts', 'b.ts'],
    newPaths: ['c.ts'],
    renamedPaths: [],
    deletedPaths: [],
  },
  artifacts: { status: 'registered', registered: 1, reused: 2, unclassified: [] },
};

describe('index revision advance argument parsing (#210 §7)', () => {
  it('defaults to canonical main without touching the worktree', () => {
    expect(parseIndexRevisionArgs(['revision', 'advance'])).toEqual({
      ok: true,
      value: { kind: 'index-revision-advance', ref: DEFAULT_CANONICAL_REF, json: false },
    });
  });

  it('accepts an explicit ref, repository id and --json in any order', () => {
    expect(parseIndexRevisionArgs(['revision', 'advance', '--json', '--ref', 'refs/heads/main', '--repository-id', 'repo_pinned']))
      .toEqual({
        ok: true,
        value: {
          kind: 'index-revision-advance',
          ref: 'refs/heads/main',
          repositoryId: 'repo_pinned',
          json: true,
        },
      });
  });

  it.each([
    ['an unknown subcommand', ['revision', 'list']],
    ['a missing subcommand', ['revision']],
    ['an unknown flag', ['revision', 'advance', '--force']],
    ['a flag without a value', ['revision', 'advance', '--ref']],
    ['a flag followed by another flag', ['revision', 'advance', '--ref', '--json']],
    ['a duplicated ref flag', ['revision', 'advance', '--ref', 'refs/heads/main', '--ref', 'refs/heads/main']],
    ['a duplicated json flag', ['revision', 'advance', '--json', '--json']],
    ['a bare branch name', ['revision', 'advance', '--ref', 'main']],
    ['a traversal ref', ['revision', 'advance', '--ref', 'refs/../main']],
  ])('refuses %s', (_label, args) => {
    expect(parseIndexRevisionArgs(args).ok).toBe(false);
  });
});

describe('index revision advance output (#210 §11)', () => {
  it('prints the evidence for a promotion', () => {
    expect(formatIndexRevisionAdvance(promoted)).toBe([
      `canonical ${DEFAULT_CANONICAL_REF}: promoted`,
      `commit ${'c'.repeat(40)}`,
      `tree ${'d'.repeat(40)}`,
      'manifest man:v1:1',
      'repository repo:v1:abc',
      'reuse reused=2 new=1 renamed=0 deleted=0',
      'artifacts reused=2 registered=1 unclassified=0',
    ].join('\n'));
  });

  it('prints the refusal reason instead of a partial report', () => {
    expect(formatIndexRevisionAdvance({ status: 'refused', targetRef: DEFAULT_CANONICAL_REF, reason: 'ref does not resolve' }))
      .toBe(`canonical ${DEFAULT_CANONICAL_REF}: refused\nreason ref does not resolve`);
    expect(formatIndexRevisionAdvance({ status: 'conflict', targetRef: DEFAULT_CANONICAL_REF, currentCommitSha: null }))
      .toBe(`canonical ${DEFAULT_CANONICAL_REF}: conflict\ncurrent <unset>`);
  });

  it('does not claim registered artifacts when registration was refused', () => {
    const refused: GitRevisionAdvanceResult = { ...promoted, artifacts: { status: 'refused', reason: 'unknown manifest' } };
    expect(formatIndexRevisionAdvance(refused)).toContain('artifacts refused: unknown manifest');
    expect(indexRevisionAdvanceExitCode(refused)).toBe(1);
  });

  it('exits zero only for a promotion whose artifacts were registered', () => {
    expect(indexRevisionAdvanceExitCode(promoted)).toBe(0);
    expect(indexRevisionAdvanceExitCode({ ...promoted, status: 'noop' })).toBe(0);
    expect(indexRevisionAdvanceExitCode({ status: 'conflict', targetRef: DEFAULT_CANONICAL_REF, currentCommitSha: 'a'.repeat(40) }))
      .toBe(1);
    expect(indexRevisionAdvanceExitCode({ status: 'refused', targetRef: DEFAULT_CANONICAL_REF, reason: 'x' })).toBe(1);
  });
});
