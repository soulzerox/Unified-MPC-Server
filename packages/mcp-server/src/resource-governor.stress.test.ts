import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@unified-mpc/domain';
import { permissionProfiles } from '@unified-mpc/permissions';
import {
  ResourceAdmissionController,
  tryAdmitLspProcess,
} from '@unified-mpc/workspace';
import {
  ToolRegistry,
  type McpApplicationServices,
  type WorkspaceScope,
} from './tool-registry.js';

const MIB = 1024 * 1024;
const STRESS_CLIENTS = 64;
const MAX_REJECTION_MS = 2_000;
const PEAK_RSS_ALLOWANCE = 48 * MIB;

describe('resource governor mixed-client stress acceptance', () => {
  it('bounds aggregate mixed work, preserves cross-project progress, and recovers without waiter growth', async () => {
    const controller = new ResourceAdmissionController({
      globalCost: 24,
      workspaceCost: 12,
      sessionCost: 12,
      maxOperations: 6,
      resourceClassCost: {
        context_scan: 8,
        child_mcp_call: 6,
        lsp_process: 16,
        rag_indexing: 8,
      },
    });

    let settleContext: (() => void) | undefined;
    let settleChild: (() => void) | undefined;
    let settleRag: (() => void) | undefined;
    let contextStarted = false;
    let childStarted = false;
    let ragStarted = false;

    const actorA = { clientId: 'stress-a', clientName: 'stress-a' };
    const registryA = new ToolRegistry({
      workspaceInfo: {
        async info() { return ok({ id: 'workspace-a' }); },
      },
      search: {
        async searchText() {
          contextStarted = true;
          return await new Promise<ReturnType<typeof ok>>((resolve) => {
            settleContext = (): void => resolve(ok({ matches: [], truncated: false }));
          });
        },
        async searchFiles() { return ok({ paths: [], truncated: false }); },
      },
      extensions: {
        async callMcpTool() {
          childStarted = true;
          return await new Promise<ReturnType<typeof ok>>((resolve) => {
            settleChild = (): void => resolve(ok({ ok: true }));
          });
        },
      } as unknown as McpApplicationServices['extensions'],
    } as unknown as McpApplicationServices, actorA, {
      sessionId: 'session-a',
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: () => 'full_bypass' as const,
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope> => ({
        workspaceId: 'workspace-a',
        rootPath: '/tmp/workspace-a',
      }),
      resourceAdmissionController: controller,
      contextScanAdmissionCost: 4,
      mcpCallAdmissionCost: 3,
    });

    const registryB = new ToolRegistry({
      thaiRag: {
        async call(tool: string) {
          if (tool !== 'code_index') throw new Error(`unexpected Thai-RAG tool: ${tool}`);
          ragStarted = true;
          return await new Promise<ReturnType<typeof ok>>((resolve) => {
            settleRag = (): void => resolve(ok({ indexed: true }));
          });
        },
      },
    } as unknown as McpApplicationServices, { clientId: 'stress-b', clientName: 'stress-b' }, {
      sessionId: 'session-b',
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: () => 'full_bypass' as const,
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope> => ({
        workspaceId: 'workspace-b',
        rootPath: '/tmp/workspace-b',
      }),
      resourceAdmissionController: controller,
      ragIndexAdmissionCost: 8,
    });

    const saturationSearch = vi.fn(async () => ok({ matches: [], truncated: false }));
    const saturationFiles = vi.fn(async () => ok({ paths: [], truncated: false }));
    const saturationRegistry = new ToolRegistry({
      search: {
        searchText: saturationSearch,
        searchFiles: saturationFiles,
      },
    } as unknown as McpApplicationServices, { clientId: 'stress-d', clientName: 'stress-d' }, {
      sessionId: 'session-d',
      resourceAdmissionController: controller,
      contextScanAdmissionCost: 4,
    });

    const beforeRss = process.memoryUsage().rss;
    let peakRss = beforeRss;
    let peakCost = 0;
    let peakOperations = 0;
    const sample = (): void => {
      const snapshot = controller.snapshot();
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      peakCost = Math.max(peakCost, snapshot.activeCost);
      peakOperations = Math.max(peakOperations, snapshot.activeOperations);
      expect(snapshot.activeCost).toBeLessThanOrEqual(24);
      expect(snapshot.activeOperations).toBeLessThanOrEqual(6);
    };

    const contextPending = registryA.invoke('search_all', {
      workspaceId: 'workspace-a',
      query: 'needle',
    });
    const batchPending = registryA.invoke('tool_batch', {
      parallel: true,
      maxConcurrency: 1,
      calls: [{
        id: 'child-1',
        tool: 'mcp_call',
        arguments: { server: 'child', tool: 'slow', arguments: {} },
        dependsOn: [],
      }],
    });
    const ragPending = registryB.invoke('rag_code_index', {
      workspaceId: 'workspace-b',
      background: false,
      userConfirmed: true,
    });

    for (let attempt = 0; attempt < 50 && !(contextStarted && childStarted && ragStarted); attempt += 1) {
      await Promise.resolve();
    }
    expect({ contextStarted, childStarted, ragStarted }).toEqual({
      contextStarted: true,
      childStarted: true,
      ragStarted: true,
    });

    const lsp = tryAdmitLspProcess(controller, {
      operationId: 'stress-lsp',
      workspaceId: 'workspace-c',
      sessionId: 'session-c',
      cost: 8,
    });
    if (!lsp.admitted) throw new Error(`expected mixed LSP admission, got ${lsp.reason}`);
    sample();

    expect(controller.snapshot()).toMatchObject({
      activeCost: 23,
      activeOperations: 4,
      activeCostByClass: {
        context_scan: 4,
        child_mcp_call: 3,
        lsp_process: 8,
        rag_indexing: 8,
      },
      activeCostByWorkspace: {
        'workspace-a': 7,
        'workspace-b': 8,
        'workspace-c': 8,
      },
      activeCostBySession: {
        'session-a': 7,
        'session-b': 8,
        'session-c': 8,
      },
    });

    const metadata = await registryA.invoke('workspace_snapshot', { workspaceId: 'workspace-a' });
    expect(metadata.isError).not.toBe(true);
    expect(controller.snapshot()).toMatchObject({ activeCost: 23, activeOperations: 4 });

    const rejectionStarted = performance.now();
    const rejected = await Promise.all(Array.from({ length: STRESS_CLIENTS }, async (_, index) => {
      const response = await saturationRegistry.invoke('search_all', {
        workspaceId: `workspace-d-${index % 4}`,
        query: `saturated-${index}`,
      });
      sample();
      return response;
    }));
    const rejectionElapsedMs = performance.now() - rejectionStarted;

    for (const response of rejected) {
      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: 'RESOURCE_PRESSURE',
            recoverable: true,
            details: { reason: 'global_cost_exhausted' },
          },
        },
      });
    }
    expect(rejectionElapsedMs).toBeLessThan(MAX_REJECTION_MS);
    expect(saturationSearch).not.toHaveBeenCalled();
    expect(saturationFiles).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({
      activeCost: 23,
      activeOperations: 4,
      rejected: STRESS_CLIENTS,
    });

    expect(controller.release(lsp.lease)).toBe(true);
    settleContext?.();
    settleChild?.();
    settleRag?.();

    const [contextResult, batchResult, ragResult] = await Promise.all([
      contextPending,
      batchPending,
      ragPending,
    ]);
    expect(contextResult.isError).not.toBe(true);
    expect(batchResult.isError).not.toBe(true);
    expect(ragResult.isError).not.toBe(true);

    for (let attempt = 0; attempt < 50 && controller.snapshot().activeOperations > 0; attempt += 1) {
      await Promise.resolve();
    }
    sample();
    expect(controller.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0 });

    const recovered = await saturationRegistry.invoke('search_all', {
      workspaceId: 'workspace-d',
      query: 'after-recovery',
    });
    sample();
    expect(recovered.isError).not.toBe(true);
    expect(saturationSearch).toHaveBeenCalledTimes(1);
    expect(saturationFiles).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0 });

    expect(peakCost).toBe(23);
    expect(peakOperations).toBe(4);
    expect(Math.max(0, peakRss - beforeRss)).toBeLessThan(PEAK_RSS_ALLOWANCE);
  }, 15_000);
});
