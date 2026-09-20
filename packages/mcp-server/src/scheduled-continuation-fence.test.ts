import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@unified-mpc/domain';
import { permissionProfiles, type PermissionProfile } from '@unified-mpc/permissions';
import { ToolRegistry, type McpApplicationServices, type WorkspaceScope } from './tool-registry.js';

const actor = { clientId: 'client-1', clientName: 'test', sessionId: 'session-a' };

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
      register(_goalId: string, requestId: string, controller: AbortController) {
        registeredController = controller;
        registeredRequestId = requestId;
        return {
          accepted: true,
          done,
          release(): void { resolveDone?.(); },
        };
      },
      async cancelForGoal(goalId: string) {
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

  it('keeps ordinary read execution tied to the parent request lifetime', async (): Promise<void> => {
    let executionSignal: AbortSignal | undefined;
    let started = false;
    const readFile = vi.fn(async (_actor, _workspaceId, _request, signal?: AbortSignal) => {
      executionSignal = signal;
      started = true;
      return new Promise<ReturnType<typeof ok>>((resolve) => {
        signal?.addEventListener('abort', () => {
          resolve(ok({ path: 'src/file.ts', content: '', startLine: 1, endLine: 1 }));
        }, { once: true });
      });
    });
    const registry = new ToolRegistry({ file: { readFile } } as unknown as McpApplicationServices, actor);
    const parent = new AbortController();

    const pending = registry.invoke('read_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
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
