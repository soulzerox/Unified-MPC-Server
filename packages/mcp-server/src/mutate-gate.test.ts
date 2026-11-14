import { describe, expect, it } from 'vitest';
import { codeMutationPaths } from './harness-runtime.js';
import {
  DEFAULT_MUTATE_MODE,
  describeMutateBlockers,
  evaluateMutateGate,
  parseMutateMode,
  workspaceMutateMode,
} from './mutate-gate.js';

describe('mutate mode', () => {
  it('accepts only the exact opt-in value', () => {
    expect(parseMutateMode('require_preparation')).toBe('require_preparation');
    expect(parseMutateMode('auto_prepare')).toBe('auto_prepare');
    expect(parseMutateMode('REQUIRE_PREPARATION')).toBe(DEFAULT_MUTATE_MODE);
    expect(parseMutateMode(undefined)).toBe(DEFAULT_MUTATE_MODE);
    expect(parseMutateMode(true)).toBe(DEFAULT_MUTATE_MODE);
  });

  it('reads the opt-in from the workspace profile and defaults everything else', () => {
    expect(workspaceMutateMode({ workflowGate: { mutate: 'require_preparation' } })).toBe('require_preparation');
    expect(workspaceMutateMode({ workflowGate: { mutate: 'auto_prepare' } })).toBe('auto_prepare');
    expect(workspaceMutateMode({})).toBe(DEFAULT_MUTATE_MODE);
    expect(workspaceMutateMode({ workflowGate: 'require_preparation' })).toBe(DEFAULT_MUTATE_MODE);
    expect(workspaceMutateMode({ workflowGate: { mutate: 'yes' } })).toBe(DEFAULT_MUTATE_MODE);
    expect(workspaceMutateMode(null)).toBe(DEFAULT_MUTATE_MODE);
    expect(workspaceMutateMode([])).toBe(DEFAULT_MUTATE_MODE);
  });
});

describe('codeMutationPaths', () => {
  it('classifies marker files and extensions whatever case they were written in', () => {
    // Classification is about the artifact, not about path identity: a
    // `Dockerfile` written with a capital D is still a Dockerfile, and it must
    // not fall out of mutation coverage on a case-sensitive platform.
    expect(codeMutationPaths('write_file', { path: 'Dockerfile' })).toEqual(['Dockerfile']);
    expect(codeMutationPaths('write_file', { path: 'Makefile' })).toEqual(['Makefile']);
    expect(codeMutationPaths('write_file', { path: 'Cargo.toml' })).toEqual(['Cargo.toml']);
    expect(codeMutationPaths('write_file', { path: 'src/App.TS' })).toEqual(['src/App.TS']);
    expect(codeMutationPaths('write_file', { path: 'docs/readme.md' })).toEqual([]);
  });
});

describe('evaluateMutateGate', () => {
  it('allows everything when the workspace has not opted in', () => {
    expect(evaluateMutateGate({ mode: 'auto_prepare', harness: 'inactive', paths: ['src/a.ts'], preparedPaths: [] }))
      .toEqual({ allowed: true });
  });

  it('allows a prepared path and refuses an unprepared one by name', () => {
    expect(evaluateMutateGate({
      mode: 'require_preparation',
      harness: 'active',
      paths: ['src/a.ts'],
      preparedPaths: ['src/a.ts'],
    })).toEqual({ allowed: true });

    expect(evaluateMutateGate({
      mode: 'require_preparation',
      harness: 'active',
      paths: ['src/a.ts', 'src/b.ts'],
      preparedPaths: ['src/a.ts'],
    })).toEqual({ allowed: false, blockers: [{ code: 'preparation_missing', path: 'src/b.ts' }] });
  });

  it('normalizes a leading ./ and collapses case only where the filesystem does', () => {
    const win32 = process.platform === 'win32';
    expect(evaluateMutateGate({
      mode: 'require_preparation',
      harness: 'active',
      paths: ['./src/app.ts'],
      preparedPaths: ['src/app.ts'],
    })).toEqual({ allowed: true });

    // `\` is a separator only on Windows; on POSIX it is a filename character.
    expect(evaluateMutateGate({
      mode: 'require_preparation',
      harness: 'active',
      paths: ['src\\app.ts'],
      preparedPaths: ['src/app.ts'],
    })).toEqual(win32
      ? { allowed: true }
      : { allowed: false, blockers: [{ code: 'preparation_missing', path: 'src\\app.ts' }] });

    expect(evaluateMutateGate({
      mode: 'require_preparation',
      harness: 'active',
      paths: ['src/App.ts'],
      preparedPaths: ['src/app.ts'],
    })).toEqual(win32
      ? { allowed: true }
      : { allowed: false, blockers: [{ code: 'preparation_missing', path: 'src/App.ts' }] });
  });

  it('names each missing path once', () => {
    expect(evaluateMutateGate({
      mode: 'require_preparation',
      harness: 'active',
      paths: ['src/a.ts', 'src/a.ts'],
      preparedPaths: [],
    })).toEqual({ allowed: false, blockers: [{ code: 'preparation_missing', path: 'src/a.ts' }] });
  });

  it('refuses an inactive or stale harness even when no path is named', () => {
    expect(evaluateMutateGate({ mode: 'require_preparation', harness: 'inactive', paths: [], preparedPaths: [] }))
      .toEqual({ allowed: false, blockers: [{ code: 'harness_inactive' }] });
    expect(evaluateMutateGate({ mode: 'require_preparation', harness: 'stale', paths: [], preparedPaths: [] }))
      .toEqual({ allowed: false, blockers: [{ code: 'harness_stale' }] });
  });

  it('reports the harness blocker before the path blockers it cannot explain', () => {
    const decision = evaluateMutateGate({
      mode: 'require_preparation',
      harness: 'stale',
      paths: ['src/a.ts'],
      preparedPaths: [],
    });
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.blockers.map((blocker) => blocker.code))
      .toEqual(['harness_stale', 'preparation_missing']);
  });
});

describe('describeMutateBlockers', () => {
  it('points at the tool that clears each blocker', () => {
    expect(describeMutateBlockers([{ code: 'harness_inactive' }])).toContain('workspace_bootstrap');
    expect(describeMutateBlockers([{ code: 'harness_stale' }])).toContain('prepare_code_change');
    expect(describeMutateBlockers([{ code: 'preparation_missing', path: 'src/a.ts' }]))
      .toContain('prepare_code_change for src/a.ts');
  });

  it('bounds a long list of missing paths', () => {
    const blockers = Array.from({ length: 8 }, (_value, index) => ({
      code: 'preparation_missing' as const,
      path: `src/file-${String(index)}.ts`,
    }));
    const message = describeMutateBlockers(blockers);
    expect(message).toContain('src/file-4.ts and 3 more');
    expect(message).not.toContain('src/file-5.ts');
  });
});
