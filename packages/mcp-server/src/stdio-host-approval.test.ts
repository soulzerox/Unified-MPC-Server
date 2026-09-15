import { describe, expect, it, vi } from 'vitest';
import type { McpServerOptions } from './server.js';
import { bindStdioHostMutationApprovalLifecycle, resolveStdioHostMutationApprovalProvider, resolveStdioTurnPersistenceMode } from './stdio.js';

const approved: NonNullable<McpServerOptions['hostMutationApprovalProvider']> = async () => true;
const denied: NonNullable<McpServerOptions['hostMutationApprovalProvider']> = async () => false;

describe('stdio host approval wiring', () => {
  it('keeps turn persistence required for both legacy and modern stdio unless explicitly overridden', () => {
    expect(resolveStdioTurnPersistenceMode(undefined, 'legacy')).toBe('required');
    expect(resolveStdioTurnPersistenceMode(undefined, 'modern')).toBe('required');
    expect(resolveStdioTurnPersistenceMode('best_effort', 'legacy')).toBe('best_effort');
  });

  it('installs the trusted human approval provider by default for stdio hosts', () => {
    const factory = vi.fn(() => approved);

    const resolved = resolveStdioHostMutationApprovalProvider(undefined, factory);

    expect(resolved).toBe(approved);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicitly supplied trusted host provider', () => {
    const factory = vi.fn(() => approved);

    const resolved = resolveStdioHostMutationApprovalProvider(denied, factory);

    expect(resolved).toBe(denied);
    expect(factory).not.toHaveBeenCalled();
  });

  it('closes an internally owned trusted provider with the stdio handle exactly once', async () => {
    const closeTransport = vi.fn(async () => undefined);
    const closeProvider = vi.fn(async () => undefined);
    const bound = bindStdioHostMutationApprovalLifecycle(
      { close: closeTransport },
      { close: closeProvider },
    );

    await bound.close();
    await bound.close();

    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(closeProvider).toHaveBeenCalledTimes(1);
  });

  it('still closes the owned provider when stdio transport teardown fails', async () => {
    const failure = new Error('transport teardown failed');
    const closeProvider = vi.fn(async () => undefined);
    const bound = bindStdioHostMutationApprovalLifecycle(
      { close: vi.fn(async () => { throw failure; }) },
      { close: closeProvider },
    );

    await expect(bound.close()).rejects.toBe(failure);
    expect(closeProvider).toHaveBeenCalledTimes(1);
  });
});
