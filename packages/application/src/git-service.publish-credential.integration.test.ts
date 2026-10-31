import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { PublishAuditInput } from '@unified-mpc/audit';
import type { PublishCredentialLease } from '@unified-mpc/domain';
import { GitAdapter, type GitPublishCredentialDeployment } from '@unified-mpc/git';
import {
  SqliteDatabase,
  SqlitePublishApprovalRepository,
  SqlitePublishCredentialRepository,
  SqliteWorkspaceRepository,
  type SecretStore,
} from '@unified-mpc/storage';
import type { Workspace } from '@unified-mpc/workspace';
import { GitService } from './git-service.js';

const run = promisify(execFile);
const temporaryRoots: string[] = [];
const servers: HttpsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => { resolve(); });
  })));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MapSecretStore implements SecretStore {
  public readonly values = new Map<string, string>();

  public async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  public async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  public async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd, windowsHide: true });
  return stdout.trim();
}

async function makeCertificate(root: string): Promise<{ key: Buffer; cert: Buffer }> {
  const keyPath = path.join(root, 'key.pem');
  const certPath = path.join(root, 'cert.pem');
  await run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { windowsHide: true });
  return { key: await readFile(keyPath), cert: await readFile(certPath) };
}

/**
 * A minimal Git smart-HTTP server that requires Basic auth. Git's first
 * `info/refs` request is answered with 401, so it asks the host helper for the
 * credential and retries; the backend itself is `git http-backend` over CGI.
 */
async function startPrivateRemote(
  projectRoot: string,
  expectedAuthorization: string,
): Promise<{ port: number; authorizations: string[] }> {
  const { key, cert } = await makeCertificate(projectRoot);
  const authorizations: string[] = [];
  const server = createHttpsServer({ key, cert }, (request, response) => {
    void (async (): Promise<void> => {
      if (request.headers.authorization !== expectedAuthorization) {
        request.resume();
        response.writeHead(401, { 'www-authenticate': 'Basic realm="private"', connection: 'close' });
        response.end();
        return;
      }
      authorizations.push(expectedAuthorization);
      const url = new URL(request.url ?? '/', 'https://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
      const body = Buffer.concat(chunks);
      const child = execFile('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.replace(/^\?/u, ''),
          REQUEST_METHOD: request.method ?? 'GET',
          CONTENT_TYPE: String(request.headers['content-type'] ?? ''),
          CONTENT_LENGTH: String(body.length),
          REMOTE_ADDR: '127.0.0.1',
          REMOTE_USER: 'git',
          GATEWAY_INTERFACE: 'CGI/1.1',
          SERVER_PROTOCOL: 'HTTP/1.1',
        },
        encoding: 'buffer',
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout) => {
        if (error !== null || response.headersSent) {
          if (!response.headersSent) response.writeHead(500);
          response.end();
          return;
        }
        const split = stdout.indexOf('\r\n\r\n');
        if (split === -1) {
          response.writeHead(500);
          response.end();
          return;
        }
        const headerText = stdout.subarray(0, split).toString('utf8');
        const bodyBytes = stdout.subarray(split + 4);
        const lines = headerText.split('\r\n');
        const status = Number(/^Status:\s*(\d+)/iu.exec(lines.shift() ?? '')?.[1] ?? 200);
        const headers: Record<string, string> = {};
        for (const line of lines) {
          const index = line.indexOf(':');
          if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
        }
        response.writeHead(status, headers);
        response.end(bodyBytes);
      });
      child.stdin?.end(body);
    })();
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  servers.push(server);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { port, authorizations };
}

async function makeHelper(deploymentRoot: string, marker: string): Promise<void> {
  const helper = path.join(deploymentRoot, 'publish-credential-helper');
  await writeFile(helper, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] !== 'get') process.exit(1);
const leaseId = process.env.UNIFIED_PUBLISH_LEASE_ID;
const fd = Number(process.env.UNIFIED_PUBLISH_CREDENTIAL_FD);
let prompt = '';
try { prompt = fs.readFileSync(0, 'utf8'); } catch { process.exit(1); }
const host = /(?:^|\\n)host=([^\\n]+)/u.exec(prompt)?.[1];
let answer;
try { answer = JSON.parse(fs.readFileSync(fd, 'utf8')); } catch { process.exit(1); }
if (answer.leaseId !== leaseId || !Array.isArray(answer.hosts) || !answer.hosts.includes(host)) process.exit(1);
if (typeof answer.expiresAt !== 'number' || answer.expiresAt <= Date.now()) process.exit(1);
fs.writeFileSync(${JSON.stringify(marker)}, host + '\\n');
process.stdout.write('username=' + answer.username + '\\npassword=' + answer.secret + '\\n');
`, 'utf8');
  await chmod(helper, 0o555);
}

function workspaceFor(root: string): Workspace {
  return {
    id: 'workspace-e2e',
    displayName: 'Credential e2e',
    rootPath: root,
    realRootPath: root,
    createdAt: new Date(0).toISOString(),
  };
}

describe('GitService publish credential end to end', () => {
  it('publishes over private HTTPS with one lease and revokes it afterwards', async () => {
    const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-credential-e2e-'));
    temporaryRoots.push(rawRoot);
    const root = await realpath(rawRoot);
    const projectRoot = path.join(root, 'srv');
    const remoteRoot = path.join(projectRoot, 'remote.git');
    const workRoot = path.join(root, 'work');
    const deploymentRoot = path.join(root, 'deployment');
    const marker = path.join(root, 'helper-answered');
    const sentinelMarker = path.join(root, 'user-helper-ran');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(deploymentRoot, { recursive: true });
    await mkdir(workRoot, { recursive: true });

    await run('git', ['init', '--bare', '-b', 'main', remoteRoot], { windowsHide: true });
    await git(workRoot, ['init', '-b', 'main']);
    await git(workRoot, ['config', 'user.email', 'test@example.invalid']);
    await git(workRoot, ['config', 'user.name', 'unified-mpc test']);
    await writeFile(path.join(workRoot, 'readme.txt'), 'initial\n', 'utf8');
    await git(workRoot, ['add', '--', 'readme.txt']);
    await git(workRoot, ['commit', '-m', 'initial']);
    await git(workRoot, ['push', remoteRoot, 'main']);
    const head = await git(workRoot, ['rev-parse', '--verify', 'HEAD']);

    const expectedAuthorization = `Basic ${Buffer.from('git:e2e-secret-token').toString('base64')}`;
    const { port, authorizations } = await startPrivateRemote(projectRoot, expectedAuthorization);
    const host = `127.0.0.1:${port}`;
    await git(workRoot, ['remote', 'add', 'origin', `https://${host}/remote.git`]);
    await git(workRoot, ['config', 'http.sslVerify', 'false']);
    // A user-configured helper must never run: the host helper resets the list.
    const sentinel = path.join(root, 'sentinel.sh');
    await writeFile(sentinel, `#!/bin/sh\nprintf ran > ${JSON.stringify(sentinelMarker)}\nexit 1\n`, 'utf8');
    await chmod(sentinel, 0o755);
    await git(workRoot, ['config', 'credential.helper', `!${sentinel}`]);
    await makeHelper(deploymentRoot, marker);

    const database = new SqliteDatabase(':memory:');
    try {
      const workspaces = new SqliteWorkspaceRepository(database);
      const workspace = workspaceFor(workRoot);
      await workspaces.insert({ ...workspace, lifecycleKind: 'goal' });
      const approvals = new SqlitePublishApprovalRepository(database);
      const store = new MapSecretStore();
      const credentials = new SqlitePublishCredentialRepository({ database, secretStore: store });
      const lease: PublishCredentialLease = {
        leaseId: 'lease-e2e',
        workspaceId: workspace.id,
        remote: 'origin',
        hosts: [host],
        username: 'git',
        createdAt: Date.now() - 1_000,
        expiresAt: Date.now() + 5 * 60_000,
      };
      await expect(credentials.grant(lease, 'e2e-secret-token')).resolves.toMatchObject({ ok: true });
      expect(store.values.get('publish-lease-e2e')).toBe('e2e-secret-token');

      const adapter = new GitAdapter(undefined, {
        resolvePublishCredentialDeployment: async (): Promise<GitPublishCredentialDeployment> => ({ root: deploymentRoot, promoted: true }),
        now: (): number => Date.now(),
      });
      const auditRows: PublishAuditInput[] = [];
      const service = new GitService(workspaces, undefined, adapter, {
        publishApprovals: approvals,
        publishApprovalAuthority: approvals,
        publishCredentials: credentials,
        publishAudit: { recordPublish: async (input: PublishAuditInput): Promise<void> => { auditRows.push(input); } },
        now: (): number => Date.now(),
      });
      const actor = { clientId: 'e2e', clientName: 'e2e' };
      const request = { workspaceId: workspace.id, remote: 'origin', branch: 'goal/publish', expectedSha: head };

      const preflight = await service.publishPreflight(actor, request);
      expect(preflight).toMatchObject({
        ok: true,
        value: {
          head,
          defaultBranches: ['main'],
          protectedBranch: false,
          runtime: { ready: true },
          approval: 'missing',
        },
      });

      const approved = await service.approvePublish(actor, { ...request, userConfirmed: true });
      expect(approved).toMatchObject({
        ok: true,
        value: { leaseId: 'lease-e2e', pushUrlFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) },
      });
      if (!approved.ok) return;

      const published = await service.publish(actor, { ...request, approvalId: approved.value.approvalId });
      expect(published).toMatchObject({ ok: true, value: { sha: head, branch: 'goal/publish' } });

      expect(await git(root, ['ls-remote', remoteRoot, 'refs/heads/goal/publish']))
        .toBe(`${head}\trefs/heads/goal/publish`);
      expect(authorizations.length).toBeGreaterThan(0);
      expect(await readFile(marker, 'utf8')).toContain(host);
      await expect(stat(sentinelMarker)).rejects.toMatchObject({ code: 'ENOENT' });

      // The lease is gone after the push and its verification: the secret, the
      // ledger row and the live lookup all answer nothing.
      expect(store.values.has('publish-lease-e2e')).toBe(false);
      await expect(credentials.open('lease-e2e', Date.now())).resolves.toEqual({ ok: true, value: null });
      await expect(credentials.findLive(workspace.id, 'origin', Date.now())).resolves.toEqual({ ok: true, value: null });
      const receipt = await approvals.read(approved.value.approvalId);
      expect(receipt).toMatchObject({ leaseId: 'lease-e2e' });
      expect(receipt?.consumedAt).not.toBeNull();

      // One non-secret use row per credential-bound spend, written after the
      // lease was revoked, naming the exact receipt binding (#297 S2d).
      expect(auditRows).toMatchObject([{
        action: 'publish_credential_use',
        leaseId: 'lease-e2e',
        approvalId: approved.value.approvalId,
        branch: 'goal/publish',
        expectedSha: head,
        hosts: [host],
        username: 'git',
        resultCode: 'SUCCESS',
      }]);
      expect(auditRows[0]?.reason).toBeUndefined();
      expect(auditRows[0]?.leaseRevokeFailed).toBeUndefined();
      expect(JSON.stringify(auditRows)).not.toContain('e2e-secret-token');
    } finally {
      database.close();
    }
  }, 60_000);

  it('refuses a remote rewritten after approval and delivers no credential', async () => {
    const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-credential-e2e-'));
    temporaryRoots.push(rawRoot);
    const root = await realpath(rawRoot);
    const projectRoot = path.join(root, 'srv');
    const remoteRoot = path.join(projectRoot, 'remote.git');
    const workRoot = path.join(root, 'work');
    const deploymentRoot = path.join(root, 'deployment');
    const marker = path.join(root, 'helper-answered');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(deploymentRoot, { recursive: true });
    await mkdir(workRoot, { recursive: true });
    await run('git', ['init', '--bare', '-b', 'main', remoteRoot], { windowsHide: true });
    await git(workRoot, ['init', '-b', 'main']);
    await git(workRoot, ['config', 'user.email', 'test@example.invalid']);
    await git(workRoot, ['config', 'user.name', 'unified-mpc test']);
    await writeFile(path.join(workRoot, 'readme.txt'), 'initial\n', 'utf8');
    await git(workRoot, ['add', '--', 'readme.txt']);
    await git(workRoot, ['commit', '-m', 'initial']);
    await git(workRoot, ['push', remoteRoot, 'main']);
    const head = await git(workRoot, ['rev-parse', '--verify', 'HEAD']);

    const expectedAuthorization = `Basic ${Buffer.from('git:e2e-secret-token').toString('base64')}`;
    const { port } = await startPrivateRemote(projectRoot, expectedAuthorization);
    const host = `127.0.0.1:${port}`;
    await git(workRoot, ['remote', 'add', 'origin', `https://${host}/remote.git`]);
    await git(workRoot, ['config', 'http.sslVerify', 'false']);
    await makeHelper(deploymentRoot, marker);

    const database = new SqliteDatabase(':memory:');
    try {
      const workspaces = new SqliteWorkspaceRepository(database);
      const workspace = workspaceFor(workRoot);
      await workspaces.insert({ ...workspace, lifecycleKind: 'goal' });
      const approvals = new SqlitePublishApprovalRepository(database);
      const credentials = new SqlitePublishCredentialRepository({ database, secretStore: new MapSecretStore() });
      const lease: PublishCredentialLease = {
        leaseId: 'lease-rewrite',
        workspaceId: workspace.id,
        remote: 'origin',
        hosts: [host],
        username: 'git',
        createdAt: Date.now() - 1_000,
        expiresAt: Date.now() + 5 * 60_000,
      };
      await credentials.grant(lease, 'e2e-secret-token');
      const adapter = new GitAdapter(undefined, {
        resolvePublishCredentialDeployment: async (): Promise<GitPublishCredentialDeployment> => ({ root: deploymentRoot, promoted: true }),
        now: (): number => Date.now(),
      });
      const auditRows: PublishAuditInput[] = [];
      const service = new GitService(workspaces, undefined, adapter, {
        publishApprovals: approvals,
        publishApprovalAuthority: approvals,
        publishCredentials: credentials,
        publishAudit: { recordPublish: async (input: PublishAuditInput): Promise<void> => { auditRows.push(input); } },
        now: (): number => Date.now(),
      });
      const actor = { clientId: 'e2e', clientName: 'e2e' };
      const request = { workspaceId: workspace.id, remote: 'origin', branch: 'goal/publish', expectedSha: head };
      const approved = await service.approvePublish(actor, { ...request, userConfirmed: true });
      expect(approved).toMatchObject({ ok: true });
      if (!approved.ok) return;

      // The approval's diagnostic read used the helper. Clearing the marker lets
      // the refused publish prove that no credential reached it.
      await rm(marker, { force: true });
      await git(workRoot, ['remote', 'set-url', 'origin', 'https://127.0.0.1:1/other.git']);

      await expect(service.publish(actor, { ...request, approvalId: approved.value.approvalId }))
        .resolves.toMatchObject({
          ok: false,
          error: { code: 'PERMISSION_DENIED', details: { reason: 'publish-target-changed' } },
        });
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      // A refusal happens before the audited spend, so no use row may appear:
      // a row here would claim a lease was spent that never left the store.
      expect(auditRows).toHaveLength(0);
      const receipt = await approvals.read(approved.value.approvalId);
      expect(receipt?.consumedAt).toBeNull();
    } finally {
      database.close();
    }
  }, 60_000);
});
