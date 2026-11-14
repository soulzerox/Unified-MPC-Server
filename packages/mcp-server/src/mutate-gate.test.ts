import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_MUTATION_TOOLS, OPAQUE_MUTATION_TOOL_NAMES, codeMutationPaths, isPathExtractorTool, isRestoreMutationTool } from './harness-runtime.js';
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
    // Switching tools would abandon the restore, not resolve it, so the way out
    // for an unresolvable subject is to name one this workspace can resolve.
    expect(unresolved).toContain('name a subject this workspace can resolve');
    expect(unresolved).not.toContain('prepare_code_change');
  });

  it('records the admission as a decision, not as ordinary traffic', () => {
    const note = describeOpaqueMutateAdmission('git', 'command');
    expect(note).toContain('admitted git');
    expect(note).toContain('no prepared path');
    expect(note).toContain('workflowGate.mutateOpaque is allow');
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

/**
 * The reach of the phase used to be a list of four names, restated in prose in
 * several places, and five reviews found the same defect in it: one paragraph
 * naming three of the four. The list is gone. The phase decides every local
 * mutation whose request names no path, derived from the registry's own
 * `LOCAL_MUTATION_TOOLS`, so a tool added there extends the phase and there is
 * no second list to forget. The document states that rule once, by name.
 */
describe('the phase reach is derived from the local mutation set', () => {
  const doc = readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'docs', 'WORKFLOW_GATE.md'), 'utf8');

  it('decides every local mutation that names no path, and nothing else', () => {
    expect([...OPAQUE_MUTATION_TOOL_NAMES]).toEqual(
      [...LOCAL_MUTATION_TOOLS].filter((tool) => !isPathExtractorTool(tool) && !isRestoreMutationTool(tool)).sort(),
    );
    // A path extractor and a restore name their subject another way, so they
    // never arrive at the opaque decision.
    expect(OPAQUE_MUTATION_TOOL_NAMES.filter(isPathExtractorTool)).toEqual([]);
    expect(OPAQUE_MUTATION_TOOL_NAMES.filter(isRestoreMutationTool)).toEqual([]);
    // The families 5b-2 left out now reach the phase.
    for (const tool of ['git_publish', 'codex_run', 'agent_swarm_run', 'self_heal_apply', 'office', 'docx_merge', 'process_stop']) {
      expect(OPAQUE_MUTATION_TOOL_NAMES, tool).toContain(tool);
    }
    // Remote, desktop and gateway-mediated effects are not local mutations, so
    // refusing `mcp_call` cannot also refuse the reads it carries.
    for (const tool of ['mcp_call', 'computer_use', 'web_fetch', 'dom_cdp', 'project_test']) {
      expect(OPAQUE_MUTATION_TOOL_NAMES, tool).not.toContain(tool);
    }
  });

  it('states the rule once in the document instead of listing the tools', () => {
    expect(doc.match(/The phase decides every local mutation that names no\s+path/g)).toHaveLength(1);
    expect(doc).toContain('LOCAL_MUTATION_TOOLS');
  });
});
