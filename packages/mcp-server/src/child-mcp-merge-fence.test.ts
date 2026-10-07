import { describe, expect, it, vi } from 'vitest';
import { ok } from '@unified-mpc/domain';
import { permissionProfiles, type PermissionProfile } from '@unified-mpc/permissions';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';

const actor = { clientId: 'client-1', clientName: 'test' };

describe('child MCP merge fence', () => {
  it.each(['merge_pull_request', 'enable_auto_merge'] as const)(
    'hard-blocks pull-request merge entrypoint %s even under Full Bypass',
    async (childTool) => {
      const childCall = vi.fn(async () => ok({ merged: true }));
      const registry = new ToolRegistry({
        extensions: { callMcpTool: childCall } as unknown as McpApplicationServices['extensions'],
      }, actor, {
        profileProvider: (): PermissionProfile => permissionProfiles.full,
        authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
      });

      const response = await registry.invoke('mcp_call', {
        server: 'github',
        tool: childTool,
        arguments: { repository_full_name: 'soulzerox/Unified-MPC-Server', pr_number: 277 },
      });

      expect(childCall).not.toHaveBeenCalled();
      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: 'PERMISSION_DENIED',
            message: expect.stringContaining('guarded merge'),
          },
        },
      });
    },
  );

  it.each(['create_file', 'update_file', 'delete_file'] as const)(
    'hard-blocks direct repository-content mutation %s through child MCP even under Full Bypass',
    async (childTool) => {
      const childCall = vi.fn(async () => ok({ commit_sha: 'a'.repeat(40) }));
      const registry = new ToolRegistry({
        extensions: { callMcpTool: childCall } as unknown as McpApplicationServices['extensions'],
      }, actor, {
        profileProvider: (): PermissionProfile => permissionProfiles.full,
        authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
      });

      const response = await registry.invoke('mcp_call', {
        server: 'renamed-github-provider',
        tool: childTool,
        arguments: {
          repository_full_name: 'soulzerox/Unified-MPC-Server',
          path: 'src/index.ts',
          branch: 'main',
        },
      });

      expect(childCall).not.toHaveBeenCalled();
      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: 'PERMISSION_DENIED',
            message: expect.stringContaining('repository-content'),
          },
        },
      });
    },
  );

  it('does not mistake a non-repository child update_file call for GitHub repository integration', async () => {
    const childCall = vi.fn(async () => ok({ updated: true }));
    const registry = new ToolRegistry({
      extensions: { callMcpTool: childCall } as unknown as McpApplicationServices['extensions'],
    }, actor, {
      profileProvider: (): PermissionProfile => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    });

    const response = await registry.invoke('mcp_call', {
      server: 'filesystem',
      tool: 'update_file',
      arguments: { path: 'src/index.ts', content: 'next' },
    });

    expect(response.isError).not.toBe(true);
    expect(childCall).toHaveBeenCalledTimes(1);
  });

  it('hard-blocks direct branch-ref movement through child MCP even under Full Bypass', async () => {
    const childCall = vi.fn(async () => ok({ ref: 'refs/heads/main' }));
    const registry = new ToolRegistry({
      extensions: { callMcpTool: childCall } as unknown as McpApplicationServices['extensions'],
    }, actor, {
      profileProvider: (): PermissionProfile => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    });

    const response = await registry.invoke('mcp_call', {
      server: 'github',
      tool: 'update_ref',
      arguments: {
        repository_full_name: 'soulzerox/Unified-MPC-Server',
        branch_name: 'main',
        sha: 'a'.repeat(40),
        expected_sha: 'b'.repeat(40),
      },
    });

    expect(childCall).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'PERMISSION_DENIED',
          message: expect.stringContaining('branch-ref'),
        },
      },
    });
  });
});
