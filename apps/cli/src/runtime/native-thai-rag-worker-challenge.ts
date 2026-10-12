import { createHmac, timingSafeEqual } from 'node:crypto';

/** Python thai_rag.external_authority PR #194, separate from workspace-token MACs. */
const DOMAIN = 'thai-rag-worker-fd3-challenge-v1\0';
const RESPONSE_FIELDS = [
  'authority_generation', 'challenge', 'owner_id', 'proof', 'status', 'strict_mode',
].join(',');

export interface ThaiRagWorkerChallengeVerification {
  /** Only the trusted parent receives these ephemeral private FD3 credentials. */
  readonly secret: Uint8Array;
  readonly ownerId: string;
  readonly authorityGeneration: number;
  /** A fresh 32-byte host-generated random challenge, canonical base64url. */
  readonly challenge: string;
  /** Untrusted MCP tool result decoded from the Python worker. */
  readonly response: unknown;
}

/**
 * Validate the strict worker's private-FD3 HMAC challenge response.
 *
 * Pure verification only: the caller MUST generate a unique challenge for
 * every child connection, then refuse to expose the session if this is false.
 * This function does not enable strict mode, issue grants or open MCP sessions.
 */
export function verifyThaiRagFd3WorkerChallenge(
  input: ThaiRagWorkerChallengeVerification,
): boolean {
  try {
    if (!(input.secret instanceof Uint8Array) || input.secret.byteLength < 32
      || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.ownerId)
      || !Number.isSafeInteger(input.authorityGeneration) || input.authorityGeneration < 1
      || typeof input.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge)) return false;
    const challengeBytes = Buffer.from(input.challenge, 'base64url');
    if (challengeBytes.byteLength !== 32 || challengeBytes.toString('base64url') !== input.challenge) return false;
    if (input.response === null || typeof input.response !== 'object'
      || Array.isArray(input.response)) return false;
    const response = input.response as Record<string, unknown>;
    if (Object.keys(response).sort().join(',') !== RESPONSE_FIELDS
      || response.status !== 'ok' || response.strict_mode !== true
      || response.challenge !== input.challenge
      || response.owner_id !== input.ownerId
      || response.authority_generation !== input.authorityGeneration
      || typeof response.proof !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(response.proof)) return false;
    const actual = Buffer.from(response.proof, 'base64url');
    if (actual.byteLength !== 32 || actual.toString('base64url') !== response.proof) return false;
    const expected = createHmac('sha256', Buffer.from(input.secret))
      .update(DOMAIN, 'utf8')
      .update(challengeBytes)
      .update(Buffer.from([0]))
      .update(input.ownerId, 'ascii')
      .update(Buffer.from([0]))
      .update(String(input.authorityGeneration), 'ascii')
      .digest();
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
