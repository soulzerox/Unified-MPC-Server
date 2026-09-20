import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHILD_MCP_CALL_ADMISSION_COST,
  ResourceAdmissionController,
  sharedProcessResourceAdmissionController,
  tryAdmitChildMcpCall,
  tryAdmitDependencyBootstrap,
} from './resource-admission.js';

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

  it('returns one process-owned default controller across runtime owners', () => {
    expect(sharedProcessResourceAdmissionController()).toBe(sharedProcessResourceAdmissionController());
  });

});
