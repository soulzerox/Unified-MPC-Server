import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { FileActor } from '@unified-mpc/application';
import {
  DEFAULT_LSP_PROCESS_ADMISSION_COST,
  hostPathApi,
  isAbsoluteHostPath,
  isHostPathWithin,
  resolveHostPath,
  tryAdmitLspProcess,
  type ResourceAdmissionController,
  type ResourceAdmissionLease,
} from '@unified-mpc/workspace';
import type { McpApplicationServices } from './tools/tool-types.js';

/**
 * Wave 6 minimal stdio LSP client behind `lsp_diagnostics` and `lsp_rename`.
 * Language servers are configured per language through environment variables
 * (UNIFIED_MPC_LSP_<LANGUAGE>_COMMAND, JSON argv preferred). Workspace files are
 * canonicalized before they are opened so LSP cannot bypass workspace roots.
 */

const MAX_OPEN_FILES = 32;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DIAGNOSTICS_QUIET_MS = 2_000;
const DIAGNOSTICS_MAX_WAIT_MS = 10_000;
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.cs': 'csharp',
};

export interface LspRuntimeOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Injectable for tests: creates the server process. */
  readonly spawner?: (command: readonly string[]) => Result<ChildProcess>;
  /** Test/fixture override; production uses the actual host platform. */
  readonly platform?: NodeJS.Platform;
  /** Process-owned admission controller shared with all other expensive subsystems. */
  readonly resourceAdmissionController?: ResourceAdmissionController;
  /** Stable caller/session owner used for admission accounting. */
  readonly resourceAdmissionSessionId?: string;
  /** Weighted cost charged while one LSP server process is alive. */
  readonly lspProcessAdmissionCost?: number;
}

/** One JSON-RPC demultiplexer per server process. */
class LspConnection {
  private buffer = Buffer.alloc(0);
  private readonly responseWaiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private notificationHandler: ((method: string, params: Record<string, unknown>) => void) | undefined;

  public constructor(private readonly server: ChildProcess) {
    server.stdout?.on('data', (chunk: Buffer) => this.receive(chunk));
    server.stdin?.on('error', () => undefined);
    server.stdout?.on('error', () => undefined);
    server.on('error', () => undefined);
  }

  public onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  public request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const rejectPending = (error: Error): void => {
        if (settled) return;
        settled = true;
        this.responseWaiters.delete(id);
        cleanup();
        reject(error);
      };
      const onAbort = (): void => rejectPending(new Error(`LSP ${method} cancelled`));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      timer = setTimeout(() => rejectPending(new Error(`LSP ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
      this.responseWaiters.set(id, {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        reject: (error) => rejectPending(error),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        rejectPending(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  public close(): void {
    try {
      this.write({ jsonrpc: '2.0', id: randomUUID(), method: 'shutdown', params: {} });
      this.notify('exit', {});
    } catch {
      // The server may already be gone.
    }
    this.server.kill();
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (match === null) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.byteLength < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message: Record<string, unknown>;
      try { message = JSON.parse(body) as Record<string, unknown>; } catch { continue; }
      if (typeof message.method === 'string') {
        this.notificationHandler?.(message.method, (message.params ?? {}) as Record<string, unknown>);
      } else if (message.id !== undefined) {
        const waiter = this.responseWaiters.get(String(message.id));
        if (waiter === undefined) continue;
        this.responseWaiters.delete(String(message.id));
        if (message.error !== undefined) waiter.reject(new Error(String((message.error as { message?: unknown }).message ?? 'LSP request failed')));
        else waiter.resolve(message.result);
      }
    }
  }

  private write(message: Record<string, unknown>): void {
    const body = JSON.stringify(message);
    this.server.stdin?.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`, 'utf8');
  }
}

export class LspRuntimeService {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly spawner: (command: readonly string[]) => Result<ChildProcess>;
  private readonly platform: NodeJS.Platform;
  private readonly resourceAdmissionController: ResourceAdmissionController | undefined;
  private readonly resourceAdmissionSessionId: string;
  private readonly lspProcessAdmissionCost: number;

  public constructor(
    private readonly services: McpApplicationServices,
    private readonly actor: FileActor,
    options: LspRuntimeOptions = {},
  ) {
    this.environment = options.environment ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawner = options.spawner ?? defaultSpawner;
    this.platform = options.platform ?? process.platform;
    this.resourceAdmissionController = options.resourceAdmissionController;
    this.resourceAdmissionSessionId = options.resourceAdmissionSessionId ?? (actor.sessionId?.trim() || actor.clientId);
    this.lspProcessAdmissionCost = normalizePositiveInteger(options.lspProcessAdmissionCost, DEFAULT_LSP_PROCESS_ADMISSION_COST);
  }

  public async diagnostics(input: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    const published = new Map<string, unknown[]>();
    const session = await this.startSession(input, (connection) => {
      connection.onNotification((method, params) => {
        if (method !== 'textDocument/publishDiagnostics') return;
        const uri = typeof params.uri === 'string' ? params.uri : undefined;
        if (uri !== undefined) published.set(uri, Array.isArray(params.diagnostics) ? params.diagnostics : []);
      });
    }, signal);
    if (!session.ok) {
      if (session.error.message.startsWith('No language server configured for ')) {
        return ok({ tool: 'lsp_diagnostics', status: 'needs_setup', available: false, ready: false, executed: false, requirements: ['configured local language server'] });
      }
      return session;
    }
    try {
      await this.openFiles(session.value.connection, session.value.files, session.value.language, signal);
      await quietPeriod(DIAGNOSTICS_QUIET_MS, DIAGNOSTICS_MAX_WAIT_MS, signal);
      return ok({
        tool: 'lsp_diagnostics', status: 'ready', available: true,
        language: session.value.language, server: session.value.command[0],
        filesChecked: published.size,
        diagnostics: [...published.entries()].map(([uri, entries]) => ({ file: uriToPath(uri, this.platform), count: entries.length, entries })),
      });
    } catch (error) {
      return this.operationFailure('diagnostics', error, signal);
    } finally {
      session.value.connection.close();
    }
  }

  public async renamePlan(input: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    const requestedFile = firstFile(input);
    const newName = readString(input.newName ?? input.new_name);
    if (requestedFile === undefined || newName === undefined) return err(appError('INVALID_INPUT', 'lsp_rename requires file and newName'));
    const session = await this.startSession(input, () => undefined, signal);
    if (!session.ok) {
      if (session.error.message.startsWith('No language server configured for ')) {
        return ok({ tool: 'lsp_rename', status: 'needs_setup', available: false, ready: false, executed: false, requirements: ['configured local language server'] });
      }
      return session;
    }
    try {
      await this.openFiles(session.value.connection, session.value.files, session.value.language, signal);
      const targetFile = session.value.files[0]!;
      const edit = await session.value.connection.request('textDocument/rename', {
        textDocument: { uri: pathToUri(targetFile, this.platform) },
        position: { line: typeof input.line === 'number' ? input.line : 0, character: typeof input.character === 'number' ? input.character : 0 },
        newName,
      }, this.timeoutMs, signal);
      return ok({
        tool: 'lsp_rename', status: 'ready', available: true, applied: false, requiresApproval: true,
        language: session.value.language, file: requestedFile, newName, edit,
        applyHint: 'Review the workspace edit, then apply it through apply_patch/write_file after explicit user confirmation',
      });
    } catch (error) {
      return this.operationFailure('rename', error, signal);
    } finally {
      session.value.connection.close();
    }
  }

  private async startSession(
    input: Record<string, unknown>,
    attach: (connection: LspConnection) => void,
    signal?: AbortSignal,
  ): Promise<Result<{ root: string; language: string; command: readonly string[]; files: readonly string[]; connection: LspConnection }>> {
    const workspaceId = readString(input.workspaceId);
    if (workspaceId === undefined) return err(appError('INVALID_INPUT', 'LSP tools require workspaceId'));

    const requestedFiles = (Array.isArray(input.files) ? input.files : [input.file].filter((value): value is string => typeof value === 'string'))
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0)
      .slice(0, MAX_OPEN_FILES);
    if (requestedFiles.length === 0) return err(appError('INVALID_INPUT', 'LSP tools require file or files'));
    const language = readString(input.language) ?? LANGUAGE_BY_EXTENSION[hostPathApi(this.platform).extname(requestedFiles[0]!).toLowerCase()] ?? '';
    if (language === '') return err(appError('INVALID_INPUT', 'Could not infer a language; pass language explicitly'));
    const command = this.serverCommand(language);
    if (command === undefined) {
      return err(appError('PERMISSION_DENIED', `No language server configured for ${language}. Set UNIFIED_MPC_LSP_${language.toUpperCase()}_COMMAND (JSON argv preferred)`));
    }
    const root = await this.workspaceRoot(workspaceId);
    if (!root.ok) return root;
    const resolvedFiles = await this.resolveWorkspaceFiles(root.value, requestedFiles);
    if (!resolvedFiles.ok) return resolvedFiles;
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'LSP operation was cancelled before process start', true));

    let admissionLease: ResourceAdmissionLease | undefined;
    if (this.resourceAdmissionController !== undefined) {
      const admission = tryAdmitLspProcess(this.resourceAdmissionController, {
        operationId: `lsp:${randomUUID()}`,
        workspaceId,
        sessionId: this.resourceAdmissionSessionId,
        cost: this.lspProcessAdmissionCost,
      });
      if (!admission.admitted) {
        return err(appError(
          admission.code,
          `LSP process rejected by resource admission (${admission.reason})`,
          admission.retryable,
          {
            reason: admission.reason,
            requestedCost: admission.requestedCost,
            activeCost: admission.snapshot.activeCost,
            activeOperations: admission.snapshot.activeOperations,
          },
        ));
      }
      admissionLease = admission.lease;
    }

    const spawned = this.spawner(command);
    if (!spawned.ok) {
      this.releaseAdmission(admissionLease);
      return spawned;
    }
    if (admissionLease !== undefined) {
      spawned.value.once('close', () => this.releaseAdmission(admissionLease));
    }
    const connection = new LspConnection(spawned.value);
    try {
      attach(connection);
    } catch (error) {
      connection.close();
      return err(appError('INTERNAL_ERROR', `Language server session setup failed: ${error instanceof Error ? error.message : String(error)}`, true));
    }
    try {
      await connection.request('initialize', {
        processId: process.pid,
        rootUri: pathToUri(root.value, this.platform),
        capabilities: { textDocument: { synchronization: { dynamicRegistration: false } } },
      }, this.timeoutMs, signal);
    } catch (error) {
      connection.close();
      return signal?.aborted
        ? err(appError('PROCESS_TIMEOUT', 'Language server initialization was cancelled', true))
        : err(appError('INTERNAL_ERROR', `Language server initialization failed: ${error instanceof Error ? error.message : String(error)}`, true));
    }
    connection.notify('initialized', {});
    return ok({ root: root.value, language, command, files: resolvedFiles.value, connection });
  }

  private async resolveWorkspaceFiles(root: string, files: readonly string[]): Promise<Result<readonly string[]>> {
    let canonicalRoot: string;
    try {
      const resolvedRoot = resolveHostPath(root, this.platform);
      if (resolvedRoot === null) return err(appError('INVALID_INPUT', 'Workspace root uses a foreign host path syntax'));
      canonicalRoot = await realpath(resolvedRoot);
    } catch {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root could not be resolved'));
    }
    const resolved: string[] = [];
    for (const file of files) {
      if (this.platform !== 'win32' && file.includes('\\')) return err(appError('INVALID_INPUT', `LSP file uses a foreign host syntax: ${file}`));
      const api = hostPathApi(this.platform);
      const candidate = isAbsoluteHostPath(file, this.platform)
        ? resolveHostPath(file, this.platform)
        : resolveHostPath(api.join(canonicalRoot, file), this.platform);
      if (candidate === null) return err(appError('INVALID_INPUT', `LSP file uses a foreign host syntax: ${file}`));
      if (!isHostPathWithin(canonicalRoot, candidate, this.platform)) return err(appError('PATH_OUTSIDE_WORKSPACE', `LSP file is outside the registered workspace: ${file}`));
      if (!existsSync(candidate)) return err(appError('FILE_NOT_FOUND', `LSP file was not found: ${file}`));
      let canonicalFile: string;
      try {
        canonicalFile = await realpath(candidate);
      } catch {
        return err(appError('FILE_NOT_FOUND', `LSP file could not be resolved: ${file}`));
      }
      if (!isHostPathWithin(canonicalRoot, canonicalFile, this.platform)) return err(appError('PATH_OUTSIDE_WORKSPACE', `LSP file resolves outside the registered workspace: ${file}`));
      resolved.push(canonicalFile);
    }
    return ok(resolved);
  }

  private async openFiles(connection: LspConnection, files: readonly string[], language: string, signal?: AbortSignal): Promise<void> {
    for (const absolute of files) {
      if (signal?.aborted) throw new Error('LSP file opening cancelled');
      const content = await readFile(absolute, 'utf8');
      if (signal?.aborted) throw new Error('LSP file opening cancelled');
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) continue;
      connection.notify('textDocument/didOpen', {
        textDocument: { uri: pathToUri(absolute, this.platform), languageId: languageIdForFile(absolute, language), version: 1, text: content },
      });
    }
  }

  private releaseAdmission(lease: ResourceAdmissionLease | undefined): void {
    if (lease === undefined || this.resourceAdmissionController === undefined) return;
    this.resourceAdmissionController.release(lease);
  }

  private operationFailure(operation: string, error: unknown, signal?: AbortSignal): Result<never> {
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', `LSP ${operation} was cancelled`, true));
    return err(appError('INTERNAL_ERROR', `LSP ${operation} failed: ${error instanceof Error ? error.message : String(error)}`, true));
  }

  private serverCommand(language: string): readonly string[] | undefined {
    const settingsCommand = this.services.localProviders?.().lspCommands?.[language.toLowerCase()];
    const configured = readString(settingsCommand) ?? this.environment[`UNIFIED_MPC_LSP_${language.toUpperCase()}_COMMAND`];
    if (typeof configured !== 'string' || configured.trim().length === 0) return undefined;
    const trimmed = configured.trim();
    let command: string[];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        command = Array.isArray(parsed) && parsed.every((part) => typeof part === 'string') ? parsed.map(String) : [];
      } catch {
        command = [];
      }
    } else {
      command = trimmed.split(/\s+/);
    }
    return command[0] === undefined ? undefined : command;
  }

  private async workspaceRoot(workspaceId: string): Promise<Result<string>> {
    const workspaceInfo = this.services.workspaceInfo;
    if (workspaceInfo === undefined) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace service is not configured'));
    const info = await workspaceInfo.info(this.actor, workspaceId);
    if (!info.ok) return info;
    const rootPath = typeof (info.value as { realRootPath?: unknown }).realRootPath === 'string'
      ? (info.value as { realRootPath: string }).realRootPath
      : undefined;
    return rootPath === undefined
      ? err(appError('INTERNAL_ERROR', 'Workspace root could not be resolved', true))
      : ((): Result<string> => {
        const resolved = resolveHostPath(rootPath, this.platform);
        return resolved === null
          ? err(appError('INVALID_INPUT', 'Workspace root uses a foreign host path syntax'))
          : ok(resolved);
      })();
  }
}

function defaultSpawner(command: readonly string[]): Result<ChildProcess> {
  try {
    return ok(spawn(command[0]!, [...command.slice(1)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
  } catch {
    return err(appError('EXECUTABLE_NOT_FOUND', `Language server could not start: ${command[0]}`));
  }
}

function quietPeriod(quietMs: number, maxMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('LSP diagnostics wait cancelled'));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('LSP diagnostics wait cancelled'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.min(quietMs, maxMs));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function firstFile(input: Record<string, unknown>): string | undefined {
  if (typeof input.file === 'string' && input.file.trim().length > 0) return input.file.trim();
  const files = Array.isArray(input.files) ? input.files : [];
  const first = files.find((value) => typeof value === 'string' && value.trim().length > 0);
  return typeof first === 'string' ? first.trim() : undefined;
}

function languageIdForFile(file: string, fallback: string): string {
  switch (path.posix.extname(file.replaceAll('\\', '/')).toLowerCase()) {
    case '.tsx': return 'typescriptreact';
    case '.ts':
    case '.mts':
    case '.cts': return 'typescript';
    case '.jsx': return 'javascriptreact';
    case '.js':
    case '.mjs': return 'javascript';
    case '.py': return 'python';
    case '.rs': return 'rust';
    case '.go': return 'go';
    case '.java': return 'java';
    case '.cs': return 'csharp';
    default: return fallback;
  }
}

function pathToUri(file: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = platform === 'win32'
    ? path.win32.normalize(file).replaceAll('\\', '/').replace(/^\/+/, '')
    : path.posix.normalize(file);
  const prefix = platform === 'win32' ? 'file:///' : 'file://';
  return `${prefix}${encodeURI(normalized).replaceAll('#', '%23').replaceAll('?', '%3F')}`;
}

function uriToPath(uri: string, platform: NodeJS.Platform = process.platform): string {
  try {
    const decoded = decodeURIComponent(uri.replace(/^file:\/\/\//, ''));
    return platform === 'win32' ? decoded.replaceAll('/', '\\') : decoded;
  } catch {
    const fallback = uri.replace(/^file:\/\/\//, '');
    return platform === 'win32' ? fallback.replaceAll('/', '\\') : fallback;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
