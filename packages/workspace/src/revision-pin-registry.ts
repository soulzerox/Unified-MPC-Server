import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

  public async unpin(manifestId: string, reason: RevisionPinReason): Promise<boolean> {
    const id = requireManifestId(manifestId);
    const validatedReason = requireReason(reason);
    const pins = await this.readAll(id);
    if (!pins.some((pin) => pin.reason === validatedReason)) return false;
    await this.write(id, pins.filter((pin) => pin.reason !== validatedReason));
    return true;
  }

  public async list(manifestId: string): Promise<RevisionPin[]> {
    return this.readAll(requireManifestId(manifestId));
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

  private async readAll(manifestId: string): Promise<RevisionPin[]> {
    try {
      const raw = await readFile(this.pinsPath(manifestId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isPin);
    } catch {
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
