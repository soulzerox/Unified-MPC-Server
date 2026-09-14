import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillCatalog, IdeSyncService, stripJsonComments } from './index.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Milestone 2 - Stress Test & Edge Case Audit', () => {
  describe('McpConfigLoader Edge Cases & Stress', () => {
    it('handles complex mixed JSONC comments, unclosed comments, and trailing commas', () => {
      const complexJsonc = `
      // Top-level comment
      {
        /* Block comment */
        "mcpServers": {
          "server-1": {
            // Server 1 inline comment
            "command": "node", /* arg comment */
            "args": ["s1.js"], // trailing comma below
          },
          /* Multi-line
             block comment
             with special chars: / * // */
          "server-2": {
            "command": "python3",
            "args": ["-m", "mcp_server"],
          },
        },
      }
      `;

      const cleaned = stripJsonComments(complexJsonc);
      const parsed = JSON.parse(cleaned);
      expect(parsed.mcpServers['server-1'].command).toBe('node');
      expect(parsed.mcpServers['server-2'].command).toBe('python3');
    });

    it('safely handles unclosed block comments without hanging or throwing unhandled exception', () => {
      const unclosedJsonc = `{"mcpServers": {} /* unclosed comment`;
      const cleaned = stripJsonComments(unclosedJsonc);
      expect(cleaned).toBeDefined();
    });

    it('handles high volume server loading (100 servers) without degradation', () => {
      const servers: Record<string, unknown> = {};
      for (let i = 0; i < 100; i += 1) {
        servers[`server-${i}`] = {
          command: 'node',
          args: [`srv-${i}.js`],
          env: { PORT: `${3000 + i}` },
        };
      }
      const raw = JSON.stringify({ mcpServers: servers }, null, 2);
      const cleaned = stripJsonComments(raw);
      const parsed = JSON.parse(cleaned);
      expect(Object.keys(parsed.mcpServers)).toHaveLength(100);
    });
  });

  describe('SkillCatalog Stress & Edge Cases', () => {
    it('survives circular symlinks and broken symlinks gracefully', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'm2-skill-stress-'));
      temporaryRoots.push(root);
      const home = path.join(root, 'home');
      const agSkillsDir = path.join(home, '.gemini', 'config', 'skills');
      await mkdir(agSkillsDir, { recursive: true });

      // Valid skill
      const validSkillDir = path.join(agSkillsDir, 'valid-skill');
      await mkdir(validSkillDir, { recursive: true });
      await writeFile(path.join(validSkillDir, 'SKILL.md'), '---\nname: valid-skill\ndescription: Valid\n---\n# Valid\n', 'utf8');

      // Circular symlink
      const loopDir = path.join(agSkillsDir, 'loop-skill');
      await mkdir(loopDir, { recursive: true });
      try {
        await symlink(loopDir, path.join(loopDir, 'recursive-link'));
      } catch {
        // Ignored on platforms lacking symlink permission
      }

      // Broken symlink
      try {
        await symlink(path.join(root, 'non-existent'), path.join(agSkillsDir, 'broken-skill'));
      } catch {
        // Ignored on platforms lacking symlink permission
      }

      const catalog = new SkillCatalog({
        homeDir: home,
        settings: { enabledSkillRoots: [agSkillsDir] },
      });

      const result = await catalog.list();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skills.some((s) => s.name === 'valid-skill')).toBe(true);
      }
    });

    it('gracefully handles SKILL.md with missing or malformed frontmatter', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'm2-skill-malformed-'));
      temporaryRoots.push(root);
      const home = path.join(root, 'home');
      const skillDir = path.join(home, '.gemini', 'config', 'skills', 'no-frontmatter');
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), '# Just markdown, no yaml frontmatter\nSome details here.\n', 'utf8');

      const catalog = new SkillCatalog({
        homeDir: home,
        settings: { enabledSkillRoots: [path.dirname(skillDir)] },
      });

      const result = await catalog.list();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const found = result.value.skills.find((s) => s.name === 'no-frontmatter');
        expect(found).toBeDefined();
        expect(found?.description).toBeDefined();
      }
    });
  });

  describe('IdeSyncService Idempotency & Concurrency', () => {
    it('handles concurrent sync calls to the same workspace without file corruption', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'm2-sync-concurrency-'));
      temporaryRoots.push(root);
      const home = path.join(root, 'home');
      const workspace = path.join(root, 'workspace');
      await mkdir(home, { recursive: true });
      await mkdir(workspace, { recursive: true });

      const syncService = new IdeSyncService({ homeDir: home, workspaceRoot: workspace });

      // Run 10 syncs concurrently
      const syncPromises = Array.from({ length: 10 }, () => syncService.sync(['all']));
      const results = await Promise.all(syncPromises);

      for (const res of results) {
        expect(res.ok).toBe(true);
      }

      // Check the output files: must have exactly ONE policy block start and end
      const clinerules = await readFile(path.join(workspace, '.clinerules'), 'utf8');
      const startCount = (clinerules.match(/<!-- MCP-POLICY-START -->/g) || []).length;
      const endCount = (clinerules.match(/<!-- MCP-POLICY-END -->/g) || []).length;
      expect(startCount).toBe(1);
      expect(endCount).toBe(1);
    });

    it('correctly replaces existing policy block in file with existing content before and after', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'm2-sync-replace-'));
      temporaryRoots.push(root);
      const home = path.join(root, 'home');
      const workspace = path.join(root, 'workspace');
      await mkdir(home, { recursive: true });
      await mkdir(workspace, { recursive: true });

      const clinerulesPath = path.join(workspace, '.clinerules');
      const initialContent = [
        '# Custom User Header',
        'Some instructions...',
        '<!-- MCP-POLICY-START -->',
        'Old obsolete policy table',
        '<!-- MCP-POLICY-END -->',
        '# Custom User Footer',
        'Keep this intact.',
      ].join('\n');
      await writeFile(clinerulesPath, initialContent, 'utf8');

      const syncService = new IdeSyncService({ homeDir: home, workspaceRoot: workspace });
      const result = await syncService.sync(['cline']);
      expect(result.ok).toBe(true);

      const updated = await readFile(clinerulesPath, 'utf8');
      expect(updated).toContain('# Custom User Header');
      expect(updated).toContain('# Custom User Footer');
      expect(updated).not.toContain('Old obsolete policy table');
      expect(updated).toContain('| P1 | session-start:ask-matt | ask-matt | skill |');
      expect(updated).toContain('| P2 | child:memory | memory | server |');
    });
  });
});
