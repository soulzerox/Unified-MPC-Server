import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'apps', 'cli', 'dist', 'index.js');
const runWebPath = path.join(repoRoot, 'apps', 'cli', 'dist', 'commands', 'web.js');
const storagePath = path.join(repoRoot, 'packages', 'storage', 'dist', 'index.js');
const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-issue61-restart-'));
const dataRoot = path.join(root, 'data');
const secretFile = path.join(root, 'secret-store.json');

try {
  await ensureBuild();
  await seedCanonicalState();
  await writeFile(secretFile, JSON.stringify({
    cloudflare_tunnel_token: 'persisted-runtime-token',
    cloudflare_api_token: 'persisted-api-token',
  }), 'utf8');

  const first = await startWebProcess();
  try {
    assertSnapshot(await readSnapshot(first.url));
  } finally {
    await stopChild(first.child);
  }

  await runCommand('corepack', ['pnpm', '--filter', '@unified-mpc/cli', 'build']);

  const second = await startWebProcess();
  try {
    assertSnapshot(await readSnapshot(second.url));
  } finally {
    await stopChild(second.child);
  }

  process.stdout.write('Issue #61 restart/rebuild persistence acceptance passed\n');
} finally {
  await rm(root, { recursive: true, force: true });
}

async function ensureBuild() {
  if (existsSync(cliPath) && existsSync(runWebPath) && existsSync(storagePath)) return;
  await runCommand('corepack', ['pnpm', '--filter', '@unified-mpc/cli', 'build']);
}

async function seedCanonicalState() {
  await mkdir(dataRoot, { recursive: true });
  const storage = await import(pathToFileURL(storagePath).href);
  const database = new storage.SqliteDatabase(path.join(dataRoot, 'unified-mpc.sqlite'));
  try {
    const settings = new storage.SqliteSettingsRepository(database);
    const values = {
      cloudflare_tunnel_name: 'restart-proof-tunnel',
      cloudflare_public_url: 'https://restart.example.test',
      mcp_allowed_hostnames: 'restart.example.test',
      mcp_allowed_origins: 'https://chatgpt.com',
      cloudflare_tunnel_token_configured: 'true',
      cloudflare_account_id: 'restart-account',
      cloudflare_zone_name: 'example.test',
      cloudflare_origin_url: 'http://127.0.0.1:18765',
      cloudflare_remote_tunnel_id: 'restart-remote-id',
      cloudflare_api_token_configured: 'true',
      cloudflare_gateway_desired_state: 'STOPPED',
    };
    for (const [key, value] of Object.entries(values)) settings.set(key, value);
  } finally {
    database.close();
  }
}

function childEnvironment() {
  return {
    ...process.env,
    HOME: path.join(root, 'home'),
    XDG_DATA_HOME: path.join(root, 'xdg'),
    UNIFIED_MPC_DATA_PATH: dataRoot,
    UNIFIED_MPC_TEST_SECRET_FILE: secretFile,
    UNIFIED_MPC_TEST_RUN_WEB_URL: pathToFileURL(runWebPath).href,
    UNIFIED_MPC_TEST_STORAGE_URL: pathToFileURL(storagePath).href,
  };
}

async function startWebProcess() {
  const childSource = `
    import { readFile, writeFile } from 'node:fs/promises';

    const secretFile = process.env.UNIFIED_MPC_TEST_SECRET_FILE;
    const { runWeb } = await import(process.env.UNIFIED_MPC_TEST_RUN_WEB_URL);
    const { SecretToolSecretStore } = await import(process.env.UNIFIED_MPC_TEST_STORAGE_URL);
    const readSecrets = async () => JSON.parse(await readFile(secretFile, 'utf8'));
    const writeSecrets = async (value) => writeFile(secretFile, JSON.stringify(value), 'utf8');
    const runSecretTool = async (args, input) => {
      const operation = args[0];
      const key = args.at(-1);
      const current = await readSecrets();
      if (operation === 'lookup') {
        if (!(key in current)) {
          throw Object.assign(new Error('secret-tool exited with code 1'), { secretToolExitCode: 1 });
        }
        return current[key];
      }
      if (operation === 'store') {
        current[key] = input;
        await writeSecrets(current);
        return '';
      }
      if (operation === 'clear') {
        delete current[key];
        await writeSecrets(current);
        return '';
      }
      throw new Error('unsupported secret-tool fixture operation');
    };
    const secretStore = new SecretToolSecretStore({ run: runSecretTool });

    const result = await runWeb({ port: 0 }, { secretStore });
    if (!result.ok) {
      process.stderr.write(result.error.message + '\\n');
      process.exit(1);
    }
    process.stdout.write('CONTROL_PLANE_URL=' + result.value.url + '\\n');
    process.on('SIGTERM', async () => {
      await result.value.handle.close();
      process.exit(0);
    });
  `;

  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: repoRoot,
    env: childEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for Web process. stdout=\${stdout} stderr=\${stderr}`));
    }, 20_000);

    const inspect = () => {
      const match = stdout.match(/CONTROL_PLANE_URL=(http:\/\/127\.0\.0\.1:\d+)/);
      if (!match?.[1]) return;
      clearTimeout(timeout);
      cleanup();
      resolve(match[1]);
    };
    const exited = (code, signal) => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error(`Web process exited before readiness (code=\${code}, signal=\${signal}). stdout=\${stdout} stderr=\${stderr}`));
    };
    const cleanup = () => {
      child.stdout.off('data', inspect);
      child.off('exit', exited);
    };

    child.stdout.on('data', inspect);
    child.once('exit', exited);
    inspect();
  });

  return { child, url };
}

async function readSnapshot(url) {
  const settingsResponse = await fetch(`${url}/api/settings`);
  assert.equal(settingsResponse.status, 200);
  const settingsText = await settingsResponse.text();
  assert.equal(settingsText.includes('persisted-runtime-token'), false);
  assert.equal(settingsText.includes('persisted-api-token'), false);

  const diagnosticsResponse = await fetch(`${url}/api/storage-diagnostics`);
  assert.equal(diagnosticsResponse.status, 200);
  const diagnosticsText = await diagnosticsResponse.text();
  assert.equal(diagnosticsText.includes('persisted-runtime-token'), false);
  assert.equal(diagnosticsText.includes('persisted-api-token'), false);

  return {
    settings: JSON.parse(settingsText),
    diagnostics: JSON.parse(diagnosticsText),
  };
}

function assertSnapshot(snapshot) {
  assert.deepEqual(snapshot.settings, {
    settings: {
      tunnelName: 'restart-proof-tunnel',
      publicUrl: 'https://restart.example.test',
      allowedHostnames: ['restart.example.test'],
      allowedOrigins: ['https://chatgpt.com'],
      tunnelTokenConfigured: true,
      accountId: 'restart-account',
      zoneName: 'example.test',
      originUrl: 'http://127.0.0.1:18765',
      remoteTunnelId: 'restart-remote-id',
      cloudflareApiTokenConfigured: true,
    },
    persistence: {
      state: 'loaded',
      nonSecretConfigured: true,
      tunnelToken: { configured: true, present: true },
      apiToken: { configured: true, present: true },
    },
  });

  assert.equal(snapshot.diagnostics.available, true);
  assert.equal(snapshot.diagnostics.scope, 'control-plane-storage');
  assert.equal(snapshot.diagnostics.diagnostics.dataRoot, dataRoot);
  assert.equal(snapshot.diagnostics.diagnostics.sqlite.path, path.join(dataRoot, 'unified-mpc.sqlite'));
  assert.equal(snapshot.diagnostics.diagnostics.sqlite.exists, true);
  assert.equal(snapshot.diagnostics.diagnostics.sqlite.keyPresence.cloudflare_public_url, true);
  assert.equal(snapshot.diagnostics.diagnostics.sqlite.keyPresence.cloudflare_tunnel_token_configured, true);
  assert.equal(snapshot.diagnostics.diagnostics.sqlite.keyPresence.cloudflare_api_token_configured, true);
  assert.deepEqual(snapshot.diagnostics.diagnostics.secretService, {
    provider: 'linux-secret-service',
    service: 'unified-mpc',
    available: true,
    secretPresence: {
      cloudflare_tunnel_token: true,
      cloudflare_api_token: true,
    },
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, 3_000)),
  ]);
}

async function runCommand(executable, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${executable} ${args.join(' ')} failed (code=\${code}, signal=\${signal}). stdout=\${stdout} stderr=\${stderr}`));
    });
  });
}
