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
  /** Host-side: remove the secret and mark the lease revoked, idempotently. */
  revoke(leaseId: string, now: number): Promise<Result<void>>;
}

/**
 * Lease ids are charset-safe because the id becomes part of a SecretStore key.
 * The bound is 120, not 128: the key is `publish-<leaseId>` (8 characters of
 * prefix) and `SecretStore.normalizeKey` refuses a key longer than 128, so a
 * longer id would be accepted here and then fail inside the secret store.
 */
const PUBLISH_CREDENTIAL_LEASE_ID = /^[A-Za-z0-9._-]{1,120}$/u;
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
