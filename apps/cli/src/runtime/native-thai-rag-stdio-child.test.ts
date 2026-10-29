import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ok } from '@unified-mpc/domain';
import { SqliteDatabase, SqliteWorkspaceRepository } from '@unified-mpc/storage';
import type { ThaiRagProviderDriver } from '@unified-mpc/thai-rag';
import { createStdioMcpRuntime } from './stdio-mcp-runtime.js';

/**
 * Process-level cross-runtime topology (#407 addendum): the shipped `mcp-stdio`
 * entrypoint runs as its own process, forwards to the live provider host over
 * the real `provider.sock`, and never elects itself when the host is gone.
 *
 * The host is built in this process with an injected driver (the same factory
 * the HTTP host uses), so the test stays deterministic and needs no Python
 * worker; only the follower is a real child process. The child sets no
 * forward-only env override: the shipped stdio entrypoint must default to
 * following the designated host (#407 single-host).
 */
const temporaryRoots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const TEST_CHECKPOINT_KEY = Buffer.alloc(32, 0x46).toString('base64');
const CLI_STDIO_BIN = fileURLToPath(new URL('../../dist/bin/mcp-stdio.js', import.meta.url));
const WORKSPACE_ID = 'workspace-stdio-child';

const HEALTHY = {
  workerReachable: true,
  sqliteAvailable: true,
  ftsAvailable: true,
  vectorStoreAvailable: true,
  embedderAvailable: true,
  lexicalRetrievalAvailable: true,
  semanticRetrievalAvailable: true,
  activeJobs: [] as readonly unknown[],
};

interface DriverProbe {
  readonly driver: ThaiRagProviderDriver;
  readonly starts: () => number;
}

function createOwnerDriver(servedBy: string): DriverProbe {
  let startCalls = 0;
  return {
    starts: () => startCalls,
    driver: {
      start: async (): ReturnType<ThaiRagProviderDriver['start']> => {
        startCalls += 1;
        return ok(HEALTHY);
      },
      health: async () => ok(HEALTHY),
      call: async () => ok({ servedBy }),
      stop: async () => ok(undefined),
    },
  };
}

interface ChildSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: () => string;
  request(method: string, params: unknown): Promise<Record<string, unknown>>;
  notify(method: string): void;
}

function startChild(dataPath: string, home: string, workspacePath: string): ChildSession {
  if (!existsSync(CLI_STDIO_BIN)) {
    throw new Error(
      `mcp-stdio build is missing; run \`corepack pnpm --filter @unified-mpc/cli build\` (looked for ${CLI_STDIO_BIN})`,
    );
  }
  // The test proves the shipped default, so inherit the rest of the
  // environment but never an operator's forward-only override.
  const inheritedEnv = { ...process.env };
  delete inheritedEnv.UNIFIED_THAI_RAG_FORWARD_ONLY;
  const child = spawn(process.execPath, [CLI_STDIO_BIN, '--workspace', workspacePath], {
    env: {
      ...inheritedEnv,
      NODE_NO_WARNINGS: '1',
      HOME: home,
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      UNIFIED_MPC_DATA_PATH: dataPath,
      UNIFIED_MPC_CHECKPOINT_KEY_BASE64: TEST_CHECKPOINT_KEY,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

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
        reject(new Error(`mcp-stdio did not answer ${method} within 30s; stderr=${stderr}`));
      }, 30_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  return {
    child,
    stderr: () => stderr,
    request,
    notify: (method: string): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
  };
}

async function waitForReady(session: ChildSession): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (session.stderr().includes('MCP stdio ready')) return;
    if (session.child.exitCode !== null) {
      throw new Error(`mcp-stdio exited early (code ${session.child.exitCode}): ${session.stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`mcp-stdio was not ready within 30s: ${session.stderr()}`);
}

async function initialize(session: ChildSession): Promise<void> {
  await session.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'issue-407-stdio-child', version: '0' },
  });
  session.notify('notifications/initialized');
}

interface Fixture {
  readonly root: string;
  readonly dataPath: string;
  readonly home: string;
  readonly workspacePath: string;
  readonly workspace: {
    id: string;
    displayName: string;
    rootPath: string;
    realRootPath: string;
    createdAt: string;
  };
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-rag-stdio-child-'));
  temporaryRoots.push(root);
  const dataPath = path.join(root, 'data');
  const home = path.join(root, 'home');
  const workspacePath = path.join(root, 'workspace');
  await Promise.all([
    mkdir(dataPath, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(workspacePath, { recursive: true }),
  ]);
  const workspace = {
    id: WORKSPACE_ID,
    displayName: 'stdio-child-fixture',
    rootPath: workspacePath,
    realRootPath: workspacePath,
    createdAt: '2026-08-10T00:00:00.000Z',
  };
  const database = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
  try {
    await new SqliteWorkspaceRepository(database).insert(workspace);
  } finally {
    database.close();
  }
  return { root, dataPath, home, workspacePath, workspace };
}

function providerLockPath(dataPath: string): string {
  return path.join(dataPath, 'thai-rag', 'provider.lock');
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null) return;
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('mcp-stdio child process forwards to the live provider host (#407)', () => {
  it('serves a forwarded read from the host driver without electing the child', async () => {
    const fixture = await createFixture();
    const host = createOwnerDriver('host-a');
    const hostRuntime = createStdioMcpRuntime(fixture.dataPath, fixture.workspace, false, { thaiRagDriver: host.driver });
    try {
      await hostRuntime.initializeThaiRag();
      expect(host.starts()).toBe(1);
      const lockBefore = await readFile(providerLockPath(fixture.dataPath), 'utf8');

      const session = startChild(fixture.dataPath, fixture.home, fixture.workspacePath);
      await waitForReady(session);
      await initialize(session);

      const response = await session.request('tools/call', {
        name: 'rag_code_search',
        arguments: { workspaceId: WORKSPACE_ID, query: 'needle' },
      });

      const result = response.result as { content?: readonly { text?: string }[]; isError?: boolean } | undefined;
      const text = result?.content?.map((entry) => entry.text ?? '').join('\n') ?? '';
      expect(result?.isError).not.toBe(true);
      expect(text).toContain('host-a');
      expect(host.starts()).toBe(1);
      // The follower holds no provider state: the host's lock generation is untouched.
      expect(await readFile(providerLockPath(fixture.dataPath), 'utf8')).toBe(lockBefore);
    } finally {
      await hostRuntime.close();
    }
  }, 60_000);

  it('reports forward-host-unreachable and writes no lock when the host is gone', async () => {
    const fixture = await createFixture();
    const session = startChild(fixture.dataPath, fixture.home, fixture.workspacePath);
    await waitForReady(session);
    await initialize(session);

    const response = await session.request('tools/call', {
      name: 'rag_code_search',
      arguments: { workspaceId: WORKSPACE_ID, query: 'needle' },
    });

    const result = response.result as { content?: readonly { text?: string }[]; isError?: boolean } | undefined;
    const text = result?.content?.map((entry) => entry.text ?? '').join('\n') ?? '';
    expect(result?.isError).toBe(true);
    expect(text).toMatch(/forward host is unreachable|forward-host-unreachable/i);
    expect(existsSync(providerLockPath(fixture.dataPath))).toBe(false);
  }, 60_000);
});
