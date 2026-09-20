/* global process */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const entrypoint = path.join(root, 'apps', 'cli', 'dist', 'bin', 'mcp-http.js');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-runtime-smoke-'));
const workspace = path.join(temporaryRoot, 'workspace');
const dataRoot = path.join(temporaryRoot, 'data');
await mkdir(workspace, { recursive: true });

let child;
let stderr = '';
let settled = false;

try {
  child = spawn(process.execPath, [entrypoint], {
    cwd: root,
    env: {
      ...process.env,
      UNIFIED_MPC_WORKSPACE: workspace,
      UNIFIED_MPC_DATA_PATH: dataRoot,
      UNIFIED_MPC_PORT: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const earlyExit = new Promise((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (!settled) reject(new Error(`MCP HTTP runtime exited before identity became healthy (code=${code}, signal=${signal})\n${stderr}`));
    });
  });

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for MCP HTTP readiness.\n${stderr}`)), 20_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/Unified-MPC MCP HTTP ready endpoint=(http:\/\/127\.0\.0\.1:\d+\/mcp)/u);
      if (match === null) return;
      clearTimeout(timeout);
      resolve(new URL('/_unified-mpc/identity', match[1]));
    });
  });

  const identityUrl = await Promise.race([ready, earlyExit]);
  const response = await fetch(identityUrl, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Identity probe returned HTTP ${response.status}`);
  const identity = await response.json();
  if (identity?.service !== 'desktop-mcp' || identity?.protocol !== 1 || typeof identity?.version !== 'string') {
    throw new Error(`Unexpected identity payload: ${JSON.stringify(identity)}`);
  }
  settled = true;
  process.stdout.write(`MCP HTTP runtime smoke passed at ${identityUrl.href}; HTTP identity became healthy independently of Thai-RAG readiness.\n`);
} finally {
  settled = true;
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
