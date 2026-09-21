import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHILD_MCP_CALL_ADMISSION_COST,
  DEFAULT_CONTEXT_SCAN_ADMISSION_COST,
  DEFAULT_LSP_PROCESS_ADMISSION_COST,
  DEFAULT_RAG_INDEX_ADMISSION_COST,
  DEFAULT_GOAL_PROCESS_ADMISSION_COST,
  DEFAULT_DELEGATED_AGENT_ADMISSION_COST,
  ResourceAdmissionController,
  sharedProcessResourceAdmissionController,
  tryAdmitChildMcpCall,
  tryAdmitContextScan,
  tryAdmitDependencyBootstrap,
  tryAdmitLspProcess,
  tryAdmitRagIndex,
  tryAdmitGoalProcess,
  tryAdmitDelegatedAgent,
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

});
