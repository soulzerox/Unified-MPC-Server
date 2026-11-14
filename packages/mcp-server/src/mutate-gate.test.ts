import { describe, expect, it } from 'vitest';
import { codeMutationPaths, isOpaqueMutationTool } from './harness-runtime.js';
import {
  DEFAULT_MUTATE_MODE,
  DEFAULT_OPAQUE_MUTATE_POLICY,
  describeMutateBlockers,
  describeOpaqueMutateAdmission,
  describeOpaqueMutateRefusal,
  evaluateMutateGate,
  evaluateOpaqueMutateGate,
  parseMutateMode,
  parseOpaqueMutatePolicy,
  workspaceWorkflowGate,
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
    expect(workspaceWorkflowGate({ workflowGate: { mutate: 'require_preparation' } }).mutate).toBe('require_preparation');
    expect(workspaceWorkflowGate({ workflowGate: { mutate: 'auto_prepare' } }).mutate).toBe('auto_prepare');
    expect(workspaceWorkflowGate({}).mutate).toBe(DEFAULT_MUTATE_MODE);
    expect(workspaceWorkflowGate({ workflowGate: 'require_preparation' }).mutate).toBe(DEFAULT_MUTATE_MODE);
    expect(workspaceWorkflowGate({ workflowGate: { mutate: 'yes' } }).mutate).toBe(DEFAULT_MUTATE_MODE);
    expect(workspaceWorkflowGate(null).mutate).toBe(DEFAULT_MUTATE_MODE);
    expect(workspaceWorkflowGate([]).mutate).toBe(DEFAULT_MUTATE_MODE);
  });
});

describe('opaque mutate policy', () => {
  it('accepts only the exact refuse value and defaults everything else', () => {
    expect(parseOpaqueMutatePolicy('refuse')).toBe('refuse');
    expect(parseOpaqueMutatePolicy('allow')).toBe(DEFAULT_OPAQUE_MUTATE_POLICY);
    expect(parseOpaqueMutatePolicy('REFUSE')).toBe(DEFAULT_OPAQUE_MUTATE_POLICY);
    expect(parseOpaqueMutatePolicy(undefined)).toBe(DEFAULT_OPAQUE_MUTATE_POLICY);
    expect(parseOpaqueMutatePolicy(false)).toBe(DEFAULT_OPAQUE_MUTATE_POLICY);
  });

  it('reads both phase settings from one profile', () => {
    expect(workspaceWorkflowGate({ workflowGate: { mutate: 'require_preparation', mutateOpaque: 'refuse' } }))
      .toEqual({ mutate: 'require_preparation', mutateOpaque: 'refuse' });
    // The policy alone does not turn the phase on: the mode keeps its default.
    expect(workspaceWorkflowGate({ workflowGate: { mutateOpaque: 'refuse' } }))
      .toEqual({ mutate: DEFAULT_MUTATE_MODE, mutateOpaque: 'refuse' });
    expect(workspaceWorkflowGate({})).toEqual({ mutate: DEFAULT_MUTATE_MODE, mutateOpaque: DEFAULT_OPAQUE_MUTATE_POLICY });
    expect(workspaceWorkflowGate({ workflowGate: [] })).toEqual({ mutate: DEFAULT_MUTATE_MODE, mutateOpaque: DEFAULT_OPAQUE_MUTATE_POLICY });
  });

  it('admits an opaque mutation under allow and refuses it under refuse', () => {
    expect(evaluateOpaqueMutateGate({ policy: 'allow', reason: 'command' })).toEqual({ allowed: true });
    expect(evaluateOpaqueMutateGate({ policy: 'refuse', reason: 'command' }))
      .toEqual({ allowed: false, code: 'opaque_mutation', reason: 'command' });
    expect(evaluateOpaqueMutateGate({ policy: 'refuse', reason: 'unresolved' }))
      .toEqual({ allowed: false, code: 'opaque_mutation', reason: 'unresolved' });
  });

  it('names the tool, the missing subject and both ways out in the refusal', () => {
    const command = describeOpaqueMutateRefusal('shell', 'command');
    expect(command).toContain('shell mutates by running a command');
    expect(command).toContain('workflowGate.mutateOpaque is refuse');
    expect(command).toContain('prepare_code_change');
    expect(command).toContain('allow');

    const unresolved = describeOpaqueMutateRefusal('restore_deleted_file', 'unresolved');
    expect(unresolved).toContain('restore_deleted_file names a stored subject this workspace cannot resolve');
    expect(unresolved).not.toContain('running a command');
  });

  it('records the admission as a decision, not as ordinary traffic', () => {
    const note = describeOpaqueMutateAdmission('git', 'command');
    expect(note).toContain('admitted git');
    expect(note).toContain('no prepared path');
    expect(note).toContain('workflowGate.mutateOpaque is allow');
  });
});

describe('opaque mutation tools', () => {
  it('routes the command-shaped tools and leaves the rest to the mutation policy', () => {
    // The phase sees every tool whose mutation the gateway cannot turn into a
    // path. A tool that is removed from this list silently stops being covered,
    // so the list is pinned rather than derived.
    expect(['shell', 'wsl_exec', 'git', 'process_start'].filter((tool) => !isOpaqueMutationTool(tool))).toEqual([]);
    expect(['write_file', 'restore_deleted_file', 'mcp_call', 'computer_use', 'process_stop'].filter(isOpaqueMutationTool)).toEqual([]);
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

  it('reads every path a path-naming request spells', () => {
    // One table drives both the extractor and the mutate gate's subject seam, so
    // a tool cannot extract a path on one side and resolve to opaque on the
    // other. This pin is what stops a table entry from extracting nothing.
    expect(codeMutationPaths('edit_file', { path: 'src/a.ts' })).toEqual(['src/a.ts']);
    expect(codeMutationPaths('delete_file', { path: 'src/a.ts' })).toEqual(['src/a.ts']);
    expect(codeMutationPaths('move_file', { sourcePath: 'src/a.ts', destinationPath: 'src/b.ts' })).toEqual(['src/a.ts', 'src/b.ts']);
    expect(codeMutationPaths('copy_file', { sourcePath: 'src/a.ts', destinationPath: 'src/b.ts' })).toEqual(['src/a.ts', 'src/b.ts']);
    expect(codeMutationPaths('apply_patch', { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] })).toEqual(['src/a.ts', 'src/b.ts']);
    expect(codeMutationPaths('lsp_rename', { file: 'src/a.ts' })).toEqual(['src/a.ts']);
    // A request that does not spell its subject extracts nothing, even for a
    // tool the table names.
    expect(codeMutationPaths('write_file', { content: 'x' })).toEqual([]);
    expect(codeMutationPaths('apply_patch', { files: 'src/a.ts' })).toEqual([]);
    expect(codeMutationPaths('shell', { path: 'src/a.ts' })).toEqual([]);
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
