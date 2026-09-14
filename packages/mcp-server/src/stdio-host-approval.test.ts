import { describe, expect, it, vi } from 'vitest';
import type { McpServerOptions } from './server.js';
import { resolveStdioHostMutationApprovalProvider } from './stdio.js';

const approved: NonNullable<McpServerOptions['hostMutationApprovalProvider']> = async () => true;
const denied: NonNullable<McpServerOptions['hostMutationApprovalProvider']> = async () => false;

describe('stdio host approval wiring', () => {
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
});
