import { describe, expect, it } from 'vitest';
import { ok, type ResultBudget } from '@unified-mpc/domain';
import type { McpApplicationServices } from './tools/tool-types.js';
import { ContextEngine, type WorkspaceContextRequest } from './context-engine.js';

const actor = { clientId: 'context-test', clientName: 'context-test' };

function services(): McpApplicationServices {
  return {
    workspaceInfo: {
      async list(): Promise<ReturnType<typeof ok>> {
        return ok([{ id: 'workspace-1' }, { id: 'workspace-2' }]);
      },
    },
    search: {
      async searchText(_actor, workspaceId, request): Promise<ReturnType<typeof ok>> {
        void request;
        return ok({
          matches: workspaceId === 'workspace-1'
            ? [
              { path: 'src/auth/login.ts', line: 4, text: 'export function login() {}' },
              { path: '.env', line: 1, text: 'LOGIN_SECRET=present' },
              { path: 'node_modules/pkg/index.js', line: 1, text: 'login dependency' },
            ]
            : [{ path: 'dist/login.js', line: 1, text: 'login build' }],
          truncated: false,
        });
      },
      async searchFiles(_actor, workspaceId): Promise<ReturnType<typeof ok>> {
        return ok({
          paths: workspaceId === 'workspace-1'
            ? ['src/auth/login.ts', '.env', '.git/config', 'node_modules/pkg/index.js']
            : ['dist/login.js'],
          truncated: false,
        });
      },
    },
    file: {
      async readFile(_actor, workspaceId, request): Promise<ReturnType<typeof ok>> {
        return ok({
          path: request.path,
          content: `export function ${request.path.replace(/[^a-z]/gi, '')}() {}\nLOGIN_SECRET=present`,
          startLine: 1,
          endLine: 2,
          encoding: 'utf8' as const,
          ...(workspaceId === undefined ? {} : { byteLength: 64 }),
        });
      },
    },
    git: {
      async status(): Promise<ReturnType<typeof ok>> {
        return ok({ entries: [{ path: 'src/auth/login.ts', index: 'M', worktree: ' ' }] });
      },
    },
  };
}

describe('context engine', () => {
  it('aggregates matches across workspaces, ranks candidates, and filters vendor/build paths by default', async () => {
    const request: WorkspaceContextRequest = {
      query: 'login',
      mode: 'exhaustive',
      pageSize: 20,
    };
    const result = await new ContextEngine(services(), actor).collect(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.files.map((file) => file.path);
    expect(paths).toContain('.env');
    expect(paths).not.toContain('.git/config');
    expect(paths).not.toContain('node_modules/pkg/index.js');
    expect(paths).not.toContain('dist/login.js');
    expect(paths[0]).toBe('src/auth/login.ts');
    expect(result.value.files[0]?.reason).toContain('text match');
    expect(result.value.symbols.length).toBeGreaterThan(0);
    expect(result.value.matchedFiles).toBeGreaterThanOrEqual(2);

    const explicit = await new ContextEngine(services(), actor).collect({ ...request, includeIgnored: true });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    const explicitPaths = explicit.value.files.map((file) => file.path);
    expect(explicitPaths).toContain('.git/config');
    expect(explicitPaths).toContain('node_modules/pkg/index.js');
    expect(explicitPaths).toContain('dist/login.js');
  });

  it('bounds context search and materialization before reading candidates', async () => {
    const result = await new ContextEngine(services(), actor).collect({ query: 'login', workspaceId: 'workspace-1', mode: 'exhaustive', pageSize: 20 }, {
      maxItems: 1,
      maxTextBytes: 1024,
      maxStructuredBytes: 1024,
      maxBinaryBytes: 1024,
      maxBase64Bytes: 1024,
    } satisfies ResultBudget);

    expect(result).toMatchObject({ ok: true, value: { files: expect.any(Array) } });
    if (result.ok) expect(result.value.files).toHaveLength(1);
  });

  it('stops before producer materialization when the caller is cancelled', async () => {
    let reads = 0;
    const source = {
      ...services(),
      file: {
        readFile: async (...args: Parameters<NonNullable<McpApplicationServices['file']>['readFile']>) => {
          reads += 1;
          return services().file!.readFile(...args);
        },
      },
    } as McpApplicationServices;
    const controller = new AbortController();
    controller.abort();

    const result = await new ContextEngine(source, actor).collect({ query: 'login', workspaceId: 'workspace-1' }, undefined, controller.signal);

    expect(result).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(reads).toBe(0);
  });

  it('returns a continuation token without discarding candidates outside the response page', async () => {
    const engine = new ContextEngine(services(), actor);
    const first = await engine.collect({ query: 'login', workspaceId: 'workspace-1', pageSize: 1 });

    expect(first.ok).toBe(true);
    if (!first.ok || first.value.continuationToken === undefined) return;
    expect(first.value.files).toHaveLength(1);
    expect(first.value.hasMore).toBe(true);

    const next = await engine.continue(first.value.continuationToken, 1);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.files).toHaveLength(1);
    expect(next.value.files[0]?.path).not.toBe(first.value.files[0]?.path);
  });

  it('preserves caller search limits and stops before producers when cancelled', async () => {
    const originalSearch = services().search!;
    const textLimits: number[] = [];
    const fileLimits: number[] = [];
    const source = {
      ...services(),
      search: {
        ...originalSearch,
        searchText: async (...args: Parameters<typeof originalSearch.searchText>) => {
          textLimits.push(args[2].maxResults ?? 0);
          return originalSearch.searchText(...args);
        },
        searchFiles: async (...args: Parameters<typeof originalSearch.searchFiles>) => {
          fileLimits.push(args[2].maxResults ?? 0);
          return originalSearch.searchFiles(...args);
        },
      },
    } as McpApplicationServices;
    const engine = new ContextEngine(source, actor);

    const limited = await engine.searchAll({ query: 'login', workspaceId: 'workspace-1', maxResults: 2 });
    expect(limited).toMatchObject({ ok: true, value: { totalMatches: expect.any(Number) } });
    if (limited.ok) {
      expect(limited.value.matches.length).toBeLessThanOrEqual(2);
      expect(limited.value.paths.length).toBeLessThanOrEqual(2);
    }
    expect(textLimits).toEqual([2]);
    expect(fileLimits).toEqual([2]);

    const controller = new AbortController();
    controller.abort();
    await expect(engine.searchAll({ query: 'login', workspaceId: 'workspace-1' }, undefined, controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  });

  it('stops cross-workspace search at one global result budget', async () => {
    const searched: string[] = [];
    const source = {
      ...services(),
      search: {
        ...services().search!,
        searchText: async (_actor: unknown, workspaceId: string) => {
          searched.push(workspaceId);
          return ok({ matches: [{ path: `${workspaceId}/match.ts`, line: 1, text: 'match' }], truncated: false });
        },
        searchFiles: async (_actor: unknown, workspaceId: string) => {
          searched.push(workspaceId);
          return ok({ paths: [`${workspaceId}/file.ts`], truncated: false });
        },
      },
    } as McpApplicationServices;
    const result = await new ContextEngine(source, actor).searchAll({ query: 'login' }, {
      maxItems: 2,
      maxTextBytes: 1024,
      maxStructuredBytes: 1024,
      maxBinaryBytes: 1024,
      maxBase64Bytes: 1024,
    });

    expect(result).toMatchObject({ ok: true, value: { matches: [{ workspaceId: 'workspace-1' }], paths: [{ workspaceId: 'workspace-1' }] } });
    expect(searched).toEqual(['workspace-1', 'workspace-1']);
  });

  it('supports cross-workspace search, paged full scans, and parallel many-file reads', async () => {
    const engine = new ContextEngine(services(), actor);
    const search = await engine.searchAll({ query: 'login' });
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(search.value.scannedWorkspaces).toBe(2);
    expect(search.value.paths).toEqual(expect.arrayContaining([
      { workspaceId: 'workspace-1', path: 'src/auth/login.ts' },
    ]));
    expect(search.value.paths).not.toContainEqual({ workspaceId: 'workspace-1', path: '.git/config' });
    expect(search.value.paths).not.toContainEqual({ workspaceId: 'workspace-2', path: 'dist/login.js' });

    const explicitSearch = await engine.searchAll({ query: 'login', includeIgnored: true });
    expect(explicitSearch.ok).toBe(true);
    if (!explicitSearch.ok) return;
    expect(explicitSearch.value.paths).toEqual(expect.arrayContaining([
      { workspaceId: 'workspace-1', path: '.git/config' },
      { workspaceId: 'workspace-2', path: 'dist/login.js' },
    ]));

    const scan = await engine.fullScan({ workspaceId: 'workspace-1', pageSize: 1 });
    expect(scan.ok).toBe(true);
    if (!scan.ok || scan.value.continuationToken === undefined) return;
    expect(scan.value.files).toHaveLength(1);
    const scanNext = await engine.continueFullScan(scan.value.continuationToken, 10);
    expect(scanNext.ok).toBe(true);
    if (!scanNext.ok) return;
    expect(scanNext.value.files.length).toBeGreaterThan(0);

    const many = await engine.readMany({ workspaceId: 'workspace-1', files: [{ path: '.env' }, { path: 'dist/login.js' }] });
    expect(many.ok).toBe(true);
    if (!many.ok) return;
    expect(many.value.totalFiles).toBe(2);
    expect(many.value.failedFiles).toBe(0);
  });

  it('expires and caps abandoned context and full-scan continuation tokens', async () => {
    let now = 0;
    const engine = new ContextEngine(services(), actor, undefined, {
      continuationTtlMs: 100,
      maxContinuations: 1,
      now: (): number => now,
    });

    const first = await engine.collect({ query: 'login', workspaceId: 'workspace-1', pageSize: 1 });
    const second = await engine.collect({ query: 'login', workspaceId: 'workspace-1', pageSize: 1 });
    expect(first.ok && first.value.continuationToken).toEqual(expect.any(String));
    expect(second.ok && second.value.continuationToken).toEqual(expect.any(String));
    if (!first.ok || !second.ok || first.value.continuationToken === undefined || second.value.continuationToken === undefined) return;

    await expect(engine.continue(first.value.continuationToken)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    now = 101;
    await expect(engine.continue(second.value.continuationToken)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    now = 200;
    const scan = await engine.fullScan({ workspaceId: 'workspace-1', pageSize: 1 });
    expect(scan.ok && scan.value.continuationToken).toEqual(expect.any(String));
    if (!scan.ok || scan.value.continuationToken === undefined) return;
    now = 301;
    await expect(engine.continueFullScan(scan.value.continuationToken)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('uses the context ledger to avoid resending unchanged files', async () => {
    const engine = new ContextEngine(services(), actor);
    const first = await engine.collect({ query: 'login', workspaceId: 'workspace-1', pageSize: 1 });
    const second = await engine.collect({ query: 'login', workspaceId: 'workspace-1', pageSize: 1 });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.files[0]?.delivery).toBe('content');
    expect(second.value.files[0]?.delivery).toBe('unchanged');
    expect(second.value.files[0]?.unchangedSince).toBeDefined();
    expect(second.value.economy?.ledgerHits).toBeGreaterThan(0);
    expect(second.value.economy?.previouslySeenBytesAvoided).toBeGreaterThan(0);
  });
});
