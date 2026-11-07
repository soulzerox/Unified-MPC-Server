import { describe, expect, it } from 'vitest';
import type { CanonicalStatusReport } from '@unified-mpc/workspace';
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
