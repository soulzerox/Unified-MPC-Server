import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@unified-mpc/domain';
import { permissionProfiles, type PermissionProfile } from '@unified-mpc/permissions';
import { ToolRegistry, type McpApplicationServices, type WorkspaceScope } from './tool-registry.js';

const actor = { clientId: 'client-1', clientName: 'test', sessionId: 'session-a' };
type GoalRequestCancellation = NonNullable<McpApplicationServices['goalRequestCancellation']>;

function activeFence(): ReturnType<typeof ok> {
  return ok({ goalId: 'goal-1', leaseGeneration: 2 });
}

describe('scheduled continuation mutation fence', () => {
  it('blocks file mutation without the current goalLease proof before the file handler executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const writeFile = vi.fn().mockResolvedValue(ok({ path: 'src/file.ts', bytesWritten: 1 }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      file: { writeFile },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'x',
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('blocks Git mutation without the current goalLease proof before the Git handler executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const run = vi.fn().mockResolvedValue(ok({ exitCode: 0, stdout: '', stderr: '' }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      git: { run },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('git', {
      workspaceId: 'workspace-1',
      args: ['add', 'src/file.ts'],
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(run).not.toHaveBeenCalled();
  });

  it('blocks process execution without the current goalLease proof before the process handler executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const start = vi.fn().mockResolvedValue(ok({ processId: 'process-1' }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      process: { start },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('process_start', {
      workspaceId: 'workspace-1',
      executable: 'node',
      args: ['--version'],
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(start).not.toHaveBeenCalled();
  });

  it('blocks detected project commands without the current goalLease proof before preview or process start', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const previewProjectCommand = vi.fn().mockResolvedValue(ok({ executable: 'pnpm', args: ['build'] }));
    const startProjectCommand = vi.fn().mockResolvedValue(ok({ processId: 'process-project' }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      process: { previewProjectCommand, startProjectCommand },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('project_build', {
      workspaceId: 'workspace-1',
      userConfirmed: true,
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(previewProjectCommand).not.toHaveBeenCalled();
    expect(startProjectCommand).not.toHaveBeenCalled();
  });

  it('blocks incremental verification without the current goalLease proof before it can launch a typecheck', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('verify_incremental', {
      workspaceId: 'workspace-1',
      userConfirmed: true,
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
  });

  it('blocks delegated Codex mutation without the current goalLease proof before the Codex backend executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const run = vi.fn().mockResolvedValue(ok({ codexTaskId: 'codex-1' }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      codex: { run },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, { codexToolsEnabled: true }).invoke('codex_run', {
      workspaceId: 'workspace-1',
      instruction: 'edit the project',
      userConfirmed: true,
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(run).not.toHaveBeenCalled();
  });

  it('blocks Computer Use mutation without the current goalLease proof before any capability executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const execute = vi.fn().mockResolvedValue(ok({ clicked: true }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      capabilities: { execute },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('computer_use', {
      workspaceId: 'workspace-1',
      action: 'click',
      target: { x: 10, y: 20 },
      userConfirmed: true,
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(execute).not.toHaveBeenCalled();
  });

  it('blocks opaque child MCP mutation without the current goalLease proof before host approval or child dispatch', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const begin = vi.fn();
    const hostApproval = vi.fn().mockResolvedValue(true);
    const callMcpTool = vi.fn().mockResolvedValue(ok({ ok: true }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence, begin, heartbeat: vi.fn(), end: vi.fn() },
      extensions: { callMcpTool },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor, {
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope> => ({ workspaceId: 'workspace-1', rootPath: '/workspace' }),
      profileProvider: (): PermissionProfile => permissionProfiles.balanced,
      hostMutationApprovalProvider: hostApproval,
    });

    const response = await registry.invoke('mcp_call', {
      server: 'playwright', tool: 'browser_click', arguments: { element: 'Save', ref: 'e17' },
      descriptorFingerprint: 'a'.repeat(64), catalogFingerprint: 'b'.repeat(64), userConfirmed: true,
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(hostApproval).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('admits opaque child MCP mutation only with the current goal lease and closes the fenced call', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const begin = vi.fn().mockResolvedValue(ok({ goalId: 'goal-1', leaseGeneration: 2 }));
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    const hostApproval = vi.fn().mockResolvedValue(true);
    const callMcpTool = vi.fn().mockResolvedValue(ok({ ok: true }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence, begin, heartbeat, end },
      extensions: { callMcpTool },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor, {
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope> => ({ workspaceId: 'workspace-1', rootPath: '/workspace' }),
      profileProvider: (): PermissionProfile => permissionProfiles.balanced,
      hostMutationApprovalProvider: hostApproval,
    });
    const goalLease = { goalId: 'goal-1', leaseToken: 'current-token', leaseGeneration: 2 };

    const response = await registry.invoke('mcp_call', {
      server: 'playwright', tool: 'browser_click', arguments: { element: 'Save', ref: 'e17' },
      descriptorFingerprint: 'a'.repeat(64), catalogFingerprint: 'b'.repeat(64), userConfirmed: true, goalLease,
    });

    expect(response.isError).not.toBe(true);
    expect(begin).toHaveBeenCalledWith(actor, 'workspace-1', expect.any(String), goalLease);
    expect(hostApproval).toHaveBeenCalledTimes(1);
    expect(callMcpTool).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('detaches an admitted durable goal mutation from parent request abort but still honors explicit goal cancellation', async (): Promise<void> => {
    let registeredController: AbortController | undefined;
    let registeredRequestId: string | undefined;
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const cancellation = {
      register(_goalId: string, requestId: string, controller: AbortController): ReturnType<GoalRequestCancellation['register']> {
        registeredController = controller;
        registeredRequestId = requestId;
        return {
          accepted: true,
          done,
          release(): void { resolveDone?.(); },
        };
      },
      async cancelForGoal(goalId: string): ReturnType<GoalRequestCancellation['cancelForGoal']> {
        const requested = registeredController === undefined ? 0 : 1;
        registeredController?.abort();
        if (requested > 0) await done;
        return {
          goalId,
          requested,
          stopped: requested,
          remaining: 0,
          timedOut: false,
          requestIds: registeredRequestId === undefined ? [] : [registeredRequestId],
        };
      },
    };
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const begin = vi.fn().mockResolvedValue(ok({ goalId: 'goal-1', leaseGeneration: 2 }));
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    let executionSignal: AbortSignal | undefined;
    let started = false;
    const writeFile = vi.fn(async (_actor, _workspaceId, _request, signal?: AbortSignal) => {
      executionSignal = signal;
      started = true;
      return new Promise<ReturnType<typeof ok>>((resolve) => {
        signal?.addEventListener('abort', () => {
          resolve(ok({ path: 'src/file.ts', bytesWritten: 0 }));
        }, { once: true });
      });
    });
    const services = {
      goalMutationFence: { inspectWorkspaceFence, begin, heartbeat, end },
      goalRequestCancellation: cancellation,
      file: { writeFile },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor);
    const parent = new AbortController();

    const pending = registry.invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'durable work',
      goalLease: { goalId: 'goal-1', leaseToken: 'current-token', leaseGeneration: 2 },
    }, undefined, parent.signal);

    for (let attempt = 0; attempt < 20 && !started; attempt += 1) await Promise.resolve();
    expect(started).toBe(true);

    parent.abort();

    await expect(pending).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PROCESS_TIMEOUT' } },
    });
    expect(executionSignal?.aborted).toBe(false);

    await expect(cancellation.cancelForGoal('goal-1')).resolves.toMatchObject({
      requested: 1,
      stopped: 1,
      remaining: 0,
      timedOut: false,
    });
    expect(executionSignal?.aborted).toBe(true);

    for (let attempt = 0; attempt < 20 && end.mock.calls.length === 0; attempt += 1) await Promise.resolve();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('still dispatches an admitted durable mutation when the parent aborts before backend execution starts', async (): Promise<void> => {
    let releaseFence: (() => void) | undefined;
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const begin = vi.fn(async () => new Promise<ReturnType<typeof ok>>((resolve) => {
      releaseFence = (): void => resolve(activeFence());
    }));
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    let executionSignal: AbortSignal | undefined;
    let settleWrite: (() => void) | undefined;
    let started = false;
    const writeFile = vi.fn(async (...args: unknown[]) => {
      executionSignal = args[3] as AbortSignal | undefined;
      started = true;
      return new Promise<ReturnType<typeof ok>>((resolve) => {
        settleWrite = (): void => resolve(ok({ path: 'src/file.ts', bytesWritten: 1 }));
      });
    });
    const services = {
      goalMutationFence: { inspectWorkspaceFence, begin, heartbeat, end },
      file: { writeFile },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor);
    const parent = new AbortController();

    const pending = registry.invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'durable pre-start work',
      goalLease: { goalId: 'goal-1', leaseToken: 'current-token', leaseGeneration: 2 },
    }, undefined, parent.signal);

    for (let attempt = 0; attempt < 20 && begin.mock.calls.length === 0; attempt += 1) await Promise.resolve();
    expect(begin).toHaveBeenCalledTimes(1);
    expect(started).toBe(false);

    parent.abort();
    releaseFence?.();

    await expect(pending).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PROCESS_TIMEOUT' } },
    });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(started).toBe(true);
    expect(executionSignal?.aborted).toBe(false);

    settleWrite?.();
    for (let attempt = 0; attempt < 20 && end.mock.calls.length === 0; attempt += 1) await Promise.resolve();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['test', 'project_test', { workspaceId: 'workspace-1', userConfirmed: true }],
    ['build', 'project_build', { workspaceId: 'workspace-1', userConfirmed: true }],
    ['final integration', 'git', { workspaceId: 'workspace-1', args: ['add', '--', 'src/file.ts'], userConfirmed: true }],
  ] as const)('keeps durable %s execution alive when the parent request aborts mid-phase', async (_phase, toolName, rawInput): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const begin = vi.fn().mockResolvedValue(activeFence());
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    let executionSignal: AbortSignal | undefined;
    let settleOperation: (() => void) | undefined;
    let started = false;
    const hold = async (signal: AbortSignal | undefined): Promise<ReturnType<typeof ok>> => {
      executionSignal = signal;
      started = true;
      return new Promise<ReturnType<typeof ok>>((resolve) => {
        settleOperation = (): void => resolve(ok({ processId: 'phase-process', exitCode: 0, stdout: '', stderr: '' }));
      });
    };
    const services = {
      goalMutationFence: { inspectWorkspaceFence, begin, heartbeat, end },
      process: {
        async previewProjectCommand(...args: unknown[]) {
          return ok({ executable: 'pnpm', args: [String(args[1] ?? 'test')] });
        },
        async startProjectCommand(...args: unknown[]) {
          return hold(args[3] as AbortSignal | undefined);
        },
      },
      git: {
        async run(...args: unknown[]) {
          return hold(args[2] as AbortSignal | undefined);
        },
      },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor);
    const parent = new AbortController();
    const input = {
      ...rawInput,
      goalLease: { goalId: 'goal-1', leaseToken: 'current-token', leaseGeneration: 2 },
    };

    const pending = registry.invoke(toolName, input, undefined, parent.signal);
    for (let attempt = 0; attempt < 20 && !started; attempt += 1) await Promise.resolve();
    expect(started).toBe(true);

    parent.abort();

    await expect(pending).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PROCESS_TIMEOUT' } },
    });
    expect(executionSignal?.aborted).toBe(false);

    settleOperation?.();
    for (let attempt = 0; attempt < 20 && end.mock.calls.length === 0; attempt += 1) await Promise.resolve();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('preserves a completed checkpoint when the next durable phase loses its parent request', async (): Promise<void> => {
    const checkpointGoal = vi.fn().mockResolvedValue(ok({ goalId: 'goal-1', revision: 1, status: 'active' }));
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const begin = vi.fn().mockResolvedValue(activeFence());
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    let executionSignal: AbortSignal | undefined;
    let settleWrite: (() => void) | undefined;
    let started = false;
    const writeFile = vi.fn(async (...args: unknown[]) => {
      executionSignal = args[3] as AbortSignal | undefined;
      started = true;
      return new Promise<ReturnType<typeof ok>>((resolve) => {
        settleWrite = (): void => resolve(ok({ path: 'src/after-checkpoint.ts', bytesWritten: 1 }));
      });
    });
    const services = {
      goals: { checkpointGoal },
      goalMutationFence: { inspectWorkspaceFence, begin, heartbeat, end },
      file: { writeFile },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor);

    const checkpoint = await registry.invoke('checkpoint_goal', {
      goalId: 'goal-1',
      leaseToken: 'current-token',
      expectedRevision: 0,
      currentPhase: 'verification',
      summary: 'Durable progress is persisted before the next phase.',
      stepUpdates: [],
      nextAction: 'Continue final work.',
      blockers: [],
      evidence: [],
      activeTaskIds: [],
    });
    expect(checkpoint.isError).not.toBe(true);
    expect(checkpointGoal).toHaveBeenCalledTimes(1);

    const parent = new AbortController();
    const pending = registry.invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/after-checkpoint.ts',
      content: 'continue after checkpoint',
      goalLease: { goalId: 'goal-1', leaseToken: 'current-token', leaseGeneration: 2 },
    }, undefined, parent.signal);

    for (let attempt = 0; attempt < 20 && !started; attempt += 1) await Promise.resolve();
    expect(started).toBe(true);
    parent.abort();

    await expect(pending).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PROCESS_TIMEOUT' } },
    });
    expect(executionSignal?.aborted).toBe(false);
    expect(checkpointGoal).toHaveBeenCalledTimes(1);

    settleWrite?.();
    for (let attempt = 0; attempt < 20 && end.mock.calls.length === 0; attempt += 1) await Promise.resolve();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('detaches an admitted durable goal mutation when only the response budget expires', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const begin = vi.fn().mockResolvedValue(ok({ goalId: 'goal-1', leaseGeneration: 2 }));
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    let executionSignal: AbortSignal | undefined;
    let settleWrite: (() => void) | undefined;
    const writeFile = vi.fn(async (_actor, _workspaceId, _request, signal?: AbortSignal) => {
      executionSignal = signal;
      return new Promise<ReturnType<typeof ok>>((resolve) => {
        settleWrite = (): void => { resolve(ok({ path: 'src/file.ts', bytesWritten: 1 })); };
      });
    });
    const services = {
      goalMutationFence: { inspectWorkspaceFence, begin, heartbeat, end },
      file: { writeFile },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor, { maxToolDurationMs: 10 });

    const response = await registry.invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'durable work',
      goalLease: { goalId: 'goal-1', leaseToken: 'current-token', leaseGeneration: 2 },
    });

    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PROCESS_TIMEOUT' } },
    });
    expect(executionSignal?.aborted).toBe(false);

    settleWrite?.();
    for (let attempt = 0; attempt < 20 && end.mock.calls.length === 0; attempt += 1) await Promise.resolve();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary unfenced mutation execution tied to the parent request lifetime', async (): Promise<void> => {
    let executionSignal: AbortSignal | undefined;
    let started = false;
    const writeFile = vi.fn(async (_actor, _workspaceId, _request, signal?: AbortSignal) => {
      executionSignal = signal;
      started = true;
      return new Promise<ReturnType<typeof ok>>((resolve) => {
        signal?.addEventListener('abort', () => {
          resolve(ok({ path: 'src/file.ts', bytesWritten: 0 }));
        }, { once: true });
      });
    });
    const registry = new ToolRegistry({ file: { writeFile } } as unknown as McpApplicationServices, actor);
    const parent = new AbortController();

    const pending = registry.invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'request scoped',
    }, undefined, parent.signal);

    for (let attempt = 0; attempt < 20 && !started; attempt += 1) await Promise.resolve();
    expect(started).toBe(true);

    parent.abort();

    await expect(pending).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PROCESS_TIMEOUT' } },
    });
    expect(executionSignal?.aborted).toBe(true);
  });

  it('rejects a stale opaque child MCP lease before child dispatch', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const begin = vi.fn().mockResolvedValue(err(appError('CONFLICT', 'stale goal lease', true)));
    const hostApproval = vi.fn().mockResolvedValue(true);
    const callMcpTool = vi.fn().mockResolvedValue(ok({ ok: true }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence, begin, heartbeat: vi.fn(), end: vi.fn() },
      extensions: { callMcpTool },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor, {
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope> => ({ workspaceId: 'workspace-1', rootPath: '/workspace' }),
      profileProvider: (): PermissionProfile => permissionProfiles.balanced,
      hostMutationApprovalProvider: hostApproval,
    });

    const response = await registry.invoke('mcp_call', {
      server: 'playwright', tool: 'browser_type', arguments: { element: 'Name', text: 'Ada' },
      descriptorFingerprint: 'a'.repeat(64), catalogFingerprint: 'b'.repeat(64), userConfirmed: true,
      goalLease: { goalId: 'goal-1', leaseToken: 'stale-token', leaseGeneration: 1 },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: 'CONFLICT', recoverable: true } });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('does not fence read-only file access', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const readFile = vi.fn().mockResolvedValue(ok({ path: 'src/file.ts', content: 'ok', startLine: 1, endLine: 1 }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      file: { readFile },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('read_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
    });

    expect(response.isError).not.toBe(true);
    expect(readFile).toHaveBeenCalled();
    expect(inspectWorkspaceFence).not.toHaveBeenCalled();
  });

  it('still requires the current goal lease when Full Bypass is active and a rolling fence exists', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const writeFile = vi.fn().mockResolvedValue(ok({ path: 'src/file.ts', bytesWritten: 1 }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      file: { writeFile },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    }).invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'x',
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('preserves ordinary Full Bypass mutation when no rolling goal fence exists', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(ok(null));
    const writeFile = vi.fn().mockResolvedValue(ok({ path: 'src/file.ts', bytesWritten: 1 }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      file: { writeFile },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    }).invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'x',
    });

    expect(response.isError).not.toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale Full Bypass goal lease before the file handler executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const begin = vi.fn().mockResolvedValue(err(appError('CONFLICT', 'Goal lease is no longer valid (stale generation); read the latest goal and reacquire or claim the scheduled continuation before retrying', true)));
    const writeFile = vi.fn().mockResolvedValue(ok({ path: 'src/file.ts', bytesWritten: 1 }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence, begin },
      file: { writeFile },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    }).invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'x',
      goalLease: { goalId: 'goal-1', leaseToken: 'stale-token', leaseGeneration: 1 },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: 'CONFLICT', recoverable: true } });
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(begin).toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
