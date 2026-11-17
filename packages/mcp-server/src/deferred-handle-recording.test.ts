import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@unified-mpc/domain';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';
import type { ActivitySinkEvent } from './activity-tracker.js';
import type { DeferredHandleRecord, DeferredSettlementRecord } from './deferred-handle-descriptor.js';

const actor = { clientId: 'deferred-handle-recording', clientName: 'deferred-handle-recording' };

/**
 * The recorder is only useful if it names the same call the journal row names:
 * the sweep looks handles up by the activity `callId`, so a mismatch would write
 * a row nothing ever reads and leave the call pinned as if nothing was recorded.
 */
function registryWith(recorder?: (record: DeferredHandleRecord) => void): {
  readonly registry: ToolRegistry;
  readonly events: ActivitySinkEvent[];
} {
  const events: ActivitySinkEvent[] = [];
  const process = {
    async previewProjectCommand(): Promise<Result<{ executable: string; args: string[] }>> {
      return ok({ executable: 'pnpm', args: ['test'] });
    },
    async startProjectCommand(): Promise<Result<{ processId: string }>> {
      return ok({ processId: 'process-1' });
    },
  } as unknown as McpApplicationServices['process'];
  const registry = new ToolRegistry({ process }, actor, {
    activeWorkspaceScopeProvider: async (): Promise<{ workspaceId: string; rootPath: string }> => ({ workspaceId: 'workspace-a', rootPath: '/tmp/project-a' }),
    hostMutationApprovalProvider: async (): Promise<boolean> => true,
    activity: { async record(event): Promise<void> { events.push(event); } },
    ...(recorder === undefined ? {} : { deferredHandleRecorder: recorder }),
  });
  return { registry, events };
}

describe('recording a deferred handle', () => {
  it('names the call the activity sink named, with the workspace the handler ran against', async (): Promise<void> => {
    const records: DeferredHandleRecord[] = [];
    const { registry, events } = registryWith((record) => { records.push(record); });

    expect((await registry.invoke('project_test', { workspaceId: 'workspace-a', userConfirmed: true })).isError).not.toBe(true);

    expect(records).toEqual([{
      workspaceId: 'workspace-a',
      provider: 'process',
      handleId: 'process-1',
      callId: events[0]?.callId,
    }]);
  });

  it('never fails the call it describes when the ledger write throws', async (): Promise<void> => {
    const { registry } = registryWith(() => { throw new Error('ledger is down'); });

    expect((await registry.invoke('project_test', { workspaceId: 'workspace-a', userConfirmed: true })).isError).not.toBe(true);
  });
});

/**
 * A verification that reached a verdict runs its gate inside the call, so its
 * `started` row can only be closed by the call itself: it records no handle, and
 * nothing else in the sweep would ever ask about it.
 */
describe('recording a deferred settlement', () => {
  function verificationRegistry(recorder: (record: DeferredSettlementRecord) => void): {
    readonly registry: ToolRegistry;
    readonly events: ActivitySinkEvent[];
  } {
    const events: ActivitySinkEvent[] = [];
    const services = {
      mergePolicy: {
        async getByRepository() {
          return {
            repository: 'soulzerox/Unified-MPC-Server',
            defaultBranch: 'main',
            verificationMode: 'local_exact_head',
            requiredGates: [{ name: 'test', source: 'local_command' }],
            reviewPolicy: { required: true, acceptedOutcomes: ['clean_llm_review'] },
          };
        },
      },
      mergeVerificationRun: {
        async run() {
          return ok({ status: 'completed', receiptRef: 'receipt-1', receipt: {}, decision: { status: 'MERGE_ALLOWED', blockers: [] }, sequence: 1 });
        },
      },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor, {
      activeWorkspaceScopeProvider: async (): Promise<{ workspaceId: string; rootPath: string }> => ({ workspaceId: 'workspace-a', rootPath: '/tmp/project-a' }),
      hostMutationApprovalProvider: async (): Promise<boolean> => true,
      activity: { async record(event): Promise<void> { events.push(event); } },
      deferredSettlementRecorder: recorder,
    });
    return { registry, events };
  }

  it('settles the call the activity sink named, in the workspace the handler ran against', async (): Promise<void> => {
    const records: DeferredSettlementRecord[] = [];
    const { registry, events } = verificationRegistry((record) => { records.push(record); });

    expect((await registry.invoke('merge_verification_run', {
      repository: 'soulzerox/Unified-MPC-Server',
      pullRequest: 880,
      workspaceId: 'workspace-a',
      review: { outcome: 'clean_llm_review' },
    })).isError).not.toBe(true);

    expect(records).toEqual([{
      workspaceId: 'workspace-a',
      closureCode: 'verification_settled',
      callId: events[0]?.callId,
    }]);
  });

  it('never fails the call it settles when the journal write throws', async (): Promise<void> => {
    const { registry } = verificationRegistry(() => { throw new Error('journal is down'); });

    expect((await registry.invoke('merge_verification_run', {
      repository: 'soulzerox/Unified-MPC-Server',
      pullRequest: 880,
      workspaceId: 'workspace-a',
      review: { outcome: 'clean_llm_review' },
    })).isError).not.toBe(true);
  });
});
