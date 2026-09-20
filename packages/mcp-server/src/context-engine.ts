import { randomUUID } from 'node:crypto';
import { err, ok, type AppError, type Result, type ResultBudget } from '@unified-mpc/domain';
import type { FileActor, GitService, SearchService } from '@unified-mpc/application';
import { classifyContextPath } from '@unified-mpc/search';
import type { McpApplicationServices } from './tools/tool-types.js';
import { ContextEconomyRuntime, type ContextEconomyStats, type ContextDeliveryKind } from './context-economy.js';
import { BoundedRetentionMap } from './bounded-retention-map.js';

export type ContextIntent = 'auto' | 'debug' | 'implement' | 'review' | 'trace' | 'explore';
export type ContextMode = 'optimized' | 'full' | 'exhaustive';

export interface WorkspaceContextRequest {
  readonly query: string;
  readonly workspaceId?: string;
  readonly path?: string;
  readonly intent?: ContextIntent;
  readonly mode?: ContextMode;
  readonly includeIgnored?: boolean;
  readonly responseTargetBytes?: number;
  readonly pageSize?: number;
  readonly resultBudget?: ResultBudget;
}

export interface ContextSnippet {
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface ContextMatch {
  readonly workspaceId: string;
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface ContextFile {
  readonly workspaceId: string;
  readonly path: string;
  readonly reason: string;
  readonly snippets: readonly ContextSnippet[];
  readonly symbols: readonly string[];
  readonly gitRelevance: 'changed' | 'related' | 'none';
  readonly testRelevance: 'test' | 'source' | 'unknown';
  readonly byteLength?: number;
  readonly error?: { readonly code: string; readonly message: string };
  readonly delivery?: ContextDeliveryKind;
  readonly fingerprint?: string;
  readonly summary?: {
    readonly byteLength: number;
    readonly lineCount: number;
    readonly imports: readonly string[];
    readonly exports: readonly string[];
    readonly symbols: readonly string[];
  };
  readonly diff?: string;
  readonly referencePath?: string;
  readonly unchangedSince?: string;
}

export interface WorkspaceContextResult {
  readonly files: readonly ContextFile[];
  readonly symbols: readonly string[];
  readonly matches: readonly ContextMatch[];
  readonly scannedFiles: number;
  readonly matchedFiles: number;
  readonly totalMatches: number;
  readonly hasMore: boolean;
  readonly continuationToken?: string;
  readonly economy?: ContextEconomyStats;
}

export interface ContextContinueRequest {
  readonly continuationToken: string;
  readonly pageSize?: number;
}

export interface SearchAllRequest {
  readonly query: string;
  readonly workspaceId?: string;
  readonly path?: string;
  readonly glob?: string;
  readonly maxResults?: number;
  readonly includeIgnored?: boolean;
  readonly resultBudget?: ResultBudget;
}

export interface SearchAllResult {
  readonly matches: readonly ContextMatch[];
  readonly paths: readonly { readonly workspaceId: string; readonly path: string }[];
  readonly scannedWorkspaces: number;
  readonly totalMatches: number;
  readonly hasMore: boolean;
}

export interface WorkspaceFullScanRequest {
  readonly workspaceId?: string;
  readonly path?: string;
  readonly glob?: string;
  readonly pageSize?: number;
  readonly includeIgnored?: boolean;
  readonly resultBudget?: ResultBudget;
}

export interface WorkspaceFullScanResult {
  readonly files: readonly { readonly workspaceId: string; readonly path: string }[];
  readonly scannedWorkspaces: number;
  readonly scannedFiles: number;
  readonly hasMore: boolean;
  readonly continuationToken?: string;
}

export interface ReadManyFilesRequest {
  readonly workspaceId?: string;
  readonly files: readonly { readonly path: string; readonly startLine?: number; readonly endLine?: number }[];
}

export interface ReadManyFileResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ReadManyFilesResult {
  readonly files: readonly ReadManyFileResult[];
  readonly totalFiles: number;
  readonly failedFiles: number;
}

export interface WorkspaceSnapshotResult {
  readonly workspace?: unknown;
  readonly project?: unknown;
}

interface Candidate {
  readonly workspaceId: string;
  readonly path: string;
  readonly matches: readonly ContextMatch[];
  readonly score: number;
  readonly reason: string;
  readonly gitRelevance: ContextFile['gitRelevance'];
  readonly testRelevance: ContextFile['testRelevance'];
}

interface WorkspaceCollection {
  readonly candidates: readonly Candidate[];
  readonly scannedFiles: number;
  readonly totalMatches: number;
  readonly searchTruncated: boolean;
}

interface Continuation {
  readonly candidates: readonly Candidate[];
  readonly request: WorkspaceContextRequest;
  readonly scannedFiles: number;
  readonly totalMatches: number;
  readonly searchTruncated: boolean;
}

type ScanContinuation =
  | {
    readonly kind: 'materialized';
    readonly files: readonly { readonly workspaceId: string; readonly path: string }[];
    readonly scannedWorkspaces: number;
    readonly scannedFiles: number;
  }
  | {
    readonly kind: 'indexed';
    readonly workspaceId: string;
    readonly requestedPath?: string;
    readonly lastPath?: string;
    readonly scannedWorkspaces: number;
    readonly scannedFiles: number;
  };

const DEFAULT_RESPONSE_TARGET_BYTES = 256 * 1024;
const MAX_RESPONSE_TARGET_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAGE_SIZE: Record<ContextMode, number> = { optimized: 12, full: 50, exhaustive: 200 };
const SEARCH_LIMIT: Record<ContextMode, number> = { optimized: 100, full: 300, exhaustive: 500 };
const DEFAULT_CONTINUATION_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_CONTINUATIONS = 64;

export interface ContextEngineRetentionOptions {
  readonly continuationTtlMs?: number;
  readonly maxContinuations?: number;
  readonly now?: () => number;
}

export class ContextEngine {
  private readonly continuations: BoundedRetentionMap<string, Continuation>;
  private readonly scanContinuations: BoundedRetentionMap<string, ScanContinuation>;

  public constructor(
    private readonly services: McpApplicationServices,
    private readonly actor: FileActor,
    private readonly economy: ContextEconomyRuntime = new ContextEconomyRuntime(),
    retention: ContextEngineRetentionOptions = {},
  ) {
    const options = {
      ttlMs: retention.continuationTtlMs ?? DEFAULT_CONTINUATION_TTL_MS,
      maxEntries: retention.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS,
      ...(retention.now === undefined ? {} : { now: retention.now }),
    };
    this.continuations = new BoundedRetentionMap(options);
    this.scanContinuations = new BoundedRetentionMap(options);
  }

  public async collect(request: WorkspaceContextRequest, budget?: ResultBudget, signal?: AbortSignal): Promise<Result<WorkspaceContextResult>> {
    this.economy.beginRequest();
    const boundedRequest = boundContextRequest(request, budget);
    const validation = validateRequest(boundedRequest);
    if (!validation.ok) return validation;
    if (signal?.aborted === true) return err({ code: 'PROCESS_TIMEOUT', message: 'Context collection was cancelled', recoverable: true });
    const workspaceIds = await this.resolveWorkspaceIds(boundedRequest.workspaceId);
    if (!workspaceIds.ok) return workspaceIds;
    if (workspaceIds.value.length === 0) return err({ code: 'WORKSPACE_NOT_FOUND', message: 'No registered workspace is available', recoverable: false });

    const successful: WorkspaceCollection[] = [];
    let firstError: AppError | undefined;
    let collectedCandidates = 0;
    const candidateLimit = boundedRequest.resultBudget?.maxItems ?? Number.MAX_SAFE_INTEGER;
    for (const workspaceId of workspaceIds.value) {
      if (signal?.aborted) return err({ code: 'PROCESS_TIMEOUT', message: 'Context search was cancelled', recoverable: true });
      const remaining = candidateLimit - collectedCandidates;
      if (remaining <= 0) break;
      const workspaceRequest = boundedRequest.resultBudget === undefined ? boundedRequest : {
        ...boundedRequest,
        pageSize: Math.min(boundedRequest.pageSize ?? DEFAULT_PAGE_SIZE[boundedRequest.mode ?? 'optimized'], remaining),
        resultBudget: { ...boundedRequest.resultBudget, maxItems: remaining },
      };
      const result = await this.collectWorkspace(workspaceId, workspaceRequest, signal);
      if (result.ok) {
        successful.push(result.value);
        collectedCandidates += result.value.candidates.length;
      } else if (firstError === undefined) firstError = result.error;
    }
    if (successful.length === 0) {
      return err(firstError ?? { code: 'INTERNAL_ERROR', message: 'Context search failed', recoverable: true });
    }

    const merged = mergeCollections(successful);
    try {
      return await this.materialize(merged.candidates, boundedRequest, {
        scannedFiles: merged.scannedFiles,
        totalMatches: merged.totalMatches,
        searchTruncated: merged.searchTruncated,
      }, signal);
    } catch (error: unknown) {
      if (signal?.aborted || error instanceof Error && error.message === 'File read was cancelled') {
        return err({ code: 'PROCESS_TIMEOUT', message: 'Context materialization was cancelled', recoverable: true });
      }
      return err({ code: 'INTERNAL_ERROR', message: 'Context materialization failed', recoverable: true });
    }
  }

  public async continue(token: string, pageSize?: number, budget?: ResultBudget, signal?: AbortSignal): Promise<Result<WorkspaceContextResult>> {
    const continuation = this.continuations.take(token);
    if (continuation === undefined) return err({ code: 'INVALID_INPUT', message: 'Continuation token is invalid or expired', recoverable: false });
    return this.materialize(continuation.candidates, boundContextRequest({
      ...continuation.request,
      ...(pageSize === undefined ? {} : { pageSize }),
    }, budget), continuation, signal);
  }

  public async searchAll(request: SearchAllRequest, budget?: ResultBudget, signal?: AbortSignal): Promise<Result<SearchAllResult>> {
    this.economy.beginRequest();
    if (request.query.trim().length === 0) return err({ code: 'INVALID_INPUT', message: 'Search query is required', recoverable: false });
    const workspaceIds = await this.resolveWorkspaceIds(request.workspaceId);
    if (!workspaceIds.ok) return workspaceIds;
    if (this.services.search === undefined) return err({ code: 'INTERNAL_ERROR', message: 'Search service is unavailable', recoverable: true });
    const effectiveBudget = budget ?? request.resultBudget;
    const maxResults = Math.max(1, Math.min(500, Math.floor(Math.min(request.maxResults ?? 500, effectiveBudget?.maxItems ?? Number.MAX_SAFE_INTEGER))));
    const matches: ContextMatch[] = [];
    const paths: Array<{ readonly workspaceId: string; readonly path: string }> = [];
    let hasMore = false;
    let successfulWorkspaces = 0;
    for (const workspaceId of workspaceIds.value) {
      if (signal?.aborted) return err({ code: 'PROCESS_TIMEOUT', message: 'Search was cancelled', recoverable: true });
      let remaining = maxResults - matches.length - paths.length;
      if (remaining <= 0) { hasMore = true; break; }
      const producerLimit = effectiveBudget === undefined ? maxResults : remaining;
      const searchRequest = { query: request.query, ...(request.includeIgnored === undefined ? {} : { includeIgnored: request.includeIgnored }), ...(request.path === undefined ? {} : { path: request.path }), ...(effectiveBudget === undefined ? {} : { resultBudget: effectiveBudget }) };
      const text = await this.safeSearchText(workspaceId, searchRequest, producerLimit, signal);
      successfulWorkspaces += 1;
      if (text.ok) {
        matches.push(...text.value.matches
          .filter((match) => {
            const allowed = request.includeIgnored === true || classifyContextPath(match.path, 'automatic').discoverable;
            if (!allowed) this.economy.recordSkipped(match.path);
            return allowed;
          })
          .slice(0, remaining)
          .map((match) => ({ workspaceId, path: match.path, line: match.line, text: match.text })));
        hasMore ||= text.value.truncated;
      }
      remaining = maxResults - matches.length - paths.length;
      if (effectiveBudget !== undefined && remaining <= 0) { hasMore = true; break; }
      const files = await this.safeSearchFiles(workspaceId, searchRequest, effectiveBudget === undefined ? maxResults : remaining, request.glob, signal);
      if (files.ok) {
        paths.push(...files.value.paths
          .filter((path) => {
            const allowed = request.includeIgnored === true || classifyContextPath(path, 'automatic').discoverable;
            if (!allowed) this.economy.recordSkipped(path);
            return allowed;
          })
          .slice(0, remaining)
          .map((path) => ({ workspaceId, path })));
        hasMore ||= files.value.truncated;
      }
      if (matches.length + paths.length >= maxResults) hasMore = true;
    }
    const boundedMatches = matches.slice(0, maxResults);
    const boundedPaths = dedupePaths(paths).slice(0, maxResults);
    return ok({
      matches: boundedMatches,
      paths: boundedPaths,
      scannedWorkspaces: successfulWorkspaces,
      totalMatches: boundedMatches.length,
      hasMore: hasMore || matches.length > boundedMatches.length || paths.length > boundedPaths.length,
    });
  }

  public async fullScan(request: WorkspaceFullScanRequest, budget?: ResultBudget, signal?: AbortSignal): Promise<Result<WorkspaceFullScanResult>> {
    this.economy.beginRequest();
    const workspaceIds = await this.resolveWorkspaceIds(request.workspaceId);
    if (!workspaceIds.ok) return workspaceIds;
    if (request.includeIgnored === false && request.workspaceId !== undefined && this.services.workspaceIndex !== undefined) {
      const indexed = await this.fullScanFromIndex(request.workspaceId, request.path, Math.min(request.pageSize ?? 200, budget?.maxItems ?? Number.MAX_SAFE_INTEGER));
      if (indexed !== null) return indexed;
    }
    if (this.services.search === undefined) return err({ code: 'INTERNAL_ERROR', message: 'Search service is unavailable', recoverable: true });
    const effectiveBudget = budget ?? request.resultBudget;
    const maxResults = Math.max(1, Math.min(500, effectiveBudget?.maxItems ?? 500));
    const files: Array<{ readonly workspaceId: string; readonly path: string }> = [];
    let hasMore = false;
    let scannedWorkspaces = 0;
    for (const workspaceId of workspaceIds.value) {
      if (signal?.aborted) return err({ code: 'PROCESS_TIMEOUT', message: 'Workspace scan was cancelled', recoverable: true });
      const remaining = Math.max(1, maxResults - files.length);
      const result = await this.safeSearchFiles(workspaceId, { query: '*', includeIgnored: request.includeIgnored !== false, ...(request.path === undefined ? {} : { path: request.path }), ...(effectiveBudget === undefined ? {} : { resultBudget: effectiveBudget }) }, Math.min(maxResults, remaining), request.glob, signal);
      scannedWorkspaces += 1;
      if (!result.ok) continue;
      files.push(...result.value.paths.map((path) => ({ workspaceId, path })));
      hasMore ||= result.value.truncated;
      if (files.length >= maxResults) hasMore = true;
    }
    const deduped = dedupePaths(files).slice(0, maxResults);
    const pageSize = normalizePageSize(request.pageSize ?? 200);
    const page = deduped.slice(0, pageSize);
    const remaining = deduped.slice(page.length);
    hasMore ||= remaining.length > 0;
    let continuationToken: string | undefined;
    if (hasMore) {
      continuationToken = randomUUID();
      this.scanContinuations.set(continuationToken, { kind: 'materialized', files: remaining, scannedWorkspaces, scannedFiles: deduped.length });
    }
    return ok({
      files: page,
      scannedWorkspaces,
      scannedFiles: deduped.length,
      hasMore,
      ...(continuationToken === undefined ? {} : { continuationToken }),
    });
  }

  public async continueFullScan(token: string, pageSize?: number, budget?: ResultBudget, signal?: AbortSignal): Promise<Result<WorkspaceFullScanResult>> {
    if (signal?.aborted) return err({ code: 'PROCESS_TIMEOUT', message: 'Workspace scan was cancelled', recoverable: true });
    const continuation = this.scanContinuations.take(token);
    if (continuation === undefined) return err({ code: 'INVALID_INPUT', message: 'Scan continuation token is invalid or expired', recoverable: false });
    const size = normalizePageSize(Math.min(pageSize ?? 200, budget?.maxItems ?? Number.MAX_SAFE_INTEGER));
    if (continuation.kind === 'indexed') {
      return (await this.fullScanFromIndex(continuation.workspaceId, continuation.requestedPath, size, continuation.lastPath))
        ?? err({ code: 'INTERNAL_ERROR', message: 'Indexed workspace scan is unavailable', recoverable: true });
    }
    const files = continuation.files.slice(0, size);
    const remaining = continuation.files.slice(files.length);
    let nextToken: string | undefined;
    if (remaining.length > 0) {
      nextToken = randomUUID();
      this.scanContinuations.set(nextToken, { ...continuation, files: remaining });
    }
    return ok({
      files,
      scannedWorkspaces: continuation.scannedWorkspaces,
      scannedFiles: continuation.scannedFiles,
      hasMore: remaining.length > 0,
      ...(nextToken === undefined ? {} : { continuationToken: nextToken }),
    });
  }

  public async readMany(request: ReadManyFilesRequest, budget?: ResultBudget, signal?: AbortSignal): Promise<Result<ReadManyFilesResult>> {
    if (this.services.file === undefined) return err({ code: 'INTERNAL_ERROR', message: 'File service is unavailable', recoverable: true });
    const workspaceIds = await this.resolveWorkspaceIds(request.workspaceId);
    if (!workspaceIds.ok) return workspaceIds;
    const workspaceId = request.workspaceId ?? workspaceIds.value[0];
    if (workspaceId === undefined) return err({ code: 'WORKSPACE_NOT_FOUND', message: 'No workspace is available', recoverable: false });
    const filesToRead = request.files.slice(0, budget?.maxItems ?? Number.MAX_SAFE_INTEGER);
    const files: ReadManyFileResult[] = [];
    let consumedBytes = 0;
    for (const file of filesToRead) {
      if (signal?.aborted) {
        files.push({ workspaceId, path: file.path, error: { code: 'PROCESS_TIMEOUT', message: 'File read was cancelled' } });
        break;
      }
      try {
        const remainingBytes = budget === undefined ? undefined : Math.max(1, budget.maxStructuredBytes - consumedBytes);
        const fileBudget = budget === undefined || remainingBytes === undefined ? budget : { ...budget, maxTextBytes: Math.min(budget.maxTextBytes, remainingBytes), maxBinaryBytes: Math.min(budget.maxBinaryBytes, remainingBytes), maxBase64Bytes: Math.min(budget.maxBase64Bytes, remainingBytes) };
        const result = await this.services.file!.readFile(this.actor, workspaceId, file, undefined, signal, fileBudget);
        const entry = result.ok
          ? { workspaceId, path: file.path, result: result.value }
          : { workspaceId, path: file.path, error: { code: result.error.code, message: result.error.message } };
        files.push(entry);
        if (result.ok) consumedBytes += Buffer.byteLength(JSON.stringify(result.value), 'utf8');
        if (budget !== undefined && consumedBytes >= budget.maxStructuredBytes) break;
      } catch {
        files.push({ workspaceId, path: file.path, error: { code: 'INTERNAL_ERROR', message: 'File read failed' } });
      }
    }
    return ok({ files, totalFiles: files.length, failedFiles: files.filter((file) => file.error !== undefined).length });
  }

  public async snapshot(workspaceId: string): Promise<Result<WorkspaceSnapshotResult>> {
    const workspace = this.services.workspaceInfo === undefined
      ? undefined
      : await this.services.workspaceInfo.info(this.actor, workspaceId);
    if (workspace !== undefined && !workspace.ok) return err(workspace.error);
    const project = this.services.projectSnapshot === undefined
      ? undefined
      : await this.services.projectSnapshot.snapshot(this.actor, workspaceId);
    if (project !== undefined && !project.ok) return err(project.error);
    if (workspace === undefined && project === undefined) return err({ code: 'INTERNAL_ERROR', message: 'Workspace snapshot service is unavailable', recoverable: true });
    return ok({
      ...(workspace?.ok === true ? { workspace: workspace.value } : {}),
      ...(project?.ok === true ? { project: project.value } : {}),
    });
  }

  private async fullScanFromIndex(workspaceId: string, requestedPath: string | undefined, pageSize: number | undefined, lastPath?: string): Promise<Result<WorkspaceFullScanResult> | null> {
    const status = await this.services.workspaceIndex!.status(workspaceId);
    if (!status.ok || status.value.snapshot === null) return null;
    const prefix = requestedPath === undefined ? '' : normalizePath(requestedPath).replace(/^\.\//, '').replace(/\/$/, '');
    const size = normalizePageSize(pageSize ?? 200);
    const entries = status.value.snapshot.entries;
    const normalizedCursor = lastPath === undefined ? undefined : normalizePath(lastPath);
    const files: Array<{ readonly workspaceId: string; readonly path: string }> = [];
    let totalMatchingFiles = 0;
    let remainingMatchingFiles = 0;
    for (const entry of entries) {
      if (entry.kind !== 'file' && entry.kind !== 'symlink') continue;
      const normalizedPath = normalizePath(entry.relativePath);
      if (!matchesIndexedPath(normalizedPath, prefix)) continue;
      totalMatchingFiles += 1;
      if (normalizedCursor === undefined || normalizedPath > normalizedCursor) remainingMatchingFiles += 1;
    }
    let cursor = normalizedCursor;
    // ponytail: rescan the bounded page instead of retaining every indexed path; replace with an index cursor when scan latency matters.
    for (let index = 0; index < size; index += 1) {
      let next: { readonly originalPath: string; readonly normalizedPath: string } | undefined;
      for (const entry of entries) {
        if (entry.kind !== 'file' && entry.kind !== 'symlink') continue;
        const normalizedPath = normalizePath(entry.relativePath);
        if (!matchesIndexedPath(normalizedPath, prefix) || (cursor !== undefined && normalizedPath <= cursor)) continue;
        if (next === undefined || normalizedPath.localeCompare(next.normalizedPath) < 0 || normalizedPath === next.normalizedPath && entry.relativePath.localeCompare(next.originalPath) < 0) {
          next = { originalPath: entry.relativePath, normalizedPath };
        }
      }
      if (next === undefined) break;
      files.push({ workspaceId, path: next.originalPath });
      cursor = next.normalizedPath;
    }
    const hasMore = files.length < remainingMatchingFiles;
    let continuationToken: string | undefined;
    if (hasMore) {
      continuationToken = randomUUID();
      this.scanContinuations.set(continuationToken, {
        kind: 'indexed',
        workspaceId,
        ...(requestedPath === undefined ? {} : { requestedPath }),
        ...(files.at(-1) === undefined ? {} : { lastPath: files.at(-1)!.path }),
        scannedWorkspaces: 1,
        scannedFiles: totalMatchingFiles,
      });
    }
    return ok({ files, scannedWorkspaces: 1, scannedFiles: totalMatchingFiles, hasMore, ...(continuationToken === undefined ? {} : { continuationToken }) });
  }

  private async resolveWorkspaceIds(workspaceId: string | undefined): Promise<Result<readonly string[]>> {
    if (workspaceId !== undefined && workspaceId.trim().length > 0) return ok([workspaceId]);
    const list = this.services.workspaceInfo?.list;
    if (list === undefined) return err({ code: 'INVALID_INPUT', message: 'workspaceId is required when workspace listing is unavailable', recoverable: false });
    const result = await list(this.actor);
    if (!result.ok) return err(result.error);
    if (!Array.isArray(result.value)) return err({ code: 'INTERNAL_ERROR', message: 'Workspace list has an invalid shape', recoverable: true });
    const ids = result.value.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null || !('id' in entry)) return [];
      const id = (entry as { id?: unknown }).id;
      return typeof id === 'string' && id.trim().length > 0 ? [id] : [];
    });
    return ok(ids);
  }

  private async collectWorkspace(workspaceId: string, request: WorkspaceContextRequest, signal?: AbortSignal): Promise<Result<WorkspaceCollection>> {
    if (this.services.search === undefined) return err({ code: 'INTERNAL_ERROR', message: 'Search service is unavailable', recoverable: true });
    const limit = SEARCH_LIMIT[request.mode ?? 'optimized'];
    const searchTextPromise = this.safeSearchText(workspaceId, request, limit, signal);
    const searchFilesPromise = this.safeSearchFiles(workspaceId, request, limit, undefined, signal);
    const gitPromise = this.safeGitStatus(workspaceId);
    const [textResult, filesResult, gitResult] = await Promise.all([searchTextPromise, searchFilesPromise, gitPromise]);
    if (signal?.aborted) return err({ code: 'PROCESS_TIMEOUT', message: 'Context search was cancelled', recoverable: true });
    if (!textResult.ok && !filesResult.ok) return err(textResult.error);

    const changed = new Set<string>();
    if (gitResult.ok) {
      for (const entry of gitResult.value.entries) {
        if (typeof entry.path === 'string') changed.add(normalizePath(entry.path));
      }
    }
    const candidates = new Map<string, {
      path: string;
      matches: ContextMatch[];
      score: number;
      fromFilename: boolean;
    }>();
    const query = request.query.toLowerCase();
    if (textResult.ok) {
      for (const match of textResult.value.matches) {
        const key = normalizePath(match.path);
        const current = candidates.get(key) ?? { path: match.path, matches: [], score: 0, fromFilename: false };
        current.matches.push({ workspaceId, path: match.path, line: match.line, text: match.text });
        current.score += 12 + (match.text.toLowerCase().includes(query) ? 8 : 0);
        candidates.set(key, current);
      }
    }
    if (filesResult.ok) {
      for (const pathValue of filesResult.value.paths) {
        const key = normalizePath(pathValue);
        const current = candidates.get(key) ?? { path: pathValue, matches: [], score: 0, fromFilename: false };
        current.fromFilename = true;
        if (pathValue.toLowerCase().includes(query)) current.score += 25;
        candidates.set(key, current);
      }
    }

    for (const changedPath of changed) {
      const current = candidates.get(changedPath) ?? { path: changedPath, matches: [], score: 0, fromFilename: false };
      current.score += 30;
      candidates.set(changedPath, current);
    }

    const ranked = [...candidates.values()]
      .filter((candidate) => {
        const allowed = request.includeIgnored === true || changed.has(normalizePath(candidate.path)) || classifyContextPath(candidate.path, 'automatic').discoverable;
        if (!allowed) this.economy.recordSkipped(candidate.path);
        return allowed;
      })
      .map((candidate): Candidate => {
      const normalized = normalizePath(candidate.path);
      const gitRelevance: ContextFile['gitRelevance'] = changed.has(normalized)
        ? 'changed'
        : candidate.matches.length > 0 ? 'related' : 'none';
      const testRelevance = isTestPath(candidate.path) ? 'test' : isSourcePath(candidate.path) ? 'source' : 'unknown';
      const score = candidate.score
        + (gitRelevance === 'changed' ? 20 : gitRelevance === 'related' ? 4 : 0)
        + (request.intent === 'review' && testRelevance === 'test' ? 8 : 0)
        + (request.intent === 'implement' && testRelevance === 'source' ? 5 : 0);
      const reasons = [
        ...(candidate.matches.length > 0 ? ['text match'] : []),
        ...(candidate.fromFilename ? ['filename match or workspace inventory'] : []),
        ...(gitRelevance === 'changed' ? ['changed in Git'] : gitRelevance === 'related' ? ['Git-related path'] : []),
        ...(testRelevance === 'test' ? ['test relevance'] : []),
      ];
      return {
        workspaceId,
        path: candidate.path,
        matches: candidate.matches,
        score,
        reason: reasons.join('; ') || 'workspace inventory candidate',
        gitRelevance,
        testRelevance,
      };
      });
    ranked.sort((left, right) => right.score - left.score || normalizePath(left.path).localeCompare(normalizePath(right.path)));
    return ok({
      candidates: ranked,
      scannedFiles: filesResult.ok ? filesResult.value.paths.length : ranked.length,
      totalMatches: textResult.ok ? textResult.value.matches.length : 0,
      searchTruncated: (textResult.ok && textResult.value.truncated) || (filesResult.ok && filesResult.value.truncated),
    });
  }

  private async safeSearchText(workspaceId: string, request: WorkspaceContextRequest, maxResults: number, signal?: AbortSignal): Promise<Awaited<ReturnType<SearchService['searchText']>>> {
    try {
      const result = await this.services.search!.searchText(this.actor, workspaceId, {
        query: request.query,
        maxResults,
        discovery: request.includeIgnored === true ? 'explicit' : 'automatic',
        ...(request.path === undefined ? {} : { path: request.path }),
        ...(request.resultBudget === undefined ? {} : { resultBudget: request.resultBudget }),
      }, signal);
      if (!result.ok) return result;
      const matches = result.value.matches.slice(0, maxResults);
      return ok({ matches, truncated: result.value.truncated || result.value.matches.length > matches.length });
    } catch {
      return err({ code: 'INTERNAL_ERROR', message: 'Context text search failed', recoverable: true });
    }
  }

  private async safeSearchFiles(workspaceId: string, request: WorkspaceContextRequest, maxResults: number, glob?: string, signal?: AbortSignal): Promise<Awaited<ReturnType<SearchService['searchFiles']>>> {
    try {
      const result = await this.services.search!.searchFiles(this.actor, workspaceId, {
        maxResults,
        discovery: request.includeIgnored === true ? 'explicit' : 'automatic',
        ...(glob === undefined ? {} : { glob }),
        ...(request.path === undefined ? {} : { path: request.path }),
        ...(request.resultBudget === undefined ? {} : { resultBudget: request.resultBudget }),
      }, signal);
      if (!result.ok) return result;
      const paths = result.value.paths.slice(0, maxResults);
      return ok({ paths, truncated: result.value.truncated || result.value.paths.length > paths.length });
    } catch {
      return err({ code: 'INTERNAL_ERROR', message: 'Context filename search failed', recoverable: true });
    }
  }

  private async safeGitStatus(workspaceId: string): Promise<Awaited<ReturnType<GitService['status']>>> {
    if (this.services.git === undefined) return ok({ entries: [] as never[] });
    try {
      return await this.services.git.status(this.actor, workspaceId);
    } catch {
      return err({ code: 'INTERNAL_ERROR', message: 'Context Git lookup failed', recoverable: true });
    }
  }

  private async materialize(
    candidates: readonly Candidate[],
    request: WorkspaceContextRequest,
    metadata: Pick<Continuation, 'scannedFiles' | 'totalMatches' | 'searchTruncated'>,
    signal?: AbortSignal,
  ): Promise<Result<WorkspaceContextResult>> {
    if (this.services.file === undefined) return err({ code: 'INTERNAL_ERROR', message: 'File service is unavailable', recoverable: true });
    const mode = request.mode ?? 'optimized';
    const pageSize = normalizePageSize(request.pageSize ?? DEFAULT_PAGE_SIZE[mode]);
    const targetBytes = normalizeResponseTarget(request.responseTargetBytes);
    const selectedCandidates = candidates.slice(0, pageSize);
    const contextId = randomUUID();
    const selected: ContextFile[] = [];
    let estimatedBytes = 0;
    for (const candidate of selectedCandidates) {
      if (signal?.aborted) return err({ code: 'PROCESS_TIMEOUT', message: 'Context materialization was cancelled', recoverable: true });
      const remainingBytes = request.resultBudget === undefined ? undefined : Math.max(1, request.resultBudget.maxStructuredBytes - estimatedBytes);
      const candidateRequest = remainingBytes === undefined ? request : {
        ...request,
        resultBudget: { ...request.resultBudget!, maxTextBytes: Math.min(request.resultBudget!.maxTextBytes, remainingBytes), maxBinaryBytes: Math.min(request.resultBudget!.maxBinaryBytes, remainingBytes), maxBase64Bytes: Math.min(request.resultBudget!.maxBase64Bytes, remainingBytes) },
      };
      const file = await this.readCandidate(candidate, candidateRequest, contextId, signal);
      selected.push(file);
      estimatedBytes += Buffer.byteLength(JSON.stringify(file), 'utf8');
      if (request.resultBudget !== undefined && estimatedBytes >= request.resultBudget.maxStructuredBytes) break;
    }
    let consumed = selected.length;
    while (selected.length > 1 && estimatedBytes > targetBytes) {
      const removed = selected.pop();
      if (removed !== undefined) estimatedBytes -= Buffer.byteLength(JSON.stringify(removed), 'utf8');
      consumed -= 1;
    }
    const remaining = candidates.slice(consumed);
    const hasMore = remaining.length > 0 || metadata.searchTruncated;
    let continuationToken: string | undefined;
    if (hasMore) {
      continuationToken = randomUUID();
      this.continuations.set(continuationToken, {
        candidates: remaining,
        request,
        scannedFiles: metadata.scannedFiles,
        totalMatches: metadata.totalMatches,
        searchTruncated: false,
      });
    }
    const symbols = [...new Set(selected.flatMap((file) => file.symbols))];
    const matches = selectedCandidates.slice(0, consumed).flatMap((candidate) => candidate.matches);
    return ok({
      files: selected,
      symbols,
      matches,
      scannedFiles: metadata.scannedFiles,
      matchedFiles: candidates.length,
      totalMatches: metadata.totalMatches,
      hasMore,
      ...(continuationToken === undefined ? {} : { continuationToken }),
      economy: this.economy.snapshot(),
    });
  }

  private async readCandidate(candidate: Candidate, request: WorkspaceContextRequest, contextId: string, signal?: AbortSignal): Promise<ContextFile> {
    try {
      const result = await this.services.file!.readFile(this.actor, candidate.workspaceId, { path: candidate.path }, undefined, signal, request.resultBudget);
      if (!result.ok) {
        if (result.error.code === 'PROCESS_TIMEOUT') throw new Error('File read was cancelled');
        return {
          workspaceId: candidate.workspaceId,
          path: candidate.path,
          reason: candidate.reason,
          snippets: [],
          symbols: [],
          gitRelevance: candidate.gitRelevance,
          testRelevance: candidate.testRelevance,
          error: { code: result.error.code, message: result.error.message },
        };
      }
      const prepared = this.economy.prepare({
        workspaceId: candidate.workspaceId,
        path: candidate.path,
        content: result.value.content,
        contextId,
        discovery: request.includeIgnored === true || candidate.gitRelevance === 'changed' ? 'explicit' : 'automatic',
      });
      const snippets = prepared.delivery === 'unchanged' || prepared.delivery === 'reference' || prepared.delivery === 'metadata'
        ? []
        : createSnippets(result.value.content, candidate.matches, request.mode ?? 'optimized');
      const file: ContextFile = {
        workspaceId: candidate.workspaceId,
        path: candidate.path,
        reason: candidate.reason,
        snippets,
        symbols: prepared.delivery === 'unchanged' || prepared.delivery === 'reference' || prepared.delivery === 'metadata'
          ? []
          : prepared.summary.symbols.length > 0 ? prepared.summary.symbols : extractSymbols(result.value.content),
        gitRelevance: candidate.gitRelevance,
        testRelevance: candidate.testRelevance,
        ...(result.value.byteLength === undefined ? {} : { byteLength: result.value.byteLength }),
        delivery: prepared.delivery,
        fingerprint: prepared.fingerprint,
        summary: prepared.summary,
        ...(prepared.diff === undefined ? {} : { diff: prepared.diff }),
        ...(prepared.referencePath === undefined ? {} : { referencePath: prepared.referencePath }),
        ...(prepared.unchangedSince === undefined ? {} : { unchangedSince: prepared.unchangedSince }),
      };
      this.economy.recordDelivery(prepared, Buffer.byteLength(JSON.stringify(file), 'utf8'));
      return file;
    } catch (error: unknown) {
      if (signal?.aborted || error instanceof Error && error.message === 'File read was cancelled') throw error;
      return {
        workspaceId: candidate.workspaceId,
        path: candidate.path,
        reason: candidate.reason,
        snippets: [],
        symbols: [],
        gitRelevance: candidate.gitRelevance,
        testRelevance: candidate.testRelevance,
        error: { code: 'INTERNAL_ERROR', message: 'File read failed' },
      };
    }
  }
}

function boundContextRequest(request: WorkspaceContextRequest, budget: ResultBudget | undefined): WorkspaceContextRequest {
  if (budget === undefined) return request;
  return {
    ...request,
