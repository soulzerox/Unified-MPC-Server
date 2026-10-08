import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrivateFdAuthorizedClientFactory } from './private-fd-authorized-client.js';

const fixture = fileURLToPath(new URL('../tests/fixtures/private-fd-authorized-mcp-server.mjs', import.meta.url));
const WS = '14fc20d1-5836-4faf-aed6-0df6a9633a38';
const OTHER = 'ee83c457-0b79-49d7-937e-5c35aa91975d';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function decode(result: unknown) {
  const r = result as { content: { text: string }[] };
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}
async function setup(reuseProof = false, revocationSignal?: AbortSignal) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'private-fd-authorized-session-'));
  roots.push(root);
  const allowed = new Set([WS]);
  const created: Array<{ payload: Buffer; disposed: boolean; issued: number; attested: number; challenges: string[] }> = [];
  const factory = createPrivateFdAuthorizedClientFactory({
    async createBootstrap() {
      const secret = randomBytes(32);
      let replayToken: string | undefined;
      const payload = Buffer.from(JSON.stringify({
        secret_b64url: secret.toString('base64url'),
        owner_id: 'unified-worker-1', authority_generation: 9,
        workspace_roots: { [WS]: root },
      }), 'utf8');
      const stats = { payload, disposed: false, issued: 0, attested: 0, challenges: [] as string[] };
      created.push(stats);
      return {
        payload,
        ...(revocationSignal === undefined ? {} : { revocationSignal }),
        async issue({ workspaceId, operation }: { workspaceId: string; operation: string }): Promise<string> {
          stats.issued += 1;
          if (!allowed.has(workspaceId)) throw new Error('scope_not_registered');
          const now = Math.floor(Date.now() / 1000);
          const claims = JSON.stringify({
            authority_generation: 9,
            expires_at: now + 30, issued_at: now,
            nonce: randomBytes(18).toString('base64url'),
            operation, owner_id: 'unified-worker-1',
            root_fingerprint: 'sha256:' + createHash('sha256').update(root).digest('hex'),
            workspace_id: workspaceId,
          });
          const token = Buffer.from(claims, 'utf8').toString('base64url') + '.' +
            createHmac('sha256', secret).update('thai-rag-external-workspace-authority-v1\0').update(claims).digest('base64url');
          if (reuseProof) return replayToken ??= token;
          return token;
        },
        async validateLiveBinding(): Promise<boolean> {
          return allowed.has(WS) && !stats.disposed;
        },
        verifyWorkerChallenge(challenge: string, response: unknown): boolean {
          stats.attested += 1;
          stats.challenges.push(challenge);
          if (stats.disposed || typeof response !== 'object' || response === null) return false;
          const r = response as Record<string, unknown>;
          const expected = createHmac('sha256', secret)
            .update('thai-rag-worker-fd3-challenge-v1\0')
            .update(Buffer.from(challenge, 'base64url'))
            .update(Buffer.from([0])).update('unified-worker-1').update(Buffer.from([0]))
            .update('9').digest('base64url');
          return r.status === 'ok' && r.strict_mode === true &&
            r.challenge === challenge && r.owner_id === 'unified-worker-1' &&
            r.authority_generation === 9 && r.proof === expected;
        },
        dispose() { stats.disposed = true; payload.fill(0); secret.fill(0); },
      };
    },
  });
  const launch = { command: process.execPath, args: [fixture] };
  return { factory, launch, allowed, created };
}

describe('private FD3 per-session authority MCP client', () => {
  it('uses actual inherited FD3 bootstrap and a fresh exact-operation workspace proof per call', async () => {
    const { factory, launch, created } = await setup();
    const session = await factory.connect(launch);
    try {
      expect((await session.listTools()).map(x => x.name)).toEqual(['health', 'version', 'remember', 'recall']);
      expect(decode(await session.callTool('health', {}))).toMatchObject({ accepted: 0, unscoped: true, proofReceived: false });
      expect(decode(await session.callTool('remember', { workspace_id: WS, content: 'first' }))).toMatchObject({ valid: true, accepted: 1 });
      expect(decode(await session.callTool('remember', { workspace_id: WS, content: 'second' }))).toMatchObject({ valid: true, accepted: 2 });
      expect(decode(await session.callTool('recall', { workspace_id: WS, query: 'first' }))).toMatchObject({ valid: true, accepted: 3 });
      expect(created[0]?.issued).toBe(3);
      expect(created[0]?.attested).toBe(1);
      expect(created[0]?.payload.every(b => b === 0)).toBe(true);
      expect(await session.listResources()).toEqual([]);
    } finally { await session.close(); }
    expect(created[0]?.disposed).toBe(true);
  }, 20_000);

  it('refuses forged workspace, missing workspace, fake authority_proof and unknown tool before IPC', async () => {
    const { factory, launch, created } = await setup();
    const session = await factory.connect(launch);
    try {
      await expect(session.callTool('remember', { workspace_id: OTHER, content: 'forged' })).rejects.toThrow('workspace_authority_denied');
      await expect(session.callTool('remember', { content: 'unscoped' })).rejects.toThrow('workspace_authority_denied');
      await expect(session.callTool('remember', { workspace_id: WS, content: 'attack', authority_proof: 'attacker' })).rejects.toThrow('workspace_authority_denied');
      await expect(session.callTool('not_registered', { workspace_id: WS })).rejects.toThrow('workspace_authority_denied');
      await expect(session.callTool('worker_authority_probe', { challenge: 'caller' })).rejects.toThrow('workspace_authority_denied');
      await expect(session.callTool('health', { authority_proof: 'attacker' })).rejects.toThrow('workspace_authority_denied');
      expect(decode(await session.callTool('health', {}))).toMatchObject({ accepted: 0, proofReceived: false });
      expect(created[0]?.issued).toBe(1); // only the foreign ID reaches trusted issuer; rejected there
    } finally { await session.close(); }
  }, 20_000);

  it('the actual worker rejects a replay if a buggy issuer reuses an operation proof', async () => {
    const { factory, launch } = await setup(true);
    const session = await factory.connect(launch);
    try {
      expect(decode(await session.callTool('remember', { workspace_id: WS }))).toMatchObject({ valid: true, accepted: 1 });
      expect(decode(await session.callTool('remember', { workspace_id: WS }))).toMatchObject({ valid: false, accepted: 1 });
    } finally { await session.close(); }
  }, 20_000);

  it('denies after live registry revocation, and a close disposes its private key', async () => {
    const { factory, launch, allowed, created } = await setup();
    const session = await factory.connect(launch);
    expect(decode(await session.callTool('remember', { workspace_id: WS }))).toMatchObject({ valid: true, accepted: 1 });
    allowed.delete(WS);
    await expect(session.callTool('remember', { workspace_id: WS })).rejects.toThrow('workspace_authority_denied');
    await expect(session.callTool('health', {})).rejects.toThrow('workspace_authority_denied');
    await session.close();
    await session.close();
    expect(created[0]?.disposed).toBe(true);
    await expect(session.callTool('remember', { workspace_id: WS })).rejects.toThrow('workspace_authority_denied');
  }, 20_000);

  it('proactively terminates the idle inherited-FD3 child on live registration loss', async () => {
    const { factory, launch, allowed, created } = await setup();
    const session = await factory.connect(launch);
    expect(created[0]?.disposed).toBe(false);
    allowed.delete(WS);
    await expect.poll(() => created[0]?.disposed, { timeout: 3_000, interval: 25 }).toBe(true);
    expect(created[0]?.payload.every(x => x === 0)).toBe(true);
    await expect(session.listTools()).rejects.toThrow('workspace_authority_denied');
    await expect(session.callTool('health', {})).rejects.toThrow('workspace_authority_denied');
    await session.close();
  }, 10_000);

  it('fences a live child synchronously on host-owned revocation, without waiting for polling', async () => {
    const controller = new AbortController();
    const { factory, launch, created } = await setup(false, controller.signal);
    const session = await factory.connect(launch);
    controller.abort();
    await expect(session.callTool('remember', { workspace_id: WS })).rejects.toThrow('workspace_authority_denied');
    await expect.poll(() => created[0]?.disposed, { timeout: 1_500, interval: 10 }).toBe(true);
    expect(created[0]?.issued).toBe(0);
    await expect(session.listTools()).rejects.toThrow('workspace_authority_denied');
    await session.close();
  }, 15_000);

  it('aborts an in-flight worker RPC on host revocation and never delivers its stale result', async () => {
    const controller = new AbortController();
    const { factory, launch, created } = await setup(false, controller.signal);
    const session = await factory.connect(launch);
    try {
      const pending = session.callTool('recall', { workspace_id: WS, delay_ms: 1000 });
      const rejected = expect(pending).rejects.toThrow();
      await new Promise(resolve => setTimeout(resolve, 80));
      controller.abort();
      await rejected;
      await expect(session.callTool('health', {})).rejects.toThrow('workspace_authority_denied');
      await expect.poll(() => created[0]?.disposed, { timeout: 1_500, interval: 10 }).toBe(true);
    } finally {
      await session.close();
    }
  }, 15_000);

  it('keeps every child connection isolated with independently generated bootstrap secrets', async () => {
    const { factory, launch, created } = await setup();
    const first = await factory.connect(launch);
    const second = await factory.connect(launch);
    try {
      expect(created).toHaveLength(2);
      expect(decode(await first.callTool('remember', { workspace_id: WS }))).toMatchObject({ valid: true, accepted: 1 });
      expect(decode(await second.callTool('remember', { workspace_id: WS }))).toMatchObject({ valid: true, accepted: 1 });
      expect(created.map(x => x.issued)).toEqual([1, 1]);
      expect(created.map(x => x.attested)).toEqual([1, 1]);
      expect(created[0]?.challenges[0]).not.toBe(created[1]?.challenges[0]);
    } finally { await Promise.all([first.close(), second.close()]); }
    expect(created.every(x => x.disposed)).toBe(true);
  }, 20_000);

  it.each(['missing', 'wrong-owner', 'wrong-epoch', 'bad-mac', 'stale', 'downgrade'])(
    'denies %s worker challenge and disposes the private key before returning a session',
    async mode => {
      const { factory, launch, created } = await setup();
      await expect(factory.connect({
        ...launch, env: { TEST_FD_CHALLENGE_MODE: mode },
      })).rejects.toThrow('workspace_authority_denied');
      expect(created).toHaveLength(1);
      expect(created[0]?.disposed).toBe(true);
      expect(created[0]?.payload.every(x => x === 0)).toBe(true);
      expect(created[0]?.issued).toBe(0);
    },
    15_000,
  );

  it('rejects network transports and cleans bootstrap when spawning its private worker fails', async () => {
    const { factory, launch, created } = await setup();
    await expect(factory.connect({ ...launch, type: 'http', url: 'https://example.org' } as never))
      .rejects.toThrow('workspace_authority_denied');
    expect(created).toHaveLength(0);
    await expect(factory.connect({ ...launch, command: '/does-not-exist-private-worker' }))
      .rejects.toThrow();
    expect(created).toHaveLength(1);
    expect(created[0]?.disposed).toBe(true);
    expect(created[0]?.payload.every(x => x === 0)).toBe(true);
  }, 20_000);
});
