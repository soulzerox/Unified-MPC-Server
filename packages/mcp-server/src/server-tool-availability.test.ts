import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import type { FileActor } from '@unified-mpc/application';
import type { ToolAvailabilitySnapshot } from '@unified-mpc/shared';
import { createMcpServer } from './server.js';
import { ToolRegistry } from './tool-registry.js';
import type { McpApplicationServices } from './tool-registry.js';
import { prepareCodeChangeSchema } from './index.js';

const actor: FileActor = {
  clientId: 'tool-availability-test-client',
  clientName: 'tool-availability-test',
  sessionId: 'tool-availability-test-session',
};

describe('MCP server live tool availability', () => {
  it('exports canonical harness schemas from public MCP package surface', () => {
    expect(prepareCodeChangeSchema).toBeDefined();
    expect(prepareCodeChangeSchema.safeParse({ workspaceId: 'workspace-1', filePath: 'src/file.ts', unexpected: true }).success).toBe(false);
    const registry = new ToolRegistry({}, actor);
    expect(registry.describeInputJsonSchema('workspace_bootstrap')).toMatchObject({ additionalProperties: false, required: ['workspaceId'] });
    expect(registry.describeInputJsonSchema('prepare_code_change')).toMatchObject({ additionalProperties: false, required: ['workspaceId', 'filePath'] });
    expect(Object.keys(registry.describeInputJsonSchema('prepare_code_change')?.properties as object)).toEqual(['workspaceId', 'filePath', 'proposedSymbol', 'runGodkillerSafetyCheck']);
  });

  it('exports only exposed canonical definitions while retaining harness prerequisites', (): void => {
    const registry = new ToolRegistry({}, actor, {
      toolAvailabilitySnapshotProvider: (): ToolAvailabilitySnapshot => ({ version: 1, generation: 1, overrides: { read_file: 'disabled' } }),
    });

    expect(registry.listExposedDefinitions().map((tool) => tool.name)).not.toContain('read_file');
    expect(registry.listExposedDefinitions().map((tool) => tool.name)).toContain('workspace_bootstrap');
    expect(registry.listExposedDefinitions().map((tool) => tool.name)).toContain('prepare_code_change');
    expect(registry.describeExposedDefinition('prepare_code_change')).toBe(registry.listExposedDefinitions().find((tool) => tool.name === 'prepare_code_change'));
  });

  it('keeps canonical harness schemas strict at registry invocation boundary', async () => {
    const registry = new ToolRegistry({}, actor);
    expect(registry.describeInputJsonSchema('prepare_code_change')).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['workspaceId', 'filePath'],
    });
    await expect(registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1',
      filePath: 'src/file.ts',
      unexpected: true,
    })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
  });

  it('keeps connector discovery contract identical to canonical registered harness definitions', async () => {
    const registry = new ToolRegistry({}, actor);
    const canonical = registry.describeSchema('prepare_code_change');
    expect(canonical).toBeDefined();

    const server = createMcpServer({ services: {} as McpApplicationServices, actor });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'connector-contract-test-client', version: '1.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const tool = listed.tools.find((candidate) => candidate.name === 'prepare_code_change');
      expect(tool).toBeDefined();
      const described = await client.callTool({ name: 'tool_describe', arguments: { name: 'prepare_code_change' } });
      expect(described.isError).not.toBe(true);
      const describedValue = described.structuredContent as {
        inputSchema: unknown;
        outputSchema: unknown;
        annotations: unknown;
        execution: unknown;
      };

      expect(tool?.inputSchema).toEqual(describedValue.inputSchema);
      expect(tool?.outputSchema).toEqual(describedValue.outputSchema);
      expect(tool?.annotations).toEqual(describedValue.annotations);
      expect(describedValue.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['workspaceId', 'filePath'],
      });
      const invalid = await client.callTool({
        name: 'prepare_code_change',
        arguments: { workspaceId: 'workspace-1', filePath: 'src/file.ts', unexpected: true },
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text' })]));
      expect(canonical?.inputSchema).toBeInstanceOf(Object);
      expect(canonical?.annotations).toEqual(describedValue.annotations);
      expect(canonical?.execution).toEqual(describedValue.execution);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('updates one connected client live and debounces tools/list_changed notifications', async () => {
    let snapshot: ToolAvailabilitySnapshot = { version: 1, generation: 0, overrides: {} };
    const listeners = new Set<(next: ToolAvailabilitySnapshot) => void>();
    let unsubscribeCount = 0;

    const server = createMcpServer({
      services: {} as McpApplicationServices,
      actor,
      toolAvailabilitySnapshotProvider: () => snapshot,
      toolAvailabilitySubscribe(listener): () => void {
        listeners.add(listener);
        return () => {
          if (listeners.delete(listener)) unsubscribeCount += 1;
        };
      },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tool-availability-test-client', version: '1.0.0' });
    let toolListChangedNotifications = 0;
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      toolListChangedNotifications += 1;
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const initial = await client.listTools();
      expect(initial.tools.map((tool) => tool.name)).toContain('read_file');
      expect(initial.tools.map((tool) => tool.name)).not.toContain('codex_run');

      snapshot = {
        version: 1,
        generation: 1,
        overrides: { read_file: 'disabled' },
      };
      for (const listener of [...listeners]) listener(snapshot);

      snapshot = {
        version: 1,
        generation: 2,
        overrides: { read_file: 'enabled' },
      };
      for (const listener of [...listeners]) listener(snapshot);

      await vi.waitFor(() => {
        expect(toolListChangedNotifications).toBe(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(toolListChangedNotifications).toBe(1);

      const updated = await client.listTools();
      expect(updated.tools.map((tool) => tool.name)).toContain('read_file');
      expect(updated.tools.map((tool) => tool.name)).not.toContain('codex_run');
      const prepare = updated.tools.find((tool) => tool.name === 'prepare_code_change');
      const bootstrap = updated.tools.find((tool) => tool.name === 'workspace_bootstrap');
      expect(bootstrap).toBeDefined();
      expect(prepare).toBeDefined();
      expect(prepare?.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['workspaceId', 'filePath'],
        properties: {
          workspaceId: { type: 'string' },
          filePath: { type: 'string' },
          proposedSymbol: { type: 'string' },
          runGodkillerSafetyCheck: { type: 'boolean' },
        },
      });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }

    expect(unsubscribeCount).toBe(1);
    expect(listeners.size).toBe(0);
  });
});
