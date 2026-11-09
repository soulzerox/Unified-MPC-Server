import { describe, expect, it, vi } from 'vitest';
import { reconcileProviderGenerations } from './provider-generation-reconcile.js';

describe('reconcileProviderGenerations', () => {
  it('releases rows for workspaces that are no longer registered', async () => {
    const releaseUnknown = vi.fn(async () => ['workspace-gone']);

    const result = await reconcileProviderGenerations(
      { releaseUnknown },
      { list: async () => [{ id: 'workspace-live' }] },
    );

    expect(releaseUnknown).toHaveBeenCalledWith(['workspace-live']);
    expect(result).toEqual({ released: ['workspace-gone'] });
  });

  it('reports a sweep failure instead of throwing so startup can continue', async () => {
    const result = await reconcileProviderGenerations(
      { releaseUnknown: async () => { throw new Error('ledger is read-only'); } },
      { list: async () => [{ id: 'workspace-live' }] },
    );

    expect(result).toEqual({ released: [], error: 'ledger is read-only' });
  });
});
