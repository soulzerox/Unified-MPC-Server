import { describe, expect, it } from 'vitest';
import { ok } from '@unified-mpc/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { gitTools } from './git-tools.js';
import type { McpToolContext } from './tool-types.js';

describe('gitTools', () => {
  it('forwards the invocation cancellation signal to every Git service call', async () => {
    const observedSignals: Array<AbortSignal | undefined> = [];
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        git: {
          async status(_actor: unknown, _workspaceId: string, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({ entries: [] });
          },
          async diff(_actor: unknown, _workspaceId: string, _request: unknown, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({ patch: '', truncated: false });
          },
          async log(_actor: unknown, _workspaceId: string, _request: unknown, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({ entries: [], truncated: false });
          },
          async run(_actor: unknown, _request: unknown, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({ exitCode: 0, stdout: '', stderr: '' });
          },
          async publishPreflight(_actor: unknown, _request: unknown, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({
              remote: 'origin',
              branch: 'goal/publish',
              head: '0'.repeat(40),
              defaultBranches: [],
              protectedBranch: false,
              targets: ['https://example.invalid'],
              runtime: { ready: true },
              approval: 'missing',
            });
          },
          async approvePublish(_actor: unknown, _request: unknown, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({
              approvalId: 'approval-1',
              workspaceId: 'workspace-1',
              remote: 'origin',
              branch: 'goal/publish',
              expectedSha: '0'.repeat(40),
              approvedBy: 'test',
              approvedAt: 0,
              expiresAt: 1,
            });
          },
          async publish(_actor: unknown, _request: unknown, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({ remote: 'origin', branch: 'goal/publish', sha: '0'.repeat(40), targets: ['file'], approvalId: 'approval-1' });
          },
        },
      },
    } as unknown as McpToolContext;
    const tools = gitTools(context);
    const signal = new AbortController().signal;
    const calls: ReadonlyArray<readonly [string, unknown]> = [
      ['git_status', { workspaceId: 'workspace-1' }],
      ['git_diff', { workspaceId: 'workspace-1' }],
      ['git_log', { workspaceId: 'workspace-1' }],
      ['git', { args: ['status'], workspaceId: 'workspace-1', userConfirmed: true }],
      ['git_publish_preflight', { remote: 'origin', branch: 'goal/publish', workspaceId: 'workspace-1' }],
      ['publish_approve', { remote: 'origin', branch: 'goal/publish', expectedSha: '0'.repeat(40), workspaceId: 'workspace-1', userConfirmed: true }],
      ['git_publish', { remote: 'origin', branch: 'goal/publish', expectedSha: '0'.repeat(40), approvalId: 'approval-1', workspaceId: 'workspace-1' }],
    ];

    for (const [name, input] of calls) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`Missing Git tool: ${name}`);
      await tool.execute(input, signal);
    }

    expect(observedSignals).toEqual([signal, signal, signal, signal, signal, signal, signal]);
  });

  it('rejects force, tag, delete, mirror and option-shaped publish forms at the schema', () => {
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: {},
    } as unknown as McpToolContext;
    const tools = gitTools(context);
    const sha = 'a'.repeat(40);
    const approve = tools.find((candidate) => candidate.name === 'publish_approve');
    const publish = tools.find((candidate) => candidate.name === 'git_publish');
    if (approve === undefined || publish === undefined) throw new Error('Missing publish tools');
    const binding = { remote: 'origin', branch: 'goal/publish', expectedSha: sha };

    for (const extra of [{ force: true }, { tags: true }, { delete: true }, { all: true }, { mirror: true }]) {
      expect(approve.parse({ ...binding, userConfirmed: true, ...extra })).toMatchObject({ ok: false });
      expect(publish.parse({ ...binding, approvalId: 'approval-1', ...extra })).toMatchObject({ ok: false });
    }
    expect(approve.parse({ ...binding, expectedSha: sha.toUpperCase(), userConfirmed: true })).toMatchObject({ ok: false });
    expect(approve.parse({ ...binding, expectedSha: sha.slice(0, 7), userConfirmed: true })).toMatchObject({ ok: false });
    expect(publish.parse({ ...binding, approvalId: '' })).toMatchObject({ ok: false });
    expect(approve.parse({ ...binding, userConfirmed: true })).toMatchObject({ ok: true });
    expect(publish.parse({ ...binding, approvalId: 'approval-1' })).toMatchObject({ ok: true });
  });
});
