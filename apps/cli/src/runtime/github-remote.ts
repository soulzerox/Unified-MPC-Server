import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GITHUB_HOST = 'github.com';
const SSH_RESOLVE_TIMEOUT_MS = 10_000;
const SSH_RESOLVE_MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_REMOTE_CHARS = 2_048;
const MAX_HOST_CHARS = 255;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,253}[a-z0-9])?$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export interface GitRemoteCoordinates {
  readonly protocol: 'https' | 'ssh';
  readonly host: string;
  readonly repository: string;
}

/** Resolves an SSH host alias to the hostname SSH would actually connect to. */
export type SshHostnameResolver = (host: string) => Promise<string | undefined>;

/**
 * Parse the host and owner/repo coordinates of a Git remote URL.
 *
 * Only the URL shapes a Git remote actually uses are accepted: HTTPS and the
 * two SSH forms. Anything with an unexpected path, credentials in the URL or an
 * invalid host/owner/repo segment is rejected rather than guessed at.
 */
export function parseGitRemote(value: string): GitRemoteCoordinates | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REMOTE_CHARS) return undefined;
  const normalized = trimmed.replace(/\/+$/, '').replace(/\.git$/i, '');

  const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(normalized);
  if (match !== null) return coordinates('https', match);

  const sshUrl = /^ssh:\/\/git@([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+)$/i.exec(normalized);
  if (sshUrl !== null) return coordinates('ssh', sshUrl);

  const scp = /^git@([^/:]+):([^/]+)\/([^/]+)$/i.exec(normalized);
  return scp === null ? undefined : coordinates('ssh', scp);
}

/**
 * Return the GitHub owner/repo for a remote URL, or undefined when the remote
 * cannot be proven to belong to github.com.
 *
 * A canonical github.com host is accepted directly. Any other host must be an
 * SSH alias that `ssh -G` resolves to hostname github.com, so a lookalike host
 * or a broken SSH configuration fails closed instead of being trusted.
 */
export async function githubRepositoryFromRemote(
  value: string,
  resolveHostname: SshHostnameResolver = resolveSshHostname,
): Promise<string | undefined> {
  const parsed = parseGitRemote(value);
  if (parsed === undefined) return undefined;
  if (parsed.host === GITHUB_HOST) return parsed.repository;
  if (parsed.protocol !== 'ssh') return undefined;

  let hostname: string | undefined;
  try {
    hostname = await resolveHostname(parsed.host);
  } catch {
    return undefined;
  }
  if (hostname === undefined) return undefined;

  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (normalized.length > MAX_HOST_CHARS || !HOST_PATTERN.test(normalized)) return undefined;
  return normalized === GITHUB_HOST ? parsed.repository : undefined;
}

/** Resolve an SSH host alias without connecting, using the local SSH config. */
export async function resolveSshHostname(host: string): Promise<string | undefined> {
  if (host.length > MAX_HOST_CHARS || !HOST_PATTERN.test(host)) return undefined;
  try {
    const { stdout } = await execFileAsync('ssh', ['-G', host], {
      timeout: SSH_RESOLVE_TIMEOUT_MS,
      maxBuffer: SSH_RESOLVE_MAX_BUFFER_BYTES,
      encoding: 'utf8',
    });
    return sshHostnameFromConfig(stdout);
  } catch {
    return undefined;
  }
}

/** Read the effective `hostname` line from `ssh -G` output. */
export function sshHostnameFromConfig(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*hostname\s+(\S+)\s*$/i.exec(line);
    if (match !== null) return match[1];
  }
  return undefined;
}

function validSegment(value: string): boolean {
  return SEGMENT_PATTERN.test(value) && value !== '.' && value !== '..';
}

function coordinates(
  protocol: 'https' | 'ssh',
  match: RegExpExecArray,
): GitRemoteCoordinates | undefined {
  const host = (match[1] ?? '').toLowerCase();
  const owner = match[2] ?? '';
  const repo = match[3] ?? '';
  if (host.length > MAX_HOST_CHARS || !HOST_PATTERN.test(host)) return undefined;
  if (!validSegment(owner) || !validSegment(repo)) return undefined;
  return { protocol, host, repository: `${owner}/${repo}` };
}
