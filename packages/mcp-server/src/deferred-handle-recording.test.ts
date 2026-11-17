import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@unified-mpc/domain';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';
import type { ActivitySinkEvent } from './activity-tracker.js';
import type { DeferredHandleRecord } from './deferred-handle-descriptor.js';

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
