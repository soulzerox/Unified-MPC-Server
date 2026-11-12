/* global process */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = path.join(SCRIPT_DIR, 'smoke-materialized-runtime.mjs');

/**
 * The ports the smoke bound before #778: `18765` is the desktop runtime's MCP
 * port and `3000` its web port. The regression this test guards is exactly a
 * return to those values, so they are asserted against by name.
 */
const LEGACY_MCP_PORT = '18765';
const LEGACY_WEB_PORT = '3000';

const BUILD_COMMIT = 'a'.repeat(40);

/**
 * Minimal stand-in for a materialized release.
 *
 * The real release is produced by `pnpm deploy` and is far too heavy for the
 * merge gate, but the smoke only needs three things from it: clean provenance,
 * an MCP HTTP child that answers `/_unified-mpc/identity`, and a web child that
 * answers `/api/status`. Each fake child records the port it was asked to bind,
 * which is how the test proves the smoke reserved free ports instead of using
 * the live installation's.
 */
const FAKE_MCP = `/* global process */
const { appendFileSync, readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const path = require('node:path');

const provenance = JSON.parse(readFileSync(path.join(__dirname, '..', 'build-provenance.json'), 'utf8'));
const port = Number(process.env.UNIFIED_MPC_PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error('fake MCP child requires a positive UNIFIED_MPC_PORT, got ' + process.env.UNIFIED_MPC_PORT);
  process.exit(2);
}
appendFileSync(path.join(process.env.SMOKE_PORT_RECORD, 'ports.jsonl'), JSON.stringify({
  role: 'mcp',
  port,
  // The smoke must hand the release a throwaway machine, not the operator's
  // home (#777). Record what the child actually received so the test can
  // prove the redirect instead of trusting the helper's unit test.
  HOME: process.env.HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  UNIFIED_MPC_DATA_PATH: process.env.UNIFIED_MPC_DATA_PATH,
}) + '\\n');

const server = createServer((request, response) => {
  if (request.url === '/_unified-mpc/identity') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ buildCommit: provenance.buildCommit }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.on('error', (error) => {
  console.error('fake MCP child failed to bind ' + port + ': ' + error.message);
  process.exit(3);
});
server.listen(port, '127.0.0.1');
`;

const FAKE_WEB = `/* global fetch, process */
const { appendFileSync, readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const path = require('node:path');

const provenance = JSON.parse(readFileSync(path.join(__dirname, 'build-provenance.json'), 'utf8'));
const arguments_ = process.argv.slice(2);
const portIndex = arguments_.indexOf('--port');
const webPort = Number(arguments_[portIndex + 1]);
const mcpPort = Number(process.env.UNIFIED_MPC_PORT);
if (!Number.isInteger(webPort) || webPort <= 0) {
  console.error('fake web child requires --port <port>, got ' + arguments_.join(' '));
  process.exit(2);
}
if (!Number.isInteger(mcpPort) || mcpPort <= 0) {
  console.error('fake web child requires a positive UNIFIED_MPC_PORT, got ' + process.env.UNIFIED_MPC_PORT);
  process.exit(2);
}
appendFileSync(path.join(process.env.SMOKE_PORT_RECORD, 'ports.jsonl'), JSON.stringify({
  role: 'web',
  port: webPort,
  HOME: process.env.HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  UNIFIED_MPC_DATA_PATH: process.env.UNIFIED_MPC_DATA_PATH,
}) + '\\n');

const server = createServer(async (request, response) => {
  if (request.url !== '/api/status') {
    response.writeHead(404);
    response.end();
    return;
  }
  // Mirror the real control plane: it probes the MCP identity on its
  // configured gateway port, which is UNIFIED_MPC_PORT. If the smoke forgets to
  // forward the reserved MCP port, this probe cannot reach the release under
  // test and the status stays unhealthy.
  let payload;
  try {
    const identity = await (await fetch('http://127.0.0.1:' + mcpPort + '/_unified-mpc/identity')).json();
    payload = { status: 'healthy', mcpIdentity: { buildCommit: identity.buildCommit } };
  } catch (error) {
    payload = { status: 'unhealthy', error: String(error) };
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
});
server.on('error', (error) => {
  console.error('fake web child failed to bind ' + webPort + ': ' + error.message);
  process.exit(3);
});
server.listen(webPort, '127.0.0.1');
`;

async function createFakeRelease() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-fake-release-'));
  const cliDist = path.join(root, 'apps', 'cli', 'dist');
  await mkdir(path.join(cliDist, 'bin'), { recursive: true });
  await writeFile(
    path.join(cliDist, 'build-provenance.json'),
    JSON.stringify({ buildCommit: BUILD_COMMIT, buildDirty: false }),
  );
  await writeFile(path.join(cliDist, 'bin', 'mcp-http.js'), FAKE_MCP);
  await writeFile(path.join(cliDist, 'index.js'), FAKE_WEB);
  return root;
}

function runSmoke(releaseRoot, recordDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SMOKE, releaseRoot], {
      env: { ...process.env, SMOKE_PORT_RECORD: recordDirectory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    // 'close' fires after the stdio pipes drain, so the collected output holds
    // the whole transcript. 'exit' can fire while they are still draining.
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('the release smoke runs the artifact on a throwaway machine with reserved ports', async (t) => {
  const releaseRoot = await createFakeRelease();
  const recordDirectory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-smoke-ports-'));
  t.after(async () => {
    await rm(releaseRoot, { recursive: true, force: true });
    await rm(recordDirectory, { recursive: true, force: true });
  });

  const { code, output } = await runSmoke(releaseRoot, recordDirectory);
  assert.equal(code, 0, `the smoke must pass against a healthy release:\n${output}`);
  assert.match(output, new RegExp(`Materialized runtime restart smoke passed for ${BUILD_COMMIT}\\.`));

  const records = (await readFile(path.join(recordDirectory, 'ports.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const mcpPorts = records.filter((record) => record.role === 'mcp').map((record) => record.port);
  const webPorts = records.filter((record) => record.role === 'web').map((record) => record.port);

  // One record per child per cycle: two cycles, and a restart must reach both.
  assert.equal(mcpPorts.length, 2, `expected two MCP children, saw ${JSON.stringify(records)}`);
  assert.equal(webPorts.length, 2, `expected two web children, saw ${JSON.stringify(records)}`);
  // A restart reuses the same reserved ports, so a fixed port regression shows
  // up here even on a machine where those ports happen to be free.
  assert.deepEqual(new Set(mcpPorts).size, 1, 'MCP port must stay reserved across both cycles');
  assert.deepEqual(new Set(webPorts).size, 1, 'web port must stay reserved across both cycles');

  for (const port of mcpPorts) {
    assert.notEqual(String(port), LEGACY_MCP_PORT, 'the smoke must not bind the desktop MCP port');
  }
  for (const port of webPorts) {
    assert.notEqual(String(port), LEGACY_WEB_PORT, 'the smoke must not bind the desktop web port');
  }
  assert.notEqual(mcpPorts[0], webPorts[0], 'the two reserved ports must differ');

  // The other half of the same gate: #777 moved HOME and the XDG roots into the
  // throwaway root so the release sees a clean machine. Dropping that helper
  // would leave the ports test green, so assert on what the children received.
  const realHome = process.env.HOME;
  for (const record of records) {
    for (const key of ['HOME', 'XDG_DATA_HOME', 'UNIFIED_MPC_DATA_PATH']) {
      const value = record[key];
      assert.equal(typeof value, 'string', `${record.role} child must receive ${key}`);
      if (realHome !== undefined) {
        assert.notEqual(value, realHome, `${record.role} child must not inherit the operator HOME as ${key}`);
      }
      const relative = path.relative(os.tmpdir(), value);
      assert.equal(
        relative.startsWith('..') || path.isAbsolute(relative),
        false,
        `${record.role} child ${key} must stay inside a throwaway root, got ${value}`,
      );
    }
  }
  // One run uses one throwaway root for both cycles; a per-cycle root would be
  // a design change, so pin the invariant that matters: all four children see
  // the same throwaway machine, not the operator's.
  const homes = records.map((record) => record.HOME);
  assert.equal(new Set(homes).size, 1, 'every child of one smoke run must share its throwaway root');
});
