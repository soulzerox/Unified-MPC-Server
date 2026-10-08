import { readFileSync } from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';

const envelope = JSON.parse(readFileSync(3, 'utf8'));
const secret = Buffer.from(envelope.secret_b64url, 'base64url');
const usedNonces = new Set();
let accepted = 0;
function check(name, args) {
  const token = args.authority_proof;
  if (typeof token !== 'string' || token.split('.').length !== 2) return false;
  const [payloadBase64, signature] = token.split('.');
  const payload = Buffer.from(payloadBase64, 'base64url');
  const expected = createHmac('sha256', secret).update('thai-rag-external-workspace-authority-v1\0').update(payload).digest();
  const provided = Buffer.from(signature, 'base64url');
  if (provided.byteLength !== expected.byteLength || !timingSafeEqual(provided, expected)) return false;
  let claims;
  try { claims = JSON.parse(payload.toString('utf8')); } catch { return false; }
  if (claims.operation !== name || claims.workspace_id !== args.workspace_id ||
    claims.owner_id !== envelope.owner_id || claims.authority_generation !== envelope.authority_generation ||
    typeof claims.nonce !== 'string' || usedNonces.has(claims.nonce)) return false;
  const root = envelope.workspace_roots?.[args.workspace_id];
  if (!root || claims.root_fingerprint !== 'sha256:' + createHash('sha256').update(root).digest('hex')) return false;
  const now = Math.floor(Date.now() / 1000);
  if (!(claims.issued_at <= now && claims.expires_at > now && claims.expires_at - claims.issued_at <= 60)) return false;
  usedNonces.add(claims.nonce);
  return true;
}
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'private-authority-mcp-fixture', version: '1.0.0' },
    }); continue;
  }
  if (message.method === 'tools/list') {
    respond(message.id, { tools: ['health', 'version', 'remember', 'recall'].map(name => ({
      name, inputSchema: { type: 'object', additionalProperties: true },
    })) }); continue;
  }
  if (message.method === 'resources/list') { respond(message.id, { resources: [] }); continue; }
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (name === 'health' || name === 'version') {
      respond(message.id, { content: [{ type: 'text', text: JSON.stringify({ accepted, unscoped: true, proofReceived: Object.hasOwn(args, 'authority_proof') }) }] }); continue;
    }
    const valid = check(name, args);
    if (valid) accepted += 1;
    respond(message.id, { content: [{ type: 'text', text: JSON.stringify({ valid, accepted, operation: name }) }], isError: !valid });
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } }) + '\n');
}
