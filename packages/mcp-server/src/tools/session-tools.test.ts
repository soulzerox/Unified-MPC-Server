import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@unified-mpc/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { IncrementalVerifier } from '../incremental-verifier.js';
import { sessionTools } from './session-tools.js';
import type { McpToolContext, McpToolDefinition } from './tool-types.js';

const actor = { clientId: 'test-client', clientName: 'test' };

function findTool(context: McpToolContext, verifier: IncrementalVerifier, name: string): McpToolDefinition {
  const tool = sessionTools(context, verifier).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing tool ${name}`);
  return tool;
}

/** The tracker and git stubs every handoff test shares; only the journal varies. */
function handoffContext(services: Record<string, unknown>): McpToolContext {
  return {
    actor,
    contextEconomy: new ContextEconomyRuntime(),
    services: {
      file: {
        async readFile() {
          return ok({ path: 'docs/PHASE_PROGRESS.md', content: '# Tracker\n## Next chat startup probe\nRUN-SMOKE-42', startLine: 1, endLine: 3 });
        },
      },
      git: {
        async status() {
          return ok({ entries: [{ path: 'packages/mcp-server/src/run-budget.ts', index: ' ', worktree: 'M' }] });
        },
        async diff() {
          return ok({ patch: '', truncated: false });
        },
      },
      ...services,
    },
  } as unknown as McpToolContext;
}

describe('session tools', () => {
  it('creates a same-chat handoff from the real tracker content, git changes, and durable task IDs', async () => {
    const context = {
      actor,
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        file: {
          async readFile() {
            return ok({
              path: 'docs/PHASE_PROGRESS.md',
              content: '# Tracker\n## Next chat startup probe\nRUN-SMOKE-42\n## Current phase\nPhase budget guard',
              startLine: 1,
              endLine: 5,
            });
          },
        },
        git: {
          async status() {
            return ok({ entries: [{ path: 'packages/mcp-server/src/run-budget.ts', index: ' ', worktree: 'M' }] });
          },
          async diff(_actor: unknown, _workspaceId: string, request: { staged?: boolean }) {
            return ok({ patch: request.staged === true ? '' : '+RUN-BUDGET-DIFF', truncated: false });
          },
        },
        capabilities: {
          async execute(tool: string, request: { operation?: string }) {
            expect(tool).toBe('shell');
            expect(request.operation).toBe('list');
            return ok({
              tasks: [
                { task_id: 'durable-123', state: 'running', durable: true, started_at: '2026-08-22T01:00:00.000Z' },
                { task_id: 'ephemeral-1', state: 'running', durable: false },
              ],
            });
          },
        },
      },
    } as unknown as McpToolContext;

    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute(
      { workspaceId: 'workspace-1' },
      new AbortController().signal,
    );

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const value = response.value as Record<string, unknown>;
    expect(value.tracker_excerpt).toContain('RUN-SMOKE-42');
    expect(value.changed_files).toContain('packages/mcp-server/src/run-budget.ts');
    expect(value.background_tasks).toEqual([expect.objectContaining({ task_id: 'durable-123', state: 'running' })]);
    expect(value.prompt).toEqual(expect.stringContaining('Continue this run in the same chat'));
    expect(value.prompt).toEqual(expect.stringContaining('durable-123'));
    expect(value.prompt).toEqual(expect.stringContaining('Refresh connector'));
    expect(value.prompt).toEqual(expect.stringContaining('Continue until the requested acceptance is complete'));
    expect(value.prompt).not.toEqual(expect.stringContaining('Before ending'));
  });

  it('derives handoff task state from the journal projection rather than the chat', async () => {
    const requests: unknown[] = [];
    const context = handoffContext({
      workspaceResume: {
        read(request: unknown) {
          requests.push(request);
          return ok({
            workspaceId: 'workspace-1',
            generatedAt: '2026-11-18T03:00:00.000Z',
            cursor: 9,
            truncated: true,
            events: [
              { sequence: 8, operationKind: 'process_start', toolName: 'project_test', phase: 'started', status: 'started', recordedAt: '2026-11-18T02:00:00.000Z', open: true },
              { sequence: 9, operationKind: 'file_read', phase: 'completed', status: 'succeeded', recordedAt: '2026-11-18T02:01:00.000Z', open: false },
            ],
            openReferences: { count: 1, latestSequence: 8 },
          });
        },
      },
    });

    const response = await findTool(context, new IncrementalVerifier(), 'session_handoff').execute(
      { workspaceId: 'workspace-1' },
      new AbortController().signal,
    );

    // The window is workspace-scoped and bounded by the reader's own default, so a
    // handoff cannot widen it or ask for another workspace's journal.
    expect(requests).toEqual([{ workspaceId: 'workspace-1', limit: 20 }]);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const value = response.value as Record<string, unknown>;
    expect(value.workspace_journal).toMatchObject({
      workspaceId: 'workspace-1',
      cursor: 9,
      truncated: true,
      openReferences: { count: 1, latestSequence: 8 },
      events: [
        expect.objectContaining({ sequence: 8, toolName: 'project_test', open: true }),
        expect.objectContaining({ sequence: 9, open: false }),
      ],
    });
    expect(value.prompt).toEqual(expect.stringContaining('#8 process_start project_test (started/started) 2026-11-18T02:00:00.000Z OPEN'));
    expect(value.prompt).toEqual(expect.stringContaining('1 open call(s) in this window; latest row #8'));
    expect(value.prompt).toEqual(expect.stringContaining('window truncated: continue from cursor 9'));
  });

  it('states why journal task state is missing instead of handing over an empty window', async () => {
    const signal = new AbortController().signal;
    const handoff = (services: Record<string, unknown>): ReturnType<McpToolDefinition['execute']> =>
      findTool(handoffContext(services), new IncrementalVerifier(), 'session_handoff').execute({ workspaceId: 'workspace-1' }, signal);

    // No journal in this runtime: the field is absent (no claim) and the prompt says so.
    const absent = await handoff({});
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(absent.value as Record<string, unknown>).not.toHaveProperty('workspace_journal');
    expect((absent.value as Record<string, unknown>).prompt).toEqual(expect.stringContaining('journal is not wired in this runtime'));

    // A journal that throws is "could not be read", never an empty journal.
    const throwing = await handoff({
      workspaceResume: {
        read() {
          throw new Error('journal store is closed');
        },
      },
    });
    expect(throwing.ok).toBe(true);
    if (!throwing.ok) return;
    expect(throwing.value as Record<string, unknown>).toMatchObject({ workspace_journal: null });
    expect((throwing.value as Record<string, unknown>).prompt).toEqual(expect.stringContaining('journal could not be read'));

    // A reader that refuses (rather than throws) is the same "unreadable" state: the
    // handoff still happens, and no empty window is claimed.
    const refused = await handoff({
      workspaceResume: {
        read() {
          return err(appError('RESOURCE_PRESSURE', 'journal store is busy', true));
        },
      },
    });
    expect(refused.ok).toBe(true);
    if (!refused.ok) return;
    expect(refused.value as Record<string, unknown>).toMatchObject({ workspace_journal: null });
    expect((refused.value as Record<string, unknown>).prompt).toEqual(expect.stringContaining('journal could not be read'));

    // An empty window is a fourth, distinct answer: the journal answered and had nothing.
    const empty = await handoff({
      workspaceResume: {
        read() {
          return ok({
            workspaceId: 'workspace-1',
            generatedAt: '2026-11-18T03:00:00.000Z',
            cursor: 0,
            truncated: false,
            events: [],
            openReferences: { count: 0, latestSequence: null },
          });
        },
      },
    });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.value as Record<string, unknown>).toMatchObject({
      workspace_journal: { workspaceId: 'workspace-1', events: [], truncated: false },
    });
    expect((empty.value as Record<string, unknown>).prompt).toEqual(
      expect.stringContaining('no journal rows in this window (an empty journal, not an unreadable one)'),
    );

    // The reader echoes the workspace it was asked for, so a snapshot naming another
    // one cannot be its output: refuse it instead of handing over foreign work.
    const foreign = await handoff({
      workspaceResume: {
        read() {
          return ok({
            workspaceId: 'workspace-2',
            generatedAt: '2026-11-18T03:00:00.000Z',
            cursor: 4,
            truncated: false,
            events: [],
            openReferences: { count: 0, latestSequence: null },
          });
        },
      },
    });
    expect(foreign).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('projects the journal through the resume port and reports a runtime without one', async () => {
    const requests: unknown[] = [];
    const context = {
      actor,
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        workspaceResume: {
          read(request: unknown) {
            requests.push(request);
            return ok({
              workspaceId: 'workspace-1',
              generatedAt: '2026-11-18T03:00:00.000Z',
              cursor: 9,
              truncated: true,
              events: [{
                sequence: 8,
                operationKind: 'process_start',
                phase: 'started',
                status: 'started',
                recordedAt: '2026-11-18T02:00:00.000Z',
                open: true,
              }],
              openReferences: { count: 1, latestSequence: 8 },
            });
          },
        },
      },
    } as unknown as McpToolContext;

    const answered = await findTool(context, new IncrementalVerifier(), 'workspace_resume').execute(
      { workspaceId: 'workspace-1', afterSequence: 7, limit: 2 },
      new AbortController().signal,
    );

    expect(requests).toEqual([{ workspaceId: 'workspace-1', afterSequence: 7, limit: 2 }]);
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(answered.value).toEqual({
      workspaceId: 'workspace-1',
      generatedAt: '2026-11-18T03:00:00.000Z',
      cursor: 9,
      truncated: true,
      events: [expect.objectContaining({ sequence: 8, open: true })],
      openReferences: { count: 1, latestSequence: 8 },
    });

    // A runtime with no journal must say so: an empty event list would read as
    // "nothing happened in this workspace", which is the wrong answer.
    const absent = { actor, contextEconomy: new ContextEconomyRuntime(), services: {} } as unknown as McpToolContext;
    const refused = await findTool(absent, new IncrementalVerifier(), 'workspace_resume').execute(
      { workspaceId: 'workspace-1' },
      new AbortController().signal,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('INTERNAL_ERROR');
  });

  it('fences the fingerprinting on head, and lets a branch rename race it', async () => {
    // One invocation observes the workspace twice. A rename between the two is not a
    // source move; a head change is. Neither case is reachable from a test that only
    // mutates variables between calls, so the fence is exercised here.
    let observeCalls = 0;
    let race: 'branch' | 'head' | 'none' = 'branch';
    const baseHead = 'c'.repeat(40);
    const otherHead = 'd'.repeat(40);
    const context = {
      actor,
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        git: {
          async observeWorkspace() {
            observeCalls += 1;
            const second = observeCalls % 2 === 0;
            return ok({
              repositoryIdentity: 'repo-1',
              gitCommonDirIdentity: 'common-1',
              gitCommonDirFilesystemIdentity: 'fs-1',
              worktreeIdentity: 'worktree-1',
              branch: second && race === 'branch' ? 'feat/renamed-midway' : 'feat/race',
              head: second && race === 'head' ? otherHead : baseHead,
              statusEntries: [{ path: 'src/app.ts', index: ' ', worktree: 'M' }],
              stagedFingerprint: 'staged-1',
              dirtyFingerprint: '+race-diff',
            });
          },
          async status() {
            return ok({ entries: [{ path: 'src/app.ts', index: ' ', worktree: 'M' }] });
          },
          async diff(_actor: unknown, _workspaceId: string, request: { staged?: boolean }) {
            return ok({ patch: request.staged === true ? '' : '+race-diff', truncated: false });
          },
        },
        process: {
          async startProjectCommand() {
            return ok({
              processId: 'typecheck-race',
              executable: 'pnpm',
              args: ['typecheck'],
              cwd: 'E:/repo',
              state: 'exited' as const,
              startedAt: '2026-08-22T01:00:00.000Z',
              finishedAt: '2026-08-22T01:00:01.000Z',
              exitCode: 0,
            });
          },
          async status() {
            throw new Error('status should not be needed for an already-terminal start result');
          },
          async logs() {
            return ok({ entries: [], truncated: false, nextSequence: 1 });
          },
        },
      },
    } as unknown as McpToolContext;
    const tool = findTool(context, new IncrementalVerifier(), 'verify_incremental');
    const signal = new AbortController().signal;

    const renamed = await tool.execute({ workspaceId: 'workspace-1' }, signal);
    race = 'head';
    const moved = await tool.execute({ workspaceId: 'workspace-2' }, signal);

    expect(renamed).toMatchObject({ ok: true, value: { passed: true } });
    expect(moved).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('returns verify_incremental cache hit only while the exact source HEAD and diff stay unchanged', async () => {
    let patch = '+first-diff';
    let head = 'a'.repeat(40);
    let repositoryIdentity = 'repo-1';
    let worktreeIdentity = 'worktree-1';
    let fsIdentity = 'fs-1';
    let branch = 'feat/task-7';
    let starts = 0;
    const context = {
      actor,
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        git: {
          async observeWorkspace() {
            return ok({
              repositoryIdentity,
              gitCommonDirIdentity: 'common-1',
              gitCommonDirFilesystemIdentity: fsIdentity,
              worktreeIdentity,
              branch,
              head,
              statusEntries: [{ path: 'src/app.ts', index: ' ', worktree: 'M' }],
              stagedFingerprint: 'staged-1',
              dirtyFingerprint: patch,
            });
          },
          async status() {
            return ok({ entries: [{ path: 'src/app.ts', index: ' ', worktree: 'M' }] });
          },
          async diff(_actor: unknown, _workspaceId: string, request: { staged?: boolean }) {
            return ok({ patch: request.staged === true ? '' : patch, truncated: false });
          },
        },
        process: {
          async startProjectCommand() {
            starts += 1;
            return ok({
              processId: `typecheck-${starts}`,
              executable: 'pnpm',
              args: ['typecheck'],
              cwd: 'E:/repo',
              state: 'exited' as const,
              startedAt: '2026-08-22T01:00:00.000Z',
              finishedAt: '2026-08-22T01:00:01.000Z',
              exitCode: 0,
            });
          },
          async status() {
            throw new Error('status should not be needed for an already-terminal start result');
          },
          async logs(_actor: unknown, _workspaceId: string, processId: string) {
            return ok({
              entries: [{ sequence: 1, stream: 'stdout' as const, text: `${processId}: typecheck passed` }],
              truncated: false,
              nextSequence: 2,
            });
          },
        },
      },
    } as unknown as McpToolContext;
    const verifier = new IncrementalVerifier();
    const tool = findTool(context, verifier, 'verify_incremental');
    const signal = new AbortController().signal;

    const first = await tool.execute({ workspaceId: 'workspace-1' }, signal);
    const second = await tool.execute({ workspaceId: 'workspace-1' }, signal);
    // A branch rename at the identical head and patches is the same source, so the
    // cached result is still the right answer for it.
    branch = 'feat/task-7-renamed';
    const branchOnly = await tool.execute({ workspaceId: 'workspace-1' }, signal);
    patch = '+second-diff';
    const third = await tool.execute({ workspaceId: 'workspace-1' }, signal);
    head = 'b'.repeat(40);
    const fourth = await tool.execute({ workspaceId: 'workspace-1' }, signal);
    worktreeIdentity = 'worktree-2';
    const otherWorktree = await tool.execute({ workspaceId: 'workspace-1' }, signal);
    repositoryIdentity = 'repo-2';
    const fifth = await tool.execute({ workspaceId: 'workspace-1' }, signal);
    // The path hashes cannot see a repository replaced at the same canonical path, so the
    // git directory's device/inode identity is what tells this case apart.
    fsIdentity = 'fs-2';
    const replacedRepository = await tool.execute({ workspaceId: 'workspace-1' }, signal);
    // The entry was replaced by the new checkout's result, so the next call replays it
    // instead of re-running the typecheck forever against a retained foreign entry.
    const sixth = await tool.execute({ workspaceId: 'workspace-1' }, signal);

    expect(first).toMatchObject({ ok: true, value: { cache: 'miss', reuse: 'unknown', passed: true } });
    expect(second).toMatchObject({ ok: true, value: { cache: 'hit', reuse: 'fresh', passed: true } });
    expect(branchOnly).toMatchObject({ ok: true, value: { cache: 'hit', reuse: 'fresh', passed: true } });
    expect(third).toMatchObject({ ok: true, value: { cache: 'miss', reuse: 'stale', passed: true } });
    expect(fourth).toMatchObject({ ok: true, value: { cache: 'miss', reuse: 'stale', passed: true } });
    // Another worktree or repository under the same workspace id is not out of date,
    // it is unusable: reusing it would report another checkout's result as this one's.
    expect(otherWorktree).toMatchObject({ ok: true, value: { cache: 'miss', reuse: 'not_reusable', passed: true } });
    expect(fifth).toMatchObject({ ok: true, value: { cache: 'miss', reuse: 'not_reusable', passed: true } });
    expect(replacedRepository).toMatchObject({ ok: true, value: { cache: 'miss', reuse: 'not_reusable', passed: true } });
    expect(sixth).toMatchObject({ ok: true, value: { cache: 'hit', reuse: 'fresh', passed: true } });
    expect(verifier.stats()).toMatchObject({ entries: 1, hits: 3, misses: 6, hitRate: 3 / 9 });
    expect(verifier.stats().bytesSaved).toBeGreaterThan(0);
    expect(verifier.invalidate('workspace-1')).toBe(1);
    expect(verifier.stats()).toMatchObject({ entries: 0, hits: 3, misses: 6 });
    expect(starts).toBe(6);
  });
});
