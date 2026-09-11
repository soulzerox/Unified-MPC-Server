import { describe, expect, it } from 'vitest';
import { ok } from '@unified-mpc/domain';
import type { SyncTarget, IdeSyncService } from '@unified-mpc/extensions';
import { runSync, parseSyncArgs } from './sync.js';

describe('sync CLI command', () => {
  describe('parseSyncArgs', () => {
    it('parses empty args as target all', () => {
      const parsed = parseSyncArgs([]);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'sync',
          targets: ['all'],
        },
      });
    });

    it('parses custom targets', () => {
      const parsed = parseSyncArgs(['--targets', 'antigravity,cursor,cline']);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'sync',
          targets: ['antigravity', 'cursor', 'cline'],
        },
      });
    });
  });

  describe('runSync', () => {
    it('invokes ideSyncService.sync with parsed targets', async () => {
      let capturedTargets: readonly SyncTarget[] | undefined;
      const fakeResult = {
        updatedFiles: ['/home/user/.gemini/antigravity/rules/mcp-policy.md'],
      };
      const service: Pick<IdeSyncService, 'sync'> = {
        sync: async (targets) => {
          capturedTargets = targets;
          return ok(fakeResult);
        },
      };

      const result = await runSync(service, ['antigravity']);
      expect(result.ok).toBe(true);
      expect(capturedTargets).toEqual(['antigravity']);
    });
  });
});
