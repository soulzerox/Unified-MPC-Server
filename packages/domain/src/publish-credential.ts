import { createHash } from 'node:crypto';
import type { Result } from './errors.js';
import { isPublishRemoteName } from './publish-approval.js';

/**
 * One host-owned credential lease for an approved publish (#297).
 *
 * A lease names exactly one remote, the HTTPS host set resolved from that
 * remote at grant time, and a short expiry. The secret itself never lives here:
 * it stays in the `SecretStore` under `publish-<leaseId>` and is released only
 * through `PublishCredentialPort.open` inside the host process.
 */
export interface PublishCredentialLease {
  readonly leaseId: string;
  readonly workspaceId: string;
  readonly remote: string;
  /** Resolved push targets at grant time: lowercase host plus optional non-default port. */
  readonly hosts: readonly string[];
  /** Operator-supplied Git username; never taken from a model tool call. */
  readonly username: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** The live secret plus the lease it belongs to. Never serialized into a tool result. */
export interface PublishCredentialMaterial {
  readonly lease: PublishCredentialLease;
  readonly secret: string;
}

/**
 * Host-side credential mediation port (#297). Every method is called by the
 * operator CLI or the descriptor responder, never by an MCP tool caller.
 */
export interface PublishCredentialPort {
  /** Host-side: store the operator secret for one lease. */
  grant(lease: PublishCredentialLease, secret: string): Promise<Result<void>>;
  /** Host-side: open one live lease. Unknown, revoked and expired leases answer null. */
  open(leaseId: string, now: number): Promise<Result<PublishCredentialMaterial | null>>;
  /**
   * Host-side: the newest live lease for one workspace and remote, if any. The
   * preflight and the approval use it to learn whether a credential exists for
   * this target without reading the secret; `open` still gates the value.
   */
  findLive(workspaceId: string, remote: string, now: number): Promise<Result<PublishCredentialLease | null>>;
  /** Host-side: remove the secret and mark the lease revoked, idempotently. */
  revoke(leaseId: string, now: number): Promise<Result<void>>;
}

/**
 * The fixed helper file name inside a deployment root (#297 §2). The guard
 * compares the real path of the helper an invocation installs to
 * `<deployment>/publish-credential-helper`, so the name is a contract, not a
 * configuration value.
 */
export const PUBLISH_CREDENTIAL_HELPER_NAME = 'publish-credential-helper';

/**
 * Why one Git invocation may install the host helper (#297 §4). The three modes
 * exist because three different Gits need the credential at three moments:
 *
 * - `diagnostic`: the pre-approval `ls-remote` that resolves default branches.
 * - `publish`: the push itself, tied to the receipt it consumed.
 * - `verify`: the post-push `ls-remote`, tied to the same receipt and to the
 *   nonce minted for the publish spawn that is still running.
 *
 * The mode is never a tool argument: only `GitService.publish` can mint one, and
 * the Git adapter keeps the one-shot nonce that makes it usable.
 */
export type PublishCredentialAuthorization =
  | {
    readonly kind: 'diagnostic';
    readonly lease: PublishCredentialLease;
  }
  | {
    readonly kind: 'publish';
    readonly lease: PublishCredentialLease;
    readonly approvalId: string;
    readonly spendNonce: string;
  }
  | {
    readonly kind: 'verify';
    readonly lease: PublishCredentialLease;
    readonly approvalId: string;
    readonly spendNonce: string;
  };

/**
 * Lease ids are charset-safe because the id becomes part of a SecretStore key.
 * The bound is 120, not 128: the key is `publish-<leaseId>` (8 characters of
 * prefix) and `SecretStore.normalizeKey` refuses a key longer than 128, so a
 * longer id would be accepted here and then fail inside the secret store.
 */
const PUBLISH_CREDENTIAL_LEASE_ID = /^[A-Za-z0-9._-]{1,120}$/u;
/** Approval ids and spend nonces are opaque, bounded, charset-safe tokens. */
const PUBLISH_CREDENTIAL_AUTHORIZATION_TOKEN = /^[A-Za-z0-9._-]{1,128}$/u;
const PUBLISH_CREDENTIAL_HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const PUBLISH_CREDENTIAL_PORT = /^[1-9][0-9]{0,4}$/u;
const MAX_PUBLISH_CREDENTIAL_SECRET = 8_192;

/** A lease id is charset-safe because it becomes part of a SecretStore key. */
export function isPublishCredentialLeaseId(value: unknown): value is string {
  return typeof value === 'string' && PUBLISH_CREDENTIAL_LEASE_ID.test(value);
}

/**
 * A credential target is a lowercase DNS host with an optional non-default
 * port. Bracketed IPv6, uppercase, empty labels, a trailing colon and an
 * out-of-range port are refused so the lease cannot name an ambiguous host.
 */
export function isPublishCredentialHost(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 259) return false;
  if (value !== value.toLowerCase()) return false;
  const separator = value.lastIndexOf(':');
  if (value.indexOf(':') !== separator) return false;
  const host = separator === -1 ? value : value.slice(0, separator);
  const port = separator === -1 ? undefined : value.slice(separator + 1);
  if (host.length === 0 || host.length > 253) return false;
  if (!host.split('.').every((label) => PUBLISH_CREDENTIAL_HOST_LABEL.test(label))) return false;
  if (port === undefined) return true;
  if (!PUBLISH_CREDENTIAL_PORT.test(port)) return false;
  return Number(port) <= 65_535;
}

/** Operator-supplied Git username: 1..256 characters and no control characters. */
export function isPublishCredentialUsername(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/** A single-line secret accepted by `SecretToolSecretStore`; never empty or whitespace-only. */
export function isPublishCredentialSecret(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= MAX_PUBLISH_CREDENTIAL_SECRET
    && !value.includes('\n')
    && !value.includes('\r');
}

/** A host clock value: non-negative safe integer milliseconds since the epoch. */
export function isPublishCredentialTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate one lease before it can reach the ledger or the SecretStore. The
 * remote reuses the publish remote-name rule, so a URL or option form is
 * refused even though grant resolves URLs separately.
 */
export function isValidPublishCredentialLease(lease: PublishCredentialLease): boolean {
  return isPublishCredentialLeaseId(lease.leaseId)
    && typeof lease.workspaceId === 'string'
    && lease.workspaceId.length > 0
    && lease.workspaceId.length <= 128
    && isPublishRemoteName(lease.remote)
    && Array.isArray(lease.hosts)
    && lease.hosts.length > 0
    && lease.hosts.every((host) => isPublishCredentialHost(host))
    && new Set(lease.hosts).size === lease.hosts.length
    && isPublishCredentialUsername(lease.username)
    && isPublishCredentialTimestamp(lease.createdAt)
    && isPublishCredentialTimestamp(lease.expiresAt)
    && lease.expiresAt > lease.createdAt;
}

/** Approval ids and spend nonces are opaque tokens, never URLs or paths. */
export function isPublishCredentialAuthorizationToken(value: unknown): value is string {
  return typeof value === 'string' && PUBLISH_CREDENTIAL_AUTHORIZATION_TOKEN.test(value);
}

/**
 * Shape-check an authorization before a Git child is allowed to install the
 * helper. A `publish` or `verify` authorization must name the receipt it belongs
 * to and the nonce minted for that spawn; `diagnostic` has neither because it
 * runs before a receipt exists.
 */
export function isPublishCredentialAuthorization(value: unknown): value is PublishCredentialAuthorization {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const lease = record.lease;
  if (typeof lease !== 'object' || lease === null) return false;
  if (!isValidPublishCredentialLease(lease as PublishCredentialLease)) return false;
  if (record.kind === 'diagnostic') return true;
  if (record.kind !== 'publish' && record.kind !== 'verify') return false;
  return isPublishCredentialAuthorizationToken(record.approvalId)
    && isPublishCredentialAuthorizationToken(record.spendNonce);
}

/**
 * Normalize one resolved push URL to the lease host shape: lowercase host plus a
 * non-default port, with `:443` dropped. Userinfo and path never reach the
 * comparison, so a URL carrying a token cannot make two hosts look equal.
 * Anything that is not an `https` URL with a plain DNS host answers null and is
 * refused by the caller.
 */
export function normalizePublishCredentialPushHost(target: unknown): string | null {
  if (typeof target !== 'string' || target.length === 0 || target.length > 4_096) return null;
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port === '' || parsed.port === '443' ? '' : `:${parsed.port}`;
  const normalized = `${host}${port}`;
  return isPublishCredentialHost(normalized) ? normalized : null;
}

const PUBLISH_CREDENTIAL_HOST_FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;

/**
 * The receipt's host binding (#297 §6): one stable digest of the resolved push
 * host set, so the receipt names *where* a credential may go without recording
 * a URL that could carry userinfo or a token. Hosts are normalized, deduplicated
 * and sorted first, so argument order and a trailing `:443` cannot change the
 * fingerprint. An empty set or a host that is not a credential target answers
 * null and the caller fails closed.
 */
export function fingerprintPublishCredentialHosts(hosts: readonly string[]): string | null {
  if (!Array.isArray(hosts) || hosts.length === 0) return null;
  const normalized = [...new Set(hosts)].sort();
  if (!normalized.every((host) => isPublishCredentialHost(host))) return null;
  return `sha256:${createHash('sha256').update(normalized.join('\n')).digest('hex')}`;
}

/** Shape of a stored receipt fingerprint; never a URL or a bare host. */
export function isPublishCredentialHostFingerprint(value: unknown): value is string {
  return typeof value === 'string' && PUBLISH_CREDENTIAL_HOST_FINGERPRINT.test(value);
}
