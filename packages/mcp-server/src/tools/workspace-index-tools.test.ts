import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@unified-mpc/domain';
import type { WorkspaceIndexEntry, WorkspaceIndexStatus } from '@unified-mpc/application';
import { mapResult } from '../result-mapper.js';
import { ToolSchemaRegistry } from '../tool-schema-registry.js';
import { workspaceIndexTools } from './workspace-index-tools.js';
import type { McpToolContext } from './tool-types.js';

const WORKSPACE = 'workspace-1';

function entry(index: number): WorkspaceIndexEntry {
  return {
    relativePath: `packages/application/src/module-${index}.ts`,
    kind: 'file',
    size: 4_096,
    mtimeMs: 1_700_000_000_000 + index,
    contentHash: 'a'.repeat(64),
    gitBlobSha: 'b'.repeat(40),
    language: 'typescript',
    isTest: false,
    symbols: Array.from({ length: 12 }, (_, symbol) => `exportedSymbol${symbol}${index}`),
    imports: Array.from({ length: 8 }, (_, imported) => `@unified-mpc/dependency-${imported}`),
    exports: Array.from({ length: 6 }, (_, exported) => `exported${exported}`),
    functions: ['run', 'build', 'parse'],
    classes: ['Service'],
    interfaces: ['Options'],
    indexedAt: '2026-10-09T08:00:00.000Z',
  };
}

function status(entryCount: number): WorkspaceIndexStatus {
  return {
    indexed: true,
    snapshot: entryCount === 0 ? null : {
      version: 1,
      workspaceId: WORKSPACE,
      rootPath: '/repos/example',
      indexedAt: '2026-10-09T08:00:00.000Z',
      entries: Array.from({ length: entryCount }, (_, index) => entry(index)),
    },
    watcher: {
      pendingEvents: 0,
      activeWorkers: 0,
      concurrency: 4,
      debounceMs: 25,
      enqueuedEvents: 10,
      coalescedEvents: 2,
      completedEvents: 8,
      failedEvents: 0,
      droppedEvents: 0,
    },
    generation: 'gen-1',
    freshness: 'watching_clean',
    stale: false,
  };
}

function toolFor(
  reported: WorkspaceIndexStatus | Error,
  name = 'workspace_index_status',
): { execute: (input: unknown) => Promise<{ ok: boolean; value?: unknown; error?: unknown }> } {
  const context = {
    actor: { clientId: 'test', clientName: 'test' },
    contextEconomy: undefined,
    services: {
      workspaceIndex: {
        async status() {
          if (reported instanceof Error) return err(appError('WORKSPACE_NOT_FOUND', reported.message, false));
          return ok(reported);
        },
        // The watch handler shares the projection with status; the same stub is
        // enough to pin its payload because startWatch resolves the same status.
        async startWatch() {
          if (reported instanceof Error) return err(appError('WORKSPACE_NOT_FOUND', reported.message, false));
          return ok(reported);
        },
      },
    },
  } as unknown as McpToolContext;
  const tool = workspaceIndexTools(context).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`${name} is not registered`);
  return {
    async execute(input: unknown): Promise<{ ok: boolean; value?: unknown; error?: unknown }> {
      const parsed = tool.parse(input);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return await tool.execute(parsed.value, new AbortController().signal) as { ok: boolean; value?: unknown; error?: unknown };
    },
  };
}

describe('workspace_index_status payload bounds', () => {
  it('caps entries by default while reporting the true entry count', async () => {
    const result = await toolFor(status(950)).execute({ workspaceId: WORKSPACE });
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      indexed: true,
      generation: 'gen-1',
      freshness: 'watching_clean',
      stale: false,
      entryCount: 950,
      entryLimit: 200,
      entriesTruncated: true,
    });
    const snapshot = (result.value as { snapshot: { entries: unknown[] } }).snapshot;
    expect(snapshot.entries).toHaveLength(200);
  });

  it('honours an explicit entry limit and reports when nothing was dropped', async () => {
    const full = await toolFor(status(950)).execute({ workspaceId: WORKSPACE, entryLimit: 5_000 });
    expect(full.value).toMatchObject({ entryCount: 950, entryLimit: 5_000, entriesTruncated: false });
    expect((full.value as { snapshot: { entries: unknown[] } }).snapshot.entries).toHaveLength(950);

    const none = await toolFor(status(950)).execute({ workspaceId: WORKSPACE, entryLimit: 0 });
    expect(none.value).toMatchObject({ entryCount: 950, entryLimit: 0, entriesTruncated: true });
    expect((none.value as { snapshot: { entries: unknown[] } }).snapshot.entries).toHaveLength(0);
  });

  it('distinguishes a missing snapshot from a clipped one', async () => {
    const result = await toolFor(status(0)).execute({ workspaceId: WORKSPACE });
    expect(result.value).toMatchObject({
      indexed: true,
      snapshot: null,
      entryCount: 0,
      entriesTruncated: false,
    });
  });

  it('forwards a workspace lookup failure unchanged', async () => {
    const result = await toolFor(new Error('Workspace was not found')).execute({ workspaceId: WORKSPACE });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'WORKSPACE_NOT_FOUND', message: 'Workspace was not found' });
  });

  it('keeps the real 512 KiB tool-result budget on a large workspace', async () => {
    const result = await toolFor(status(950)).execute({ workspaceId: WORKSPACE });
    const mapped = mapResult(result as never, { maxBytes: 524_288, toolName: 'workspace_index_status' });
    expect(mapped.structuredContent).toMatchObject({
      entryCount: 950,
      entriesTruncated: true,
      indexed: true,
    });
    expect(mapped.structuredContent?.truncated).toBeUndefined();
  });
});

describe('workspace_index tool annotation contract', () => {
  it('only claims read-only for the surface that only reads', () => {
    const tools = workspaceIndexTools({ services: {} } as unknown as McpToolContext);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('workspace_index_status')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const name of ['workspace_index', 'workspace_index_watch', 'workspace_index_stop']) {
      expect(byName.get(name)?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
  });

  it('keeps the index build and watcher control out of the parallel-safe set', () => {
    const registry = new ToolSchemaRegistry();
    for (const tool of workspaceIndexTools({ services: {} } as unknown as McpToolContext)) registry.register(tool);
    expect(registry.describe('workspace_index_status')?.parallelSafe).toBe(true);
    // Two concurrent builds, or a build racing a watcher drain, are a hazard on
    // one workspace; `parallelSafe` is derived from `readOnlyHint`.
    for (const name of ['workspace_index', 'workspace_index_watch', 'workspace_index_stop']) {
      expect(registry.describe(name)?.parallelSafe, name).toBe(false);
    }
  });
});

describe('workspace_index_watch payload bounds', () => {
  it('answers a control call with watcher telemetry and no entries by default', async () => {
    const result = await toolFor(status(950), 'workspace_index_watch').execute({ workspaceId: WORKSPACE });
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      indexed: true,
      generation: 'gen-1',
      freshness: 'watching_clean',
      stale: false,
      entryCount: 950,
      entryLimit: 0,
      entriesTruncated: true,
      watcher: { concurrency: 4, debounceMs: 25, completedEvents: 8 },
    });
    expect((result.value as { snapshot: { entries: unknown[] } }).snapshot.entries).toHaveLength(0);
  });

  it('opts entries back in through entryLimit', async () => {
    const result = await toolFor(status(950), 'workspace_index_watch').execute({ workspaceId: WORKSPACE, entryLimit: 3 });
    expect(result.value).toMatchObject({ entryCount: 950, entryLimit: 3, entriesTruncated: true });
    expect((result.value as { snapshot: { entries: unknown[] } }).snapshot.entries).toHaveLength(3);
  });

  it('stays under the real 512 KiB budget instead of returning the whole snapshot', async () => {
    const result = await toolFor(status(950), 'workspace_index_watch').execute({ workspaceId: WORKSPACE });
    const mapped = mapResult(result as never, { maxBytes: 524_288, toolName: 'workspace_index_watch' });
    expect(mapped.structuredContent?.truncated).toBeUndefined();
    expect(mapped.structuredContent).toMatchObject({ entryCount: 950, indexed: true });
  });
});
