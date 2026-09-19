import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SEARCH_RESULTS, err, MAX_PROCESS_LOG_BYTES, MAX_SEARCH_RESULTS, ok, type Result, type ResultBudget } from '@unified-mpc/domain';
import { createProcessTreeTerminator, createSpawnInvocationFactory, PathExecutableResolver, type ExecutableResolver, type ProcessTreeTerminator, type SpawnInvocationFactory } from '@unified-mpc/process';
import {
  classifyContextPath,
  DEFAULT_CONTEXT_IGNORE_GLOBS,
  type ContextDiscoveryMode,
} from './context-economy.js';

export interface ProcessRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
  /** True when the caller intentionally stopped a streaming child after collecting enough evidence. */
  readonly stoppedEarly?: boolean;
}

export interface ProcessRunOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Observe complete stdout lines while the child is running. Returning true
   * requests an orderly process-tree stop without classifying the result as a timeout.
   * This keeps high-volume tools such as ripgrep from flooding Electron's main loop.
   */
  readonly stopAfterStdoutLine?: (line: string) => boolean;
  readonly maxStdoutBytes?: number;
}

export interface ProcessRunner {
  run(command: string, args: readonly string[], cwd: string, options?: ProcessRunOptions): Promise<ProcessRunResult>;
}

export class DirectProcessRunner implements ProcessRunner {
  public constructor(
    private readonly terminator: ProcessTreeTerminator = createProcessTreeTerminator(),
    private readonly invocationFactory: SpawnInvocationFactory = createSpawnInvocationFactory(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public run(command: string, args: readonly string[], cwd: string, options: ProcessRunOptions = {}): Promise<ProcessRunResult> {
    return new Promise((resolve) => {
      const invocation = this.invocationFactory.create(command, args);
      if (!invocation.ok) {
        resolve({ exitCode: -1, stdout: '', stderr: invocation.error.message });
        return;
      }
      const child = spawn(invocation.value.executable, [...invocation.value.args], {
        cwd,
        shell: false,
        detached: true,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutLinePending = '';
      let timedOut = false;
      let stoppedEarly = false;
      let settled = false;
      let terminationPending = false;
      let pendingExitCode: number | null = null;
      const stdoutLimit = typeof options.maxStdoutBytes === 'number' && Number.isFinite(options.maxStdoutBytes) && options.maxStdoutBytes > 0
        ? Math.min(MAX_PROCESS_LOG_BYTES, Math.floor(options.maxStdoutBytes))
        : MAX_PROCESS_LOG_BYTES;

      const appendBounded = (chunks: Buffer[], currentBytes: number, chunk: Buffer, maxBytes = MAX_PROCESS_LOG_BYTES): number => {
        if (currentBytes >= maxBytes) return currentBytes;
        const remaining = maxBytes - currentBytes;
        const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        if (kept.length > 0) chunks.push(Buffer.from(kept));
        return currentBytes + kept.length;
      };
      const stdoutText = (): string => Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
      const stderrText = (): string => Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
      const complete = (exitCode: number): void => {
        if (terminationPending) {
          pendingExitCode = exitCode;
          return;
        }
        finish(exitCode);
      };
      const requestStop = (reason: 'timeout' | 'early'): void => {
        if (terminationPending || settled) return;
        if (reason === 'timeout') timedOut = true;
        else stoppedEarly = true;
        const pid = child.pid;
        if (pid === undefined) {
          finish(-1);
          return;
        }
        terminationPending = true;
        void this.terminator.stop(child, pid).then(() => {
          terminationPending = false;
          finish(pendingExitCode ?? -1);
        }).catch((error: unknown) => {
          terminationPending = false;
          const message = Buffer.from(error instanceof Error ? error.message : 'process termination could not be verified', 'utf8');
          stderrBytes = appendBounded(stderrChunks, stderrBytes, message);
          finish(-1);
        });
      };
      const abort = (): void => requestStop('timeout');
      const captureStdout = (chunk: Buffer): void => {
        const observer = options.stopAfterStdoutLine;
        if (observer === undefined) {
          stdoutBytes = appendBounded(stdoutChunks, stdoutBytes, chunk, stdoutLimit);
          return;
        }
        if (stoppedEarly || timedOut) return;
        stdoutLinePending += chunk.toString('utf8');
        if (Buffer.byteLength(stdoutLinePending, 'utf8') > stdoutLimit) {
          requestStop('early');
          return;
        }
        const lines = stdoutLinePending.split(/\r?\n/);
        stdoutLinePending = lines.pop() ?? '';
        for (const line of lines) {
          stdoutBytes = appendBounded(stdoutChunks, stdoutBytes, Buffer.from(`${line}\n`, 'utf8'), stdoutLimit);
          if (observer(line)) {
            stdoutLinePending = '';
            requestStop('early');
            return;
          }
        }
      };
      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        resolve({
          exitCode,
          stdout: stdoutText(),
          stderr: stderrText(),
          ...(timedOut ? { timedOut: true } : {}),
          ...(stoppedEarly ? { stoppedEarly: true } : {}),
        });
      };
      const timeoutMs = options.timeoutMs;
      const timer = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
          requestStop('timeout');
        }, timeoutMs)
        : undefined;
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => {
        captureStdout(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes = appendBounded(stderrChunks, stderrBytes, chunk);
      });
      child.on('error', (error: Error) => {
        stderrBytes = appendBounded(stderrChunks, stderrBytes, Buffer.from(error.message, 'utf8'));
        complete(-1);
      });
      child.on('close', (exitCode) => complete(exitCode ?? -1));
    });
  }
}

export interface SearchTextRequest {
  readonly rootPath: string;
  readonly query: string;
  readonly glob?: string;
  readonly maxResults?: number;
  readonly discovery?: ContextDiscoveryMode;
  readonly signal?: AbortSignal;
  readonly resultBudget?: ResultBudget;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchTextResult {
  readonly matches: readonly SearchMatch[];
  readonly truncated: boolean;
}

export interface SearchFilesRequest {
  readonly rootPath: string;
  readonly glob?: string;
  readonly maxResults?: number;
  readonly discovery?: ContextDiscoveryMode;
  readonly signal?: AbortSignal;
  readonly resultBudget?: ResultBudget;
}

export interface SearchFilesResult {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

const SEARCH_PROCESS_TIMEOUT_MS = 45_000;

export class RipgrepAdapter {
  public constructor(
    private readonly resolver: ExecutableResolver = new PathExecutableResolver(),
    private readonly runner: ProcessRunner = new DirectProcessRunner(),
  ) {}

  public async searchText(request: SearchTextRequest): Promise<Result<SearchTextResult>> {
    const maxResults = Math.min(request.maxResults ?? DEFAULT_SEARCH_RESULTS, request.resultBudget?.maxItems ?? Number.MAX_SAFE_INTEGER);
    if (request.query.length === 0 || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_SEARCH_RESULTS) {
      return err({ code: 'INVALID_INPUT', message: 'Search query or result limit is invalid', recoverable: false });
    }
    const executable = await this.resolver.resolve('rg');
    if (!executable.ok) {
      if (executable.error.code !== 'EXECUTABLE_NOT_FOUND') return executable;
      return this.searchTextFallback(request, maxResults);
    }
    const discovery = request.discovery ?? 'automatic';
    const args = ['--json', '--no-heading', '--color', 'never', '--hidden', '--no-ignore'];
    if (discovery === 'automatic') this.appendDefaultGlobs(args);
    if (request.glob !== undefined) args.push('--glob', request.glob);
    args.push('--', request.query, '.');
    let observedMatches = 0;
    const processResult = await this.runner.run(executable.value, args, request.rootPath, {
      timeoutMs: SEARCH_PROCESS_TIMEOUT_MS,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.resultBudget === undefined ? {} : { maxStdoutBytes: request.resultBudget.maxStructuredBytes }),
      stopAfterStdoutLine: (line) => {
        const match = this.parseMatch(line);
        if (match === null) return false;
        if (discovery === 'automatic' && !classifyContextPath(match.path, discovery).discoverable) return false;
        observedMatches += 1;
        return observedMatches > maxResults;
      },
    });
    if (!processResult.timedOut && !processResult.stoppedEarly && processResult.exitCode !== 0 && processResult.exitCode !== 1) {
      if (processResult.exitCode === 2) return err({ code: 'INVALID_INPUT', message: searchArgumentError(processResult.stderr), recoverable: false });
      return err({ code: 'INTERNAL_ERROR', message: searchProcessError(processResult.stderr), recoverable: true });
    }
    const matches: SearchMatch[] = [];
    let resultBytes = 0;
    let hasAdditionalMatch = false;
    for (const line of processResult.stdout.split(/\r?\n/)) {
      const match = this.parseMatch(line);
      if (match === null) continue;
      if (discovery === 'automatic' && !classifyContextPath(match.path, discovery).discoverable) continue;
      const matchBytes = Buffer.byteLength(JSON.stringify(match), 'utf8');
      if (matches.length >= maxResults || resultBytes + matchBytes > (request.resultBudget?.maxStructuredBytes ?? Number.MAX_SAFE_INTEGER)) {
        hasAdditionalMatch = true;
        break;
      }
      matches.push(match);
      resultBytes += matchBytes;
    }
    return ok({ matches, truncated: processResult.timedOut === true || processResult.stoppedEarly === true || hasAdditionalMatch });
  }

  public async searchFiles(request: SearchFilesRequest): Promise<Result<SearchFilesResult>> {
    const maxResults = Math.min(request.maxResults ?? DEFAULT_SEARCH_RESULTS, request.resultBudget?.maxItems ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_SEARCH_RESULTS) {
      return err({ code: 'INVALID_INPUT', message: 'Search result limit is invalid', recoverable: false });
    }
    const executable = await this.resolver.resolve('rg');
    if (!executable.ok) {
      if (executable.error.code !== 'EXECUTABLE_NOT_FOUND') return executable;
      return this.searchFilesFallback(request, maxResults);
    }
    const discovery = request.discovery ?? 'automatic';
    const args = ['--files', '--hidden', '--no-ignore'];
    if (discovery === 'automatic') this.appendDefaultGlobs(args);
    if (request.glob !== undefined) args.push('--glob', request.glob);
    args.push('--');
    let observedPaths = 0;
    const processResult = await this.runner.run(executable.value, args, request.rootPath, {
      timeoutMs: SEARCH_PROCESS_TIMEOUT_MS,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.resultBudget === undefined ? {} : { maxStdoutBytes: request.resultBudget.maxStructuredBytes }),
      stopAfterStdoutLine: (line) => {
        if (line.length === 0) return false;
        if (discovery === 'automatic' && !classifyContextPath(line, discovery).discoverable) return false;
        observedPaths += 1;
        return observedPaths > maxResults;
      },
    });
    if (!processResult.timedOut && !processResult.stoppedEarly && processResult.exitCode !== 0 && processResult.exitCode !== 1) {
      if (processResult.exitCode === 2) return err({ code: 'INVALID_INPUT', message: searchArgumentError(processResult.stderr), recoverable: false });
      return err({ code: 'INTERNAL_ERROR', message: searchProcessError(processResult.stderr), recoverable: true });
    }
    const discoveredPaths = processResult.stdout
      .split(/\r?\n/)
      .filter((entry) => entry.length > 0)
      .filter((entry) => discovery === 'explicit' || classifyContextPath(entry, discovery).discoverable);
    const paths = discoveredPaths.slice(0, maxResults);
    return ok({ paths, truncated: processResult.timedOut === true || processResult.stoppedEarly === true || discoveredPaths.length > maxResults });
  }

  private async searchTextFallback(request: SearchTextRequest, maxResults: number): Promise<Result<SearchTextResult>> {
    let pattern: RegExp;
    try {
      pattern = new RegExp(request.query);
      this.validateFallbackGlob(request.glob);
    } catch (error: unknown) {
      return err({ code: 'INVALID_INPUT', message: searchArgumentError(error instanceof Error ? error.message : ''), recoverable: false });
    }
    const discovery = request.discovery ?? 'automatic';
    const matches: SearchMatch[] = [];
    const deadline = Date.now() + SEARCH_PROCESS_TIMEOUT_MS;
    let truncated = false;
    try {
      for await (const relativePath of this.walkFallbackFiles(request.rootPath, discovery, request.signal)) {
        if (request.signal?.aborted === true || Date.now() >= deadline) {
          truncated = true;
          break;
        }
        if (!this.matchesFallbackGlob(relativePath, request.glob)) continue;
        let content: Buffer;
        try {
          content = await readFile(path.join(request.rootPath, relativePath));
        } catch {
          continue;
        }
        if (content.subarray(0, Math.min(content.byteLength, 8192)).includes(0)) continue;
        const text = content.toString('utf8');
        const lines = text.split(/\r?\n/);
        if (text.endsWith('\n')) lines.pop();
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex] ?? '';
          pattern.lastIndex = 0;
          if (!pattern.test(line)) continue;
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
          matches.push({ path: relativePath, line: lineIndex + 1, text: line });
        }
        if (truncated) break;
      }
    } catch (error: unknown) {
      return err({ code: 'INTERNAL_ERROR', message: searchProcessError(error instanceof Error ? error.message : ''), recoverable: true });
    }
    return ok({ matches, truncated });
  }

  private async searchFilesFallback(request: SearchFilesRequest, maxResults: number): Promise<Result<SearchFilesResult>> {
    try {
      this.validateFallbackGlob(request.glob);
    } catch (error: unknown) {
      return err({ code: 'INVALID_INPUT', message: searchArgumentError(error instanceof Error ? error.message : ''), recoverable: false });
    }
    const discovery = request.discovery ?? 'automatic';
    const paths: string[] = [];
    const deadline = Date.now() + SEARCH_PROCESS_TIMEOUT_MS;
    let truncated = false;
    try {
      for await (const relativePath of this.walkFallbackFiles(request.rootPath, discovery, request.signal)) {
        if (request.signal?.aborted === true || Date.now() >= deadline) {
          truncated = true;
          break;
        }
        if (!this.matchesFallbackGlob(relativePath, request.glob)) continue;
        if (paths.length >= maxResults) {
          truncated = true;
          break;
        }
        paths.push(relativePath);
      }
    } catch (error: unknown) {
      return err({ code: 'INTERNAL_ERROR', message: searchProcessError(error instanceof Error ? error.message : ''), recoverable: true });
    }
    return ok({ paths, truncated });
  }

  private async *walkFallbackFiles(rootPath: string, discovery: ContextDiscoveryMode, signal?: AbortSignal): AsyncGenerator<string> {
    const directories = [''];
    for (let index = 0; index < directories.length; index += 1) {
      if (signal?.aborted === true) return;
      const relativeDirectory = directories[index] ?? '';
      const absoluteDirectory = relativeDirectory.length === 0 ? rootPath : path.join(rootPath, relativeDirectory);
      let entries;
      try {
        entries = await readdir(absoluteDirectory, { withFileTypes: true });
      } catch (error: unknown) {
        if (relativeDirectory.length === 0) throw error;
        continue;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relativePath = relativeDirectory.length === 0 ? entry.name : path.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
          if (discovery === 'automatic' && !classifyContextPath(relativePath, discovery).discoverable) continue;
          directories.push(relativePath);
        } else if (entry.isFile()) {
          if (discovery === 'automatic' && !classifyContextPath(relativePath, discovery).discoverable) continue;
          yield relativePath;
        }
      }
    }
  }

  private validateFallbackGlob(glob: string | undefined): void {
    if (glob === undefined) return;
    const pattern = glob.startsWith('!') ? glob.slice(1) : glob;
    if (pattern.length === 0) throw new Error('glob must not be empty');
    path.posix.matchesGlob('', pattern);
  }

  private matchesFallbackGlob(relativePath: string, glob: string | undefined): boolean {
    if (glob === undefined) return true;
    const negated = glob.startsWith('!');
    const pattern = negated ? glob.slice(1) : glob;
    const normalizedPath = relativePath.replaceAll(path.sep, '/');
    const candidate = pattern.includes('/') ? normalizedPath : path.posix.basename(normalizedPath);
    const matched = path.posix.matchesGlob(candidate, pattern);
    return negated ? !matched : matched;
  }

  private parseMatch(line: string): SearchMatch | null {
    try {
      const value: unknown = JSON.parse(line);
      if (!this.isMatchRecord(value)) return null;
      return { path: value.data.path.text, line: value.data.line_number, text: value.data.lines.text.replace(/\r?\n$/, '') };
    } catch {
      return null;
    }
  }

  private appendDefaultGlobs(args: string[]): void {
    for (const glob of DEFAULT_CONTEXT_IGNORE_GLOBS) args.push('--glob', glob);
  }

  private isMatchRecord(value: unknown): value is MatchRecord {
    if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'match' || !('data' in value)) return false;
    const data = value.data;
    if (typeof data !== 'object' || data === null || !('path' in data) || !('line_number' in data) || !('lines' in data)) return false;
    if (typeof data.path !== 'object' || data.path === null || !('text' in data.path) || typeof data.path.text !== 'string') return false;
    if (typeof data.line_number !== 'number' || typeof data.lines !== 'object' || data.lines === null || !('text' in data.lines) || typeof data.lines.text !== 'string') return false;
    return true;
  }
}

function searchArgumentError(stderr: string): string {
  const detail = boundedSearchError(stderr);
  return detail.length === 0 ? 'Search pattern or glob is invalid' : `Search pattern or glob is invalid: ${detail}`;
}

function searchProcessError(stderr: string): string {
  const detail = boundedSearchError(stderr);
  return detail.length === 0 ? 'Search process failed' : `Search process failed: ${detail}`;
}

function boundedSearchError(stderr: string): string {
  return stderr.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512);
}

interface MatchRecord {
  readonly type: 'match';
  readonly data: {
    readonly path: { readonly text: string };
    readonly line_number: number;
    readonly lines: { readonly text: string };
  };
}
