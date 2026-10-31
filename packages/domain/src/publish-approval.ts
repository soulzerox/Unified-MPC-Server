/**
 * Lifecycle of one exact publish approval binding (#297), as reported by a
 * read-only diagnostic. `pending` means an unexpired, unconsumed receipt exists
 * for this workspace/remote/branch/SHA; it is never authority by itself, because
 * only the publish path may spend a receipt.
 */
export type PublishApprovalState = 'missing' | 'pending' | 'expired' | 'consumed';

export interface PublishApprovalBinding {
  readonly workspaceId: string;
  readonly remote: string;
  readonly branch: string;
  readonly expectedSha: string;
}

/** Read-only lookup for diagnostics and preflight. A failed lookup is not an approval. */
export interface PublishApprovalLookupPort {
  inspect(binding: PublishApprovalBinding, now: number): Promise<PublishApprovalState>;
  /**
   * The stored receipt, when the ledger can answer. The publish path uses it to
   * learn the credential binding the human approved; a receipt that cannot be
   * read is treated as credential-free and still has to be spent.
   */
  read?(approvalId: string): Promise<PublishApprovalRecord | null>;
}

/**
 * One single-use publish capability (#297). Bound to one workspace, remote,
 * branch and exact commit; minting is a human-confirmed action, and the publish
 * path spends it before it spawns Git.
 */
export interface PublishApprovalRecord extends PublishApprovalBinding {
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly approvedAt: number;
  readonly expiresAt: number;
  /**
   * The resolved push-host fingerprint the human approved (#297 §6). Present
   * only on a credential-bound receipt: the publish path re-resolves the push
   * URLs and refuses with `publish-target-changed` when they differ, so
   * rewriting `remote.<name>.url` cannot redirect the lease.
   */
  readonly pushUrlFingerprint?: string;
  /**
   * The live lease this receipt may spend. Absent on a credential-free receipt,
   * and a receipt naming a lease that is no longer live publishes nothing.
   */
  readonly leaseId?: string;
}

/**
 * Authority side of the ledger: mint and spend. Kept apart from the read-only
 * lookup so a diagnostic can hold the lookup alone and never gain authority.
 */
export interface PublishApprovalAuthorityPort {
  /** Idempotent per exact binding; never rewinds a consumed receipt. */
  record(record: PublishApprovalRecord): Promise<boolean>;
  /** Transaction-scoped spend: true only when this exact binding was live and is now consumed. */
  consume(approvalId: string, binding: PublishApprovalBinding, now: number): Promise<boolean>;
}

/** Same shape the Git adapter accepts for a remote name; no URL or option form. */
const PUBLISH_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PUBLISH_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function hasControlOrSpace(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A publish remote is a configured remote name. URLs, paths, scp-like forms and
 * option-like strings are refused, so the ledger and the publish path can only
 * address a remote the workspace already knows.
 */
export function isPublishRemoteName(value: unknown): value is string {
  return typeof value === 'string' && PUBLISH_REMOTE_NAME.test(value);
}

/** A plain branch name: no whitespace, traversal segment, option form or ref lock suffix. */
export function isPublishBranchName(value: unknown): value is string {
  return bounded(value, 256)
    && !hasControlOrSpace(value)
    && !value.includes('..')
    && !value.includes('@{')
    && !value.startsWith('-')
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.endsWith('.')
    && !value.endsWith('.lock')
    && !value.includes('//');
}

/** An exact commit id: full 40 or 64 lowercase hex characters, never an abbreviation or ref. */
export function isPublishObjectId(value: unknown): value is string {
  return typeof value === 'string' && PUBLISH_OBJECT_ID.test(value);
}

/** Validate a binding before it can reach the ledger or the Git child. */
export function isValidPublishBinding(binding: PublishApprovalBinding): boolean {
  return bounded(binding.workspaceId, 128)
    && isPublishRemoteName(binding.remote)
    && isPublishBranchName(binding.branch)
    && isPublishObjectId(binding.expectedSha);
}
