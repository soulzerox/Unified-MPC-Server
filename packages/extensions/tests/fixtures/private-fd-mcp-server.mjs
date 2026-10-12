import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const secretPayload = readFileSync(3, 'utf8'); // Linux inherited private pipe, not stdin/argv/env
const config = JSON.parse(secretPayload);
const secret = String(config.secret_b64url ?? '');
const matchesEnv = Object.values(process.env).some((value) => value?.includes(secret));
const matchesArgs = process.argv.some((value) => value.includes(secret));
if (process.env.THAI_RAG_EXTERNAL_AUTH_MODE !== 'strict'
  || process.env.THAI_RAG_EXTERNAL_AUTH_FD !== '3' || !secret
  || matchesEnv || matchesArgs) {
  process.exit(73);
}
let initialized = false;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'notifications/initialized') {
    initialized = true;
    continue;
  }
  if (message.id === undefined) continue;
  const response = { jsonrpc: '2.0', id: message.id };
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      ...response,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'private-fd-fixture', version: '1.0.0' },
      },
    }) + '\n');
    continue;
  }
  if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      ...response, result: { tools: [{
        name: 'bootstrap_probe',
        description: 'Exercise the real private FD worker',
        inputSchema: { type: 'object', properties: {} },
      }] },
    }) + '\n');
    continue;
  }
  if (message.method === 'tools/call' && message.params?.name === 'bootstrap_probe') {
    process.stdout.write(JSON.stringify({
      ...response, result: {
        content: [{ type: 'text', text: JSON.stringify({
          ready: initialized,
          fd: 3,
          strict: true,
          workspaceCount: Object.keys(config.workspace_roots ?? {}).length,
          leaked: matchesEnv || matchesArgs,
        }) }],
      },
    }) + '\n');
    continue;
  }
  process.stdout.write(JSON.stringify({
    ...response, error: { code: -32601, message: 'Unknown method' },
  }) + '\n');
}
