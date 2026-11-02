import { spawn } from 'node:child_process';

export interface SecretStoreIdentity {
  readonly provider: string;
  readonly service: string | null;
}

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  describe?(): SecretStoreIdentity;
}

export interface SecretToolSecretStoreOptions {
  readonly service?: string;
  readonly command?: string;
  readonly run?: SecretToolRunner;
}

type SecretToolRunner = (args: readonly string[], input?: string) => Promise<string>;

/**
 * Why a Secret Service call failed. The publish path reports these separately
 * because the operator fix differs: install the daemon, unlock the collection,
 * or retry (#297 §3).
 */
export type SecretStoreFailureReason =
  | 'secret-store-missing'
  | 'secret-store-locked'
  | 'secret-store-timeout'
  | 'secret-store-failed';

export class SecretStoreError extends Error {
  public constructor(readonly reason: SecretStoreFailureReason, message: string) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

/** Reason for a failed SecretStore call, or null when the error is not ours. */
export function secretStoreFailureReason(error: unknown): SecretStoreFailureReason | null {
  return error instanceof SecretStoreError ? error.reason : null;
}

/** Stores secrets in Linux Secret Service through secret-tool. Never writes plaintext files. */
export class SecretToolSecretStore implements SecretStore {
  private readonly service: string;
  private readonly command: string;
  private readonly run: SecretToolRunner;

  public constructor(options: SecretToolSecretStoreOptions = {}) {
    this.service = options.service?.trim() || 'unified-mpc';
    this.command = options.command?.trim() || 'secret-tool';
    this.run = options.run ?? ((args, input): Promise<string> => runSecretTool(this.command, args, input));
  }

  public describe(): SecretStoreIdentity {
    return {
      provider: 'linux-secret-service',
      service: this.service,
    };
  }

  public async get(key: string): Promise<string | null> {
    const normalized = normalizeKey(key);
    try {
      const value = await this.run(['lookup', 'service', this.service, 'key', normalized]);
      return value.trim().length === 0 ? null : value.trim();
    } catch (error: unknown) {
      if (error instanceof Error && /No secret found/i.test(error.message)) return null;
      // `secret-tool` exits 1 for an absent item *and* for a locked collection,
      // so the classification decides before "missing" is assumed (#297).
      if (classifySecretStoreFailure(error) === 'secret-store-failed' && isMissingSecret(error)) return null;
      throw secretStoreError('lookup', error);
    }
  }

  public async set(key: string, value: string): Promise<void> {
    const normalized = normalizeKey(key);
    if (value.trim().length === 0) throw new Error('Secret value must not be empty');
    try {
      await this.run(['store', '--label', 'Unified-MPC-Server secret', 'service', this.service, 'key', normalized], value);
    } catch (error: unknown) {
      throw secretStoreError('write', error);
    }
  }

  public async delete(key: string): Promise<void> {
    const normalized = normalizeKey(key);
    try {
      await this.run(['clear', 'service', this.service, 'key', normalized]);
    } catch (error: unknown) {
      if (error instanceof Error && /No secret found/i.test(error.message)) return;
      if (classifySecretStoreFailure(error) === 'secret-store-failed' && isMissingSecret(error)) return;
      throw secretStoreError('delete', error);
    }
  }
}

function normalizeKey(key: string): string {
  const value = key.trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value)) throw new Error('Secret key is invalid');
  return value;
}

function runSecretTool(command: string, args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('secret-tool timed out'));
    }, 5_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(0, 8_192); });
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(0, 8_192); });
    child.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else {
        const failure = new Error(stderr || `secret-tool exited with code ${code ?? 'unknown'}`);
        if (code !== null) Object.assign(failure, { secretToolExitCode: code });
        reject(failure);
      }
    });
    if (input !== undefined) child.stdin.end(input, 'utf8');
    else child.stdin.end();
  });
}

/**
 * Classify one `secret-tool` failure. `secret-tool` reports a locked collection
 * on stderr ("Cannot create an item in a locked collection") and the daemon's
 * absence as an ENOENT spawn error, so the two are distinguishable without
 * asking the caller to guess.
 */
export function classifySecretStoreFailure(error: unknown): SecretStoreFailureReason {
  if (isSecretToolNotFound(error)) return 'secret-store-missing';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/timed out/i.test(message)) return 'secret-store-timeout';
  if (/locked/i.test(message)) return 'secret-store-locked';
  if (/was not found|command not found|ENOENT/i.test(message)) return 'secret-store-missing';
  return 'secret-store-failed';
}

function secretStoreError(operation: 'lookup' | 'write' | 'delete', error: unknown): SecretStoreError {
  const reason = classifySecretStoreFailure(error);
  // A missing binary and an unreachable D-Bus service both mean "the service is
  // unavailable", but only the first is about `secret-tool` itself (#297).
  const missing = isSecretToolNotFound(error) ? 'secret-tool was not found' : 'the Secret Service is not reachable';
  const cause = reason === 'secret-store-locked'
    ? ': the collection is locked'
    : reason === 'secret-store-missing'
      ? `: ${missing}`
      : reason === 'secret-store-timeout'
        ? ': secret-tool timed out'
        : '';
  return new SecretStoreError(reason, `Linux Secret Service ${operation} failed${cause}`);
}

function isSecretToolNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** secret-tool lookup/clear exit with status 1 when the item does not exist (empty stdout/stderr). */
function isMissingSecret(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'secretToolExitCode' in error &&
    (error as { secretToolExitCode?: number }).secretToolExitCode === 1
  );
}