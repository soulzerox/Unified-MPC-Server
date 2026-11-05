import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { errorMessage, isMissingPath, isStrictRead, type ReachabilityReadOptions } from './reachability-read.js';

export type RevisionPinReason =
  | 'canonical-ref'
  | 'goal-base'
  | 'goal-overlay'
  | 'index-job'
  | 'rollback'
  | 'user-pin';

const PIN_REASONS: readonly RevisionPinReason[] = [
  'canonical-ref',
  'goal-base',
  'goal-overlay',
  'index-job',
  'rollback',
  'user-pin',
];

const MANIFEST_ID = /^man:v1:[a-f0-9]{64}$/i;

export interface RevisionPin {
  readonly manifestId: string;
  readonly reason: RevisionPinReason;
  readonly note: string;
  readonly createdAt: string;
}

export type PruneVerdict =
  | { readonly prunable: true }
  | { readonly prunable: false; readonly blockedBy: readonly RevisionPinReason[] };

function requireManifestId(value: string): string {
  if (!MANIFEST_ID.test(value)) throw new Error(`invalid manifest id: ${value}`);
  return value.toLowerCase();
}

function requireReason(value: string): RevisionPinReason {
  if (!(PIN_REASONS as readonly string[]).includes(value)) {
    throw new Error(`invalid pin reason: ${value}`);
  }
  return value as RevisionPinReason;
}

/**
 * Revision pin registry (#210 U13).
 *
 * Pins are the reachability roots that revision pruning and artifact GC
 * must consult: a pinned manifest (and everything it references) is never
 * pruned. Pinning never deletes anything; unpinning never deletes either —
 * both only change reachability evidence. One JSON file per manifest id
 * under <root>/pins/, written via tmp+rename. Prune itself refuses a
 * pinned revision and reports the blocking reasons instead.
 */
export class RevisionPinRegistry {
  public constructor(private readonly root: string) {}

  public async pin(manifestId: string, reason: RevisionPinReason, note: string): Promise<RevisionPin[]> {
    const id = requireManifestId(manifestId);
    const validatedReason = requireReason(reason);
    const pins = await this.readAll(id);
    const existing = pins.find((pin) => pin.reason === validatedReason);
    const now = new Date().toISOString();
    const next = existing !== undefined
      ? pins.map((pin) => (pin.reason === validatedReason ? { ...pin, note, createdAt: now } : pin))
      : [...pins, { manifestId: id, reason: validatedReason, note, createdAt: now }];
    await this.write(id, next);
    return next;
  }

  public async unpin(
    manifestId: string,
    reason: RevisionPinReason,
    options?: ReachabilityReadOptions,
  ): Promise<boolean> {
    const id = requireManifestId(manifestId);
    const validatedReason = requireReason(reason);
    const pins = await this.readAll(id, options);
    if (!pins.some((pin) => pin.reason === validatedReason)) return false;
    await this.write(id, pins.filter((pin) => pin.reason !== validatedReason));
    return true;
  }

  public async pinnedManifestIds(options?: ReachabilityReadOptions): Promise<string[]> {
    const strict = isStrictRead(options);
    const pinsDir = path.join(this.root, 'pins');
    let names: string[];
    try {
      const entries = await readdir(pinsDir, { withFileTypes: true });
      names = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);
    } catch (error) {
      if (strict && !isMissingPath(error)) throw new Error(`cannot read the pin directory: ${errorMessage(error)}`);
      return [];
    }
    const ids: string[] = [];
    for (const name of names) {
      const id = name.slice(0, -'.json'.length);
      try {
        const raw = await readFile(path.join(pinsDir, name), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (!(Array.isArray(parsed) && parsed.some(isPin) && MANIFEST_ID.test(id))) {
          throw new Error('not a revision pin record');
        }
        // Every reader looks a pin up by its canonical lowercase id. A record
        // stored under a differently-cased name passes the regex above but the
        // reasons read back from the lowercase path as empty, so a destructive
        // caller must refuse it instead of treating the pin as reason-less. A
        // tolerant listing still returns the raw id so status can report it.
        if (strict && id !== id.toLowerCase()) throw new Error('non-canonical pin file name');
        ids.push(id);
      } catch (error) {
        // Tolerant listings skip unreadable pins; a GC planning read must not,
        // because a skipped pin silently removes its manifest from the roots.
        if (strict) throw new Error(`cannot read revision pin ${name}: ${errorMessage(error)}`);
      }
    }
    return ids.sort();
  }

  public async list(manifestId: string, options?: ReachabilityReadOptions): Promise<RevisionPin[]> {
    return this.readAll(requireManifestId(manifestId), options);
  }

  public async isPinned(manifestId: string): Promise<boolean> {
    return (await this.readAll(requireManifestId(manifestId))).length > 0;
  }

  public async checkPrune(manifestId: string): Promise<PruneVerdict> {
    const pins = await this.readAll(requireManifestId(manifestId));
    if (pins.length === 0) return { prunable: true };
    return { prunable: false, blockedBy: pins.map((pin) => pin.reason).sort() };
  }

  private pinsPath(manifestId: string): string {
    return path.join(this.root, 'pins', `${manifestId}.json`);
  }

  private async readAll(manifestId: string, options?: ReachabilityReadOptions): Promise<RevisionPin[]> {
    const strict = isStrictRead(options);
    try {
      const raw = await readFile(this.pinsPath(manifestId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not a revision pin record');
      const pins = parsed.filter(isPin);
      // A present record with no valid pin entries is unreadable evidence: the
      // registry deletes a file when its last reason is removed, so an empty or
      // partly malformed record is corruption, not "nothing is pinned".
      if (strict && (pins.length === 0 || pins.length !== parsed.length)) {
        throw new Error('malformed or empty revision pin record');
      }
      return pins;
    } catch (error) {
      // A missing file is the legitimately empty case. Every other failure is
      // only tolerated when the caller did not ask for strict evidence.
      if (strict && !isMissingPath(error)) {
        throw new Error(`cannot read revision pin ${manifestId}: ${errorMessage(error)}`);
      }
      return [];
    }
  }

  private async write(manifestId: string, pins: readonly RevisionPin[]): Promise<void> {
    const finalPath = this.pinsPath(manifestId);
    if (pins.length === 0) {
      await rm(finalPath, { force: true });
      return;
    }
    await mkdir(path.dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(pins, null, 2), { mode: 0o600 });
    await rename(tmpPath, finalPath);
  }
}

function isPin(value: unknown): value is RevisionPin {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.manifestId === 'string'
    && typeof record.reason === 'string'
    && (PIN_REASONS as readonly string[]).includes(record.reason)
    && typeof record.note === 'string'
    && typeof record.createdAt === 'string';
}
