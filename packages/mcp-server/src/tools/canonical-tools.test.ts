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
  overlayCount: 1,
  quarantinedCount: 0,
  activeJobCount: 1,
  danglingRefs: [],
  missingOverlayBases: [],
  orphanedPins: [],
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
};

const gcReport: GcStatusReport = {
  status: 'healthy',
  lease: { status: 'free' },
  quarantine: {
    total: 1,
    due: 1,
    inGrace: 0,
    rows: [{
      target: { kind: 'artifact-key', repositoryId: 'repo_abc123', artifactKey: 'file:v1:' + '9'.repeat(64) },
      quarantinedAt: '2026-11-01T00:00:00.000Z',
      graceMs: 60_000,
      expiresAt: '2026-11-01T00:01:00.000Z',
      due: true,
    }],
  },
};

function namedTool(services: McpToolContext['services'], name: string): McpToolDefinition {
  const found = canonicalTools(context(services)).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error('missing ' + name);
  return found;
}

describe('canonical lifecycle tools', () => {
  it('projects the GC lease and quarantine as a read-only scoped snapshot', async () => {
    const tool = namedTool({ canonicalGcStatus: async () => gcReport }, 'canonical_gc_status');
    expect(tool.permission).toBe('READ');
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });

    const result = await tool.execute({}, new AbortController().signal);
    expect(result).toMatchObject({
      ok: true,
      value: {
        scope: 'canonical-store',
        status: 'healthy',
        lease: { status: 'free' },
        quarantine: { total: 1, due: 1, inGrace: 0, rows: [{ due: true }] },
      },
    });
  });

  it('bounds the revision list and keeps the full count visible', async () => {
    const tool = namedTool({ canonicalRevisionList: async () => revisionReport }, 'canonical_revision_list');

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
