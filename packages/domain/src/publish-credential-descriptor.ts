import { isPublishCredentialHost, isPublishCredentialLeaseId, isPublishCredentialSecret, isPublishCredentialTimestamp, isPublishCredentialUsername } from './publish-credential.js';

/**
 * The wire contract between the host process and `<deployment>/publish-credential-helper`
 * (#297 §3). The helper is a dumb reader: it receives one descriptor answer on
 * an inherited pipe, validates it against the prompt Git handed it, and prints
 * the credential block. Nothing here is reachable from a tool caller, and no
 * part of it carries a secret in argv, the environment or a log.
 */

/** The lease id the adapter put on this spawn; never a caller-supplied value. */
export const PUBLISH_CREDENTIAL_LEASE_ID_ENV = 'UNIFIED_PUBLISH_LEASE_ID';

/** The inherited, readable pipe the host writes one descriptor answer to. */
export const PUBLISH_CREDENTIAL_DESCRIPTOR_FD_ENV = 'UNIFIED_PUBLISH_CREDENTIAL_FD';

/**
 * Both directions are bounded so a hostile or stalled peer cannot make the
 * helper buffer without limit. A descriptor answer is a few hundred bytes; a
 * Git prompt is smaller still.
 */
export const PUBLISH_CREDENTIAL_PROMPT_MAX_BYTES = 65_536;
export const PUBLISH_CREDENTIAL_DESCRIPTOR_MAX_BYTES = 65_536;

/** The descriptor starts at 3; fds 0..2 are the helper's own stdio. */
const PUBLISH_CREDENTIAL_DESCRIPTOR_FD = /^[1-9][0-9]{0,3}$/u;

/**
 * One descriptor answer: everything the helper needs to answer exactly one
 * `get`, and nothing it could use to reach the ledger or the SecretStore.
 * `hosts` and `expiresAt` are repeated from the lease so the helper can refuse
 * a forged prompt itself instead of trusting the prompt alone.
 */
export interface PublishCredentialDescriptorAnswer {
  readonly version: 1;
  readonly leaseId: string;
  readonly username: string;
  readonly secret: string;
  readonly hosts: readonly string[];
  readonly expiresAt: number;
}

/**
 * The subset of a Git credential prompt the helper reads (#297 §3). `path` is
 * carried for faithfulness to Git's format but never decides an answer: the
 * lease is host-scoped, and Git only sends `path` when `credential.useHttpPath`
 * is enabled, so matching on it would refuse legitimate prompts.
 */
export interface PublishCredentialPrompt {
  readonly protocol: string;
  readonly host: string;
  readonly path: string | null;
}

/** A descriptor fd is a small, non-stdio integer; anything else fails closed. */
export function parsePublishCredentialDescriptorFd(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!PUBLISH_CREDENTIAL_DESCRIPTOR_FD.test(trimmed)) return null;
  const fd = Number(trimmed);
  return fd >= 3 ? fd : null;
}

/**
 * Parse the `key=value` block Git writes on the helper's stdin. Only the first
 * occurrence of a key counts, unknown keys (`username`, `password`, `url`,
 * `wwwauth[]`) are ignored, and a block with no `protocol` or no `host` is not a
 * usable prompt. The value is never echoed or logged.
 */
export function parsePublishCredentialPrompt(text: unknown): PublishCredentialPrompt | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (Buffer.byteLength(text, 'utf8') > PUBLISH_CREDENTIAL_PROMPT_MAX_BYTES) return null;
  const values = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) break;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (key.length === 0 || values.has(key)) continue;
    values.set(key, line.slice(separator + 1));
  }
  const protocol = values.get('protocol');
  const host = values.get('host');
  if (protocol === undefined || host === undefined) return null;
  return { protocol: protocol.trim().toLowerCase(), host, path: values.get('path') ?? null };
}

/**
 * Git puts a non-default port in `host`, so the lease matches on the same shape
 * `grant` stored: lowercased, with the default HTTPS port dropped. A bracketed
 * IPv6 literal or an ambiguous host is not a credential target and answers null.
 */
export function normalizePublishCredentialPromptHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  if (host.length === 0) return null;
  const normalized = host.endsWith(':443') ? host.slice(0, -4) : host;
  return isPublishCredentialHost(normalized) ? normalized : null;
}

/** One descriptor answer is one JSON line; the host closes the pipe afterwards. */
export function serializePublishCredentialDescriptorAnswer(answer: PublishCredentialDescriptorAnswer): string {
  return `${JSON.stringify({
    version: answer.version,
    leaseId: answer.leaseId,
    username: answer.username,
    secret: answer.secret,
    hosts: [...answer.hosts],
    expiresAt: answer.expiresAt,
  })}\n`;
}

/**
 * Validate an answer before it can become a credential block. The helper treats
 * every failure the same way it treats a missing descriptor: exit 1, no output.
 */
export function parsePublishCredentialDescriptorAnswer(text: unknown): PublishCredentialDescriptorAnswer | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  if (Buffer.byteLength(text, 'utf8') > PUBLISH_CREDENTIAL_DESCRIPTOR_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (!isPublishCredentialLeaseId(record.leaseId)) return null;
  if (!isPublishCredentialUsername(record.username)) return null;
  if (!isPublishCredentialSecret(record.secret)) return null;
  if (!isPublishCredentialTimestamp(record.expiresAt)) return null;
  const hosts = record.hosts;
  if (!Array.isArray(hosts) || hosts.length === 0) return null;
  if (!hosts.every((host) => isPublishCredentialHost(host))) return null;
  if (new Set(hosts).size !== hosts.length) return null;
  return {
    version: 1,
    leaseId: record.leaseId,
    username: record.username,
    secret: record.secret,
    hosts: hosts as readonly string[],
    expiresAt: record.expiresAt,
  };
}

/**
 * The one place the secret leaves the server: a Git credential block on stdout.
 * Both values are validated first, because a newline in either would let the
 * secret value forge an extra attribute line.
 */
export function formatPublishCredentialBlock(username: unknown, secret: unknown): string | null {
  if (!isPublishCredentialUsername(username)) return null;
  if (!isPublishCredentialSecret(secret)) return null;
  return `username=${username}\npassword=${secret}\n`;
}
