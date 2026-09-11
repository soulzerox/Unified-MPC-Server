import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallerService, type InstallServerInput, type InstallSkillInput } from './index.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Milestone 3 - Stress Test & Edge Case Ingestion Audit', () => {
  describe('Security & Input Validation', () => {
    it('rejects prototype pollution attempts on server name (constructor, __proto__, prototype)', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'm3-proto-'));
      temporaryRoots.push(root);
      const home = path.join(root, 'home');
      const installer = new InstallerService({ homeDir: home });

      for (const dangerousName of ['constructor', '__proto__', 'prototype', 'CONSTRUCTOR']) {
        const result = await installer.installServer({
          name: dangerousName,
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          targets: ['antigravity'],
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('INVALID_INPUT');
        }
      }
    });

    it('rejects installations with empty targets array', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'm3-targets-'));
      temporaryRoots.push(root);
      const home = path.join(root, 'home');
      const installer = new InstallerService({ homeDir: home });

      const serverRes = await installer.installServer({
        name: 'valid-server',
        transport: 'stdio',
        command: 'node',
        args: ['valid.js'],
        targets: [],
      });
      expect(serverRes.ok).toBe(false);
      if (!serverRes.ok) {
        expect(serverRes.error.code).toBe('INVALID_INPUT');
      }

      const skillDir = path.join(root, 'skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: valid-skill\ndescription: Test\n---\n# Test\n');

      const skillRes = await installer.installSkill({
        name: 'valid-skill',
        source: skillDir,
        targets: [],
      });
      expect(skillRes.ok).toBe(false);
      if (!skillRes.ok) {
        expect(skillRes.error.code).toBe('INVALID_INPUT');
      }
    });

    it('rejects invalid or unsafe URLs for SSE and HTTP transports', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'm3-urls-'));
      temporaryRoots.push(root);
      const home = path.join(root, 'home');
      const installer = new InstallerService({ homeDir: home });

      const dangerousUrls = [
        'javascript:alert(1)',
        'file:///etc/passwd',
        'not a valid url',
        'ftp://example.com/mcp',
      ];

      for (const url of dangerousUrls) {
        const result = await installer.installServer({
          name: 'remote-srv',
          transport: 'sse',
          url,
          targets: ['antigravity'],
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('INVALID_INPUT');
        }
      }
    });

    it('strictly prevents self-aggregation loops', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'm3-self-'));
      temporaryRoots.push(root);
      const home = path.join(root, 'home');
      const installer = new InstallerService({ homeDir: home });

      const loopConfigs: InstallServerInput[] = [
        {
          name: 'unified-mpc',
          transport: 'stdio',
          command: 'node',
          args: ['anything.js'],
          targets: ['cursor'],
        },
        {
          name: 'my-wrapper',
          transport: 'stdio',
          command: 'node',
          args: ['/opt/unified-mpc/apps/cli/dist/bin/mcp-stdio.js'],
          targets: ['cursor'],
        },
        {
          name: 'sub-service',
          transport: 'stdio',
          command: '/usr/local/bin/unified-mpc',
          args: ['serve'],
          targets: ['cursor'],
        },
      ];

      for (const config of loopConfigs) {
        const res = await installer.installServer(config);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('INVALID_INPUT');
          expect(res.error.message).toContain('aggregate unified-mpc itself');
        }
      }
    });
  });

  describe('Concurrency & Atomic Durability Stress Test', () => {
    it('survives 20 concurrent server installations to the same target config without lost updates', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'm3-concurrency-'));
      temporaryRoots.push(root);
      const home = path.join(root, 'home');
      await mkdir(home, { recursive: true });

      const installer = new InstallerService({ homeDir: home });

      // Run 20 concurrent install operations on Cursor mcp.json
      const count = 20;
      const promises = Array.from({ length: count }, (_, i) =>
        installer.installServer({
          name: `server-${i}`,
          transport: 'stdio',
          command: 'node',
          args: [`worker-${i}.js`],
          env: { WORKER_ID: `${i}` },
          targets: ['cursor'],
        })
      );

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.ok).toBe(true);
      }

      // Read Cursor config file: must have all 20 servers!
      const cursorConfigPath = path.join(home, '.cursor', 'mcp.json');
      const content = await readFile(cursorConfigPath, 'utf8');
      const doc = JSON.parse(content);
      expect(doc.mcpServers).toBeDefined();
      const keys = Object.keys(doc.mcpServers);
      expect(keys).toHaveLength(count);

      for (let i = 0; i < count; i += 1) {
        expect(doc.mcpServers[`server-${i}`]).toBeDefined();
        expect(doc.mcpServers[`server-${i}`].command).toBe('node');
        expect(doc.mcpServers[`server-${i}`].args).toEqual([`worker-${i}.js`]);
        expect(doc.mcpServers[`server-${i}`].env).toEqual({ WORKER_ID: `${i}` });
      }
    });

    it('recovers from pre-existing JSONC with comments and trailing commas during installation', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'm3-jsonc-recovery-'));
      temporaryRoots.push(root);
      const home = path.join(root, 'home');
      const cursorDir = path.join(home, '.cursor');
      await mkdir(cursorDir, { recursive: true });

      // Pre-seed with JSONC comments and trailing commas
      const messyJsonc = `
      // User manual configuration
      {
        "mcpServers": {
          "existing-server": {
            "command": "python3",
            "args": ["existing.py"], // inline comment
          }, // trailing comma
        },
      }
      `;
      await writeFile(path.join(cursorDir, 'mcp.json'), messyJsonc, 'utf8');

      const installer = new InstallerService({ homeDir: home });
      const res = await installer.installServer({
        name: 'new-server',
        transport: 'stdio',
        command: 'node',
        args: ['new.js'],
        targets: ['cursor'],
      });

      expect(res.ok).toBe(true);

      const updated = await readFile(path.join(cursorDir, 'mcp.json'), 'utf8');
      const doc = JSON.parse(updated);
      expect(doc.mcpServers['existing-server']).toBeDefined();
      expect(doc.mcpServers['new-server']).toBeDefined();
    });
  });
});

