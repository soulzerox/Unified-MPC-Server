import { spawn } from 'node:child_process';

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SecretToolSecretStoreOptions {
  readonly service?: string;
  readonly command?: string;
  readonly run?: SecretToolRunner;
}

type SecretToolRunner = (args: readonly string[], input?: string) => Promise<string>;

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

  public async get(key: string): Promise<string | null> {
    const normalized = normalizeKey(key);
    try {
      const value = await this.run(['lookup', 'service', this.service, 'key', normalized]);
      return value.trim().length === 0 ? null : value.trim();
    } catch (error: unknown) {
      if (isSecretToolNotFound(error)) throw new Error('Linux Secret Service is unavailable: secret-tool was not found');
      if (error instanceof Error && /No secret found/i.test(error.message)) return null;
      throw new Error('Linux Secret Service lookup failed');
    }
  }

  public async set(key: string, value: string): Promise<void> {
    const normalized = normalizeKey(key);
    if (value.trim().length === 0) throw new Error('Secret value must not be empty');
    try {
      await this.run(['store', '--label', 'Unified-MPC-Server secret', 'service', this.service, 'key', normalized], value);
    } catch (error: unknown) {
      if (isSecretToolNotFound(error)) throw new Error('Linux Secret Service is unavailable: secret-tool was not found');
      throw new Error('Linux Secret Service write failed');
    }
  }

  public async delete(key: string): Promise<void> {
    const normalized = normalizeKey(key);
    try {
      await this.run(['clear', 'service', this.service, 'key', normalized]);
    } catch (error: unknown) {
      if (isSecretToolNotFound(error)) throw new Error('Linux Secret Service is unavailable: secret-tool was not found');
      if (error instanceof Error && /No secret found/i.test(error.message)) return;
      throw new Error('Linux Secret Service delete failed');
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
      else reject(new Error(stderr || `secret-tool exited with code ${code ?? 'unknown'}`));
    });
    if (input !== undefined) child.stdin.end(input, 'utf8');
    else child.stdin.end();
  });
}

function isSecretToolNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}