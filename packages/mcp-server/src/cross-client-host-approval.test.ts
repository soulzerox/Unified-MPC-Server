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

  it('never prompts for a request claimed after close began', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-approval-claim-close-'));
    temporaryRoots.push(directory);
    let prompts = 0;
    let closeRequested: Promise<void> | undefined;
    let clockReads = 0;
    const provider = createCrossClientHostMutationApprovalProvider({ directory, timeoutMs: 400, pollMs: 10 });
    const answer = provider(scopedRequest('scope-claim-close'));
    // The worker has to see the request in its first scan, otherwise the clock
    // injection below lands on an empty directory and close() arrives before
    // the entry loop's closed check instead of inside its window.
    const pendingDir = path.join(directory, 'pending');
    const pendingDeadline = Date.now() + 2_000;
    for (;;) {
      const pending = await readdir(pendingDir).catch(() => [] as string[]);
      if (pending.length > 0) break;
      if (Date.now() > pendingDeadline) throw new Error('the requester never wrote a pending request');
      await delay(5);
    }

    const worker = startCrossClientHostApprovalWorker({
      directory,
      provider: async (): Promise<boolean> => {
        prompts += 1;
        return true;
      },
      workerId: 'trusted-stdio-claim-close',
      pollMs: 10,
      // Only the scan's own heartbeat reads the clock, so the second read is
      // unambiguously the per-entry expiry check: it runs after the request was
      // read and before the claim. Closing exactly there is the window that the
      // loop's closed check does not cover.
      heartbeatMs: 60_000,
      workerFreshMs: 100,
      now: (): number => {
        clockReads += 1;
        if (clockReads === 2) closeRequested = worker.close();
        return Date.now();
      },
    });
    workers.push(worker);

    await waitFor(() => closeRequested !== undefined);
    await closeRequested;
    await expect(answer).resolves.toBe(false);
    // A prompt after close would keep the trusted provider's serialized queue
    // occupied by an unanswered approval, and it can surface a user-facing
    // prompt for a process that already shut down.
    expect(prompts).toBe(0);
    await expect(readdir(path.join(directory, 'claimed'))).resolves.toEqual([]);
  });

  it('closes while a provider prompt is still pending and leaves no broker files behind', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-approval-close-'));
    temporaryRoots.push(directory);
    let prompts = 0;
    let releaseProvider: () => void = () => undefined;
    const providerGate = new Promise<boolean>((resolve) => { releaseProvider = (): void => { resolve(false); }; });
    const worker = startCrossClientHostApprovalWorker({
      directory,
      provider: async (): Promise<boolean> => {
        prompts += 1;
        return providerGate;
      },
      workerId: 'trusted-stdio-close',
      pollMs: 10,
      heartbeatMs: 10,
      workerFreshMs: 100,
    });
    workers.push(worker);
    const provider = createCrossClientHostMutationApprovalProvider({ directory, timeoutMs: 200, pollMs: 10 });
    const request = provider(scopedRequest('scope-close'));

    await waitFor(() => prompts === 1);
    // The prompt is still open, so a close that waited for it would hang here.
    await expect(worker.close()).resolves.toBeUndefined();
    await expect(request).resolves.toBe(false);

    // Nothing may be recreated after close resolved, which is what both the
    // temporary-root teardown and the stdio shutdown path rely on.
    await delay(40);
    await expect(readdir(path.join(directory, 'workers'))).resolves.toEqual([]);
    releaseProvider();
  });
});
