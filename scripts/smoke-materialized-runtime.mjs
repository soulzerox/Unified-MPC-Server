/* global process, fetch, AbortSignal, setTimeout */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const releaseArgument = process.argv[2];
if (releaseArgument === undefined || releaseArgument.length === 0) {
  throw new Error('usage: smoke-materialized-runtime.mjs <release-root>');
}
const releaseRoot = path.resolve(releaseArgument);

const provenancePath = path.join(releaseRoot, 'apps', 'cli', 'dist', 'build-provenance.json');
const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
if (typeof provenance.buildCommit !== 'string' || provenance.buildDirty !== false) {
  throw new Error('Materialized runtime provenance must be clean and include buildCommit');
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-portable-release-'));
const workspace = path.join(temporaryRoot, 'workspace');
const dataRoot = path.join(temporaryRoot, 'data');
await mkdir(workspace, { recursive: true });

const baseEnv = {
  ...process.env,
  NODE_ENV: 'production',
  UNIFIED_MPC_WORKSPACE: workspace,
  UNIFIED_MPC_DATA_PATH: dataRoot,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJson(url, predicate, label) {
  const deadline = Date.now() + 30_000;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const value = await response.json();
        if (predicate(value)) return value;
        lastError = `unexpected payload: ${JSON.stringify(value)}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`${label} did not become healthy: ${lastError}`);
}

function start(command, args, env) {
  const child = spawn(command, args, {
    cwd: temporaryRoot,
    env: { ...baseEnv, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function stop(runtime) {
  if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) return;
  runtime.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => runtime.child.once('exit', resolve)),
    sleep(5_000),
  ]);
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill('SIGKILL');
}

async function verifyCycle(cycle) {
  const mcpEntrypoint = path.join(releaseRoot, 'apps', 'cli', 'dist', 'bin', 'mcp-http.js');
  const cliEntrypoint = path.join(releaseRoot, 'apps', 'cli', 'dist', 'index.js');

  const mcp = start(process.execPath, [mcpEntrypoint], { UNIFIED_MPC_PORT: '18765' });
  let web;
  try {
    await waitForJson(
      'http://127.0.0.1:18765/_unified-mpc/identity',
      (value) => value?.buildCommit === provenance.buildCommit,
      `MCP identity cycle ${cycle}`,
    );
    web = start(process.execPath, [cliEntrypoint, 'web', '--port', '3000'], {});
    await waitForJson(
      'http://127.0.0.1:3000/api/status',
      (value) => value?.status === 'healthy' && value?.mcpIdentity?.buildCommit === provenance.buildCommit,
      `Web status cycle ${cycle}`,
    );
  } catch (error) {
    const details = [mcp.output(), web?.output() ?? ''].filter(Boolean).join('\n');
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${details}`);
  } finally {
    if (web !== undefined) await stop(web);
    await stop(mcp);
  }
}

try {
  await verifyCycle(1);
  await verifyCycle(2);
  process.stdout.write(`Materialized runtime restart smoke passed for ${provenance.buildCommit}.\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
