import { describe, expect, it } from 'vitest';
import { ok } from '@unified-mpc/domain';
import type { PruneSkillInput, PruneServerInput, PruneSkillResult, PruneServerResult } from '@unified-mpc/extensions';
import { runPruneSkill, runPruneServer, parsePruneSkillArgs, parsePruneServerArgs } from './prune.js';

describe('prune CLI commands', () => {
  describe('parsePruneSkillArgs', () => {
    it('parses valid prune skill arguments with default targets', () => {
      const parsed = parsePruneSkillArgs(['my-skill']);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'prune-skill',
          name: 'my-skill',
          targets: ['all'],
        },
      });
    });

    it('parses specific targets', () => {
      const parsed = parsePruneSkillArgs(['my-skill', '--targets', 'antigravity,cursor']);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'prune-skill',
          name: 'my-skill',
          targets: ['antigravity', 'cursor'],
        },
      });
    });

    it('returns error when skill name is missing', () => {
      const parsed = parsePruneSkillArgs([]);
      expect(parsed.ok).toBe(false);
    });
  });

  describe('parsePruneServerArgs', () => {
    it('parses valid prune server arguments with default targets', () => {
      const parsed = parsePruneServerArgs(['sqlite']);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'prune-server',
          name: 'sqlite',
          targets: ['all'],
          killProcess: true,
        },
      });
    });

    it('parses specific targets', () => {
      const parsed = parsePruneServerArgs(['sqlite', '--targets', 'cline']);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'prune-server',
          name: 'sqlite',
          targets: ['cline'],
          killProcess: true,
        },
      });
    });

    it('returns error when server name is missing', () => {
      const parsed = parsePruneServerArgs([]);
      expect(parsed.ok).toBe(false);
    });
  });

  describe('runPruneSkill', () => {
    it('invokes prunerService.pruneSkill', async () => {
      let capturedInput: PruneSkillInput | undefined;
      const fakeResult: PruneSkillResult = {
        name: 'my-skill',
        removedPaths: ['/home/user/.gemini/antigravity/skills/my-skill'],
      };
      const service = {
        pruneSkill: async (input: PruneSkillInput) => {
          capturedInput = input;
          return ok(fakeResult);
        },
      };

      const result = await runPruneSkill(service, {
        name: 'my-skill',
        targets: ['antigravity'],
      });

      expect(result.ok).toBe(true);
      expect(capturedInput?.name).toBe('my-skill');
      expect(capturedInput?.targets).toEqual(['antigravity']);
    });
  });

  describe('runPruneServer', () => {
    it('invokes prunerService.pruneServer', async () => {
      let capturedInput: PruneServerInput | undefined;
      const fakeResult: PruneServerResult = {
        name: 'sqlite',
        updatedConfigFiles: ['/home/user/.cline/cline_mcp_settings.json'],
        processTerminated: true,
        removedPaths: [],
      };
      const service = {
        pruneServer: async (input: PruneServerInput) => {
          capturedInput = input;
          return ok(fakeResult);
        },
      };

      const result = await runPruneServer(service, {
        name: 'sqlite',
        targets: ['cline'],
      });

      expect(result.ok).toBe(true);
      expect(capturedInput?.name).toBe('sqlite');
      expect(capturedInput?.targets).toEqual(['cline']);
    });
  });
});
