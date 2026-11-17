import { describe, expect, it } from 'vitest';
import { ok } from '@unified-mpc/domain';
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

  it('returns verify_incremental cache hit only while the exact source HEAD and diff stay unchanged', async () => {
    let patch = '+first-diff';
    let head = 'a'.repeat(40);
    let repositoryIdentity = 'repo-1';
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
              worktreeIdentity: 'worktree-1',
              branch: 'feat/task-7',
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
    patch = '+second-diff';
    const third = await tool.execute({ workspaceId: 'workspace-1' }, signal);
    head = 'b'.repeat(40);
    const fourth = await tool.execute({ workspaceId: 'workspace-1' }, signal);
    repositoryIdentity = 'repo-2';
    const fifth = await tool.execute({ workspaceId: 'workspace-1' }, signal);

    expect(first).toMatchObject({ ok: true, value: { cache: 'miss', reuse: 'unknown', passed: true } });
    expect(second).toMatchObject({ ok: true, value: { cache: 'hit', reuse: 'fresh', passed: true } });
    expect(third).toMatchObject({ ok: true, value: { cache: 'miss', reuse: 'stale', passed: true } });
    expect(fourth).toMatchObject({ ok: true, value: { cache: 'miss', reuse: 'stale', passed: true } });
    // Another repository under the same workspace id is not out of date, it is
    // unusable: reusing it would report another checkout's result as this one's.
    expect(fifth).toMatchObject({ ok: true, value: { cache: 'miss', reuse: 'not_reusable', passed: true } });
    expect(verifier.stats()).toMatchObject({ entries: 1, hits: 1, misses: 4, hitRate: 1 / 5 });
    expect(verifier.stats().bytesSaved).toBeGreaterThan(0);
    expect(verifier.invalidate('workspace-1')).toBe(1);
    expect(verifier.stats()).toMatchObject({ entries: 0, hits: 1, misses: 4 });
    expect(starts).toBe(4);
  });
});
