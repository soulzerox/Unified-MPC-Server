import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyThaiRagFd3WorkerChallenge } from './native-thai-rag-worker-challenge.js';
import { createThaiRagPrivateWorkerBootstrap } from './native-thai-rag-private-bootstrap.js';

// Independent Python worker PR #194 wire contract: 32 * b'k', 32 * b'x',
// owner 'unified-worker-1', generation 7, HMAC domain with three NUL separators.
const CHALLENGE = 'eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg';
const PROOF = '_YX5l17xp-Rh3wGCboZS6Ozud9Uy4n24TdDtPTuZA-o';
const KEY = Buffer.alloc(32, 107);
const OWNER = 'unified-worker-1';
const GENERATION = 7;
const BASE = {
  status: 'ok',
  strict_mode: true,
  challenge: CHALLENGE,
  owner_id: OWNER,
  authority_generation: GENERATION,
  proof: PROOF,
} as const;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const input = (response: unknown = BASE) => ({
  secret: KEY, ownerId: OWNER, authorityGeneration: GENERATION, challenge: CHALLENGE, response,
});

describe('strict Python FD3 worker challenge verifier', () => {
  it('accepts the independently signed Python wire contract golden vector', () => {
    expect(verifyThaiRagFd3WorkerChallenge(input())).toBe(true);
  });

  it('rejects forged worker identity, stale or wrong generation and altered response', () => {
    const altered: unknown[] = [
      { ...BASE, strict_mode: false }, { ...BASE, status: 'scope_denied' },
      { ...BASE, owner_id: 'attacker' }, { ...BASE, authority_generation: 8 },
      { ...BASE, challenge: Buffer.alloc(32, 121).toString('base64url') },
      { ...BASE, proof: 'a'.repeat(43) }, { ...BASE, proof: PROOF + '=' },
      { ...BASE, proof: null }, { ...BASE, secret_b64url: 'leak' },
      [], null, 3, 'plaintext',
    ];
    for (const response of altered) expect(verifyThaiRagFd3WorkerChallenge(input(response))).toBe(false);
    expect(verifyThaiRagFd3WorkerChallenge({ ...input(), ownerId: 'other-worker' })).toBe(false);
    expect(verifyThaiRagFd3WorkerChallenge({ ...input(), authorityGeneration: 8 })).toBe(false);
    expect(verifyThaiRagFd3WorkerChallenge({ ...input(), secret: Buffer.alloc(32, 44) })).toBe(false);
  });

  it('rejects malformed and noncanonical 32-byte challenges before verifying', () => {
    for (const challenge of ['', 'x', '0'.repeat(42) + '+', CHALLENGE + '=',
      Buffer.alloc(31, 120).toString('base64url'),
      Buffer.alloc(33, 120).toString('base64url'),
      '\uD83D\uDD25', 'a'.repeat(9000)]) {
      expect(verifyThaiRagFd3WorkerChallenge({ ...input(), challenge })).toBe(false);
    }
  });

  it('binds a new private FD3 worker bootstrap to its own secret and zeroizes on dispose', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'strict-worker-challenge-'));
    roots.push(root);
    const worker = await createThaiRagPrivateWorkerBootstrap({
      ownerId: OWNER, authorityGeneration: GENERATION,
      workspacesProvider: async () => [{ id: '14fc20d1-5836-4faf-aed6-0df6a9633a38', realRootPath: root }],
    });
    const payload = JSON.parse(worker.payload.toString('utf8')) as { secret_b64url: string };
    const secret = Buffer.from(payload.secret_b64url, 'base64url');
    const raw = randomBytes(32);
    const challenge = raw.toString('base64url');
    const mac = createHmac('sha256', secret)
      .update('thai-rag-worker-fd3-challenge-v1\0', 'utf8')
      .update(raw)
      .update(Buffer.from([0]))
      .update(OWNER, 'ascii')
      .update(Buffer.from([0]))
      .update(String(GENERATION), 'ascii')
      .digest('base64url');
    const response = { ...BASE, challenge, proof: mac };
    expect(worker.verifyWorkerChallenge(challenge, response)).toBe(true);
    expect(worker.verifyWorkerChallenge(challenge, { ...response, authority_generation: 8 })).toBe(false);
    worker.dispose();
    expect(worker.verifyWorkerChallenge(challenge, response)).toBe(false);
    expect(worker.payload.every(value => value === 0)).toBe(true);
  });

  it('rejects missing or weak key and malformed trusted authority inputs', () => {
    expect(verifyThaiRagFd3WorkerChallenge({ ...input(), secret: Buffer.alloc(1) })).toBe(false);
    expect(verifyThaiRagFd3WorkerChallenge({ ...input(), authorityGeneration: 0 })).toBe(false);
    expect(verifyThaiRagFd3WorkerChallenge({ ...input(), ownerId: 'unicode 🔥' })).toBe(false);
  });
});
