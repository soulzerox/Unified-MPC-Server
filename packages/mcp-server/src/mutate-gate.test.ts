import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DELEGATED_EFFECT_TOOLS, codeMutationPaths, isPathExtractorTool, isPhaseDecidedMutation, isRestoreMutationTool } from './harness-runtime.js';
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

  it('names the tool, the missing subject and the ways out in the refusal', () => {
    const command = describeOpaqueMutateRefusal('shell', 'shape');
    expect(command).toContain('shell does not name a file the phase can turn into a preparation');
    expect(command).not.toContain('running a command');
    expect(command).toContain('workflowGate.mutateOpaque is refuse');
    // Relaxing the setting is the one way out that always exists, so every shape
    // refusal names it first and the path-bearing form only as a condition.
    expect(command).toContain('set workflowGate.mutateOpaque back to allow');
    expect(command).toContain('if the change has a form whose request names the file it writes');
    expect(command).toContain('prepare_code_change');
    // `office` names its target, but not in a field the extractor table answers
    // for, so the same sentence has to describe it without calling it a command.
    expect(describeOpaqueMutateRefusal('office', 'shape'))
      .toContain('office does not name a file the phase can turn into a preparation');
    // `process_stop` has no path-bearing form at all, so the sentence offers the
    // preparation as a condition to meet rather than a tool to switch to: this is
    // the case that made the unconditional phrasing wrong.
    const stop = describeOpaqueMutateRefusal('process_stop', 'shape');
    expect(stop).toContain('if the change has a form whose request names the file it writes');
    expect(stop).not.toContain('express the change as a tool whose request names the file it writes and prepare_code_change');

    const unresolved = describeOpaqueMutateRefusal('restore_deleted_file', 'unresolved');
    expect(unresolved).toContain('restore_deleted_file names a stored subject this workspace cannot resolve');
    expect(unresolved).not.toContain('running a command');
    // Switching tools would abandon the restore, not resolve it, so the way out
    // for an unresolvable subject is to name one this workspace can resolve.
    expect(unresolved).toContain('name a subject this workspace can resolve');
    expect(unresolved).toContain('set workflowGate.mutateOpaque back to allow');
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
 * The reach used to be a list of names, restated in prose, and every review of
 * this step found the same defect in it: one name short. A union of "tools that
 * mutate" sets cannot be complete, because the registry declares tools in more
 * than one place. The reach is now the complement of a short delegation list, so
 * the only tools the phase misses are the ones somebody chose to delegate and
 * wrote down with a reason.
 */
describe('the phase decides every mutation it was not told to delegate', () => {
  const doc = readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'docs', 'WORKFLOW_GATE.md'), 'utf8');

  it('delegates exactly these effects, and nothing else', () => {
    // The whole exception list, written out rather than recomputed. Adding a name
    // here is a policy decision, so it has to show up in a diff that says so.
    expect([...DELEGATED_EFFECT_TOOLS].sort()).toEqual([
      'accessibility', 'benchmark_run', 'cancel_goal', 'cancel_scheduled_continuation', 'clipboard',
      'computer_use', 'dom_cdp', 'input_event', 'mcp_call', 'notification', 'project_build',
      'project_dev', 'project_lint', 'project_test', 'project_typecheck', 'recipe_run',
      'run_affected_tests', 'ui_target_action', 'web_fetch', 'window',
    ]);
  });

  it('decides the work a tool name hides, not just the name it was copied from', () => {
    // Every one of these mutates, and every one of them was outside the phase at
    // some point in this step's review: a scheduled task, a recording, a
    // background shell task, a goal rebase, a merge, an install.
    for (const tool of [
      'shell', 'wsl_exec', 'git', 'git_publish', 'publish_approve', 'process_start', 'process_stop',
      'codex_run', 'codex_stop', 'agent_swarm_run', 'office', 'office_ppt', 'docx_merge',
      'self_heal_apply', 'git_worktree_spawn', 'git_worktree_remove', 'scheduler', 'audio',
      'screen_record', 'task_create', 'task_cancel', 'delegate', 'parallel_delegate',
      'delegate_cancel', 'guarded_pr_merge', 'rebase_goal_workspace', 'merge_verification_run',
      'verify_incremental', 'mcp_install', 'skills_install', 'plugin_install', 'hook_register',
      'cache_clear', 'session_checkpoint', 'tool_schema_register', 'project_profile_set',
    ]) {
      expect(isPhaseDecidedMutation(tool), tool).toBe(true);
    }
  });

  it('keeps the delegated effects out of the path and restore routes', () => {
    // A delegated effect stays with the mutation policy's approval gate, so it is
    // not an opaque subject — its reason is that the phase does not decide it, not
    // that it would have no subject. The disjointness keeps the two explanations
    // from overlapping: the seam checks `codeMutationPaths` before the delegated
    // predicate, so a name in both lists would be read as delegated while the path
    // route still decides its path-bearing requests — the reach would depend on
    // which branch ran first. That the path and restore tools do extract their
    // subject is pinned where it is observable, by the `codeMutationPaths` and
    // `resolveMutationSubjects` cases in this file and in `mutation-subject.test.ts`.
    for (const tool of DELEGATED_EFFECT_TOOLS) {
      expect(isPathExtractorTool(tool), tool).toBe(false);
      expect(isRestoreMutationTool(tool), tool).toBe(false);
    }
  });

  it('decides every catalog mutation it does not name as a configured command', () => {
    // The catalog is one of the places the registry declares tools, and it is the
    // one that names a severity, so it is a second opinion about what mutates.
    // Three of the eight configured commands are catalog mutations, and the pin
    // says so literally: a configured command that leaves the catalog fails here
    // rather than disappearing with it.
    const configuredCommands = ['project_dev', 'project_test', 'project_lint', 'project_typecheck', 'project_build', 'recipe_run', 'run_affected_tests', 'benchmark_run'];
    const nonRead = UPGRADE_TOOL_CATALOG.filter((entry) => entry.permission !== 'READ'
      && entry.deliveryState !== 'planned' && entry.deliveryState !== 'feature_disabled');
    expect(nonRead.length).toBeGreaterThan(20);
    expect(configuredCommands.filter((name) => nonRead.some((entry) => entry.name === name))).toEqual([
      'recipe_run', 'run_affected_tests', 'benchmark_run',
    ]);
    // Every catalog mutation that is delegated has to be one of the configured
    // commands, and every configured command the catalog names has to be
    // delegated: the two directions are checked separately so a new delegation and
    // a missing one are different failures.
    for (const entry of nonRead) {
      if (!DELEGATED_EFFECT_TOOLS.has(entry.name)) continue;
      expect(configuredCommands, `${entry.name} is delegated but is not a configured command`).toContain(entry.name);
    }
    for (const name of ['recipe_run', 'run_affected_tests', 'benchmark_run']) {
      expect(DELEGATED_EFFECT_TOOLS.has(name), `${name} runs the workspace's command and must be delegated`).toBe(true);
    }
  });

  it('leaves the phase every mutation the registry always confirms, except the gateway and the stops', () => {
    // The registry's confirmation list is a third opinion: it asks before a call
    // that writes. Handing one of those back to the policy as a delegated effect
    // would return the strict posture's decision to the gate it is stricter than,
    // so the intersection is compared with the names whose reason covers a
    // confirmation — a gateway call, a desktop tool, a stop — and nothing else.
    const expected = [
      'accessibility', 'cancel_goal', 'cancel_scheduled_continuation', 'clipboard', 'computer_use',
      'dom_cdp', 'input_event', 'mcp_call', 'ui_target_action', 'web_fetch', 'window',
    ];
    expect([...ALWAYS_CONFIRM_MUTATION_TOOLS].filter((tool) => DELEGATED_EFFECT_TOOLS.has(tool)).sort()).toEqual(expected);
  });

  it('states the rule once in the document instead of listing the tools', () => {
    expect(doc.match(/The phase decides every mutation it\s+cannot\s+turn\s+into\s+a\s+path, except the effects it\s+delegates/g)).toHaveLength(1);
    expect(doc).toContain('DELEGATED_EFFECT_TOOLS');
    for (const retired of ['OPAQUE_MUTATION_TOOL_NAMES', 'HOST_MUTATION_TOOLS', 'ALIASED_WORK_MUTATION_TOOLS', 'LOCAL_MUTATION_TOOLS', 'LOCAL_OUTPUT_REPLACEMENT_TOOLS']) {
      expect(doc, retired).not.toContain(retired);
    }
  });
});
