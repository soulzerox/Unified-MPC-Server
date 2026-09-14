import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@unified-mpc/domain';
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

    it('returns error when arguments are missing', () => {
      const parsed = parseInstallSkillArgs(['my-skill']);
      expect(parsed.ok).toBe(false);
    });
  });

  describe('parseInstallServerArgs', () => {
    it('parses valid stdio server arguments', () => {
      const parsed = parseInstallServerArgs([
        'sqlite',
        '--transport',
        'stdio',
        '--command',
        'mcp-server-sqlite',
        '--args',
        '--db,test.db',
        '--env',
        'DEBUG=true',
        '--targets',
        'antigravity',
      ]);

      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value).toEqual({
          kind: 'install-server',
          name: 'sqlite',
          transport: 'stdio',
          command: 'mcp-server-sqlite',
          args: ['--db', 'test.db'],
          env: { DEBUG: 'true' },
          targets: ['antigravity'],
          scope: 'global',
        });
      }
    });

    it('parses valid sse server arguments with URL', () => {
      const parsed = parseInstallServerArgs([
        'remote-api',
        '--transport',
        'sse',
        '--url',
        'http://localhost:8080/sse',
      ]);

      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.url).toBe('http://localhost:8080/sse');
      }
    });

    it('parses an HTTPS Git source as a stdio server alternative to command', () => {
      const parsed = parseInstallServerArgs([
        'remote-mcp',
        '--transport',
        'stdio',
        '--source',
        'https://github.com/example/remote-mcp.git',
      ]);

      expect(parsed).toMatchObject({
        ok: true,
        value: {
          kind: 'install-server',
          name: 'remote-mcp',
          transport: 'stdio',
          source: 'https://github.com/example/remote-mcp.git',
        },
      });
    });

    it('returns error when command is missing for stdio', () => {
      const parsed = parseInstallServerArgs(['sqlite', '--transport', 'stdio']);
      expect(parsed.ok).toBe(false);
    });

    it('returns error when url is missing for sse', () => {
      const parsed = parseInstallServerArgs(['sqlite', '--transport', 'sse']);
      expect(parsed.ok).toBe(false);
    });

    it('returns error when name is missing', () => {
      const parsed = parseInstallServerArgs([]);
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
        installSkill: async (input: InstallSkillInput): Promise<Result<InstallSkillResult, unknown>> => {
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
        installServer: async (input: InstallServerInput): Promise<Result<InstallServerResult, unknown>> => {
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
