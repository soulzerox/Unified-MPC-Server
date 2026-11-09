import { describe, expect, it, vi } from 'vitest';
import { reconcileProviderGenerations } from './provider-generation-reconcile.js';

describe('reconcileProviderGenerations', () => {
  it('invalidates a verification before releasing its row', async () => {
    const events: string[] = [];
    const releaseUnknown = vi.fn(async (
      known: readonly string[],
      options?: { readonly beforeRelease?: (workspaceId: string) => Promise<void> },
    ) => {
      events.push(`known:${known.join(',')}`);
      await options?.beforeRelease?.('workspace-gone');
      events.push('release:workspace-gone');
      return ['workspace-gone'];
    });

    const result = await reconcileProviderGenerations(
      { releaseUnknown },
      { list: async () => [{ id: 'workspace-live' }] },
      {
        invalidate: async (workspaceId) => {
          events.push(`invalidate:${workspaceId}`);
          return { ok: true, value: undefined };
        },
      },
    );

    expect(events).toEqual([
      'known:workspace-live',
      'invalidate:workspace-gone',
      'release:workspace-gone',
    ]);
    expect(result).toEqual({ released: ['workspace-gone'] });
  });

  it('keeps the row when the verification cannot be invalidated', async () => {
    const releaseUnknown = vi.fn(async (
      _known: readonly string[],
      options?: { readonly beforeRelease?: (workspaceId: string) => Promise<void> },
    ) => {
      await options?.beforeRelease?.('workspace-gone');
      return ['workspace-gone'];
    });

    const result = await reconcileProviderGenerations(
      { releaseUnknown },
      { list: async () => [{ id: 'workspace-live' }] },
      { invalidate: async () => ({ ok: false, error: { message: 'verification is read-only' } }) },
    );

    expect(result).toEqual({ released: [], error: 'verification is read-only' });
  });

  it('reports a ledger failure instead of throwing so startup can continue', async () => {
    const result = await reconcileProviderGenerations(
      { releaseUnknown: async () => { throw new Error('ledger is read-only'); } },
      { list: async () => [{ id: 'workspace-live' }] },
      { invalidate: async () => ({ ok: true, value: undefined }) },
    );

    expect(result).toEqual({ released: [], error: 'ledger is read-only' });
  });
});
