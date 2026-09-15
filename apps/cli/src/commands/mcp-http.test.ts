import { appError, ok } from '@unified-mpc/domain';
import type { McpServerOptions } from '@unified-mpc/mcp-server';
import { describe, expect, it } from 'vitest';
import { createWebMcpHttpServerOptions, runMcpHttpCommand, type McpHttpServerHandle, type McpHttpServerStarter } from './mcp-http.js';

const workspace = {
  id: 'workspace-http-1',
  displayName: 'fixture',
  rootPath: 'E:\\fixture',
  realRootPath: 'E:\\fixture',
  createdAt: '2026-08-10T00:00:00.000Z',
};

describe('mcp http command', () => {
  it('keeps the ChatGPT Web HTTP composition fail-closed even when a trusted host provider is supplied upstream', () => {
    const hostMutationApprovalProvider = async (): Promise<boolean> => true;
    const webOptions = createWebMcpHttpServerOptions({
      port: 0,
      services: {},
      actor: { clientId: 'web-http-security', clientName: 'web-http-security' },
      allowedHostnames: ['mcp.example.com'],
      hostMutationApprovalProvider,
    });

    expect(webOptions).not.toHaveProperty('hostMutationApprovalProvider');
    expect(webOptions.allowedHostnames).toEqual(['mcp.example.com']);
  });

  it('accepts only an explicitly brokered host approval provider for Web HTTP', () => {
    const directProvider = async (): Promise<boolean> => true;
    const brokerProvider = async (): Promise<boolean> => false;
    const webOptions = createWebMcpHttpServerOptions({
      port: 0,
      services: {},
      actor: { clientId: 'web-http-broker', clientName: 'web-http-broker' },
      hostMutationApprovalProvider: directProvider,
    }, brokerProvider);

    expect(webOptions.hostMutationApprovalProvider).toBe(brokerProvider);
    expect(webOptions.hostMutationApprovalProvider).not.toBe(directProvider);
  });

  it('resolves the configured workspace and strips trusted-host approval before starting HTTP', async () => {
    let startedWith: McpServerOptions | undefined;
    const starter: McpHttpServerStarter = {
      async start(options): Promise<McpHttpServerHandle> {
        startedWith = options;
        return { address: { host: '127.0.0.1', port: 4000 }, endpoint: new URL('http://127.0.0.1:4000/mcp'), close: async (): Promise<void> => {} };
      },
    };

    const result = await runMcpHttpCommand({
      workspaceReference: 'workspace-http-1',
      resolver: { resolve: async () => ok(workspace) },
      createServerOptions: (selectedWorkspace) => ({
        port: 0,
        services: {},
        actor: { clientId: selectedWorkspace.id, clientName: 'unified-mpc-cli' },
        hostMutationApprovalProvider: async (): Promise<boolean> => true,
      }),
      starter,
    });

    expect(result.ok).toBe(true);
    expect(startedWith?.actor.clientId).toBe('workspace-http-1');
    expect(startedWith).not.toHaveProperty('hostMutationApprovalProvider');
  });

  it('does not start when the workspace reference is invalid', async () => {
    let starts = 0;
    const result = await runMcpHttpCommand({
      workspaceReference: ' ',
      resolver: { resolve: async () => ok(workspace) },
      createServerOptions: () => ({ port: 0, services: {}, actor: { clientId: 'unused', clientName: 'unused' } }),
      starter: { start: async (): Promise<McpHttpServerHandle> => { starts += 1; return { address: { host: '127.0.0.1', port: 4000 }, endpoint: new URL('http://127.0.0.1:4000/mcp'), close: async (): Promise<void> => {} }; } },
    });

    expect(result).toEqual({ ok: false, error: appError('INVALID_INPUT', 'A workspace reference is required') });
    expect(starts).toBe(0);
  });
});
