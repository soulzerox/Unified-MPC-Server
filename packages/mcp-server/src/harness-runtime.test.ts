import { describe, expect, it } from 'vitest';
import type { MandatoryMcpBootstrapResult } from '@unified-mpc/extensions';
import { HarnessActivationLedger } from './harness-runtime.js';

const mandatoryMcp = { ready: true, servers: [] } as unknown as MandatoryMcpBootstrapResult;

describe('HarnessActivationLedger lifecycle', () => {
  it('invalidates every workspace state owned by one transport session only', () => {
    const ledger = new HarnessActivationLedger();
    const first = { sessionId: 'session-1', workspaceId: 'workspace-1' } as const;
    const second = { sessionId: 'session-1', workspaceId: 'workspace-2' } as const;
    const other = { sessionId: 'session-2', workspaceId: 'workspace-1' } as const;
    ledger.markBootstrapped(first, 'hash-a', mandatoryMcp);
    ledger.markBootstrapped(second, 'hash-b', mandatoryMcp);
    ledger.markBootstrapped(other, 'hash-c', mandatoryMcp);

    ledger.invalidateSession('session-1');

    expect(ledger.state(first)).toBeUndefined();
    expect(ledger.state(second)).toBeUndefined();
    expect(ledger.state(other)).toBeDefined();
  });
});
