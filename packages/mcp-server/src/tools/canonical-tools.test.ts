import { describe, expect, it } from 'vitest';
import type { CanonicalRevisionListReport, CanonicalStatusReport, GcStatusReport } from '@unified-mpc/workspace';
import { canonicalTools } from './canonical-tools.js';
import type { McpToolContext, McpToolDefinition } from './tool-types.js';

const report: CanonicalStatusReport = {
  status: 'degraded',
  refs: [{
    ref: 'refs/remotes/origin/main',
    manifestId: 'man:v1:' + 'a'.repeat(64),
    commitSha: 'b'.repeat(40),
    treeOid: 'c'.repeat(40),
    manifestCreatedAt: '2026-11-01T00:00:00.000Z',
    manifestEntryCount: 12,
    manifestExists: true,
    pinned: true,
    pinReasons: ['goal-base'],
  }],
  overlays: [{
    goalWorkspaceId: 'goal-1',
    baseManifestId: 'man:v1:' + 'a'.repeat(64),
    baseCommitSha: 'b'.repeat(40),
    baseTreeOid: 'c'.repeat(40),
    baseManifestExists: true,
    baseMatchesLiveRef: false,
    modifiedCount: 2,
    addedCount: 1,
    deletedCount: 0,
    updatedAt: '2026-11-02T00:00:00.000Z',
  }],
  jobs: [{
    operationId: 'op-1',
    manifestId: 'man:v1:' + 'd'.repeat(64),
    status: 'open',
    openedAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
    manifestExists: false,
  }],
  manifestCount: 2,
  pinCount: 1,
  refCount: 1,
  overlayCount: 1,
  quarantinedCount: 0,
  activeJobCount: 1,
  danglingRefs: [],
  missingOverlayBases: [],
  orphanedPins: [],
  danglingRefCount: 0,
  missingOverlayBaseCount: 0,
  orphanedPinCount: 0,
};

function context(services: McpToolContext['services']): McpToolContext {
  return {
    actor: { clientId: 'test', clientName: 'test' },
    contextEconomy: {} as McpToolContext['contextEconomy'],
    services,
  } as McpToolContext;
}

function statusTool(services: McpToolContext['services']): McpToolDefinition {
  const tool = canonicalTools(context(services)).find((candidate) => candidate.name === 'canonical_index_status');
  if (tool === undefined) throw new Error('missing canonical_index_status');
  return tool;
}

describe('canonicalTools', () => {
  it('projects the canonical store report as a read-only scoped snapshot', async () => {
    const tool = statusTool({ canonicalIndexStatus: async () => report });
    expect(tool.permission).toBe('READ');
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });

    const result = await tool.execute({}, new AbortController().signal);
    expect(result).toMatchObject({
      ok: true,
      value: {
        scope: 'canonical-store',
        status: 'degraded',
        manifestCount: 2,
        pinCount: 1,
        overlayCount: 1,
        activeJobCount: 1,
        refs: [{ ref: 'refs/remotes/origin/main', commitSha: 'b'.repeat(40), pinned: true }],
        overlays: [{ goalWorkspaceId: 'goal-1', baseMatchesLiveRef: false }],
        jobs: [{ operationId: 'op-1', manifestExists: false }],
      },
    });
    expect(JSON.stringify(result)).not.toContain('providerJobId');
    expect(JSON.stringify(result)).not.toContain('result');
  });

  it('reports a missing service instead of inventing an empty store', async () => {
    const result = await statusTool({}).execute({}, new AbortController().signal);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'MCP application service is unavailable' },
    });
  });

  it('bounds every row collection and keeps the full-store counts', async () => {
    const seen: Array<{ readonly limit?: number } | undefined> = [];
    const wide: CanonicalStatusReport = {
      ...report,
      refs: [
        report.refs[0],
        { ...report.refs[0], ref: 'refs/remotes/origin/next' },
        { ...report.refs[0], ref: 'refs/remotes/origin/dev' },
      ],
      overlays: [report.overlays[0], { ...report.overlays[0], goalWorkspaceId: 'goal-2' }],
      jobs: [
        report.jobs[0],
        { ...report.jobs[0], operationId: 'op-2', openedAt: '2026-11-04T00:00:00.000Z' },
      ],
      danglingRefs: [{ ref: 'refs/remotes/origin/gone', manifestId: report.refs[0].manifestId }],
      missingOverlayBases: ['goal-3'],
      orphanedPins: [report.refs[0].manifestId],
      refCount: 3,
      overlayCount: 2,
      activeJobCount: 2,
      danglingRefCount: 1,
      missingOverlayBaseCount: 1,
      orphanedPinCount: 1,
    };
    const tool = statusTool({
      canonicalIndexStatus: async (options) => {
        seen.push(options);
        return wide;
      },
    });

    const bounded = await tool.execute({ limit: 1 }, new AbortController().signal);
    expect(bounded).toMatchObject({
      ok: true,
      value: {
        scope: 'canonical-store',
        status: 'degraded',
        refCount: 3,
        overlayCount: 2,
        activeJobCount: 2,
        danglingRefCount: 1,
        missingOverlayBaseCount: 1,
        orphanedPinCount: 1,
      },
    });
    const value = (bounded as { value: Record<string, readonly unknown[]> }).value;
    for (const key of ['refs', 'overlays', 'jobs', 'danglingRefs', 'missingOverlayBases', 'orphanedPins']) {
      expect(value[key]).toHaveLength(1);
    }

    // The advertised default is 50, and the tool forwards its own bound.
    const defaulted = await tool.execute({}, new AbortController().signal);
    expect(defaulted).toMatchObject({ ok: true, value: { refCount: 3 } });
    expect(seen).toEqual([{ limit: 1 }, { limit: 50 }]);
  });

  it('keeps a store failure fixed instead of copying a local path into the response', async () => {
    const result = await statusTool({
      canonicalIndexStatus: async () => {
        throw new Error('cannot read /home/operator/private/canonical/refs');
      },
    }).execute({}, new AbortController().signal);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Canonical index store status could not be read' },
    });
    expect(JSON.stringify(result)).not.toContain('/home/operator');
  });
});

const revision = {
  manifestId: 'man:v1:' + 'a'.repeat(64),
  repositoryId: 'repo_abc123',
  revisionId: 'rev:v1:' + 'b'.repeat(64),
  commitSha: 'c'.repeat(40),
  treeOid: 'd'.repeat(40),
  targetRef: 'refs/remotes/origin/main',
  entryCount: 12,
  createdAt: '2026-11-01T00:00:00.000Z',
  refs: ['refs/remotes/origin/main'],
  pins: ['goal-base'],
  overlayGoalIds: [],
  indexJobOperationIds: [],
};

const revisionReport: CanonicalRevisionListReport = {
  revisions: [
    revision,
    { ...revision, manifestId: 'man:v1:' + 'e'.repeat(64), createdAt: '2026-10-31T00:00:00.000Z' },
    { ...revision, manifestId: 'man:v1:' + 'f'.repeat(64), createdAt: '2026-10-30T00:00:00.000Z' },
  ],
  total: 3,
};

function quarantineRow(digit: string, due: boolean): GcStatusReport['quarantine']['rows'][number] {
  return {
    target: { kind: 'artifact-key', repositoryId: 'repo_abc123', artifactKey: 'file:v1:' + digit.repeat(64) },
    quarantinedAt: '2026-11-01T00:00:00.000Z',
    graceMs: 60_000,
    expiresAt: '2026-11-01T00:01:00.000Z',
    due,
  };
}

const gcReport: GcStatusReport = {
  status: 'healthy',
  lease: { status: 'free' },
  quarantine: {
    total: 3,
    due: 2,
    inGrace: 1,
    rows: [quarantineRow('9', true), quarantineRow('8', true), quarantineRow('7', false)],
  },
};

function namedTool(services: McpToolContext['services'], name: string): McpToolDefinition {
  const found = canonicalTools(context(services)).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error('missing ' + name);
  return found;
}

describe('canonical lifecycle tools', () => {
  it('projects the GC lease and bounds the quarantine rows', async () => {
    const tool = namedTool({ canonicalGcStatus: async () => gcReport }, 'canonical_gc_status');
    expect(tool.permission).toBe('READ');
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });

    const bounded = await tool.execute({ limit: 1 }, new AbortController().signal);
    expect(bounded).toMatchObject({
      ok: true,
      value: {
        scope: 'canonical-store',
        status: 'healthy',
        lease: { status: 'free' },
        returned: 1,
        quarantine: { total: 3, due: 2, inGrace: 1, rows: [{ due: true }] },
      },
    });

    const defaulted = await tool.execute({}, new AbortController().signal);
    expect(defaulted).toMatchObject({
      ok: true,
      value: {
        returned: 3,
        quarantine: { total: 3, due: 2, inGrace: 1, rows: [{ due: true }, { due: true }, { due: false }] },
      },
    });
  });

  it('bounds the revision list and keeps the full count visible', async () => {
    const seen: Array<{ readonly limit?: number } | undefined> = [];
    const tool = namedTool({
      canonicalRevisionList: async (options) => {
        seen.push(options);
        const limit = options?.limit ?? 50;
        return { revisions: revisionReport.revisions.slice(0, limit), total: revisionReport.total };
      },
    }, 'canonical_revision_list');

    const bounded = await tool.execute({ limit: 1 }, new AbortController().signal);
    expect(bounded).toMatchObject({
      ok: true,
      value: {
        scope: 'canonical-store',
        total: 3,
        returned: 1,
        revisions: [{ manifestId: revision.manifestId, pins: ['goal-base'] }],
      },
    });

    const defaulted = await tool.execute({}, new AbortController().signal);
    expect(defaulted).toMatchObject({ ok: true, value: { total: 3, returned: 3 } });
    // The tool forwards its own bound instead of reading the whole store and slicing.
    expect(seen).toEqual([{ limit: 1 }, { limit: 50 }]);
  });

  it('stays bounded when a service implementation ignores the requested limit', async () => {
    const tool = namedTool({
      // A port implementation that ignores `limit` must not widen the response.
      canonicalRevisionList: async () => revisionReport,
    }, 'canonical_revision_list');

    const result = await tool.execute({ limit: 1 }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { total: 3, returned: 1 } });
    const value = (result as { value: { revisions: readonly unknown[] } }).value;
    expect(value.revisions).toHaveLength(1);
  });

  it('reports a missing service for both lifecycle reports', async () => {
    for (const name of ['canonical_gc_status', 'canonical_revision_list']) {
      const result = await namedTool({}, name).execute({}, new AbortController().signal);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'MCP application service is unavailable' },
      });
    }
  });

  it('keeps store failures fixed instead of copying a local path into either response', async () => {
    const throwing = async (): Promise<never> => {
      throw new Error('cannot read /home/operator/private/canonical/manifests');
    };
    const gc = await namedTool({ canonicalGcStatus: throwing }, 'canonical_gc_status')
      .execute({}, new AbortController().signal);
    expect(gc).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Canonical GC status could not be read' },
    });
    const revisions = await namedTool({ canonicalRevisionList: throwing }, 'canonical_revision_list')
      .execute({}, new AbortController().signal);
    expect(revisions).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Canonical revision history could not be read' },
    });
    expect(JSON.stringify([gc, revisions])).not.toContain('/home/operator');
  });
});
