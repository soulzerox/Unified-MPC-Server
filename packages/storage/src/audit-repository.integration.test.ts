import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@unified-mpc/audit';
import { SqliteAuditRepository } from './audit-repository.js';
import { SqliteDatabase } from './database.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteAuditRepository', () => {
  it('persists sanitized audit metadata through the audit migration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-audit-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const event: AuditEvent = {
      id: 'event-1',
      timestamp: new Date(0).toISOString(),
      actorId: 'client-1',
      actorName: 'test',
      workspaceId: 'workspace-1',
      action: 'read_file',
      resultCode: 'SUCCESS',
      durationMs: 4,
      metadata: { path: 'src/index.ts' },
    };

    await repository.insert(event);

    await expect(repository.list(10)).resolves.toEqual([event]);
    database.close();
  });

  it('round-trips session scope and applies workspace/session filters before LIMIT', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-audit-scope-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);

    const targetEvents: AuditEvent[] = [
      scopedEvent('target-1', '2026-08-20T00:00:01.000Z', 'workspace-target', 'session-a'),
      scopedEvent('target-2', '2026-08-20T00:00:02.000Z', 'workspace-target', 'session-a'),
      scopedEvent('target-b', '2026-08-20T00:00:03.000Z', 'workspace-target', 'session-b'),
    ];
    for (const event of targetEvents) await repository.insert(event);
    for (let index = 0; index < 25; index += 1) {
      await repository.insert(scopedEvent(
        `noise-${index}`,
        `2026-08-21T00:00:${String(index).padStart(2, '0')}.000Z`,
        'workspace-noise',
        'session-noise',
      ));
    }

    await expect(repository.listScoped({
      actionPrefix: 'mcp_tool:',
      workspaceId: 'workspace-target',
      sessionId: 'session-a',
    }, 2)).resolves.toEqual([targetEvents[1], targetEvents[0]]);
    await expect(repository.listScoped({ workspaceId: 'workspace-target', sessionId: 'session-b' }, 10))
      .resolves.toEqual([targetEvents[2]]);
    database.close();
  }, 20_000);

  it('preserves legacy null session scope during migration and can query it explicitly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-audit-legacy-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const legacy: AuditEvent = {
      id: 'legacy-event', timestamp: '2026-08-20T00:00:00.000Z', actorId: 'legacy', actorName: 'legacy',
      action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1, metadata: {},
    };
    const scoped = scopedEvent('scoped-event', '2026-08-20T00:00:01.000Z', 'workspace-1', 'session-1');
    await repository.insert(legacy);
    await repository.insert(scoped);

    await expect(repository.listScoped({ workspaceId: null, sessionId: null }, 10)).resolves.toEqual([legacy]);
    database.close();
  });

  it('batch-searches retained target detail by call id, event id, and completed reference', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-audit-detail-search-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const base = {
      actorId: 'client-1', actorName: 'test', action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1,
    } as const;
    await repository.insert({
      ...base,
      id: 'started-a',
      timestamp: '2026-08-20T00:00:00.000Z',
      metadata: {
        callId: 'call-a', phase: 'started', toolName: 'read_file',
        activityTargetDetail: { kind: 'files', items: ['visible.ts', 'hidden-needle.ts'] },
      },
    });
    await repository.insert({
      ...base,
      id: 'completed-a',
      timestamp: '2026-08-20T00:00:01.000Z',
      metadata: {
        callId: 'call-a', phase: 'completed', toolName: 'read_file',
        activityTargetDetail: { kind: 'details', items: ['completed-needle'] },
      },
    });

    await expect(repository.activityTargetDetailsMatching(
      ['call-a', 'started-a', 'call-a:completed', 'missing-ref'],
      'needle',
    )).resolves.toEqual(new Set(['call-a', 'started-a', 'call-a:completed']));
    await expect(repository.activityTargetDetailsMatching(['call-a'], 'absent')).resolves.toEqual(new Set());
    database.close();
  });

});


function scopedEvent(id: string, timestamp: string, workspaceId: string, sessionId: string): AuditEvent {
  return {
    id, timestamp, actorId: 'client-1', actorName: 'test', workspaceId, sessionId,
    action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1, metadata: { callId: id },
  };
}
