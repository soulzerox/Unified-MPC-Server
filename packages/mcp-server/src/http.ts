import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  isLegacyRequest,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  WebStandardStreamableHTTPServerTransport,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type McpHttpHandler,
  type McpServer,
} from '@modelcontextprotocol/server';
import { createMcpServer, type McpServerOptions } from './server.js';
import { SetOfMarksObservationStore } from './set-of-marks-service.js';
import { actorForRequestScope, createHttpRequestScope, createProtocolHttpRequestScope } from './request-scope.js';
import { ModernTasksProtocol } from './modern-tasks-protocol.js';
import { maybeHandleModernTasksWireRequest, maybeTransformModernTasksWireResponse } from './modern-tasks-wire.js';
import { IncrementalVerifier } from './incremental-verifier.js';
import { RunBudgetGuard } from './run-budget.js';
import { PonytailActivationLedger } from './ponytail-runtime.js';
import { HarnessActivationLedger } from './harness-runtime.js';
import { createOriginPolicy, type OriginPolicy } from './origin-policy.js';
import { BoundedRetentionMap } from './bounded-retention-map.js';
import { APP_NAME, APP_VERSION } from '@unified-mpc/shared';

export const MAX_MCP_HTTP_BODY_BYTES = 1_048_576;
export const UNIFIED_MPC_MCP_IDENTITY_PATH = '/_unified-mpc/identity';
export const DEFAULT_LEGACY_SESSION_TTL_MS = 60 * 60_000;
export const LEGACY_SESSION_EVICTION_REASONS = ['idle_ttl', 'lru_capacity', 'client_delete', 'transport_close', 'backend_shutdown', 'protocol_error'] as const;
export type LegacySessionEvictionReason = typeof LEGACY_SESSION_EVICTION_REASONS[number];
export interface LegacySessionEvictionEvent {
  readonly sessionId: string;
  readonly reason: LegacySessionEvictionReason;
}
const DEFAULT_MAX_LEGACY_SESSIONS = 64;

export interface McpHttpServerOptions extends McpServerOptions {
  readonly port: number;
  readonly maxBodyBytes?: number;
  readonly originPolicy?: OriginPolicy;
  readonly allowedHostnames?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly allowedHostnamesProvider?: () => readonly string[] | undefined;
  readonly allowedOriginsProvider?: () => readonly string[] | undefined;
  readonly legacySessionTtlMs?: number;
  readonly maxLegacySessions?: number;
  readonly legacySessionNow?: () => number;
  readonly legacySessionEvictionObserver?: (event: LegacySessionEvictionEvent) => void;
}

export interface McpHttpServerAddress {
  readonly host: '127.0.0.1';
  readonly port: number;
}

export interface McpHttpServerHandle {
  readonly address: McpHttpServerAddress;
  readonly endpoint: URL;
  close(): Promise<void>;
}

interface BodyReadResult {
  readonly tooLarge: boolean;
  readonly body: Buffer;
}

interface LegacySession {
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly scopeSessionId: string;
}

function writeDiagnostic(error: Error): void {
  process.stderr.write(`unified-mpc MCP HTTP error: ${error.message}\n`);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 0 && port <= 65_535;
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<BodyReadResult> {
  const declaredLength = Number(request.headers['content-length']);
  let tooLarge = Number.isFinite(declaredLength) && declaredLength > maxBytes;
  let size = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (!tooLarge && size <= maxBytes) chunks.push(buffer);
    if (size > maxBytes) tooLarge = true;
  }

  return { tooLarge, body: Buffer.concat(chunks) };
}

function toFetchRequest(request: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(', '));
    else if (value !== undefined) headers.set(name, value);
  }

  const requestedPath = new URL(request.url ?? '/', 'http://127.0.0.1');
  const init: RequestInit = { method: request.method ?? 'GET', headers };
  if (init.method !== 'GET' && init.method !== 'HEAD' && body.length > 0) {
    init.body = new Uint8Array(body);
  }
  return new Request(`http://127.0.0.1${requestedPath.pathname}${requestedPath.search}`, init);
}

function sendStatus(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.end(message);
}

function waitForDrainOrClose(response: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      response.off('drain', onDrain);
      response.off('close', onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolve(true);
    };
    const onClose = (): void => {
      cleanup();
      resolve(false);
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
  });
}

async function writeFetchResponse(response: ServerResponse, result: Response): Promise<void> {
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  if (result.body === null) {
    response.end();
    return;
  }

  const reader = result.body.getReader();
  let clientDisconnected = false;
  const onClose = (): void => {
    if (response.writableEnded) return;
    clientDisconnected = true;
    void reader.cancel(new Error('MCP HTTP client disconnected')).catch(() => undefined);
  };
  response.once('close', onClose);
  response.flushHeaders();

  try {
    while (!clientDisconnected) {
      const next = await reader.read();
      if (next.done) break;
      if (response.destroyed) {
        clientDisconnected = true;
        break;
      }
      if (!response.write(next.value) && !(await waitForDrainOrClose(response))) {
        clientDisconnected = true;
        break;
      }
    }
    if (clientDisconnected) await reader.cancel().catch(() => undefined);
  } finally {
    response.off('close', onClose);
    reader.releaseLock();
  }

  if (!clientDisconnected && !response.destroyed && !response.writableEnded) response.end();
}

function sessionNotFoundResponse(): Response {
  return Response.json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Session not found' },
    id: null,
  }, { status: 404 });
}

async function readJsonRpcRequest(request: Request): Promise<JSONRPCMessage | undefined> {
  if (request.method !== 'POST') return undefined;
  try {
    const value = await request.clone().json();
    return isJSONRPCRequest(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function transformModernJsonResponse(
  protocol: ModernTasksProtocol,
  requestMessage: JSONRPCMessage,
  response: Response,
): Promise<Response> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) return response;
  try {
    const value = await response.clone().json();
    if (!isJSONRPCResultResponse(value) && !isJSONRPCErrorResponse(value)) return response;
    const transformed = await maybeTransformModernTasksWireResponse(protocol, requestMessage, value);
    if (transformed === value) return response;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(JSON.stringify(transformed), { status: response.status, statusText: response.statusText, headers });
  } catch {
    return response;
  }
}

function createSessionfulMcpHandler(options: McpHttpServerOptions): McpHttpHandler {
  const runBudgetGuard = options.runBudgetGuard ?? new RunBudgetGuard();
  const incrementalVerifier = options.incrementalVerifier ?? new IncrementalVerifier();
  const setOfMarksStore = options.setOfMarksStore ?? new SetOfMarksObservationStore();
  const ponytailActivationLedger = options.ponytailActivationLedger ?? new PonytailActivationLedger();
  const harnessActivationLedger = options.harnessActivationLedger ?? new HarnessActivationLedger();
  const endpointFallbackSessionId = randomUUID();
  const factory = (request?: Request): McpServer => createMcpServer({
    ...options,
    runBudgetGuard,
    incrementalVerifier,
    setOfMarksStore,
    ponytailActivationLedger,
    harnessActivationLedger,
    legacyTasksProtocol: false,
    requestScope: createHttpRequestScope({ ...(request === undefined ? {} : { request }), fallbackSessionId: endpointFallbackSessionId }),
  });
  const modernHandler = createMcpHandler((context) => factory(context.requestInfo), { legacy: 'reject', onerror: writeDiagnostic });
  const sessionTtlMs = options.legacySessionTtlMs ?? DEFAULT_LEGACY_SESSION_TTL_MS;
  const sessions = new BoundedRetentionMap<string, LegacySession>({
    ttlMs: sessionTtlMs,
    maxEntries: options.maxLegacySessions ?? DEFAULT_MAX_LEGACY_SESSIONS,
    ...(options.legacySessionNow === undefined ? {} : { now: options.legacySessionNow }),
  });
  const closingSessions = new WeakSet<LegacySession>();
  const pendingSessionCloses = new Set<Promise<void>>();
  const explicitCloseReasons = new Map<string, LegacySessionEvictionReason>();
  let closed = false;

  const disposeLegacySession = async (session: LegacySession): Promise<void> => {
    if (closingSessions.has(session)) return;
    closingSessions.add(session);
    ponytailActivationLedger.invalidateSession(session.scopeSessionId);
    harnessActivationLedger.invalidateSession(session.scopeSessionId);
    await session.server.close().catch(() => undefined);
  };

  const trackSessionClose = (session: LegacySession): Promise<void> => {
    const pending = disposeLegacySession(session);
    pendingSessionCloses.add(pending);
    void pending.finally(() => pendingSessionCloses.delete(pending));
    return pending;
  };

  const trackSessionEviction = (
    sessionId: string,
    session: LegacySession,
    reason: LegacySessionEvictionReason,
  ): Promise<void> => {
    if (closingSessions.has(session)) return Promise.resolve();
    try {
      options.legacySessionEvictionObserver?.({ sessionId, reason });
    } catch (error: unknown) {
      writeDiagnostic(error instanceof Error ? error : new Error(String(error)));
    }
    return trackSessionClose(session);
  };

  const pruneLegacySessions = async (): Promise<void> => {
    const expired = sessions.pruneExpired();
    await Promise.allSettled(expired.map(([sessionId, session]) => trackSessionEviction(sessionId, session, 'idle_ttl')));
  };

  const sweepTimer = setInterval(() => { void pruneLegacySessions(); }, Math.min(sessionTtlMs, 60_000));
  sweepTimer.unref();

  const closeLegacySession = async (
    sessionId: string,
    session: LegacySession,
    reason: LegacySessionEvictionReason,
  ): Promise<void> => {
    if (sessions.peek(sessionId) === session) sessions.delete(sessionId);
    await trackSessionEviction(sessionId, session, reason);
  };

  const createLegacySession = async (request: Request): Promise<Response> => {
    if (closed) return sessionNotFoundResponse();

    const protocolSessionId = randomUUID();
    const requestScope = createProtocolHttpRequestScope(protocolSessionId);
    const server = createMcpServer({
      ...options,
      runBudgetGuard,
      incrementalVerifier,
      setOfMarksStore,
      ponytailActivationLedger,
      harnessActivationLedger,
      legacyTasksProtocol: true,
      requestScope,
    });
    let registeredSessionId: string | undefined;
    let registeredSession: LegacySession | undefined;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: (): string => protocolSessionId,
      onsessioninitialized(sessionId): void {
        registeredSessionId = sessionId;
        registeredSession = { server, transport, scopeSessionId: requestScope.sessionId };
        const evicted = sessions.setWithEvictions(sessionId, registeredSession);
        for (const entry of evicted) {
          void trackSessionEviction(entry.key, entry.value, entry.reason === 'ttl' ? 'idle_ttl' : 'lru_capacity');
        }
      },
      onsessionclosed(sessionId): void {
        const session = sessions.peek(sessionId);
        if (session?.transport !== transport) return;
        sessions.delete(sessionId);
        const reason = explicitCloseReasons.get(sessionId) ?? 'transport_close';
        explicitCloseReasons.delete(sessionId);
        void trackSessionEviction(sessionId, session, reason);
      },
    });

    try {
      await server.connect(transport);
      const result = await transport.handleRequest(request);
      if (registeredSessionId === undefined) await server.close();
      else await Promise.allSettled([...pendingSessionCloses]);
      return result;
    } catch (error: unknown) {
      if (registeredSessionId !== undefined && registeredSession !== undefined && sessions.peek(registeredSessionId) === registeredSession) {
        sessions.delete(registeredSessionId);
      }
      if (registeredSessionId !== undefined && registeredSession !== undefined) {
        await trackSessionEviction(registeredSessionId, registeredSession, 'protocol_error');
      } else {
        await server.close().catch(() => undefined);
      }
      throw error;
    }
  };

  return {
    bus: modernHandler.bus,
    notify: modernHandler.notify,
    async fetch(request, requestOptions): Promise<Response> {
      if (!(await isLegacyRequest(request))) {
        const requestMessage = await readJsonRpcRequest(request);
        if (requestMessage === undefined) return modernHandler.fetch(request, requestOptions);
        const requestScope = createHttpRequestScope({ request, fallbackSessionId: endpointFallbackSessionId });
        const protocol = new ModernTasksProtocol(options.services, { actor: actorForRequestScope(options.actor, requestScope) });
        const taskResponse = await maybeHandleModernTasksWireRequest(protocol, requestMessage);
        if (taskResponse !== undefined) return Response.json(taskResponse, { headers: { 'cache-control': 'no-store' } });
        const result = await modernHandler.fetch(request, requestOptions);
        return transformModernJsonResponse(protocol, requestMessage, result);
      }

      await pruneLegacySessions();
      const sessionId = request.headers.get('mcp-session-id')?.trim();
      if (sessionId === undefined || sessionId.length === 0) {
        return createLegacySession(request);
      }

      const session = sessions.get(sessionId);
      if (session === undefined) return sessionNotFoundResponse();

      if (request.method === 'DELETE') explicitCloseReasons.set(sessionId, 'client_delete');
      try {
        const result = await session.transport.handleRequest(request, requestOptions);
        if (request.method === 'DELETE') await closeLegacySession(sessionId, session, 'client_delete');
        return result;
      } catch (error: unknown) {
        if (sessions.peek(sessionId) === session) {
          sessions.delete(sessionId);
          await trackSessionEviction(sessionId, session, 'protocol_error');
        }
        throw error;
      } finally {
        explicitCloseReasons.delete(sessionId);
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(sweepTimer);
      await modernHandler.close();
      const activeSessions = sessions.drain();
      await Promise.allSettled(activeSessions.map(([sessionId, session]) => trackSessionEviction(sessionId, session, 'backend_shutdown')));
      await Promise.allSettled([...pendingSessionCloses]);
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: McpHttpHandler,
  originPolicy: OriginPolicy,
  maxBodyBytes: number,
  allowedHostnames: readonly string[],
): Promise<void> {
  const requestedPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (requestedPath !== '/mcp' && requestedPath !== UNIFIED_MPC_MCP_IDENTITY_PATH) {
    sendStatus(response, 404, 'Not found');
    return;
  }

  const read = await readBody(request, maxBodyBytes);
  if (read.tooLarge) {
    sendStatus(response, 413, 'Request body too large');
    return;
  }

  const fetchRequest = toFetchRequest(request, read.body);
  const rejected = hostHeaderValidationResponse(fetchRequest, [...allowedHostnames])
    ?? originPolicy.validate(fetchRequest);
  if (rejected !== undefined) {
    await writeFetchResponse(response, rejected);
    return;
  }

  if (requestedPath === UNIFIED_MPC_MCP_IDENTITY_PATH) {
    if (fetchRequest.method !== 'GET') {
      sendStatus(response, 405, 'Method not allowed');
      return;
    }
    await writeFetchResponse(response, Response.json({
      product: APP_NAME,
      service: 'desktop-mcp',
      protocol: 1,
      version: APP_VERSION,
    }, {
      headers: {
        'cache-control': 'no-store',
        'x-unified-mpc-service': 'desktop-mcp',
      },
    }));
    return;
  }

  await writeFetchResponse(response, await handler.fetch(fetchRequest));
}

function listen(server: HttpServer, port: number): Promise<McpHttpServerAddress> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
        reject(new Error('MCP HTTP server did not bind to loopback'));
        return;
      }
      resolve({ host: '127.0.0.1', port: address.port });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port });
  });
}

export async function startMcpHttp(options: McpHttpServerOptions): Promise<McpHttpServerHandle> {
  if (!isValidPort(options.port)) throw new Error('MCP HTTP port must be an integer from 0 to 65535');
  const maxBodyBytes = options.maxBodyBytes ?? MAX_MCP_HTTP_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new Error('MCP HTTP body limit must be positive');

  const handler = createSessionfulMcpHandler(options);
  const configuredHostnames = options.allowedHostnamesProvider ?? ((): readonly string[] | undefined => options.allowedHostnames);
  const configuredOrigins = options.allowedOriginsProvider ?? ((): readonly string[] | undefined => options.allowedOrigins);
  const server = createServer((request, response) => {
    const allowedHostnames = [...new Set([...localhostAllowedHostnames(), ...(configuredHostnames() ?? [])])];
    const allowedOrigins = [...new Set([...localhostAllowedOrigins(), ...(configuredOrigins() ?? [])])];
    const requestOriginPolicy = options.originPolicy ?? createOriginPolicy(allowedOrigins);
    void handleRequest(request, response, handler, requestOriginPolicy, maxBodyBytes, allowedHostnames).catch((error: unknown) => {
      writeDiagnostic(error instanceof Error ? error : new Error('Unhandled MCP HTTP request error'));
      if (!response.headersSent) sendStatus(response, 500, 'Internal server error');
      else response.destroy();
    });
  });
  const address = await listen(server, options.port);
  const endpoint = new URL(`http://${address.host}:${address.port}/mcp`);

  return {
    address,
    endpoint,
    async close(): Promise<void> {
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}

