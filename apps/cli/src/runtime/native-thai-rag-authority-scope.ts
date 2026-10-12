import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { issueThaiRagWorkspaceProof } from './native-thai-rag-authority.js';

/**
 * Trusted host-owned authority state. NEVER construct this from caller args.
 * The provider must fetch the current workspace registry on every issue call.
 */
export interface ThaiRagTrustedAuthority {
  readonly secret: Uint8Array;
  readonly ownerId: string;
  readonly authorityGeneration: number;
  readonly workspacesProvider: () => Promise<readonly {
    readonly id: string;
    readonly realRootPath: string;
  }[]>;
  /** Host-owned clock and TTL; untrusted callers must never choose token times. */
  readonly clockSeconds?: () => number;
  readonly ttlSeconds?: number;
  /** Optional host-owned generator for deterministic contract tests. */
  readonly nonceFactory?: () => string;
}

/** Caller supplies only a scope and operation, not its authority or root. */
export interface ThaiRagRegisteredProofRequest {
  readonly workspaceId: string;
  readonly operation: string;
}

function denied(): never {
  throw new Error('thai_rag_authority_denied');
}

/**
 * Issue a signed proof only for exactly one LIVE registered workspace.
 *
 * Root fingerprint v1 = sha256(canonical realpath UTF-8 bytes). The Python
 * verifier must use the same trusted live root binding for revocations;
 * this issuer is not itself a replacement for Python ingress enforcement.
 *
 * This is an additive helper, not an active worker dispatch/cutover.
 */
export async function issueRegisteredThaiRagWorkspaceProof(
  authority: ThaiRagTrustedAuthority,
  request: ThaiRagRegisteredProofRequest,
): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.workspaceId)) {
    denied();
  }
  if (typeof authority.workspacesProvider !== 'function') denied();
  try {
    const workspaces = await authority.workspacesProvider();
    if (!Array.isArray(workspaces)) denied();
    const matches = workspaces.filter((workspace) => workspace.id === request.workspaceId);
    if (matches.length !== 1) denied();
    const registeredRoot = matches[0]!.realRootPath;
    if (typeof registeredRoot !== 'string' || !path.isAbsolute(registeredRoot)) denied();
    const root = path.resolve(registeredRoot);
    if (root === path.parse(root).root) denied();
    const canonicalRoot = await realpath(registeredRoot);
    if (canonicalRoot !== root || !(await stat(canonicalRoot)).isDirectory()) denied();

    const rootFingerprint = 'sha256:' + createHash('sha256').update(canonicalRoot, 'utf8').digest('hex');
    const issuedAt = authority.clockSeconds?.() ?? Math.floor(Date.now() / 1000);
    return issueThaiRagWorkspaceProof({
      secret: authority.secret,
      ownerId: authority.ownerId,
      authorityGeneration: authority.authorityGeneration,
      workspaceId: request.workspaceId,
      operation: request.operation,
      rootFingerprint,
      issuedAt,
      expiresAt: issuedAt + (authority.ttlSeconds ?? 30),
      ...(authority.nonceFactory === undefined ? {} : { nonce: authority.nonceFactory() }),
    });
  } catch {
    denied();
  }
}
