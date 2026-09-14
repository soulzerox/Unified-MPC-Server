import { describe, expect, it, vi } from 'vitest';
import type { HostMutationApprovalRequest } from './tool-registry.js';
import {
  createTrustedHostMutationApprovalProvider,
  formatHostMutationApprovalMessage,
  type HostApprovalCommandRequest,
  type HostApprovalCommandResult,
} from './trusted-host-approval.js';

const request: HostMutationApprovalRequest = {
  toolName: 'mcp_call',
  mutationKind: 'opaque_mutation',
  reason: 'External MCP child mutation is opaque',
  summary: 'Call filesystem.write_file on /workspace/demo.txt',
  workspaceId: 'workspace-1',
  workspaceRoot: '/workspace',
  externalMcpContract: {
    descriptorFingerprint: 'a'.repeat(64),
    catalogFingerprint: 'b'.repeat(64),
  },
};

describe('trusted host exact-action approval', () => {
  it('formats the exact action and pinned child contract for human review', () => {
    const message = formatHostMutationApprovalMessage(request);

    expect(message).toContain('mcp_call');
    expect(message).toContain('opaque_mutation');
    expect(message).toContain(request.reason);
    expect(message).toContain(request.summary);
    expect(message).toContain('workspace-1');
    expect(message).toContain('/workspace');
    expect(message).toContain('a'.repeat(64));
    expect(message).toContain('b'.repeat(64));
    expect(message).toContain('Approve only if this exact action is expected.');
  });

  it('uses Linux GUI approval out-of-band and never falls through after an explicit denial', async () => {
    const commands: HostApprovalCommandRequest[] = [];
    const runCommand = vi.fn(async (command: HostApprovalCommandRequest): Promise<HostApprovalCommandResult> => {
      commands.push(command);
      return { status: 'denied' };
    });
    const ttyPrompt = vi.fn(async () => true);
    const provider = createTrustedHostMutationApprovalProvider({
      platform: 'linux',
      environment: { DISPLAY: ':0' },
      runCommand,
      ttyPrompt,
    });

    await expect(provider(request)).resolves.toBe(false);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe('zenity');
    expect(commands[0]?.args).toContain('--question');
    expect(ttyPrompt).not.toHaveBeenCalled();
  });

  it('falls back across unavailable Linux GUI helpers and then to a controlling TTY', async () => {
    const commands: HostApprovalCommandRequest[] = [];
    const runCommand = vi.fn(async (command: HostApprovalCommandRequest): Promise<HostApprovalCommandResult> => {
      commands.push(command);
      return { status: 'unavailable' };
    });
    const ttyPrompt = vi.fn(async (message: string) => {
      expect(message).toContain(request.summary);
      return true;
    });
    const provider = createTrustedHostMutationApprovalProvider({
      platform: 'linux',
      environment: { DISPLAY: ':0' },
      runCommand,
      ttyPrompt,
    });

    await expect(provider(request)).resolves.toBe(true);
    expect(commands.map((entry) => entry.command)).toEqual(['zenity', 'kdialog']);
    expect(ttyPrompt).toHaveBeenCalledTimes(1);
  });

  it('uses osascript on macOS and PowerShell on Windows', async () => {
    const macCommands: HostApprovalCommandRequest[] = [];
    const macProvider = createTrustedHostMutationApprovalProvider({
      platform: 'darwin',
      runCommand: async (command) => {
        macCommands.push(command);
        return { status: 'approved' };
      },
      ttyPrompt: async () => false,
    });
    await expect(macProvider(request)).resolves.toBe(true);
    expect(macCommands[0]?.command).toBe('osascript');

    const windowsCommands: HostApprovalCommandRequest[] = [];
    const windowsProvider = createTrustedHostMutationApprovalProvider({
      platform: 'win32',
      runCommand: async (command) => {
        windowsCommands.push(command);
        return { status: 'approved' };
      },
      ttyPrompt: async () => false,
    });
    await expect(windowsProvider(request)).resolves.toBe(true);
    expect(windowsCommands[0]?.command).toBe('powershell.exe');
  });

  it('fails closed when no trusted human approval surface is available', async () => {
    const provider = createTrustedHostMutationApprovalProvider({
      platform: 'linux',
      environment: {},
      runCommand: async () => ({ status: 'unavailable' }),
      ttyPrompt: async () => null,
    });

    await expect(provider(request)).resolves.toBe(false);
  });

  it('serializes concurrent approval prompts so dialogs cannot overlap', async () => {
    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];
    const provider = createTrustedHostMutationApprovalProvider({
      platform: 'darwin',
      runCommand: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => release.push(resolve));
        active -= 1;
        return { status: 'approved' };
      },
      ttyPrompt: async () => false,
    });

    const first = provider(request);
    const second = provider({ ...request, summary: 'second exact action' });
    await vi.waitFor(() => expect(release).toHaveLength(1));
    release.shift()?.();
    await vi.waitFor(() => expect(release).toHaveLength(1));
    release.shift()?.();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(maxActive).toBe(1);
  });
});
