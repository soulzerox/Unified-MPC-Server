import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase, SqliteWorkspaceRepository } from '@unified-mpc/storage';

/**
 * Opt-in cross-process E2E for the long-lived HTTP host (#407 addendum):
 * `dist/bin/mcp-http.js` owns the real Thai-RAG provider, and the shipped
 * `dist/bin/mcp-stdio.js` runs as a forward-only follower against the same
 * data root. Unlike the in-process topology test, both runtimes are real
 * entrypoints and the provider is the actual Python worker.
 *
 * Skipped unless a provider checkout is named:
 *
 *   THAI_RAG_REAL_PYTHON=/path/to/thai-rag-mcp/venv/bin/python3 \
 *   THAI_RAG_REAL_SOURCE=/path/to/thai-rag-mcp \
 *   corepack pnpm --filter @unified-mpc/cli exec vitest run \
 *     src/runtime/native-thai-rag-http-host-follower.test.ts
 *
 * The runtime derives the worker interpreter from `<source>/venv/bin/python3`;
 * `THAI_RAG_REAL_PYTHON` is the shared opt-in switch used by the existing
 * real-worker suite, not a second interpreter override.
 */
const python = process.env.THAI_RAG_REAL_PYTHON;
const source = process.env.THAI_RAG_REAL_SOURCE;
const execFileAsync = promisify(execFile);
const BIN_DIR = fileURLToPath(new URL('../../dist/bin/', import.meta.url));
const HTTP_BIN = path.join(BIN_DIR, 'mcp-http.js');
const STDIO_BIN = path.join(BIN_DIR, 'mcp-stdio.js');
const TEST_CHECKPOINT_KEY = Buffer.alloc(32, 0x46).toString('base64');

const hosts: ChildProcessWithoutNullStreams[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const temporaryRoots: string[] = [];

interface Fixture {
  readonly dataPath: string;
  readonly home: string;
  readonly workspacePath: string;
}

interface StderrSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: () => string;
}

interface ChildSession extends StderrSession {
  request(method: string, params: unknown): Promise<Record<string, unknown>>;
  notify(method: string): void;
}

interface ProviderLock {
  readonly pid?: number;
  readonly ownerId?: string;
  readonly startedAt?: string;
  readonly heartbeatAt?: string;
}

function spawnEnv(fixture: Fixture): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    HOME: fixture.home,
    XDG_DATA_HOME: path.join(fixture.home, '.local', 'share'),
    UNIFIED_MPC_DATA_PATH: fixture.dataPath,
    UNIFIED_MPC_CHECKPOINT_KEY_BASE64: TEST_CHECKPOINT_KEY,
    UNIFIED_MPC_THAI_RAG_PROVIDER_PATH: source,
  };
}

function captureOutput(child: ChildProcessWithoutNullStreams): () => string {
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return () => stderr;
}

function requireBuild(bin: string): void {
  if (existsSync(bin)) return;
  throw new Error(
    `CLI build is missing; run \`corepack pnpm --filter @unified-mpc/cli build\` (looked for ${bin})`,
  );
}

function startHost(fixture: Fixture): StderrSession {
  requireBuild(HTTP_BIN);
  const child = spawn(process.execPath, [HTTP_BIN], {
    env: {
      ...spawnEnv(fixture),
      UNIFIED_MPC_WORKSPACE: fixture.workspacePath,
      UNIFIED_MPC_PORT: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  hosts.push(child);
  return { child, stderr: captureOutput(child) };
}

function startFollower(fixture: Fixture): ChildSession {
  requireBuild(STDIO_BIN);
  const child = spawn(process.execPath, [STDIO_BIN, '--workspace', fixture.workspacePath], {
    env: { ...spawnEnv(fixture), UNIFIED_THAI_RAG_FORWARD_ONLY: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const stderr = captureOutput(child);

  let stdout = '';
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let nextId = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = message.id;
      if (typeof id !== 'number') continue;
      const resolve = pending.get(id);
      if (resolve === undefined) continue;
      pending.delete(id);
      resolve(message);
    }
  });

  const request = (method: string, params: unknown): Promise<Record<string, unknown>> => {
    nextId += 1;
    const id = nextId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`mcp-stdio did not answer ${method} within 60s; stderr=${stderr()}`));
      }, 60_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  return {
    child,
    stderr,
    request,
    notify: (method: string): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
  };
}

async function waitFor(check: () => boolean, session: StderrSession, label: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (check()) return;
    if (session.child.exitCode !== null) {
      throw new Error(`${label}: process exited early (code ${session.child.exitCode}): ${session.stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} was not reached within 120s: ${session.stderr()}`);
}

async function initialize(session: ChildSession): Promise<void> {
  await session.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'issue-407-http-host-follower', version: '0' },
  });
  session.notify('notifications/initialized');
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-rag-http-host-'));
  temporaryRoots.push(root);
  const dataPath = path.join(root, 'data');
  const home = path.join(root, 'home');
  const workspaceDir = path.join(root, 'workspace');
  await Promise.all([
    mkdir(dataPath, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDir);
  await writeFile(
    path.join(workspacePath, 'math.ts'),
    'export function add(a: number, b: number) { return a + b; }\n',
  );
  const git = ['-c', 'user.name=issue-407', '-c', 'user.email=issue-407@example.invalid'];
  await execFileAsync('git', ['init', '-q'], { cwd: workspacePath });
  await execFileAsync('git', ['add', '.'], { cwd: workspacePath });
  await execFileAsync('git', [...git, 'commit', '-qm', 'fixture'], { cwd: workspacePath });
  return { dataPath, home, workspacePath };
}

async function readWorkspaceId(fixture: Fixture): Promise<string> {
  const database = new SqliteDatabase(path.join(fixture.dataPath, 'unified-mpc.sqlite'));
  try {
    const workspaces = await new SqliteWorkspaceRepository(database).list();
    const match = workspaces.find((workspace) => workspace.realRootPath === fixture.workspacePath);
    if (match === undefined) {
      throw new Error(`HTTP host did not register ${fixture.workspacePath}: ${JSON.stringify(workspaces)}`);
    }
    return match.id;
  } finally {
    database.close();
  }
}

function providerLockPath(fixture: Fixture): string {
  return path.join(fixture.dataPath, 'thai-rag', 'provider.lock');
}

async function stop(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit').then(() => true);
  child.kill(signal);
  const exitTimeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), 15_000);
  });
  if (await Promise.race([exited, exitTimeout])) return;
  if (child.exitCode === null) child.kill('SIGKILL');
  await Promise.race([
    once(child, 'exit'),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => stop(host, 'SIGTERM')));
  await Promise.all(children.splice(0).map((child) => stop(child, 'SIGKILL')));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('real HTTP host + stdio follower (#407 addendum, explicit opt-in)', () => {
  it.skipIf(python === undefined || source === undefined)(
    'serves a follower code search through the host-owned Python provider',
    async () => {
      const fixture = await createFixture();
      const host = startHost(fixture);
      await waitFor(
        () => host.stderr().includes('Thai-RAG startup state=ready'),
        host,
        'HTTP host Thai-RAG startup',
      );
      expect(host.stderr()).not.toContain('Thai-RAG startup state=degraded');

      const workspaceId = await readWorkspaceId(fixture);
      const lockBefore = JSON.parse(await readFile(providerLockPath(fixture), 'utf8')) as ProviderLock;
      expect(lockBefore.pid).toBe(host.child.pid);
      expect(lockBefore.ownerId).toBeDefined();
      expect(lockBefore.startedAt).toBeDefined();
      expect(lockBefore.heartbeatAt).toBeDefined();

      const follower = startFollower(fixture);
      await waitFor(() => follower.stderr().includes('MCP stdio ready'), follower, 'stdio follower ready');
      await initialize(follower);

      const response = await follower.request('tools/call', {
        name: 'rag_code_search',
        arguments: { workspaceId, query: 'add function' },
      });
      const result = response.result as { content?: readonly { text?: string }[]; isError?: boolean } | undefined;
      const text = result?.content?.map((entry) => entry.text ?? '').join('\n') ?? '';
      expect(result?.isError).not.toBe(true);

      // The Unified tool wraps the provider's MCP result as a JSON string; unwrap
      // both layers so the assertion reads the provider payload, not its escapes.
      const envelope = JSON.parse(text) as { content?: readonly { text?: string }[] };
      const providerText = envelope.content?.map((entry) => entry.text ?? '').join('\n') ?? '';
      const payload = JSON.parse(providerText) as {
        status?: string;
        data?: { items?: readonly { file_path?: string }[] };
        metadata?: { provider_name?: string };
      };
      expect(payload.status).toBe('ok');
      expect(payload.data?.items?.some((item) => item.file_path?.endsWith('math.ts'))).toBe(true);
      expect(payload.metadata?.provider_name).toBe('thai-rag');

      // The host renews its own heartbeat, so compare ownership identity, never
      // the whole file. Wait for at least one renewal so a byte comparison
      // cannot pass by accident.
      await waitForLockHeartbeat(fixture, lockBefore.heartbeatAt);
      const lockAfter = JSON.parse(await readFile(providerLockPath(fixture), 'utf8')) as ProviderLock;
      expect(lockAfter.pid).toBe(lockBefore.pid);
      expect(lockAfter.ownerId).toBe(lockBefore.ownerId);
      expect(lockAfter.startedAt).toBe(lockBefore.startedAt);
      expect(lockAfter.pid).not.toBe(follower.child.pid);
      expect(follower.stderr()).not.toContain('Thai-RAG startup state=degraded');
    },
    180_000,
  );
});

async function waitForLockHeartbeat(fixture: Fixture, previous: string | undefined): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const current = JSON.parse(await readFile(providerLockPath(fixture), 'utf8')) as ProviderLock;
    if (current.heartbeatAt !== previous) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`provider.lock heartbeat did not advance within 20s: ${providerLockPath(fixture)}`);
}
