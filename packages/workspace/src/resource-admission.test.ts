import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHILD_MCP_CALL_ADMISSION_COST,
  DEFAULT_CONTEXT_SCAN_ADMISSION_COST,
  DEFAULT_LSP_PROCESS_ADMISSION_COST,
  DEFAULT_RAG_INDEX_ADMISSION_COST,
  DEFAULT_GOAL_PROCESS_ADMISSION_COST,
  DEFAULT_DELEGATED_AGENT_ADMISSION_COST,
  DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
  DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS,
  ResourceAdmissionController,
  sharedProcessResourceAdmissionController,
  tryAdmitChildMcpCall,
  tryAdmitContextScan,
  tryAdmitDependencyBootstrap,
  tryAdmitLspProcess,
  tryAdmitRagIndex,
  tryAdmitGoalProcess,
  tryAdmitDelegatedAgent,
  tryAdmitVerificationHeavy,
} from './resource-admission.js';
import type { ResourcePressureProbe } from './resource-pressure.js';

describe('resource admission contract', () => {
  it('admits a small dependency bootstrap and exposes active weighted usage', () => {
    const controller = new ResourceAdmissionController({ globalCost: 8, workspaceCost: 4, maxOperations: 2 });

    const decision = tryAdmitDependencyBootstrap(controller, {
      operationId: 'bootstrap-a',
      workspaceId: 'workspace-a',
      cost: 2,
    });

    expect(decision).toMatchObject({ admitted: true, lease: { operationId: 'bootstrap-a', cost: 2 } });
    expect(controller.snapshot()).toMatchObject({
      activeCost: 2,
      activeOperations: 1,
      activeCostByClass: { dependency_bootstrap: 2 },
      activeCostByWorkspace: { 'workspace-a': 2 },
    });
  });

  it('fails closed with observable pressure when global cost is exhausted', () => {
    const controller = new ResourceAdmissionController({ globalCost: 4, workspaceCost: 4, maxOperations: 4 });
    const first = tryAdmitDependencyBootstrap(controller, { operationId: 'bootstrap-a', workspaceId: 'workspace-a', cost: 4 });

    const rejected = tryAdmitDependencyBootstrap(controller, { operationId: 'bootstrap-b', workspaceId: 'workspace-b', cost: 1 });

    expect(first.admitted).toBe(true);
    expect(rejected).toMatchObject({
      admitted: false,
      code: 'RESOURCE_PRESSURE',
      reason: 'global_cost_exhausted',
      requestedCost: 1,
      snapshot: { activeCost: 4, activeOperations: 1, rejected: 1 },
    });
  });

  it('keeps workspace pressure isolated so another workspace can be admitted', () => {
    const controller = new ResourceAdmissionController({ globalCost: 8, workspaceCost: 3, maxOperations: 4 });
    const first = tryAdmitDependencyBootstrap(controller, { operationId: 'bootstrap-a', workspaceId: 'workspace-a', cost: 3 });

    const rejected = tryAdmitDependencyBootstrap(controller, { operationId: 'bootstrap-a-2', workspaceId: 'workspace-a', cost: 1 });
    const admitted = tryAdmitDependencyBootstrap(controller, { operationId: 'bootstrap-b', workspaceId: 'workspace-b', cost: 1 });

    expect(first.admitted).toBe(true);
    expect(rejected).toMatchObject({ admitted: false, code: 'RESOURCE_PRESSURE', reason: 'workspace_cost_exhausted' });
    expect(admitted).toMatchObject({ admitted: true, lease: { workspaceId: 'workspace-b' } });
  });

  it('keeps context scan admission fair across workspaces while enforcing each workspace ceiling', () => {
    const controller = new ResourceAdmissionController({
      globalCost: 8,
      workspaceCost: 4,
      sessionCost: 8,
      maxOperations: 2,
      resourceClassCost: { context_scan: 8 },
    });
    const first = tryAdmitContextScan(controller, {
      operationId: 'context-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      cost: DEFAULT_CONTEXT_SCAN_ADMISSION_COST,
    });
    if (!first.admitted) throw new Error('expected first context admission');

    const sameWorkspace = tryAdmitContextScan(controller, {
      operationId: 'context-a-2',
      workspaceId: 'workspace-a',
      sessionId: 'session-b',
      cost: DEFAULT_CONTEXT_SCAN_ADMISSION_COST,
    });
    const otherWorkspace = tryAdmitContextScan(controller, {
      operationId: 'context-b',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: DEFAULT_CONTEXT_SCAN_ADMISSION_COST,
    });

    expect(sameWorkspace).toMatchObject({ admitted: false, code: 'RESOURCE_PRESSURE', reason: 'workspace_cost_exhausted' });
    expect(otherWorkspace).toMatchObject({ admitted: true, lease: { resourceClass: 'context_scan', workspaceId: 'workspace-b', cost: 4 } });
    expect(controller.snapshot()).toMatchObject({
      activeCost: 8,
      activeOperations: 2,
      activeCostByClass: { context_scan: 8 },
      activeCostByWorkspace: { 'workspace-a': 4, 'workspace-b': 4 },
    });

    expect(controller.release(first.lease)).toBe(true);
    if (otherWorkspace.admitted) expect(controller.release(otherWorkspace.lease)).toBe(true);
  });

  it('restores pre-existing durable debt even above current ceilings and blocks new work', () => {
    const controller = new ResourceAdmissionController({
      globalCost: 4,
      workspaceCost: 4,
      sessionCost: 4,
      maxOperations: 2,
      resourceClassCost: { goal_process: 4 },
    });
    const recovered = {
      operationId: 'recovered-goal-process',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      resourceClass: 'goal_process' as const,
      cost: 8,
    };

    expect(controller.restore(recovered)).toBe(true);
    expect(controller.restore(recovered)).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      activeCost: 8,
      activeOperations: 1,
      activeCostByClass: { goal_process: 8 },
      activeCostByWorkspace: { 'workspace-a': 8 },
      activeCostBySession: { 'session-a': 8 },
    });
    expect(tryAdmitDependencyBootstrap(controller, {
      operationId: 'new-work',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: 1,
    })).toMatchObject({
      admitted: false,
      code: 'RESOURCE_PRESSURE',
      reason: 'global_cost_exhausted',
    });
    expect(controller.release(recovered)).toBe(true);
  });

  it('fails closed when restored debt reuses an operation id with different ownership', () => {
    const controller = new ResourceAdmissionController({ globalCost: 8, workspaceCost: 8, maxOperations: 4 });
    const recovered = {
      operationId: 'recovered-process',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      resourceClass: 'goal_process' as const,
      cost: 4,
    };
    expect(controller.restore(recovered)).toBe(true);
    expect(controller.restore({ ...recovered, workspaceId: 'workspace-b' })).toBe(false);
    expect(controller.snapshot()).toMatchObject({
      activeCost: 4,
      activeOperations: 1,
      activeCostByWorkspace: { 'workspace-a': 4 },
    });
  });

  it('releases capacity deterministically and rejects duplicate operation ids', () => {
    const controller = new ResourceAdmissionController({ globalCost: 4, workspaceCost: 4, maxOperations: 2 });
    const first = tryAdmitDependencyBootstrap(controller, { operationId: 'bootstrap-a', workspaceId: 'workspace-a', cost: 4 });
    if (!first.admitted) throw new Error('expected first admission');

    const duplicate = tryAdmitDependencyBootstrap(controller, { operationId: 'bootstrap-a', workspaceId: 'workspace-a', cost: 1 });
    expect(duplicate).toMatchObject({ admitted: false, code: 'INVALID_INPUT', reason: 'duplicate_operation' });
    expect(controller.release(first.lease)).toBe(true);
    expect(controller.release(first.lease)).toBe(false);
    expect(tryAdmitDependencyBootstrap(controller, { operationId: 'bootstrap-b', workspaceId: 'workspace-a', cost: 4 })).toMatchObject({ admitted: true });
  });
  it('accounts child MCP calls in the existing weighted controller', () => {
    const controller = new ResourceAdmissionController({ globalCost: 6, workspaceCost: 3, maxOperations: 2 });
    const decision = tryAdmitChildMcpCall(controller, {
      operationId: 'mcp-call-a',
      workspaceId: 'workspace-a',
      cost: DEFAULT_CHILD_MCP_CALL_ADMISSION_COST,
    });

    expect(decision).toMatchObject({
      admitted: true,
      lease: { resourceClass: 'child_mcp_call', workspaceId: 'workspace-a', cost: 3 },
    });
    expect(controller.snapshot()).toMatchObject({
      activeCost: 3,
      activeOperations: 1,
      activeCostByClass: { dependency_bootstrap: 0, child_mcp_call: 3 },
      activeCostByWorkspace: { 'workspace-a': 3 },
    });
  });

  it('admits independent LSP processes across two workspaces without globally serializing them', () => {
    const controller = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 4,
      resourceClassCost: { lsp_process: 16 },
    });

    const first = tryAdmitLspProcess(controller, {
      operationId: 'lsp-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      cost: DEFAULT_LSP_PROCESS_ADMISSION_COST,
    });
    const second = tryAdmitLspProcess(controller, {
      operationId: 'lsp-b',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: DEFAULT_LSP_PROCESS_ADMISSION_COST,
    });
    const sameWorkspaceRejected = tryAdmitLspProcess(controller, {
      operationId: 'lsp-a-2',
      workspaceId: 'workspace-a',
      sessionId: 'session-c',
      cost: 1,
    });

    expect(first).toMatchObject({ admitted: true, lease: { resourceClass: 'lsp_process', workspaceId: 'workspace-a', cost: 8 } });
    expect(second).toMatchObject({ admitted: true, lease: { resourceClass: 'lsp_process', workspaceId: 'workspace-b', cost: 8 } });
    expect(sameWorkspaceRejected).toMatchObject({ admitted: false, code: 'RESOURCE_PRESSURE' });
    expect(controller.snapshot()).toMatchObject({
      activeCost: 16,
      activeOperations: 2,
      activeCostByClass: { lsp_process: 16 },
      activeCostByWorkspace: { 'workspace-a': 8, 'workspace-b': 8 },
      activeCostBySession: { 'session-a': 8, 'session-b': 8 },
    });
    if (!first.admitted || !second.admitted) throw new Error('expected both independent LSP processes to be admitted');
    expect(controller.release(first.lease)).toBe(true);
    expect(controller.release(second.lease)).toBe(true);
  });

  it('serializes expensive RAG indexing through the shared weighted controller', () => {
    const controller = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 4,
      resourceClassCost: { rag_indexing: 8 },
    });

    const first = tryAdmitRagIndex(controller, {
      operationId: 'rag-index-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      cost: DEFAULT_RAG_INDEX_ADMISSION_COST,
    });
    const second = tryAdmitRagIndex(controller, {
      operationId: 'rag-index-b',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: DEFAULT_RAG_INDEX_ADMISSION_COST,
    });

    expect(first).toMatchObject({ admitted: true, lease: { resourceClass: 'rag_indexing', cost: 8 } });
    expect(second).toMatchObject({
      admitted: false,
      code: 'RESOURCE_PRESSURE',
      reason: 'resource_class_cost_exhausted',
    });
    if (!first.admitted) throw new Error('expected first RAG index admission');
    expect(controller.release(first.lease)).toBe(true);
    expect(tryAdmitRagIndex(controller, {
      operationId: 'rag-index-c',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: DEFAULT_RAG_INDEX_ADMISSION_COST,
    })).toMatchObject({ admitted: true });
  });


  it('accounts detached Goal-owned processes in the shared weighted controller', () => {
    const controller = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 4,
      resourceClassCost: { goal_process: 16 },
    });

    const first = tryAdmitGoalProcess(controller, {
      operationId: 'goal-process-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      cost: DEFAULT_GOAL_PROCESS_ADMISSION_COST,
    });
    const sameWorkspace = tryAdmitGoalProcess(controller, {
      operationId: 'goal-process-a-2',
      workspaceId: 'workspace-a',
      sessionId: 'session-b',
      cost: 1,
    });
    const otherWorkspace = tryAdmitGoalProcess(controller, {
      operationId: 'goal-process-b',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: DEFAULT_GOAL_PROCESS_ADMISSION_COST,
    });

    expect(first).toMatchObject({ admitted: true, lease: { resourceClass: 'goal_process', cost: 8 } });
    expect(sameWorkspace).toMatchObject({ admitted: false, code: 'RESOURCE_PRESSURE', reason: 'workspace_cost_exhausted' });
    expect(otherWorkspace).toMatchObject({ admitted: true, lease: { resourceClass: 'goal_process', cost: 8 } });
    expect(controller.snapshot()).toMatchObject({
      activeCost: 16,
      activeOperations: 2,
      activeCostByClass: { goal_process: 16 },
    });
    if (!first.admitted || !otherWorkspace.admitted) throw new Error('expected independent Goal processes');
    expect(controller.release(first.lease)).toBe(true);
    expect(controller.release(otherWorkspace.lease)).toBe(true);
  });

  it('bounds delegated agent workers per workspace while preserving cross-workspace progress', () => {
    const controller = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 4,
      resourceClassCost: { delegated_agent: 16 },
    });

    const first = tryAdmitDelegatedAgent(controller, {
      operationId: 'delegated-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      cost: DEFAULT_DELEGATED_AGENT_ADMISSION_COST,
    });
    const sameWorkspace = tryAdmitDelegatedAgent(controller, {
      operationId: 'delegated-a-2',
      workspaceId: 'workspace-a',
      sessionId: 'session-b',
      cost: 1,
    });
    const otherWorkspace = tryAdmitDelegatedAgent(controller, {
      operationId: 'delegated-b',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: DEFAULT_DELEGATED_AGENT_ADMISSION_COST,
    });

    expect(first).toMatchObject({ admitted: true, lease: { resourceClass: 'delegated_agent', cost: 8 } });
    expect(sameWorkspace).toMatchObject({ admitted: false, code: 'RESOURCE_PRESSURE', reason: 'workspace_cost_exhausted' });
    expect(otherWorkspace).toMatchObject({ admitted: true, lease: { resourceClass: 'delegated_agent', cost: 8 } });
    expect(controller.snapshot()).toMatchObject({
      activeCost: 16,
      activeOperations: 2,
      activeCostByClass: { delegated_agent: 16 },
    });
    if (!first.admitted || !otherWorkspace.admitted) throw new Error('expected independent delegated workers');
    expect(controller.release(first.lease)).toBe(true);
    expect(controller.release(otherWorkspace.lease)).toBe(true);
  });

  it('returns one process-owned default controller across runtime owners', () => {
    expect(sharedProcessResourceAdmissionController()).toBe(sharedProcessResourceAdmissionController());
  });

  it('limits one session across different workspaces and exposes bounded session usage', () => {
    const controller = new ResourceAdmissionController({
      globalCost: 8,
      workspaceCost: 8,
      sessionCost: 3,
      maxOperations: 4,
      resourceClassCost: { dependency_bootstrap: 8, child_mcp_call: 8 },
    });

    const first = tryAdmitChildMcpCall(controller, {
      operationId: 'session-a-call-1',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      cost: 3,
    });
    const rejected = tryAdmitChildMcpCall(controller, {
      operationId: 'session-a-call-2',
      workspaceId: 'workspace-b',
      sessionId: 'session-a',
      cost: 1,
    });
    const otherSession = tryAdmitChildMcpCall(controller, {
      operationId: 'session-b-call-1',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: 1,
    });

    expect(first).toMatchObject({ admitted: true, lease: { sessionId: 'session-a' } });
    expect(rejected).toMatchObject({
      admitted: false,
      code: 'RESOURCE_PRESSURE',
      reason: 'session_cost_exhausted',
    });
    expect(otherSession).toMatchObject({ admitted: true, lease: { sessionId: 'session-b' } });
    expect(controller.snapshot()).toMatchObject({
      activeCostBySession: { 'session-a': 3, 'session-b': 1 },
    });
  });

  it('caps one admission class without blocking capacity reserved for another class', () => {
    const controller = new ResourceAdmissionController({
      globalCost: 8,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 4,
      resourceClassCost: { dependency_bootstrap: 4, child_mcp_call: 3 },
    });

    const child = tryAdmitChildMcpCall(controller, {
      operationId: 'child-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      cost: 3,
    });
    const childRejected = tryAdmitChildMcpCall(controller, {
      operationId: 'child-b',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: 1,
    });
    const bootstrap = tryAdmitDependencyBootstrap(controller, {
      operationId: 'bootstrap-a',
      workspaceId: 'workspace-b',
      sessionId: 'system',
      cost: 1,
    });

    expect(child).toMatchObject({ admitted: true });
    expect(childRejected).toMatchObject({
      admitted: false,
      code: 'RESOURCE_PRESSURE',
      reason: 'resource_class_cost_exhausted',
    });
    expect(bootstrap).toMatchObject({ admitted: true, lease: { resourceClass: 'dependency_bootstrap' } });
  });

  it('reduces effective admission under elevated memory pressure without revoking running leases', () => {
    const pressureProbe: ResourcePressureProbe = {
      sample: () => ({
        state: 'elevated',
        totalMemoryBytes: 1_000,
        availableMemoryBytes: 120,
        availableRatio: 0.12,
        processRssBytes: 100,
        sampledAtMs: 1,
      }),
    };
    const controller = new ResourceAdmissionController(
      { globalCost: 8, workspaceCost: 8, sessionCost: 8, maxOperations: 8 },
      { pressureProbe, elevatedGlobalCostRatio: 0.5 },
    );

    const first = tryAdmitChildMcpCall(controller, {
      operationId: 'pressure-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      cost: 4,
    });
    const rejected = tryAdmitChildMcpCall(controller, {
      operationId: 'pressure-b',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: 1,
    });

    expect(first).toMatchObject({ admitted: true });
    expect(rejected).toMatchObject({
      admitted: false,
      code: 'RESOURCE_PRESSURE',
      reason: 'memory_pressure',
      snapshot: { pressureState: 'elevated', effectiveGlobalCost: 4, activeCost: 4 },
    });
    if (!first.admitted) throw new Error('expected pressure-a to be admitted');
    expect(controller.release(first.lease)).toBe(true);
  });

  it('stops new expensive admission under critical pressure while preserving bounded observability', () => {
    const pressureProbe: ResourcePressureProbe = {
      sample: () => ({
        state: 'critical',
        totalMemoryBytes: 1_000,
        availableMemoryBytes: 50,
        availableRatio: 0.05,
        processRssBytes: 100,
        sampledAtMs: 2,
      }),
    };
    const controller = new ResourceAdmissionController(
      { globalCost: 8, workspaceCost: 8, sessionCost: 8, maxOperations: 8 },
      { pressureProbe },
    );

    const rejected = tryAdmitDependencyBootstrap(controller, {
      operationId: 'critical-bootstrap',
      workspaceId: 'workspace-a',
      cost: 1,
    });

    expect(rejected).toMatchObject({
      admitted: false,
      code: 'RESOURCE_PRESSURE',
      reason: 'memory_pressure',
      snapshot: { pressureState: 'critical', effectiveGlobalCost: 0, activeOperations: 0 },
    });
  });

  it('keeps exactly one default heavy verification in flight per class', () => {
    expect(DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS.resourceClassCost.verification_heavy).toBe(8);
    const controller = new ResourceAdmissionController(DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS);

    const first = tryAdmitVerificationHeavy(controller, {
      operationId: 'verification-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      cost: DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
    });
    const second = tryAdmitVerificationHeavy(controller, {
      operationId: 'verification-b',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
    });

    expect(first).toMatchObject({
      admitted: true,
      lease: { resourceClass: 'verification_heavy', cost: 8 },
    });
    expect(second).toMatchObject({
      admitted: false,
      code: 'RESOURCE_PRESSURE',
      reason: 'resource_class_cost_exhausted',
    });
    if (!first.admitted) throw new Error('expected first verification to be admitted');
    expect(controller.release(first.lease)).toBe(true);
  });

  it('notifies release listeners only for releases that free real capacity (#145 wake-on-release)', () => {
    const controller = new ResourceAdmissionController(DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS);
    const wakes: string[] = [];
    const first = tryAdmitRagIndex(controller, { operationId: 'index-a', workspaceId: 'workspace-a', sessionId: 'session-a', cost: DEFAULT_RAG_INDEX_ADMISSION_COST });
    if (!first.admitted) throw new Error('expected admission');
    const unsubscribe = controller.onRelease(() => wakes.push('first'));

    // A rejected or duplicate release frees nothing, so no waiter may wake.
    expect(controller.release({ ...first.lease, operationId: 'unknown' })).toBe(false);
    expect(controller.release(first.lease)).toBe(true);
    expect(wakes).toEqual(['first']);
    expect(controller.release(first.lease)).toBe(false);
    expect(wakes).toEqual(['first']);

    // Unsubscribed listeners never fire again, and a throwing listener cannot
    // fail the caller that is releasing capacity.
    unsubscribe();
    const second = tryAdmitRagIndex(controller, { operationId: 'index-b', workspaceId: 'workspace-a', sessionId: 'session-a', cost: DEFAULT_RAG_INDEX_ADMISSION_COST });
    if (!second.admitted) throw new Error('expected admission');
    expect(controller.release(second.lease)).toBe(true);
    expect(wakes).toEqual(['first']);

    const third = tryAdmitRagIndex(controller, { operationId: 'index-c', workspaceId: 'workspace-a', sessionId: 'session-a', cost: DEFAULT_RAG_INDEX_ADMISSION_COST });
    if (!third.admitted) throw new Error('expected admission');
    controller.onRelease(() => {
      throw new Error('listener failure');
    });
    expect(controller.release(third.lease)).toBe(true);
    expect(controller.snapshot()).toMatchObject({ activeOperations: 0 });
  });

  it('serializes different heavy classes across workspaces on the default profile (#145)', () => {
    expect(DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS.maxHeavyOperations).toBe(1);
    const controller = new ResourceAdmissionController(DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS);

    // 8 + 8 fits the default 16 global ceiling, so only the heavy-capacity
    // policy can keep a build/test verification and an index batch apart.
    const index = tryAdmitRagIndex(controller, {
      operationId: 'index-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      cost: DEFAULT_RAG_INDEX_ADMISSION_COST,
    });
    const verification = tryAdmitVerificationHeavy(controller, {
      operationId: 'verification-b',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
    });

    expect(index.admitted).toBe(true);
    expect(verification).toMatchObject({
      admitted: false,
      code: 'RESOURCE_PRESSURE',
      reason: 'heavy_capacity_exhausted',
      requestedCost: 8,
      retryable: true,
      snapshot: { activeHeavyOperations: 1, maxHeavyOperations: 1 },
    });

    if (!index.admitted) throw new Error('expected index admission');
    expect(controller.release(index.lease)).toBe(true);
    // Capacity comes back on release: the next heavy job is admitted then.
    const next = tryAdmitVerificationHeavy(controller, {
      operationId: 'verification-c',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
    });
    expect(next).toMatchObject({ admitted: true, lease: { resourceClass: 'verification_heavy' } });
  });

  it('lets a light job run while the heavy slot is busy (#145)', () => {
    const controller = new ResourceAdmissionController(DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS);
    const heavy = tryAdmitVerificationHeavy(controller, {
      operationId: 'verification-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      cost: DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
    });
    if (!heavy.admitted) throw new Error('expected heavy admission');

    const light = tryAdmitContextScan(controller, {
      operationId: 'scan-b',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: DEFAULT_CONTEXT_SCAN_ADMISSION_COST,
    });

    expect(light).toMatchObject({ admitted: true, lease: { resourceClass: 'context_scan' } });
    expect(controller.snapshot()).toMatchObject({ activeHeavyOperations: 1, activeOperations: 2 });
  });

  it('allows a configured second heavy slot only when limits say so (#145)', () => {
    const limited = new ResourceAdmissionController({ ...DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS, maxHeavyOperations: 2 });
    const index = tryAdmitRagIndex(limited, {
      operationId: 'index-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      cost: DEFAULT_RAG_INDEX_ADMISSION_COST,
    });
    const verification = tryAdmitVerificationHeavy(limited, {
      operationId: 'verification-b',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      cost: DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
    });

    expect(index.admitted).toBe(true);
    expect(verification).toMatchObject({ admitted: true, lease: { resourceClass: 'verification_heavy' } });
    expect(limited.snapshot()).toMatchObject({ activeHeavyOperations: 2, maxHeavyOperations: 2 });
  });

  it('rejects a non-positive heavy-slot limit instead of silently disabling it', () => {
    expect(() => new ResourceAdmissionController({
      ...DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS,
      maxHeavyOperations: 0,
    })).toThrow('maxHeavyOperations must be a positive integer');
  });

});

describe('heavy headroom (#145)', () => {
  const GIB = 1024 ** 3;

  function pressureProbe(
    state: 'normal' | 'elevated' | 'critical',
    availableMemoryBytes: number,
  ): ResourcePressureProbe {
    return {
      sample: () => ({
        state,
        totalMemoryBytes: 32 * GIB,
        availableMemoryBytes,
        availableRatio: Number.isFinite(availableMemoryBytes) ? availableMemoryBytes / (32 * GIB) : 0,
        processRssBytes: 128 * 1024 * 1024,
        sampledAtMs: 1,
      }),
    };
  }

  function request(operationId: string, workspaceId: string): {
    operationId: string;
    workspaceId: string;
    sessionId: string;
    cost: number;
  } {
    return {
      operationId,
      workspaceId,
      sessionId: `session-${operationId}`,
      cost: DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
    };
  }

  function headroomController(
    probe: ResourcePressureProbe | undefined,
    options: { readonly maxExtraHeavyJobs?: number; readonly maxHeavyOperations?: number } = {},
  ): ResourceAdmissionController {
    return new ResourceAdmissionController(
      {
        ...DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS,
        ...(options.maxHeavyOperations === undefined ? {} : { maxHeavyOperations: options.maxHeavyOperations }),
        heavyHeadroom: {
          maxExtraHeavyJobs: options.maxExtraHeavyJobs ?? 1,
          bytesPerExtraHeavyJob: 4 * GIB,
          reserveBytes: 2 * GIB,
        },
      },
      probe === undefined ? {} : { pressureProbe: probe },
    );
  }

  it('keeps one heavy slot when measured headroom is insufficient', () => {
    const controller = headroomController(pressureProbe('normal', 4 * GIB));

    const first = tryAdmitRagIndex(controller, request('h1', 'workspace-1'));
    const second = tryAdmitVerificationHeavy(controller, request('h2', 'workspace-2'));

    expect(first.admitted).toBe(true);
    expect(second).toMatchObject({
      admitted: false,
      code: 'RESOURCE_PRESSURE',
      reason: 'heavy_capacity_exhausted',
    });
    expect(controller.snapshot()).toMatchObject({
      maxHeavyOperations: 1,
      effectiveMaxHeavyOperations: 1,
      activeHeavyOperations: 1,
    });
  });

  it('pairs two heavy classes when normal pressure leaves enough memory', () => {
    const controller = headroomController(pressureProbe('normal', 16 * GIB));

    const first = tryAdmitRagIndex(controller, request('h1', 'workspace-1'));
    const second = tryAdmitVerificationHeavy(controller, request('h2', 'workspace-2'));
    const third = tryAdmitVerificationHeavy(controller, request('h3', 'workspace-3'));

    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    // The default global and per-class ceilings still stop a third heavy job;
    // the dedicated per-class test below pins which ceiling rejects it.
    expect(third).toMatchObject({
      admitted: false,
      code: 'RESOURCE_PRESSURE',
      retryable: true,
    });
    expect(controller.snapshot()).toMatchObject({
      maxHeavyOperations: 1,
      effectiveMaxHeavyOperations: 2,
      activeHeavyOperations: 2,
    });
  });

  it('drops extra slots under elevated pressure without revoking running leases', () => {
    let state: 'normal' | 'elevated' = 'normal';
    const probe: ResourcePressureProbe = {
      sample: () => ({
        state,
        totalMemoryBytes: 32 * GIB,
        availableMemoryBytes: 16 * GIB,
        availableRatio: 0.5,
        processRssBytes: 128 * 1024 * 1024,
        sampledAtMs: 1,
      }),
    };
    const controller = new ResourceAdmissionController(
      { ...DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS },
      // Keep the global-cost reduction out of the way so this pins the heavy
      // cap itself, not the independent elevated-pressure cost ratio.
      { pressureProbe: probe, elevatedGlobalCostRatio: 1 },
    );

    expect(tryAdmitRagIndex(controller, request('h1', 'workspace-1')).admitted).toBe(true);
    state = 'elevated';
    const second = tryAdmitVerificationHeavy(controller, request('h2', 'workspace-2'));

    expect(second).toMatchObject({ admitted: false, reason: 'heavy_capacity_exhausted' });
    expect(controller.snapshot()).toMatchObject({
      activeHeavyOperations: 1,
      effectiveMaxHeavyOperations: 1,
    });
  });

  it('keeps the base cap when no pressure probe is configured', () => {
    const controller = headroomController(undefined);

    expect(tryAdmitRagIndex(controller, request('h1', 'workspace-1')).admitted).toBe(true);
    expect(tryAdmitVerificationHeavy(controller, request('h2', 'workspace-2')))
      .toMatchObject({ admitted: false, reason: 'heavy_capacity_exhausted' });
    expect(controller.snapshot().effectiveMaxHeavyOperations).toBe(1);
  });

  it('fails closed on a malformed pressure sample', () => {
    const controller = headroomController(pressureProbe('normal', Number.NaN));

    expect(tryAdmitRagIndex(controller, request('h1', 'workspace-1')).admitted).toBe(true);
    expect(tryAdmitVerificationHeavy(controller, request('h2', 'workspace-2')))
      .toMatchObject({ admitted: false, reason: 'heavy_capacity_exhausted' });
    expect(controller.snapshot().effectiveMaxHeavyOperations).toBe(1);
  });

  it('treats maxExtraHeavyJobs=0 as disabled', () => {
    const controller = headroomController(pressureProbe('normal', 64 * GIB), { maxExtraHeavyJobs: 0 });

    expect(tryAdmitRagIndex(controller, request('h1', 'workspace-1')).admitted).toBe(true);
    expect(tryAdmitVerificationHeavy(controller, request('h2', 'workspace-2')))
      .toMatchObject({ admitted: false, reason: 'heavy_capacity_exhausted' });
    expect(controller.snapshot().effectiveMaxHeavyOperations).toBe(1);
  });

  it('adds more than one extra slot only when the policy and cost ceiling allow', () => {
    const controller = new ResourceAdmissionController(
      {
        globalCost: 32,
        workspaceCost: 8,
        sessionCost: 8,
        maxOperations: 8,
        maxHeavyOperations: 1,
        // Keep the per-class ceilings out of the way so this pins the heavy cap
        // itself; the default verification class stays one-job-only.
        resourceClassCost: { rag_indexing: 32, verification_heavy: 32 },
        heavyHeadroom: {
          maxExtraHeavyJobs: 2,
          bytesPerExtraHeavyJob: 4 * GIB,
          reserveBytes: 2 * GIB,
        },
      },
      { pressureProbe: pressureProbe('normal', 16 * GIB) },
    );

    expect(tryAdmitRagIndex(controller, request('h1', 'workspace-1')).admitted).toBe(true);
    for (const index of [2, 3]) {
      expect(tryAdmitVerificationHeavy(controller, request(`h${index}`, `workspace-${index}`)).admitted).toBe(true);
    }
    expect(tryAdmitVerificationHeavy(controller, request('h4', 'workspace-4')))
      .toMatchObject({ admitted: false, reason: 'heavy_capacity_exhausted' });
    expect(controller.snapshot()).toMatchObject({
      maxHeavyOperations: 1,
      effectiveMaxHeavyOperations: 3,
      activeHeavyOperations: 3,
    });
  });

  it('keeps scoped ceilings ahead of the extra slot', () => {
    const controller = headroomController(pressureProbe('normal', 16 * GIB));

    expect(tryAdmitRagIndex(controller, request('h1', 'workspace-1')).admitted).toBe(true);
    expect(tryAdmitVerificationHeavy(controller, request('h2', 'workspace-1')))
      .toMatchObject({ admitted: false, reason: 'workspace_cost_exhausted' });
    expect(controller.snapshot().activeHeavyOperations).toBe(1);
  });

  it('keeps the default per-class ceiling ahead of the extra slot', () => {
    const controller = headroomController(pressureProbe('normal', 16 * GIB));

    expect(tryAdmitVerificationHeavy(controller, request('h1', 'workspace-1')).admitted).toBe(true);
    expect(tryAdmitVerificationHeavy(controller, request('h2', 'workspace-2')))
      .toMatchObject({ admitted: false, reason: 'resource_class_cost_exhausted' });
    expect(controller.snapshot()).toMatchObject({
      activeHeavyOperations: 1,
      effectiveMaxHeavyOperations: 2,
    });
  });

  it('rejects an invalid headroom policy instead of silently disabling it', () => {
    expect(() => new ResourceAdmissionController({
      ...DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS,
      heavyHeadroom: { maxExtraHeavyJobs: -1, bytesPerExtraHeavyJob: 4 * GIB, reserveBytes: 2 * GIB },
    })).toThrow(RangeError);
  });
});
