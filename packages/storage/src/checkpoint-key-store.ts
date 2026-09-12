import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { assertSecretPlaintext, type SecretProtector } from '@unified-mpc/shared';

export interface CheckpointKeyStoreOptions {
  readonly filePath: string;
  readonly secretProtector: SecretProtector;
  readonly byteLength?: number;
}

/**
 * Owns the protected checkpoint master-key file. Creation and rotation are
 * atomic so concurrent Desktop/STDIO startup cannot silently create two keys.
 */
export class CheckpointKeyStore {
  private readonly byteLength: number;

  public constructor(private readonly options: CheckpointKeyStoreOptions) {
    this.byteLength = options.byteLength ?? 32;
    if (!Number.isInteger(this.byteLength) || this.byteLength < 16 || this.byteLength > 64) {
      throw new Error('Checkpoint key length is invalid');
    }
  }

  public async loadOrCreate(): Promise<Buffer> {
    const existing = await this.readExisting();
    if (existing !== null) return existing;

    const generated = randomBytes(this.byteLength);
    const encrypted = await this.options.secretProtector.encrypt('checkpoint_master_key', generated.toString('base64'));
    await ensurePrivateParent(path.dirname(path.resolve(this.options.filePath)));
    try {
      await writeExclusive(this.options.filePath, encrypted);
      return generated;
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      const concurrent = await this.readExisting();
      if (concurrent === null) throw new Error('Checkpoint key appeared during concurrent startup but could not be read');
      return concurrent;
    }
  }

  private async readExisting(): Promise<Buffer | null> {
    let encrypted: string;
    try {
      const metadata = await lstat(this.options.filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Protected checkpoint key is not a trusted regular file');
      if ((metadata.mode & 0o777) !== 0o600) throw new Error('Protected checkpoint key has unsafe permissions');
      encrypted = await readFile(this.options.filePath, 'utf8');
    } catch (error: unknown) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    const trimmed = encrypted.trim();
    const result = await this.options.secretProtector.decrypt('checkpoint_master_key', trimmed);
    assertSecretPlaintext(result.plainText);
    const key = Buffer.from(result.plainText, 'base64');
    if (key.byteLength !== this.byteLength || key.toString('base64') !== result.plainText) {
      throw new Error('Protected checkpoint key has an invalid key length');
    }
    if (result.shouldReEncrypt) {
      const next = await this.options.secretProtector.encrypt('checkpoint_master_key', result.plainText);
      await writeAtomic(this.options.filePath, next);
    }
    return key;
  }
}


async function writeExclusive(filePath: string, contents: string): Promise<void> {
  const handle = await open(path.resolve(filePath), 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const absolutePath = path.resolve(filePath);
  await ensurePrivateParent(path.dirname(absolutePath));
  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeExclusive(temporaryPath, contents);
    await rename(temporaryPath, absolutePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

async function ensurePrivateParent(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Checkpoint key parent is not a trusted directory');
      if (!isTrustedSharedAncestor(current, metadata) && typeof process.getuid === 'function') {
        if (metadata.uid !== process.getuid()) throw new Error('Checkpoint key parent has an unexpected owner');
        if ((metadata.mode & 0o077) !== 0) await chmod(current, 0o700);
      }
    } catch (error: unknown) {
      if (!isMissingFile(error)) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

function isTrustedSharedAncestor(directory: string, metadata: { readonly mode: number }): boolean {
  return directory === '/tmp' && (metadata.mode & 0o002) !== 0 && (metadata.mode & 0o1000) !== 0;
}
