import { Client } from '@modelcontextprotocol/client';
import { randomBytes } from 'node:crypto';
import type { McpClientFactory, McpClientSession } from './mcp-session-manager.js';
import { PrivateFdStdioClientTransport } from './private-fd-stdio-transport.js';

const CANONICAL_WORKSPACE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPED_OPERATIONS = new Set([
  'remember', 'remember_turn', 'recall', 'record_event', 'forget',
  'pre_edit_context', 'code_search', 'code_context', 'code_blast_radius',
  'code_index', 'adopt_legacy_index', 'index_status', 'cancel_index',
  'memory_reconcile', 'code_reconcile', 'health', 'version',
]);

function denied(): Error {
  return new Error('workspace_authority_denied');
}

/** Strictly private, per CHILD process. Never persist or log a bootstrap key. */
export interface PrivateFdSessionBootstrap {
  readonly payload: Buffer;
  issue(request: { readonly workspaceId: string; readonly operation: string }): Promise<string>;
  /** Verify Python's strict private-FD3 worker MAC with this session's key. */
  verifyWorkerChallenge(challenge: string, response: unknown): boolean;
  dispose(): void;
}

export interface PrivateFdAuthorizedClientFactoryOptions {
  /** Only a trusted Unified native runtime may provide this issuer. */
  readonly createBootstrap: () => Promise<PrivateFdSessionBootstrap>;
}

/**
 * Opt-in MCP client factory for a distinct worker-bound secret per session.
 *
 * Does not change the external/default MCP client factory or enable the native
 * provider. It rejects caller-supplied proofs and unscoped/unknown operations
 * BEFORE the child IPC call; each scoped call gets one fresh token from the
 * matching child session's authority.
 */
export function createPrivateFdAuthorizedClientFactory(
  options: PrivateFdAuthorizedClientFactoryOptions,
): McpClientFactory {
  return {
    async connect(config, signal): Promise<McpClientSession> {
      if (config.type !== undefined && config.type !== 'stdio') throw denied();
      if (signal?.aborted || typeof options.createBootstrap !== 'function') throw denied();
      let bootstrap: PrivateFdSessionBootstrap;
      try {
        bootstrap = await options.createBootstrap();
      } catch {
        throw denied();
      }
      if (!bootstrap || !Buffer.isBuffer(bootstrap.payload) ||
        typeof bootstrap.issue !== 'function' ||
        typeof bootstrap.verifyWorkerChallenge !== 'function' ||
        typeof bootstrap.dispose !== 'function') {
        bootstrap?.dispose?.();
        throw denied();
      }
      const transport = new PrivateFdStdioClientTransport({
        command: config.command,
        ...(config.args === undefined ? {} : { args: config.args }),
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        ...(config.env === undefined ? {} : { env: config.env }),
        bootstrap: bootstrap.payload,
      });
      const client = new Client(
        { name: 'unified-native-thai-rag-private-worker', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      try {
        await client.connect(transport, signal === undefined ? undefined : { signal });
        // Initialize only establishes an MCP transport, NOT an authenticated
        // worker. Never return a session without a unique FD3 challenge proof.
        const challenge = randomBytes(32).toString('base64url');
        const reply = await client.callTool(
          { name: 'worker_authority_probe', arguments: { challenge } },
          { timeout: 5_000, ...(signal === undefined ? {} : { signal }) },
        );
        if (reply.isError) throw denied();
        // Python FastMCP may expose the returned dict via structuredContent
        // or its single JSON text fallback. No arbitrary nested result is trusted.
        const structured = reply.structuredContent;
        const text = reply.content.length === 1 &&
          reply.content[0]?.type === 'text' ? reply.content[0].text : undefined;
        let verified = structured !== undefined &&
          bootstrap.verifyWorkerChallenge(challenge, structured);
        if (!verified && structured === undefined && typeof text === 'string' && text.length < 4096) {
          const parsed: unknown = JSON.parse(text);
          verified = bootstrap.verifyWorkerChallenge(challenge, parsed);
        }
        if (!verified) throw denied();
      } catch {
        await client.close().catch(() => undefined);
        bootstrap.dispose();
        throw denied();
      }

      let closed = false;
      async function guardedArgs(tool: string, args: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
        if (closed || Object.hasOwn(args, 'authority_proof') || !SCOPED_OPERATIONS.has(tool)) throw denied();
        if ((tool === 'health' || tool === 'version') && !Object.hasOwn(args, 'workspace_id')) {
          return { ...args }; // exact unscoped startup handshake only
        }
        const workspaceId = args.workspace_id;
        if (typeof workspaceId !== 'string' || !CANONICAL_WORKSPACE.test(workspaceId)) throw denied();
        try {
          const proof = await bootstrap.issue({ workspaceId, operation: tool });
          if (typeof proof !== 'string' || proof.length < 32) throw denied();
          if (closed) throw denied();
          return { ...args, authority_proof: proof };
        } catch {
          throw denied();
        }
      }

      return {
        async listTools(listSignal) {
          if (closed) throw denied();
          const catalog = await client.listTools(undefined, listSignal === undefined ? undefined : { signal: listSignal });
          // Never advertise the host-only bootstrap probe to general callers.
          return catalog.tools.filter(tool => tool.name !== 'worker_authority_probe').map((tool) => ({
            name: tool.name,
            description: tool.description ?? '',
            ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
            ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
          }));
        },
        async listResources(listSignal) {
          if (closed) throw denied();
          const resources = await client.listResources(undefined, listSignal === undefined ? undefined : { signal: listSignal });
          return resources.resources.map((resource) => ({
            uri: resource.uri,
            ...(resource.name === undefined ? {} : { name: resource.name }),
            ...(resource.description === undefined ? {} : { description: resource.description }),
            ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
          }));
        },
        async callTool(name, args, callSignal, timeoutMs) {
          const trusted = await guardedArgs(name, args);
          return client.callTool({ name, arguments: trusted },
            callSignal === undefined && timeoutMs === undefined
              ? undefined
              : {
                  ...(callSignal === undefined ? {} : { signal: callSignal }),
                  ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
                });
        },
        async close() {
          if (closed) return;
          closed = true;
          try {
            await client.close();
          } finally {
            bootstrap.dispose();
          }
        },
      };
    },
  };
}
