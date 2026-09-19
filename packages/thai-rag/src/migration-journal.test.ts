import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCanonicalWorkspaceId } from './canonical-workspace.js';
import { ThaiRagMigrationJournal, type ThaiRagMigrationClassification } from './migration-journal.js';

const roots: string[] = [];
const workspaceId = parseCanonicalWorkspaceId('86a0931e-0851-4a1f-b802-0f2e1500b4ec');
if (!workspaceId.ok) throw new Error(workspaceId.error.message);

async function temp(prefix: string): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('ThaiRagMigrationJournal', () => {
  it('creates a full backup before recording a prepared migration', async () => {
    const dataRoot = await temp('unified-data-');
    const legacyRoot = await temp('thai-rag-legacy-');
    await writeFile(path.join(legacyRoot, 'local_context.db'), 'db-bytes');
    await mkdir(path.join(legacyRoot, 'chroma_vectors'), { recursive: true });
    await writeFile(path.join(legacyRoot, 'chroma_vectors', 'segment.bin'), 'vector-bytes');

    const journal = new ThaiRagMigrationJournal(dataRoot, { now: (): Date => new Date('2026-09-17T03:00:00.000Z') });
    const prepared = await journal.prepare('legacy-v1', legacyRoot);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.state).toBe('prepared');
    expect(prepared.value.backupCompletedAt).toBe('2026-09-17T03:00:00.000Z');
    await expect(readFile(path.join(prepared.value.backupRoot, 'local_context.db'), 'utf8')).resolves.toBe('db-bytes');
    await expect(readFile(path.join(prepared.value.backupRoot, 'chroma_vectors', 'segment.bin'), 'utf8')).resolves.toBe('vector-bytes');
    await expect(access(prepared.value.journalPath)).resolves.toBeUndefined();
  });

  it('is idempotent and reuses an existing prepared backup after restart', async () => {
    const dataRoot = await temp('unified-data-');
    const legacyRoot = await temp('thai-rag-legacy-');
    await writeFile(path.join(legacyRoot, 'local_context.db'), 'before');
    const journal = new ThaiRagMigrationJournal(dataRoot);
    const first = await journal.prepare('legacy-v1', legacyRoot);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await writeFile(path.join(legacyRoot, 'local_context.db'), 'after');
    const restarted = new ThaiRagMigrationJournal(dataRoot);
    const second = await restarted.prepare('legacy-v1', legacyRoot);
    expect(second).toEqual(first);
    await expect(readFile(path.join(first.value.backupRoot, 'local_context.db'), 'utf8')).resolves.toBe('before');
  });

  it('records progress monotonically and can resume an interrupted migration', async () => {
    const dataRoot = await temp('unified-data-');
    const legacyRoot = await temp('thai-rag-legacy-');
    await writeFile(path.join(legacyRoot, 'local_context.db'), 'db');
    const journal = new ThaiRagMigrationJournal(dataRoot, { now: (): Date => new Date('2026-09-17T03:00:00.000Z') });
    expect((await journal.prepare('legacy-v1', legacyRoot)).ok).toBe(true);

    const progressed = await journal.checkpoint('legacy-v1', {
      importedTurnIds: ['turn-a', 'turn-b'],
      reindexWorkspaceIds: ['86a0931e-0851-4a1f-b802-0f2e1500b4ec'],
    });
    expect(progressed.ok).toBe(true);
    if (!progressed.ok) return;
    expect(progressed.value.state).toBe('in-progress');
    expect(progressed.value.importedTurnIds).toEqual(['turn-a', 'turn-b']);

    const resumed = await new ThaiRagMigrationJournal(dataRoot).get('legacy-v1');
    expect(resumed).toEqual(progressed);
  });

  it('records explicit legacy classifications idempotently without deleting source data', async () => {
    const dataRoot = await temp('unified-data-');
    const legacyRoot = await temp('thai-rag-legacy-');
    await writeFile(path.join(legacyRoot, 'local_context.db'), 'db');
    const journal = new ThaiRagMigrationJournal(dataRoot);
    expect((await journal.prepare('legacy-v2', legacyRoot)).ok).toBe(true);

    const classifications: readonly ThaiRagMigrationClassification[] = [
      { source: 'Unified MCP Server', dataClass: 'conversation', classification: 'legacy', reason: 'basename-only-not-identity-proof' },
      { source: 'Unified MCP Server', dataClass: 'code-index', classification: 'reindex_required', workspaceId: workspaceId.value, reason: 'basename-only-not-identity-proof' },
    ];
    const first = await journal.checkpoint('legacy-v2', { classifications });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.classifications).toEqual(classifications);
    expect(first.value.reindexWorkspaceIds).toEqual([workspaceId.value]);
    const second = await new ThaiRagMigrationJournal(dataRoot).checkpoint('legacy-v2', { classifications });
    expect(second).toEqual(first);
    await expect(readFile(path.join(legacyRoot, 'local_context.db'), 'utf8')).resolves.toBe('db');
  });

  it('cannot complete before backup preparation exists', async () => {
    const dataRoot = await temp('unified-data-');
    const journal = new ThaiRagMigrationJournal(dataRoot);
    const completed = await journal.complete('missing');
    expect(completed.ok).toBe(false);
    if (!completed.ok) expect(completed.error.code).toBe('CONFLICT');
  });
});
