import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase, SqliteWorkspaceRepository } from '@unified-mpc/storage';

/**
 * Process-level failure modes for the long-lived HTTP provider host
 * (#407 addendum). The host entrypoint and the stdio follower are the shipped
 * `dist/bin` processes, so lock/socket/heartbeat lifecycle is exercised across
 * real process boundaries.
 *
 * Case 1 always runs and needs no provider checkout: a launcher that exits
 * after the owner lock is written makes `driver.start` fail before the socket
 * exists, so both the lock acquisition and its release are observable.
 *
 * Cases 2-4 are opt-in with the same switch as the other real-worker suites.
 * Cases 3-4 signal the provider worker through POSIX `ps --ppid`, so they are
 * Linux-only:
 *
 *   THAI_RAG_REAL_PYTHON=/path/to/thai-rag-mcp/venv/bin/python3 \
 *   THAI_RAG_REAL_SOURCE=/path/to/thai-rag-mcp \
 *   corepack pnpm --filter @unified-mpc/cli exec vitest run \
 *     src/runtime/native-thai-rag-http-host-failure-modes.test.ts
 */
const python = process.env.THAI_RAG_REAL_PYTHON;
const source = process.env.THAI_RAG_REAL_SOURCE;
const execFileAsync = promisify(execFile);
const BIN_DIR = fileURLToPath(new URL('../../dist/bin/', import.meta.url));
const HTTP_BIN = path.join(BIN_DIR, 'mcp-http.js');
const STDIO_BIN = path.join(BIN_DIR, 'mcp-stdio.js');
const TEST_CHECKPOINT_KEY = Buffer.alloc(32, 0x46).toString('base64');
const FILE_COUNT = 60;

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

interface JournalRow {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly status: string;
  readonly providerJobId?: string;
  readonly error?: string;
}

function spawnEnv(fixture: Fixture, providerPath: string | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    HOME: fixture.home,
    XDG_DATA_HOME: path.join(fixture.home, '.local', 'share'),
    UNIFIED_MPC_DATA_PATH: fixture.dataPath,
    UNIFIED_MPC_CHECKPOINT_KEY_BASE64: TEST_CHECKPOINT_KEY,
    ...(providerPath === undefined ? {} : { UNIFIED_MPC_THAI_RAG_PROVIDER_PATH: providerPath }),
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

function startHost(
  fixture: Fixture,
  providerPath: string | undefined = source,
  extraEnv: NodeJS.ProcessEnv = {},
): StderrSession {
  requireBuild(HTTP_BIN);
  const child = spawn(process.execPath, [HTTP_BIN], {
    env: {
      ...spawnEnv(fixture, providerPath),
      UNIFIED_MPC_WORKSPACE: fixture.workspacePath,
      UNIFIED_MPC_PORT: '0',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  hosts.push(child);
  return { child, stderr: captureOutput(child) };
}

function startFollower(fixture: Fixture): ChildSession {
  requireBuild(STDIO_BIN);
  const child = spawn(process.execPath, [STDIO_BIN, '--workspace', fixture.workspacePath], {
    env: { ...spawnEnv(fixture, source), UNIFIED_THAI_RAG_FORWARD_ONLY: '1' },
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
        reject(new Error(`mcp-stdio did not answer ${method} within 180s; stderr=${stderr()}`));
      }, 180_000);
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

async function waitFor(check: () => boolean, session: StderrSession, label: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    if (session.child.exitCode !== null) {
      throw new Error(`${label}: process exited early (code ${session.child.exitCode}): ${session.stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} was not reached within ${timeoutMs / 1_000}s: ${session.stderr()}`);
}

async function initialize(session: ChildSession): Promise<void> {
  await session.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'issue-407-http-host-failure-modes', version: '0' },
  });
  session.notify('notifications/initialized');
}

async function createFixture(fileCount = 1): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-rag-http-failure-'));
  temporaryRoots.push(root);
  const dataPath = path.join(root, 'data');
  const home = path.join(root, 'home');
  const workspaceDir = path.join(root, 'workspace');
  await Promise.all([
    mkdir(dataPath, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(path.join(workspaceDir, 'src'), { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDir);
  await writeFile(
    path.join(workspacePath, 'math.ts'),
    'export function add(a: number, b: number) { return a + b; }\n',
  );
  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(
      path.join(workspacePath, 'src', `module-${index}.ts`),
      [
        `export interface Shape${index} { readonly size: number; }`,
        `export function area${index}(shape: Shape${index}): number { return shape.size * ${index + 1}; }`,
        `export function perimeter${index}(shape: Shape${index}): number { return shape.size * ${(index + 1) * 4}; }`,
        '',
      ].join('\n'),
    );
  }
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

function providerSocketPath(fixture: Fixture): string {
  return path.join(fixture.dataPath, 'thai-rag', 'provider.sock');
}

function providerJobPath(fixture: Fixture): string {
  return path.join(fixture.dataPath, 'thai-rag', 'index-jobs.json');
}

async function readLock(fixture: Fixture): Promise<ProviderLock | undefined> {
  try {
    return JSON.parse(await readFile(providerLockPath(fixture), 'utf8')) as ProviderLock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readJournal(fixture: Fixture): Promise<readonly JournalRow[]> {
  try {
    const parsed = JSON.parse(await readFile(providerJobPath(fixture), 'utf8')) as { jobs?: readonly JournalRow[] };
    return parsed.jobs ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForJournal(
  fixture: Fixture,
  session: StderrSession,
  label: string,
  predicate: (rows: readonly JournalRow[]) => boolean,
  timeoutMs = 120_000,
): Promise<readonly JournalRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: readonly JournalRow[] = [];
  while (Date.now() < deadline) {
    rows = await readJournal(fixture);
    if (predicate(rows)) return rows;
    if (session.child.exitCode !== null) {
      throw new Error(`${label}: process exited early (code ${session.child.exitCode}): ${session.stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} was not reached within ${timeoutMs / 1_000}s; journal=${JSON.stringify(rows)}; stderr=${session.stderr()}`);
}

function parseEndpoint(stderr: string): URL {
  const match = /endpoint=(http:\/\/[^\s]+)/.exec(stderr);
  if (match === null) throw new Error(`HTTP endpoint was not reported: ${stderr}`);
  return new URL(match[1]);
}

interface ToolResult {
  readonly isError: boolean;
  readonly text: string;
}

async function callTool(session: ChildSession, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const response = await session.request('tools/call', { name, arguments: args });
  const result = response.result as { content?: readonly { text?: string }[]; isError?: boolean } | undefined;
  return {
    isError: result?.isError === true,
    text: result?.content?.map((entry) => entry.text ?? '').join('\n') ?? '',
  };
}

interface ProviderPayload {
  readonly status?: string;
  readonly data?: { readonly items?: readonly { file_path?: string }[] };
  readonly metadata?: { readonly provider_name?: string };
}

/** Unwrap the Unified tool envelope and the provider MCP envelope around it. */
function providerPayload(text: string): ProviderPayload {
  const envelope = JSON.parse(text) as { content?: readonly { text?: string }[] };
  const providerText = envelope.content?.map((entry) => entry.text ?? '').join('\n') ?? '';
  return JSON.parse(providerText) as ProviderPayload;
}

async function search(session: ChildSession, workspaceId: string, query = 'add function'): Promise<ToolResult & { payload?: ProviderPayload }> {
  const result = await callTool(session, 'rag_code_search', { workspaceId, query });
  if (result.isError) return result;
  return { ...result, payload: providerPayload(result.text) };
}

/** Linux/POSIX: provider worker pids spawned by the HTTP host. */
async function providerWorkerPids(hostPid: number): Promise<readonly number[]> {
  const { stdout } = await execFileAsync('ps', ['-o', 'pid=,args=', '--ppid', String(hostPid)]);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('thai_rag_context_mcp.py'))
    .map((line) => Number(line.split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * A provider checkout whose interpreter sleeps before exec'ing the real
 * worker. The owner writes `provider.lock` before it boots the driver, so the
 * delay makes the lock-before-listen window observable from another process.
 */
async function createSlowProviderRoot(realPython: string, realSource: string, delayMs: number): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-rag-slow-provider-'));
  temporaryRoots.push(root);
  const bin = path.join(root, 'venv', 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(root, 'thai_rag_context_mcp.py'), '# replaced by the launcher below\n');
  const launcher = path.join(bin, 'python3');
  await writeFile(
    launcher,
    [
      '#!/bin/sh',
      `sleep ${(delayMs / 1_000).toFixed(3)}`,
      `exec ${shellQuote(realPython)} ${shellQuote(path.join(realSource, 'thai_rag_context_mcp.py'))}`,
      '',
    ].join('\n'),
  );
  await chmod(launcher, 0o755);
  return root;
}

/**
 * A provider checkout whose interpreter waits before exiting non-zero. The
 * owner acquires `provider.lock` before booting the driver, so the delay makes
 * both the lock acquisition and the failure-path release observable.
 */
async function createFailingProviderRoot(delayMs: number): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-rag-failing-provider-'));
  temporaryRoots.push(root);
  const bin = path.join(root, 'venv', 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(root, 'thai_rag_context_mcp.py'), '# replaced by the launcher below\n');
  const launcher = path.join(bin, 'python3');
  await writeFile(
    launcher,
    [
      '#!/bin/sh',
      `sleep ${(delayMs / 1_000).toFixed(3)}`,
      'exit 1',
      '',
    ].join('\n'),
  );
  await chmod(launcher, 0o755);
  return root;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', `'\\''`)}'`;
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

describe('real HTTP host failure modes (#407 addendum)', () => {
  it('acquires and releases the owner lock while keeping HTTP serving when the provider driver cannot start', async () => {
    const fixture = await createFixture();
    const failingProvider = await createFailingProviderRoot(2_000);

    const host = startHost(fixture, failingProvider);
    // The owner writes `provider.lock` before it boots the driver; observing it
    // while the launcher sleeps proves the failure path released an owned lock
    // rather than never having acquired one.
    await waitFor(() => existsSync(providerLockPath(fixture)), host, 'owner lock before driver start');
    const startingLock = await readLock(fixture);
    expect(startingLock?.pid).toBe(host.child.pid);
    expect(startingLock?.startedAt).toBeDefined();

    await waitFor(
      () => host.stderr().includes('Thai-RAG startup state=degraded'),
      host,
      'HTTP host degraded startup',
    );
    expect(host.stderr()).not.toContain('Thai-RAG startup state=ready');
    // A failing driver must not leave an owned lock or a phantom socket behind.
    expect(existsSync(providerLockPath(fixture))).toBe(false);
    expect(existsSync(providerSocketPath(fixture))).toBe(false);
    // The provider is degraded, not the HTTP runtime: the identity endpoint still answers.
    const identity = await fetch(new URL('/_unified-mpc/identity', parseEndpoint(host.stderr())));
    expect(identity.status).toBe(200);
    expect(host.child.exitCode).toBeNull();

    const workspaceId = await readWorkspaceId(fixture);
    const follower = startFollower(fixture);
    await waitFor(() => follower.stderr().includes('MCP stdio ready'), follower, 'stdio follower ready');
    await initialize(follower);

    const response = await callTool(follower, 'rag_code_search', { workspaceId, query: 'add function' });
    expect(response.isError).toBe(true);
    expect(response.text).toMatch(/forward host is unreachable|forward-host-unreachable/i);
    // The follower never elects itself, even when the designated host is degraded.
    expect(existsSync(providerLockPath(fixture))).toBe(false);
  }, 120_000);

  it.skipIf(python === undefined || source === undefined)(
    'hands the data root to a replacement host and re-attaches the same follower',
    async () => {
      const fixture = await createFixture();
      const hostA = startHost(fixture);
      await waitFor(() => hostA.stderr().includes('Thai-RAG startup state=ready'), hostA, 'host A ready');
      const workspaceId = await readWorkspaceId(fixture);

      const follower = startFollower(fixture);
      await waitFor(() => follower.stderr().includes('MCP stdio ready'), follower, 'stdio follower ready');
      await initialize(follower);
      const first = await search(follower, workspaceId);
      expect(first.isError).toBe(false);
      expect(first.payload?.status).toBe('ok');
      expect(first.payload?.data?.items?.some((item) => item.file_path?.endsWith('math.ts'))).toBe(true);

      const lockA = await readLock(fixture);
      expect(lockA?.pid).toBe(hostA.child.pid);
      expect(existsSync(providerSocketPath(fixture))).toBe(true);

      await stop(hostA.child, 'SIGTERM');
      await waitFor(
        () => !existsSync(providerLockPath(fixture)) && !existsSync(providerSocketPath(fixture)),
        hostA,
        'host A lock/socket release',
      );

      // A replacement process starts with a deliberately slow worker boot so the
      // lock-before-listen window is observable instead of a race.
      const slowRoot = await createSlowProviderRoot(python!, source!, 2_000);
      const hostB = startHost(fixture, slowRoot);
      await waitFor(() => existsSync(providerLockPath(fixture)), hostB, 'host B owner lock');
      const lockB = await readLock(fixture);
      expect(lockB?.pid).toBe(hostB.child.pid);
      expect(lockB?.startedAt).toBeDefined();
      expect(lockB?.startedAt).not.toBe(lockA?.startedAt);
      // The owner lock proves liveness while the socket does not exist yet.
      expect(existsSync(providerSocketPath(fixture))).toBe(false);
      expect(hostB.stderr()).not.toContain('Thai-RAG startup state=ready');

      await waitFor(() => hostB.stderr().includes('Thai-RAG startup state=ready'), hostB, 'host B ready', 180_000);
      expect(existsSync(providerSocketPath(fixture))).toBe(true);

      const after = await search(follower, workspaceId);
      expect(after.isError).toBe(false);
      expect(after.payload?.status).toBe('ok');
      expect(after.payload?.data?.items?.some((item) => item.file_path?.endsWith('math.ts'))).toBe(true);

      // The follower attached to the new generation without writing its own lock.
      const lockAfter = await readLock(fixture);
      expect(lockAfter?.pid).toBe(lockB?.pid);
      expect(lockAfter?.ownerId).toBe(lockB?.ownerId);
      expect(lockAfter?.startedAt).toBe(lockB?.startedAt);
      expect(lockAfter?.pid).not.toBe(follower.child.pid);
    },
    300_000,
  );

  it.skipIf(python === undefined || source === undefined)(
    'releases the read gate when the provider worker dies mid-index and lets a later read re-admit',
    async () => {
      const fixture = await createFixture(FILE_COUNT);
      const host = startHost(fixture);
      await waitFor(() => host.stderr().includes('Thai-RAG startup state=ready'), host, 'HTTP host ready');
      const workspaceId = await readWorkspaceId(fixture);

      const follower = startFollower(fixture);
      await waitFor(() => follower.stderr().includes('MCP stdio ready'), follower, 'stdio follower ready');
      await initialize(follower);

      // The first guarded read starts the cold admission index. Keep the request
      // in flight and kill the worker once the admission job is actually bound
      // to a provider job and polling `index_status`.
      const firstSearch = search(follower, workspaceId, 'area perimeter');
      const rows = await waitForJournal(
        fixture,
        host,
        'running admission job with provider id',
        (jobs) => jobs.some((job) => job.workspaceId === workspaceId
          && (job.status === 'running' || job.status === 'cancelling')
          && job.providerJobId !== undefined),
      );
      const running = rows.find((job) => job.workspaceId === workspaceId
        && (job.status === 'running' || job.status === 'cancelling')
        && job.providerJobId !== undefined);
      expect(running?.status).toMatch(/running|cancelling/);

      const workers = await providerWorkerPids(host.child.pid);
      expect(workers.length).toBeGreaterThan(0);
      for (const pid of workers) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }

      const failedSearch = await firstSearch;
      expect(failedSearch.isError).toBe(true);
      expect(failedSearch.text).toMatch(/connection closed|not connected|worker|provider|index/i);

      // The durable row must become terminal: that is the fact the read gate
      // re-proves before serving. A stuck `running` row would keep the gate.
      const terminal = await waitForJournal(
        fixture,
        host,
        'failed admission job',
        (jobs) => jobs.some((job) => job.jobId === running?.jobId
          && (job.status === 'failed' || job.status === 'interrupted')),
        60_000,
      );
      const failed = terminal.find((job) => job.jobId === running?.jobId);
      expect(failed?.status).toMatch(/failed|interrupted/);

      // Reads re-admit with a fresh worker and succeed without restarting the
      // runtime or the follower; the host keeps ownership throughout. The
      // re-admission index is allowed to gate reads while it runs (the cold
      // workspace has no active generation yet), but the gate must clear and
      // the read must eventually serve.
      const deadline = Date.now() + 180_000;
      let recovered: Awaited<ReturnType<typeof search>> | undefined;
      while (Date.now() < deadline) {
        const attempt = await search(follower, workspaceId, 'add function');
        if (!attempt.isError) {
          recovered = attempt;
          break;
        }
        expect(attempt.text).toMatch(/indexing started|workspace indexing is still running|workspace-indexing|not connected|connection closed/i);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      expect(recovered, 'search did not recover after the worker death').toBeDefined();
      expect(recovered?.payload?.status).toBe('ok');
      expect(recovered?.payload?.data?.items?.some((item) => item.file_path?.endsWith('math.ts'))).toBe(true);

      // Recovery came from a fresh admission job, not a revived failed row.
      const afterRows = await readJournal(fixture);
      expect(afterRows.some((job) => job.jobId !== running?.jobId)).toBe(true);

      const lock = await readLock(fixture);
      expect(lock?.pid).toBe(host.child.pid);
      expect(lock?.pid).not.toBe(follower.child.pid);
    },
    300_000,
  );

  it.skipIf(python === undefined || source === undefined)(
    'fails a hung index-status job at the configured deadline and re-admits reads',
    async () => {
      // The status deadline is the contract under test, so the host runs with
      // the shipped knobs tightened instead of the 30 x 30s default: three
      // consecutive 1.5s status timeouts must fail the mirrored job.
      const fixture = await createFixture(FILE_COUNT);
      const host = startHost(fixture, source, {
        UNIFIED_MPC_THAI_RAG_INDEX_STATUS_TIMEOUT_MS: '1500',
        UNIFIED_MPC_THAI_RAG_INDEX_STATUS_TIMEOUT_POLLS: '3',
      });
      await waitFor(() => host.stderr().includes('Thai-RAG startup state=ready'), host, 'HTTP host ready');
      const workspaceId = await readWorkspaceId(fixture);

      const follower = startFollower(fixture);
      await waitFor(() => follower.stderr().includes('MCP stdio ready'), follower, 'stdio follower ready');
      await initialize(follower);

      // The cold read starts the admission index; stop the worker right after
      // the provider job id is bound so the job is live but unanswerable.
      const firstSearch = search(follower, workspaceId, 'area perimeter');
      const rows = await waitForJournal(
        fixture,
        host,
        'running admission job with provider id',
        (jobs) => jobs.some((job) => job.workspaceId === workspaceId
          && (job.status === 'running' || job.status === 'cancelling')
          && job.providerJobId !== undefined),
      );
      const running = rows.find((job) => job.workspaceId === workspaceId
        && (job.status === 'running' || job.status === 'cancelling')
        && job.providerJobId !== undefined);

      const workers = await providerWorkerPids(host.child.pid);
      expect(workers.length).toBeGreaterThan(0);

      // A stopped worker cannot be reaped by the host, so every exit path must
      // release it before the suite tears the host down.
      const releaseWorkers = (signal: NodeJS.Signals): void => {
        for (const pid of workers) {
          try {
            process.kill(pid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      };

      try {
        releaseWorkers('SIGSTOP');
        // A worker that accepts the socket but never answers is the hung-call
        // case: every poll times out instead of failing fast. The foreground
        // read only waits INDEX_ADMISSION_WAIT_MS and reports the queued state;
        // the deadline is proven on the durable row below.
        const queued = await firstSearch;
        expect(queued.isError).toBe(true);
        expect(queued.text).toMatch(/indexing started|workspace indexing is still running|workspace-indexing/);

        // The durable row is terminal with the machine-readable reason, which
        // is exactly the fact the read gate re-proves before serving.
        const terminal = await waitForJournal(
          fixture,
          host,
          'deadline-failed admission job',
          (jobs) => jobs.some((job) => job.jobId === running?.jobId
            && job.status === 'failed'
            && (job.error ?? '').includes('index-status-unreachable')),
          60_000,
        );
        expect(terminal.find((job) => job.jobId === running?.jobId)?.error)
          .toMatch(/index-status-unreachable/);
      } finally {
        releaseWorkers('SIGKILL');
      }

      // The gate must clear without restarting the host or the follower: a
      // later read re-admits a fresh job and eventually serves.
      const deadline = Date.now() + 180_000;
      let recovered: Awaited<ReturnType<typeof search>> | undefined;
      while (Date.now() < deadline) {
        const attempt = await search(follower, workspaceId, 'add function');
        if (!attempt.isError) {
          recovered = attempt;
          break;
        }
        expect(attempt.text).toMatch(/indexing started|workspace indexing is still running|workspace-indexing|not connected|connection closed/i);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      expect(recovered, 'search did not recover after the status deadline').toBeDefined();
      expect(recovered?.payload?.status).toBe('ok');
      // The recovered read is a real lexical hit, not an empty success: code
      // indexing is FTS5-first and needs no embedding backend (#407 addendum).
      expect(recovered?.payload?.data?.items?.some((item) => item.file_path?.endsWith('math.ts'))).toBe(true);

      const afterRows = await readJournal(fixture);
      expect(afterRows.some((job) => job.jobId !== running?.jobId)).toBe(true);

      // Ownership never moved to the follower while the host was degraded.
      const lock = await readLock(fixture);
      expect(lock?.pid).toBe(host.child.pid);
      expect(lock?.pid).not.toBe(follower.child.pid);
    },
    300_000,
  );
});
