import { describe, expect, it } from 'vitest';
import { ok } from '@unified-mpc/domain';
import type { InstallSkillInput, InstallServerInput, InstallSkillResult, InstallServerResult } from '@unified-mpc/extensions';
import { runInstallSkill, runInstallServer, parseInstallSkillArgs, parseInstallServerArgs } from './install.js';

describe('install CLI commands', () => {
  describe('parseInstallSkillArgs', () => {
    it('parses valid install skill arguments with defaults', () => {
      const parsed = parseInstallSkillArgs(['my-skill', '/path/to/skill']);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'install-skill',
          name: 'my-skill',
          source: '/path/to/skill',
          targets: ['all'],
          scope: 'global',
        },
      });
    });

    it('parses custom targets and workspace scope', () => {
      const parsed = parseInstallSkillArgs([
        'my-skill',
        '/path/to/skill',
        '--targets',
        'antigravity,cursor',
        '--scope',
        'workspace',
      ]);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'install-skill',
          name: 'my-skill',
          source: '/path/to/skill',
          targets: ['antigravity', 'cursor'],
          scope: 'workspace',
        },
      });
    });

    it('returns error when missing name or source', () => {
      const parsed = parseInstallSkillArgs(['my-skill']);
      expect(parsed.ok).toBe(false);
    });
  });

  describe('parseInstallServerArgs', () => {
    it('parses stdio server args with command, args, and env', () => {
      const parsed = parseInstallServerArgs([
        'sqlite',
        '--command',
        'uvx',
        '--args',
        'mcp-server-sqlite,--db,app.db',
        '--env',
        'DEBUG=1,PORT=3000',
        '--targets',
        'cline,opencode',
      ]);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'install-server',
          name: 'sqlite',
          transport: 'stdio',
          command: 'uvx',
          args: ['mcp-server-sqlite', '--db', 'app.db'],
          env: { DEBUG: '1', PORT: '3000' },
          targets: ['cline', 'opencode'],
          scope: 'global',
        },
      });
    });

    it('parses http/sse server args with url', () => {
      const parsed = parseInstallServerArgs([
        'remote-mcp',
        '--url',
        'https://mcp.example.com/sse',
        '--transport',
        'sse',
        '--targets',
        'antigravity',
      ]);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'install-server',
          name: 'remote-mcp',
          transport: 'sse',
          url: 'https://mcp.example.com/sse',
          targets: ['antigravity'],
          scope: 'global',
        },
      });
    });

    it('rejects stdio server without command', () => {
      const parsed = parseInstallServerArgs(['my-server']);
      expect(parsed.ok).toBe(false);
    });
  });

  describe('runInstallSkill', () => {
    it('invokes installerService.installSkill', async () => {
      let capturedInput: InstallSkillInput | undefined;
      const fakeResult: InstallSkillResult = {
        name: 'my-skill',
        installedPaths: ['/home/user/.gemini/antigravity/skills/my-skill/SKILL.md'],
        targets: ['antigravity'],
      };
      const service = {
        installSkill: async (input: InstallSkillInput) => {
          capturedInput = input;
          return ok(fakeResult);
        },
      };

      const result = await runInstallSkill(service, {
        name: 'my-skill',
        source: '/path/to/skill',
        targets: ['antigravity'],
        scope: 'global',
      });

      expect(result.ok).toBe(true);
      expect(capturedInput?.name).toBe('my-skill');
      expect(capturedInput?.targets).toEqual(['antigravity']);
    });
  });

  describe('runInstallServer', () => {
    it('invokes installerService.installServer', async () => {
      let capturedInput: InstallServerInput | undefined;
      const fakeResult: InstallServerResult = {
        name: 'sqlite',
        targets: ['cline'],
        updatedConfigFiles: ['/home/user/.cline/cline_mcp_settings.json'],
      };
      const service = {
        installServer: async (input: InstallServerInput) => {
          capturedInput = input;
          return ok(fakeResult);
        },
      };

      const result = await runInstallServer(service, {
        name: 'sqlite',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-sqlite'],
        targets: ['cline'],
        scope: 'global',
      });

      expect(result.ok).toBe(true);
      expect(capturedInput?.name).toBe('sqlite');
      expect(capturedInput?.command).toBe('uvx');
    });
  });
});
