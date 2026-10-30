import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  appError,
  err,
  isPublishCredentialHost,
  isPublishCredentialLeaseId,
  isPublishCredentialUsername,
  isPublishRemoteName,
  ok,
  type AppError,
  type PublishCredentialLease,
  type PublishCredentialPort,
  type Result,
} from '@unified-mpc/domain';

const execFileAsync = promisify(execFile);
const USAGE = 'Usage: unified-mpc publish-credential grant <remote> --workspace <id> --username <user> --ttl <seconds>'
  + ' | revoke <leaseId> | status <leaseId>';
const MAX_SECRET_BYTES = 8_192;

export type PublishCredentialCommand =
  | {
    readonly kind: 'publish-credential-grant';
    readonly remote: string;
    readonly workspaceReference: string;
    readonly username: string;
    readonly ttlSeconds: number;
  }
  | { readonly kind: 'publish-credential-revoke'; readonly leaseId: string }
  | { readonly kind: 'publish-credential-status'; readonly leaseId: string };

export interface PublishCredentialWorkspace {
  readonly id: string;
  readonly rootPath: string;
}

/**
 * Where the running CLI lives. Credential targets require a promoted release:
 * a canonical checkout is the agent-writable development tree, so a helper
 * file there could be rewritten by the model and still pass a mode check
 * (#297 §2). Anything the resolver cannot prove is a release is refused.
 */
export interface PublishCredentialDeployment {
  readonly promoted: boolean;
  readonly root: string | null;
  readonly reason: 'promoted-release' | 'canonical-checkout' | 'runtime-root-unset';
}

export interface PublishCredentialDeploymentOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runtimeDir?: string;
  readonly homeDir?: string;
  readonly resolveRealPath?: (target: string) => Promise<string>;
}

/** Metadata-only status answer; never carries the secret. */
export interface PublishCredentialInspection {
  readonly lease: PublishCredentialLease;
  readonly revokedAt: number | null;
}

/** Everything the command needs, injected so tests never spawn Git or touch Secret Service. */
export interface PublishCredentialCommandRunner {
  readonly credential: PublishCredentialPort;
  readonly resolveWorkspace: (workspaceReference: string) => Promise<Result<PublishCredentialWorkspace>>;
  readonly resolvePushUrls: (workspaceRoot: string, remote: string) => Promise<Result<readonly string[]>>;
  readonly readSecret: () => Promise<Result<string>>;
  readonly resolveDeployment: () => Promise<Result<PublishCredentialDeployment>>;
  readonly now?: () => number;
  readonly createLeaseId?: () => string;
  readonly inspect?: (leaseId: string) => Promise<Result<PublishCredentialInspection | null>>;
}

/**
 * Classify the running deployment. `UNIFIED_MPC_ROOT` is the documented
 * production runtime identity: the stable `runtime/current` pointer resolves to
 * `runtime/releases/<deployment-id>`, and only that exact shape is a promoted
 * release. An unset, relative or unresolvable root is not proof of a release, so
 * it fails closed.
 */
export async function resolvePublishCredentialDeployment(
  options: PublishCredentialDeploymentOptions = {},
): Promise<PublishCredentialDeployment> {
  const env = options.env ?? process.env;
  const configured = env.UNIFIED_MPC_ROOT?.trim() ?? '';
  if (!path.isAbsolute(configured)) {
    return { promoted: false, root: null, reason: 'runtime-root-unset' };
  }
  const dataHome = env.XDG_DATA_HOME ?? path.join(options.homeDir ?? os.homedir(), '.local', 'share');
  const runtimeDir = path.resolve(
    options.runtimeDir ?? env.UNIFIED_MPC_RUNTIME_DIR ?? path.join(dataHome, 'unified-mpc', 'runtime'),
  );
  let root: string;
  try {
    root = await (options.resolveRealPath ?? realpath)(configured);
  } catch {
    return { promoted: false, root: null, reason: 'runtime-root-unset' };
  }
  const relative = path.relative(path.join(runtimeDir, 'releases'), root);
  const promoted = relative.length > 0
    && !relative.startsWith('..')
    && !path.isAbsolute(relative)
    && !relative.includes(path.sep);
  return { promoted, root, reason: promoted ? 'promoted-release' : 'canonical-checkout' };
}

export function parsePublishCredentialArgs(args: readonly string[]): Result<PublishCredentialCommand> {
  const subcommand = args[0];
  if (subcommand === 'revoke' || subcommand === 'status') {
    const leaseId = args[1]?.trim();
    if (args.length !== 2 || leaseId === undefined || !isPublishCredentialLeaseId(leaseId)) {
      return err(appError('INVALID_INPUT', USAGE));
    }
    return ok({
      kind: subcommand === 'revoke' ? 'publish-credential-revoke' : 'publish-credential-status',
      leaseId,
    });
  }
  if (subcommand !== 'grant') return err(appError('INVALID_INPUT', USAGE));

  const remote = args[1]?.trim();
  if (remote === undefined || !isPublishRemoteName(remote)) {
    return err(appError('INVALID_INPUT', 'A configured remote name is required', false, {
      reason: 'publish-credential-invalid',
    }));
  }

  let workspaceReference: string | undefined;
  let username: string | undefined;
  let ttlSeconds: number | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === '--workspace' && value !== undefined && workspaceReference === undefined) {
      workspaceReference = value.trim();
      index += 1;
    } else if (flag === '--username' && value !== undefined && username === undefined) {
      username = value;
      index += 1;
    } else if (flag === '--ttl' && value !== undefined && ttlSeconds === undefined) {
      ttlSeconds = parseTtlSeconds(value);
      if (ttlSeconds === undefined) return err(appError('INVALID_INPUT', 'TTL must be a positive whole number of seconds'));
      index += 1;
    } else {
      return err(appError('INVALID_INPUT', USAGE));
    }
  }
  if (workspaceReference === undefined || workspaceReference.length === 0
    || username === undefined || ttlSeconds === undefined) {
    return err(appError('INVALID_INPUT', USAGE));
  }
  if (!isPublishCredentialUsername(username)) {
    return err(appError('INVALID_INPUT', 'Username must be 1..256 characters with no control characters'));
  }
  return ok({ kind: 'publish-credential-grant', remote, workspaceReference, username, ttlSeconds });
}

export async function runPublishCredentialCommand(
  command: PublishCredentialCommand,
  runner: PublishCredentialCommandRunner,
  write: (text: string) => void,
  writeError: (text: string) => void,
): Promise<number> {
  switch (command.kind) {
    case 'publish-credential-grant':
      return runGrant(command, runner, write, writeError);
    case 'publish-credential-revoke':
      return runRevoke(command.leaseId, runner, write, writeError);
    case 'publish-credential-status':
      return runStatus(command.leaseId, runner, write, writeError);
  }
}

/** Resolve every push URL of one remote without a shell and without contacting the network. */
export async function resolveGitPushUrls(workspaceRoot: string, remote: string): Promise<Result<readonly string[]>> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', '--push', '--all', remote], {
      cwd: workspaceRoot,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      shell: false,
    });
    return ok(stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0));
  } catch {
    return err(appError('INVALID_INPUT', 'The remote push URL could not be resolved', true, {
      reason: 'push-target-unresolved',
    }));
  }
}

/**
 * Read the operator secret from stdin only. A TTY is put in raw mode so the
 * value is never echoed; a pipe is consumed to EOF. The secret is never read
 * from argv or an environment variable.
 */
export async function readPublishCredentialSecret(
  stream: NodeJS.ReadStream = process.stdin,
): Promise<Result<string>> {
  return stream.isTTY ? readSecretFromTerminal(stream) : readSecretFromPipe(stream);
}

async function runGrant(
  command: Extract<PublishCredentialCommand, { kind: 'publish-credential-grant' }>,
  runner: PublishCredentialCommandRunner,
  write: (text: string) => void,
  writeError: (text: string) => void,
): Promise<number> {
  const deployment = await runner.resolveDeployment();
  if (!deployment.ok) return fail(deployment.error, writeError);
  if (!deployment.value.promoted) {
    return fail(unsupported(
      'Publish credentials require a promoted release deployment; '
        + `the running deployment is ${deployment.value.reason}`,
    ), writeError);
  }

  const workspace = await runner.resolveWorkspace(command.workspaceReference);
  if (!workspace.ok) return fail(workspace.error, writeError);

  const urls = await runner.resolvePushUrls(workspace.value.rootPath, command.remote);
  if (!urls.ok) return fail(urls.error, writeError);
  if (urls.value.length === 0) {
    return fail(unsupported('The remote has no push URL'), writeError);
  }
  if (urls.value.length > 1) {
    return fail(appError('INVALID_INPUT', 'The remote resolves to more than one push URL', true, {
      reason: 'push-target-ambiguous',
    }), writeError);
  }

  const hosts = resolveCredentialHosts(urls.value[0]!);
  if (!hosts.ok) return fail(hosts.error, writeError);
  const secret = await runner.readSecret();
  if (!secret.ok) return fail(secret.error, writeError);

  const createdAt = runner.now?.() ?? Date.now();
  const expiresAt = createdAt + command.ttlSeconds * 1_000;
  const lease: PublishCredentialLease = {
    leaseId: (runner.createLeaseId ?? randomUUID)(),
    workspaceId: workspace.value.id,
    remote: command.remote,
    hosts: hosts.value,
    username: command.username,
    createdAt,
    expiresAt,
  };
  const granted = await runner.credential.grant(lease, secret.value);
  if (!granted.ok) return fail(granted.error, writeError);

  write(`publish credential granted: ${lease.leaseId}`);
  write(`workspace: ${lease.workspaceId}`);
  write(`remote: ${lease.remote}`);
  write(`hosts: ${lease.hosts.join(',')}`);
  write(`username: ${lease.username}`);
  write(`expires: ${new Date(lease.expiresAt).toISOString()}`);
  return 0;
}

async function runRevoke(
  leaseId: string,
  runner: PublishCredentialCommandRunner,
  write: (text: string) => void,
  writeError: (text: string) => void,
): Promise<number> {
  const now = runner.now?.() ?? Date.now();
  const revoked = await runner.credential.revoke(leaseId, now);
  if (!revoked.ok) return fail(revoked.error, writeError);
  write(`publish credential revoked: ${leaseId}`);
  return 0;
}

async function runStatus(
  leaseId: string,
  runner: PublishCredentialCommandRunner,
  write: (text: string) => void,
  writeError: (text: string) => void,
): Promise<number> {
  const now = runner.now?.() ?? Date.now();
  if (runner.inspect === undefined) {
    const opened = await runner.credential.open(leaseId, now);
    if (!opened.ok) return fail(opened.error, writeError);
    if (opened.value === null) {
      write(`publish credential not found or not live: ${leaseId}`);
      return 0;
    }
    writeLease(opened.value.lease, null, now, write);
    return 0;
  }
  const inspected = await runner.inspect(leaseId);
  if (!inspected.ok) return fail(inspected.error, writeError);
  if (inspected.value === null) {
    write(`publish credential not found: ${leaseId}`);
    return 0;
  }
  writeLease(inspected.value.lease, inspected.value.revokedAt, now, write);
  return 0;
}

function writeLease(
  lease: PublishCredentialLease,
  revokedAt: number | null,
  now: number,
  write: (text: string) => void,
): void {
  write(`lease: ${lease.leaseId}`);
  write(`workspace: ${lease.workspaceId}`);
  write(`remote: ${lease.remote}`);
  write(`username: ${lease.username}`);
  write(`hosts: ${lease.hosts.join(',')}`);
  write(`created: ${new Date(lease.createdAt).toISOString()}`);
  write(`expires: ${new Date(lease.expiresAt).toISOString()}`);
  write(`state: ${leaseState(lease, revokedAt, now)}`);
}

function leaseState(lease: PublishCredentialLease, revokedAt: number | null, now: number): string {
  if (revokedAt !== null) return 'revoked';
  return lease.expiresAt <= now ? 'expired' : 'active';
}

/**
 * One push URL becomes one host. Only `https` is eligible (#297 §3), the
 * default port is dropped, and a non-default port is preserved so the helper
 * can match the prompt exactly.
 */
function resolveCredentialHosts(url: string): Result<readonly string[]> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return err(unsupported('The push target is not a valid URL'));
  }
  if (parsed.protocol !== 'https:') {
    return err(unsupported('Only https push targets can receive a publish credential'));
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0) return err(unsupported('The push target has no host'));
  const port = parsed.port === '' || parsed.port === '443' ? '' : `:${parsed.port}`;
  const host = `${hostname}${port}`;
  if (!isPublishCredentialHost(host)) {
    return err(unsupported('The push target host is not eligible for a publish credential'));
  }
  return ok([host]);
}

function unsupported(message: string): AppError {
  return appError('UNSUPPORTED_TARGET', message, true, { reason: 'publish-credential-unsupported' });
}

function invalidSecret(message: string): AppError {
  return appError('INVALID_INPUT', message, false, { reason: 'publish-credential-invalid' });
}

function fail(error: AppError, writeError: (text: string) => void): number {
  const reason = error.details?.reason;
  writeError(typeof reason === 'string' ? `${reason}: ${error.message}` : error.message);
  return 1;
}

function parseTtlSeconds(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^[1-9][0-9]{0,8}$/u.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function readSecretFromPipe(stream: NodeJS.ReadStream): Promise<Result<string>> {
  return new Promise<Result<string>>((resolve) => {
    let data = '';
    let settled = false;
    const finish = (result: Result<string>): void => {
      if (settled) return;
      settled = true;
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      resolve(result);
    };
    const onData = (chunk: string | Buffer): void => {
      if (settled) return;
      data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (Buffer.byteLength(data, 'utf8') > MAX_SECRET_BYTES) {
        finish(err(invalidSecret('The secret input is too large')));
      }
    };
    const onEnd = (): void => finish(normalizeSecret(data));
    const onError = (): void => finish(err(invalidSecret('The secret input could not be read')));
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

function readSecretFromTerminal(stream: NodeJS.ReadStream): Promise<Result<string>> {
  return new Promise<Result<string>>((resolve) => {
    const chars: string[] = [];
    let settled = false;
    const terminal = stream as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
    const finish = (result: Result<string>): void => {
      if (settled) return;
      settled = true;
      stream.off('data', onData);
      terminal.setRawMode?.(false);
      stream.pause();
      resolve(result);
    };
    const onData = (chunk: string | Buffer): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const char of text) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          process.stderr.write('\n');
          finish(normalizeSecret(chars.join('')));
          return;
        }
        if (char === '\u0003') {
          process.stderr.write('\n');
          finish(err(invalidSecret('Secret entry was cancelled')));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          chars.pop();
          continue;
        }
        if ((char.codePointAt(0) ?? 0) < 0x20) continue;
        chars.push(char);
      }
    };
    process.stderr.write('Secret: ');
    terminal.setRawMode?.(true);
    stream.resume();
    stream.on('data', onData);
  });
}

function normalizeSecret(raw: string): Result<string> {
  const value = raw.replace(/[\r\n]+$/u, '');
  if (value.length === 0 || value.trim().length === 0) {
    return err(invalidSecret('The secret must not be empty'));
  }
  if (value.includes('\n') || value.includes('\r')) {
    return err(invalidSecret('The secret must be a single line'));
  }
  return ok(value);
}
