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
});
