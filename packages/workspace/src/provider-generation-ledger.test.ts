import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderGenerationLedger } from './provider-generation-ledger.js';

const WS = '11111111-1111-4111-8111-111111111111';
const WS_OTHER = '22222222-2222-4222-8222-222222222222';
const M1 = 'man:v1:' + '1'.repeat(64);
const M2 = 'man:v1:' + '2'.repeat(64);
const RECORDED = new Date('2026-11-09T00:00:00.000Z');

async function withLedger<T>(run: (ledger: ProviderGenerationLedger, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'provider-generations-'));
  try {
    return await run(new ProviderGenerationLedger(dir, { now: () => RECORDED }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('provider generation ledger (#210 bullet 4)', () => {
  it('round-trips the manifest a workspace generation was built from', async () => {
    await withLedger(async (ledger) => {
      const recorded = await ledger.record({
        workspaceId: WS, generationId: 'gen-1', manifestId: M1, repositoryId: 'repo_abc123',
      });
      expect(recorded).toEqual({
        workspaceId: WS,
        generationId: 'gen-1',
        manifestId: M1,
        repositoryId: 'repo_abc123',
        recordedAt: RECORDED.toISOString(),
      });
      expect(await ledger.get(WS)).toEqual(recorded);
      expect(await ledger.liveManifestIds()).toEqual([M1]);
    });
  });

  it('replaces the row when the same workspace publishes a new generation', async () => {
    await withLedger(async (ledger) => {
      await ledger.record({ workspaceId: WS, generationId: 'gen-1', manifestId: M1, repositoryId: 'repo_abc123' });
      await ledger.record({ workspaceId: WS, generationId: 'gen-2', manifestId: M2, repositoryId: 'repo_abc123' });
      expect(await ledger.list()).toEqual([expect.objectContaining({ generationId: 'gen-2', manifestId: M2 })]);
      expect(await ledger.liveManifestIds()).toEqual([M2]);
    });
  });

  it('deduplicates and sorts manifests shared by several workspaces', async () => {
    await withLedger(async (ledger) => {
      await ledger.record({ workspaceId: WS_OTHER, generationId: 'gen-b', manifestId: M2, repositoryId: 'repo_b' });
      await ledger.record({ workspaceId: WS, generationId: 'gen-a', manifestId: M2, repositoryId: 'repo_a' });
      expect(await ledger.liveManifestIds()).toEqual([M2]);
      expect((await ledger.list()).map((row) => row.workspaceId)).toEqual([WS, WS_OTHER]);
    });
  });

  it('releases a workspace whose new generation is not manifest-bound', async () => {
    await withLedger(async (ledger) => {
      await ledger.record({ workspaceId: WS, generationId: 'gen-1', manifestId: M1, repositoryId: 'repo_abc123' });
      expect(await ledger.release(WS)).toBe(true);
      expect(await ledger.get(WS)).toBeNull();
      expect(await ledger.release(WS)).toBe(false);
      expect(await ledger.liveManifestIds()).toEqual([]);
    });
  });

  it('treats an absent directory as no generations, strictly too', async () => {
    await withLedger(async (ledger) => {
      expect(await ledger.list()).toEqual([]);
      expect(await ledger.list({ strict: true })).toEqual([]);
      expect(await ledger.liveManifestIds({ strict: true })).toEqual([]);
    });
  });

  it('releases rows for workspaces that are no longer registered', async () => {
    await withLedger(async (ledger, dir) => {
      await ledger.record({ workspaceId: WS, generationId: 'gen-1', manifestId: M1, repositoryId: 'repo_abc123' });
      await ledger.record({ workspaceId: WS_OTHER, generationId: 'gen-2', manifestId: M2, repositoryId: 'repo_abc123' });

      expect(await ledger.releaseUnknown([WS])).toEqual([WS_OTHER]);
      expect(await ledger.get(WS)).toEqual(expect.objectContaining({ manifestId: M1 }));
      expect(await ledger.get(WS_OTHER)).toBeNull();
      expect(await ledger.liveManifestIds({ strict: true })).toEqual([M1]);
      // The directory itself stays usable for the next generation.
      expect(await readdir(path.join(dir, 'provider-generations'))).toEqual([`${WS}.json`]);
    });
  });

  it('runs the caller guard before removing a row and keeps the row when it fails', async () => {
    await withLedger(async (ledger) => {
      await ledger.record({ workspaceId: WS, generationId: 'gen-1', manifestId: M1, repositoryId: 'repo_abc123' });
      await ledger.record({ workspaceId: WS_OTHER, generationId: 'gen-2', manifestId: M2, repositoryId: 'repo_abc123' });
      const events: string[] = [];

      await expect(ledger.releaseUnknown([WS], {
        beforeRelease: async (workspaceId) => {
          events.push(`before:${workspaceId}`);
          throw new Error('verification is read-only');
        },
      })).rejects.toThrow('verification is read-only');

      expect(events).toEqual([`before:${WS_OTHER}`]);
      expect(await ledger.get(WS_OTHER)).toEqual(expect.objectContaining({ manifestId: M2 }));
      expect(await ledger.get(WS)).toEqual(expect.objectContaining({ manifestId: M1 }));
    });
  });

  it('releases a corrupt row for a removed workspace without reading it', async () => {
    await withLedger(async (ledger, dir) => {
      await ledger.record({ workspaceId: WS, generationId: 'gen-1', manifestId: M1, repositoryId: 'repo_abc123' });
      await writeFile(path.join(dir, 'provider-generations', `${WS_OTHER}.json`), '{not json', 'utf8');

      expect(await ledger.releaseUnknown([WS])).toEqual([WS_OTHER]);
      // A strict read still succeeds because only the live row remains.
      expect(await ledger.liveManifestIds({ strict: true })).toEqual([M1]);
    });
  });

  it('treats an absent directory as nothing to release', async () => {
    await withLedger(async (ledger) => {
      expect(await ledger.releaseUnknown([WS])).toEqual([]);
    });
  });

  it('rejects a known workspace id that cannot name a row', async () => {
    await withLedger(async (ledger) => {
      await expect(ledger.releaseUnknown(['workspace-name'])).rejects.toThrow(/invalid workspace id/);
    });
  });

  it('refuses a strict read of a malformed row instead of dropping its manifest', async () => {
    await withLedger(async (ledger, dir) => {
      await ledger.record({ workspaceId: WS, generationId: 'gen-1', manifestId: M1, repositoryId: 'repo_abc123' });
      const [file] = await readdir(path.join(dir, 'provider-generations'));
      if (file === undefined) throw new Error('expected a provider generation row');
      await writeFile(path.join(dir, 'provider-generations', file), '{not json', 'utf8');

      expect(await ledger.list()).toEqual([]);
      await expect(ledger.list({ strict: true })).rejects.toThrow(/not valid JSON/);
      await expect(ledger.liveManifestIds({ strict: true })).rejects.toThrow(/not valid JSON/);
    });
  });

  it('refuses a strict read of a row that names another workspace', async () => {
    await withLedger(async (ledger, dir) => {
      await ledger.record({ workspaceId: WS, generationId: 'gen-1', manifestId: M1, repositoryId: 'repo_abc123' });
      const [file] = await readdir(path.join(dir, 'provider-generations'));
      if (file === undefined) throw new Error('expected a provider generation row');
      await writeFile(path.join(dir, 'provider-generations', file), JSON.stringify({
        schemaVersion: 1,
        workspaceId: WS_OTHER,
        generationId: 'gen-2',
        manifestId: M2,
        repositoryId: 'repo_abc123',
        recordedAt: RECORDED.toISOString(),
      }), 'utf8');

      await expect(ledger.liveManifestIds({ strict: true })).rejects.toThrow(/malformed or names another workspace/);
    });
  });

  it('rejects inputs that cannot name a canonical root', async () => {
    await withLedger(async (ledger) => {
      await expect(ledger.record({
        workspaceId: 'workspace-name', generationId: 'gen-1', manifestId: M1, repositoryId: 'repo_abc123',
      })).rejects.toThrow(/invalid workspace id/);
      await expect(ledger.record({
        workspaceId: WS, generationId: 'gen-1', manifestId: 'man:v1:not-hex', repositoryId: 'repo_abc123',
      })).rejects.toThrow(/invalid manifest id/);
      await expect(ledger.record({
        workspaceId: WS, generationId: ' gen-1', manifestId: M1, repositoryId: 'repo_abc123',
      })).rejects.toThrow(/invalid provider generation id/);
      await expect(ledger.record({
        workspaceId: WS, generationId: 'gen-1', manifestId: M1, repositoryId: '',
      })).rejects.toThrow(/invalid provider generation repository id/);
    });
  });
});
