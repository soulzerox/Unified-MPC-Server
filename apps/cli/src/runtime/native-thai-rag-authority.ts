import { createHmac, randomBytes } from 'node:crypto';

/**
 * Additive Unified issuer for the Python thai_rag.external_authority proof v1.
 *
 * This does NOT authorize a caller. Before issuing, a trusted parent must
 * independently verify current workspace membership and compute the canonical
 * real-root fingerprint. Never derive scope from untrusted caller arguments.
 * Worker verifier private-key bootstrap and strict-mode cutover remain separate.
 */
const DOMAIN = 'thai-rag-external-workspace-authority-v1\0';
const OPERATIONS = new Set<string>([
  'remember', 'remember_turn', 'recall', 'record_event', 'forget',
  'pre_edit_context', 'code_search', 'code_context', 'code_blast_radius',
  'code_index', 'adopt_legacy_index', 'index_status', 'cancel_index',
  'memory_reconcile', 'code_reconcile', 'health', 'version',
]);

export interface ThaiRagAuthorityIssueOptions {
  readonly secret: Uint8Array;
  readonly workspaceId: string;
  readonly operation: string;
  readonly ownerId: string;
  readonly authorityGeneration: number;
  readonly rootFingerprint: string;
  /** UTC Unix seconds from a trusted parent clock. */
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** If omitted, a fresh cryptographically random nonce is used. */
  readonly nonce?: string;
}

function denied(): never {
  throw new Error('thai_rag_authority_denied');
}

/**
 * Generates a one-use HMAC-SHA256 capability matching Python canonical JSON.
 * Only ASCII owner IDs are permitted, avoiding cross-language Unicode-JSON
 * escaping ambiguities. The key is never serialized into the token.
 */
export function issueThaiRagWorkspaceProof(input: ThaiRagAuthorityIssueOptions): string {
  if (!(input.secret instanceof Uint8Array) || input.secret.byteLength < 32) denied();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.workspaceId)) denied();
  if (!OPERATIONS.has(input.operation)) denied();
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.ownerId)) denied();
  if (!Number.isSafeInteger(input.authorityGeneration) || input.authorityGeneration < 1) denied();
  if (!/^sha256:[0-9a-f]{64}$/.test(input.rootFingerprint)) denied();
  if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) denied();
  if (!Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= input.issuedAt || input.expiresAt - input.issuedAt > 60) denied();
  const nonce = input.nonce ?? randomBytes(18).toString('base64url');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) denied();

  // Keys MUST remain in lexicographic order to match Python
  // json.dumps(asdict(claims), sort_keys=True, separators=(',', ':')).
  const payload = JSON.stringify({
    authority_generation: input.authorityGeneration,
    expires_at: input.expiresAt,
    issued_at: input.issuedAt,
    nonce,
    operation: input.operation,
    owner_id: input.ownerId,
    root_fingerprint: input.rootFingerprint,
    workspace_id: input.workspaceId,
  });
  const signature = createHmac('sha256', Buffer.from(input.secret))
    .update(DOMAIN, 'utf8')
    .update(payload, 'utf8')
    .digest('base64url');
  return Buffer.from(payload, 'utf8').toString('base64url') + '.' + signature;
}
