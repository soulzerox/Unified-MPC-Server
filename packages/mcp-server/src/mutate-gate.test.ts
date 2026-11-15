import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPAQUE_MUTATION_TOOL_NAMES, codeMutationPaths, isOpaqueMutationTool, isPathExtractorTool, isRestoreMutationTool } from './harness-runtime.js';
import { UPGRADE_TOOL_CATALOG } from './upgrade-catalog.js';
import { ALWAYS_CONFIRM_MUTATION_TOOLS } from './tool-registry.js';
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
    expect(evaluateOpaqueMutateGate({ policy: 'allow', reason: 'shape' })).toEqual({ allowed: true });
    expect(evaluateOpaqueMutateGate({ policy: 'refuse', reason: 'shape' }))
      .toEqual({ allowed: false, code: 'opaque_mutation', reason: 'shape' });
    expect(evaluateOpaqueMutateGate({ policy: 'refuse', reason: 'unresolved' }))
      .toEqual({ allowed: false, code: 'opaque_mutation', reason: 'unresolved' });
  });

  it('names the tool, the missing subject and both ways out in the refusal', () => {
    const command = describeOpaqueMutateRefusal('shell', 'shape');
    expect(command).toContain('shell does not name a file the phase can turn into a preparation');
    expect(command).not.toContain('running a command');
    expect(command).toContain('workflowGate.mutateOpaque is refuse');
    expect(command).toContain('prepare_code_change');
    expect(command).toContain('allow');
    // `office` names its target, but not in a field the extractor table answers
    // for, so the same sentence has to describe it without calling it a command.
    expect(describeOpaqueMutateRefusal('office', 'shape'))
      .toContain('office does not name a file the phase can turn into a preparation');
    // `process_stop` has no path-bearing form at all, so the sentence offers the
    // preparation as a condition to meet rather than a tool to switch to.
    expect(describeOpaqueMutateRefusal('process_stop', 'shape'))
      .toContain('express the change as a tool whose request names the file it writes');

    const unresolved = describeOpaqueMutateRefusal('restore_deleted_file', 'unresolved');
    expect(unresolved).toContain('restore_deleted_file names a stored subject this workspace cannot resolve');
    expect(unresolved).not.toContain('running a command');
    // Switching tools would abandon the restore, not resolve it, so the way out
    // for an unresolvable subject is to name one this workspace can resolve.
    expect(unresolved).toContain('name a subject this workspace can resolve');
    expect(unresolved).not.toContain('prepare_code_change');
  });

  it('records the admission as a decision, not as ordinary traffic', () => {
    const note = describeOpaqueMutateAdmission('git', 'shape');
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
 * naming three of the four. The list is gone. The phase decides every mutation
 * it cannot turn into a path, derived from the registry's own
 * `LOCAL_MUTATION_TOOLS`, `HOST_MUTATION_TOOLS`, `LOCAL_OUTPUT_REPLACEMENT_TOOLS`
 * and `ALIASED_WORK_MUTATION_TOOLS`, so a tool added there extends the phase and
 * there is no second list to forget. What it delegates is a list of effects,
 * each with a reason, pinned against the registry catalog below.
 */
describe('the phase reach is derived from the mutation sets', () => {
  const doc = readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'docs', 'WORKFLOW_GATE.md'), 'utf8');

  it('decides exactly the mutations it cannot turn into a path', () => {
    // The expected reach is written out rather than recomputed: an assertion
    // that rebuilds the production expression compares the reach with itself and
    // cannot fail when a tool is silently dropped from it.
    expect(OPAQUE_MUTATION_TOOL_NAMES).toEqual([
      'agent_swarm_run', 'audio', 'codex_run', 'codex_stop', 'delegate', 'delegate_cancel',
      'docx_merge', 'git', 'git_publish', 'git_worktree_remove', 'git_worktree_spawn', 'office',
      'office_ppt', 'parallel_delegate', 'process_start', 'process_stop', 'publish_approve',
      'scheduler', 'screen_record', 'self_heal_apply', 'shell', 'task_cancel', 'task_create', 'wsl_exec',
    ]);
  });

  it('decides the work a tool name hides, not just the name it was copied from', () => {
    // `task_create` runs an argv through the same shell runtime as `shell`, and
    // `delegate` starts the same provider work as `agent_swarm_run`. A strict
    // workspace refused one spelling and admitted the other while these were
    // outside the reach.
    for (const tool of ['task_create', 'task_cancel', 'delegate', 'parallel_delegate', 'delegate_cancel']) {
      expect(isOpaqueMutationTool(tool), tool).toBe(true);
    }
  });

  it('leaves path tools, restores, gateway calls and desktop effects alone', () => {
    // Explicit names, not a re-run of the derivation: these are the boundaries
    // the reach is defined by, and a dropped exclusion must fail here.
    for (const tool of [
      'write_file', 'edit_file', 'delete_file', 'move_file', 'copy_file', 'apply_patch', 'lsp_rename',
      'restore_deleted_file', 'restore_recovery_item', 'restore_checkpoint',
    ]) {
      expect(isOpaqueMutationTool(tool), tool).toBe(false);
    }
    for (const tool of [
      'mcp_call', 'computer_use', 'web_fetch', 'dom_cdp', 'accessibility', 'input_event',
      'ui_target_action', 'window', 'clipboard', 'notification',
      'project_dev', 'project_test', 'project_lint', 'project_typecheck', 'project_build',
    ]) {
      expect(isOpaqueMutationTool(tool), tool).toBe(false);
    }
  });

  it('decides every catalog tool declared non-read, or records why it does not', () => {
    // The registry's own catalog is an oracle independent of the four derivation
    // inputs, so this can fail when a tool is added to the catalog and never
    // reaches the phase. The always-confirm list above could not: it never held
    // `task_create`, which is how the shell alias left the phase unnoticed.
    const configuredCommands = new Set(['recipe_run', 'run_affected_tests', 'benchmark_run']);
    const hostAbsent = new Set(['sandbox_exec', 'debug_attach', 'debug_step']);
    const eventStream = new Set(['event_watch']);
    const extensionState = new Set([
      'cache_clear', 'cache_invalidate', 'hook_register', 'hook_remove', 'plugin_install',
      'plugin_enable', 'plugin_disable', 'plugin_remove', 'session_checkpoint',
      'tool_schema_register', 'project_profile_set', 'skills_import',
    ]);
    const exceptions = new Map<string, Set<string>>([
      ['a command the workspace configured', configuredCommands],
      ['a provider this host does not have', hostAbsent],
      ['an event-log subscription', eventStream],
      ['fixed extension state, not caller-supplied work', extensionState],
    ]);
    const nonRead = UPGRADE_TOOL_CATALOG.filter((entry) => entry.permission !== 'READ'
      && entry.deliveryState !== 'planned' && entry.deliveryState !== 'feature_disabled');
    expect(nonRead.length).toBeGreaterThan(20);
    for (const entry of nonRead) {
      const decided = isOpaqueMutationTool(entry.name) || isPathExtractorTool(entry.name) || isRestoreMutationTool(entry.name);
      if (decided) continue;
      const reason = [...exceptions].find(([, names]) => names.has(entry.name));
      expect(reason?.[0], `${entry.name} (${entry.permission}) is neither decided nor explained`).toBeDefined();
    }
    // A stale exception would quietly excuse a tool that has since joined the
    // reach, so each group has to name real, non-read, undecided catalog tools.
    for (const [reason, names] of exceptions) {
      for (const name of names) {
        const entry = UPGRADE_TOOL_CATALOG.find((candidate) => candidate.name === name);
        expect(entry, `${name} (${reason})`).toBeDefined();
        expect(entry?.permission, name).not.toBe('READ');
        expect(isOpaqueMutationTool(name) || isPathExtractorTool(name) || isRestoreMutationTool(name), name).toBe(false);
      }
    }
  });

  it('decides every mutation the registry always confirms', () => {
    // An independent list, not another view of the input sets: a new tool
    // that mutates enough to demand confirmation has to be decided by the phase
    // or named as a delegated effect here.
    const delegated = new Set([
      'mcp_call', 'web_fetch', 'dom_cdp', 'computer_use', 'accessibility', 'input_event',
      'ui_target_action', 'window', 'clipboard', 'cancel_goal', 'cancel_scheduled_continuation',
    ]);
    for (const tool of ALWAYS_CONFIRM_MUTATION_TOOLS) {
      if (delegated.has(tool)) continue;
      expect(isOpaqueMutationTool(tool) || isPathExtractorTool(tool) || isRestoreMutationTool(tool), tool).toBe(true);
    }
  });

  it('states the rule once in the document instead of listing the tools', () => {
    expect(doc.match(/The phase decides every mutation it cannot\s+turn into a\s+path, except the effects it\s+delegates/g)).toHaveLength(1);
    expect(doc).toContain('LOCAL_MUTATION_TOOLS');
    expect(doc).toContain('HOST_MUTATION_TOOLS');
    expect(doc).toContain('LOCAL_OUTPUT_REPLACEMENT_TOOLS');
    expect(doc).toContain('ALIASED_WORK_MUTATION_TOOLS');
  });
});
