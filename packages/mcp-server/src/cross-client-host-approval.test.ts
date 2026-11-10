import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostMutationApprovalRequest } from './tool-registry.js';
import {
  createCrossClientHostMutationApprovalProvider,
  startCrossClientHostApprovalWorker,
  type CrossClientHostApprovalWorker,
} from './cross-client-host-approval.js';
import { createTrustedHostMutationApprovalProvider } from './trusted-host-approval.js';

const temporaryRoots: string[] = [];
const workers: CrossClientHostApprovalWorker[] = [];

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not reached before the timeout');
    await delay(5);
  }
}

function scopedRequest(scopeId: string = 'scope-a'): HostMutationApprovalRequest {
  return {
    toolName: 'mcp_call',
    mutationKind: 'opaque_mutation',
    reason: 'automation',
    summary: 'tool = mcp_call',
    workspaceId: 'workspace-a',
    approvalScope: { kind: 'automation_run', id: scopeId, label: 'Automation A', ttlMs: 0, maxUses: 0 },
  };
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('cross-client host approval broker', () => {
  it('fails closed when no trusted worker is online', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-approval-none-'));
    temporaryRoots.push(directory);
    const provider = createCrossClientHostMutationApprovalProvider({ directory, timeoutMs: 80, pollMs: 10 });
    await expect(provider(scopedRequest())).resolves.toBe(false);
  });

  it('routes a Web request to a trusted worker and reuses the same worker session grant', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-approval-route-'));
    temporaryRoots.push(directory);
    let prompts = 0;
    const trustedProvider = createTrustedHostMutationApprovalProvider({
      platform: 'linux',
      environment: {},
      ttyPrompt: async (): Promise<boolean> => {
        prompts += 1;
        return true;
      },
    });
    const worker = startCrossClientHostApprovalWorker({
      directory,
      provider: trustedProvider,
      workerId: 'trusted-stdio-a',
      pollMs: 10,
      heartbeatMs: 10,
      workerFreshMs: 100,
    });
    workers.push(worker);
    const provider = createCrossClientHostMutationApprovalProvider({ directory, timeoutMs: 500, pollMs: 10, workerFreshMs: 100 });

    await expect(provider(scopedRequest('scope-session'))).resolves.toBe(true);
    await expect(provider(scopedRequest('scope-session'))).resolves.toBe(true);
    expect(prompts).toBe(1);
  });

  it('returns an explicit denial from the trusted worker', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-approval-deny-'));
    temporaryRoots.push(directory);
    const worker = startCrossClientHostApprovalWorker({
      directory,
      provider: async (): Promise<boolean> => false,
      workerId: 'trusted-stdio-deny',
      pollMs: 10,
      heartbeatMs: 10,
    });
    workers.push(worker);
    const provider = createCrossClientHostMutationApprovalProvider({ directory, timeoutMs: 500, pollMs: 10 });
    await expect(provider(scopedRequest())).resolves.toBe(false);
  });

  it('drains in-flight broker work before close resolves so nothing is recreated afterwards', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-approval-close-'));
    temporaryRoots.push(directory);
    let releaseProvider: () => void = () => undefined;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let prompts = 0;
    const worker = startCrossClientHostApprovalWorker({
      directory,
      provider: async (): Promise<boolean> => {
        prompts += 1;
        await providerGate;
        return true;
      },
      workerId: 'trusted-stdio-close',
      pollMs: 10,
      heartbeatMs: 10,
      workerFreshMs: 100,
    });
    workers.push(worker);
    const provider = createCrossClientHostMutationApprovalProvider({ directory, timeoutMs: 5_000, pollMs: 10 });
    const request = provider(scopedRequest('scope-close'));

    await waitFor(() => prompts === 1);
    let closedResolved = false;
    const closing = worker.close().then(() => { closedResolved = true; });

    // Heartbeats keep firing while the scan is parked inside the provider.
    await delay(60);
    expect(closedResolved).toBe(false);

    releaseProvider();
    await closing;
    await expect(request).resolves.toBe(true);

    // Nothing may be recreated after close resolved, which is what the temporary
    // root teardown relies on.
    await delay(40);
    await expect(readdir(path.join(directory, 'workers'))).resolves.toEqual([]);
  });
});
