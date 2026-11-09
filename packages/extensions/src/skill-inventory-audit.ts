import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { fingerprintCanonicalSkillDirectory } from './canonical-skill-migration-stager.js';
import { SkillCatalog } from './skill-catalog.js';
import type { ExtensionsSettings } from './types.js';

/** Source name `SkillCatalog` assigns to the parent-owned canonical root. */
const CANONICAL_SOURCE = 'unified-mpc-skills';

/**
 * How many distinct full-directory fingerprints one declared Skill name has
 * across every discovered root.
 *
 * `unverified` means at least one copy could not be fingerprinted, so the audit
 * refuses to state how many variants exist rather than undercounting them.
 */
export type SkillInventoryClassification = 'unique' | 'identical' | 'divergent' | 'unverified';

/**
 * How the canonical copy relates to the legacy copies advertising the same name.
 *
 * `duplicate` is the live defect #294 tracks: two canonical Skill directories
 * declare one logical name, so two catalog ids advertise one Skill.
 */
export type SkillInventoryCanonicalState =
  | 'duplicate'
  | 'unverified'
  | 'absent'
  | 'only-canonical'
  | 'matches'
  | 'diverges';

export interface SkillInventoryAuditOptions {
  readonly settings: ExtensionsSettings;
  /** Parent-owned canonical Skill root (`<dataDir>/extensions/skills`). */
  readonly managedRoot: string;
  readonly homeDir?: string;
  readonly workspaceRoot?: string;
  readonly bundledRoots?: readonly string[];
  readonly extraRoots?: readonly string[];
}

export interface SkillInventoryAuditEntry {
  readonly source: string;
  readonly rootPath: string;
  readonly skillPath: string;
  readonly isCanonical: boolean;
  /** Absent when the copy could not be fingerprinted; the reason is in `skipped`. */
  readonly fingerprint?: string;
}

export interface SkillInventoryAuditName {
  readonly name: string;
  /** Canonical identity convention: one logical Skill is `skill:<declared name>`. */
  readonly canonicalId: string;
  readonly classification: SkillInventoryClassification;
  readonly canonicalState: SkillInventoryCanonicalState;
  /** Sorted, de-duplicated fingerprints across every copy. */
  readonly variantFingerprints: readonly string[];
  readonly canonicalFingerprints: readonly string[];
  readonly entries: readonly SkillInventoryAuditEntry[];
}

export interface SkillInventoryAuditRoot {
  readonly source: string;
  readonly path: string;
  readonly directories: number;
}

export interface SkillInventoryAuditSkipped {
  readonly skillPath: string;
  readonly reason: string;
}

export interface SkillInventoryAuditSummary {
  readonly directories: number;
  readonly roots: number;
  readonly declaredNames: number;
  readonly uniqueNames: number;
  readonly identicalNames: number;
  readonly divergentNames: number;
  readonly unverifiedNames: number;
  readonly canonicalPresentNames: number;
  /**
   * Declared names whose canonical copy holds the same content as at least one
   * legacy copy. A name served only by the canonical root is `canonicalOnlyNames`
   * instead: there is no legacy sibling for it to match.
   */
  readonly canonicalMatchNames: number;
  readonly canonicalDivergingNames: number;
  /** Declared names whose only copy is the canonical one. */
  readonly canonicalOnlyNames: number;
  readonly canonicalAbsentNames: number;
  /** Declared names with more than one canonical directory, the #294 defect. */
  readonly duplicateCanonicalNames: number;
  /** Declared names whose canonical relationship cannot be stated. */
  readonly canonicalUnverifiedNames: number;
}

export interface SkillInventoryAuditReport {
  readonly schemaVersion: 1;
  readonly names: readonly SkillInventoryAuditName[];
  readonly roots: readonly SkillInventoryAuditRoot[];
  readonly skipped: readonly SkillInventoryAuditSkipped[];
  readonly summary: SkillInventoryAuditSummary;
}

/**
 * Read-only inventory of every Skill directory this host can discover, grouped
 * by the `name` each `SKILL.md` declares.
 *
 * The audit answers the question #294 asks but cannot answer from the registry
 * alone: for one logical Skill name, which directories declare it, which
 * full-directory content each one has, and whether the canonical copy is the
 * same content as its legacy siblings. It never imports, deletes, prunes or
 * chooses precedence — divergent groups are reported for human review, and the
 * report is stable across runs so it can be diffed.
 */
export class SkillInventoryAuditService {
  public constructor(private readonly options: SkillInventoryAuditOptions) {}

  public async audit(): Promise<Result<SkillInventoryAuditReport>> {
    const managedRoot = this.options.managedRoot.trim();
    if (managedRoot.length === 0) {
      return err(appError('INVALID_INPUT', 'Skill inventory audit requires a canonical Skill root'));
    }

    const catalog = new SkillCatalog({
      settings: this.options.settings,
      managedRoot: path.resolve(managedRoot),
      bundledRoots: [...(this.options.bundledRoots ?? [])],
      extraRoots: [...(this.options.extraRoots ?? [])],
      ...(this.options.homeDir === undefined ? {} : { homeDir: this.options.homeDir }),
      ...(this.options.workspaceRoot === undefined ? {} : { workspaceRoot: this.options.workspaceRoot }),
    });
    const listed = await catalog.list();
    if (!listed.ok) return err(listed.error);

    const roots = summarizeRoots(listed.value.skills);
    const skipped: SkillInventoryAuditSkipped[] = [];
    const grouped = new Map<string, NamedInventoryEntry[]>();

    for (const skill of listed.value.skills) {
      const fingerprinted = await fingerprintCanonicalSkillDirectory(path.dirname(skill.skillPath));
      const entry: NamedInventoryEntry = {
        name: skill.name,
        source: skill.source,
        rootPath: skill.rootPath,
        skillPath: skill.skillPath,
        isCanonical: skill.source === CANONICAL_SOURCE,
        ...(fingerprinted.ok ? { fingerprint: fingerprinted.value } : {}),
      };
      if (!fingerprinted.ok) {
        skipped.push({ skillPath: skill.skillPath, reason: fingerprinted.error.message });
      }
      const current = grouped.get(skill.name);
      if (current === undefined) grouped.set(skill.name, [entry]);
      else current.push(entry);
    }

    const names = [...grouped.entries()]
      .map(([name, entries]) => buildNameEntry(name, entries))
      .sort((left, right) => left.name.localeCompare(right.name));

    return ok({
      schemaVersion: 1,
      names,
      roots,
      skipped,
      summary: summarize(names, listed.value.skills.length, roots.length),
    });
  }
}

interface NamedInventoryEntry extends SkillInventoryAuditEntry {
  readonly name: string;
}

function buildNameEntry(
  name: string,
  entries: readonly NamedInventoryEntry[],
): SkillInventoryAuditName {
  const ordered = [...entries].sort(compareEntries);
  const canonical = ordered.filter((entry) => entry.isCanonical);
  const variantFingerprints = uniqueStrings(ordered.map((entry) => entry.fingerprint));
  const canonicalFingerprints = uniqueStrings(canonical.map((entry) => entry.fingerprint));
  const unfingerprinted = ordered.some((entry) => entry.fingerprint === undefined);

  return {
    name,
    canonicalId: `skill:${name}`,
    classification: classifyEntry(unfingerprinted, ordered.length, variantFingerprints.length),
    canonicalState: classifyCanonical(
      unfingerprinted,
      ordered,
      canonical.length,
      canonicalFingerprints,
    ),
    variantFingerprints,
    canonicalFingerprints,
    entries: ordered.map((entry) => ({
      source: entry.source,
      rootPath: entry.rootPath,
      skillPath: entry.skillPath,
      isCanonical: entry.isCanonical,
      ...(entry.fingerprint === undefined ? {} : { fingerprint: entry.fingerprint }),
    })),
  };
}

function classifyEntry(
  unfingerprinted: boolean,
  copyCount: number,
  variantCount: number,
): SkillInventoryClassification {
  if (unfingerprinted) return 'unverified';
  if (copyCount <= 1) return 'unique';
  return variantCount <= 1 ? 'identical' : 'divergent';
}

function classifyCanonical(
  unfingerprinted: boolean,
  entries: readonly NamedInventoryEntry[],
  canonicalCount: number,
  canonicalFingerprints: readonly string[],
): SkillInventoryCanonicalState {
  // Two canonical directories declaring one name is the #294 defect whether or
  // not any fingerprint could be computed, so it outranks every other state.
  if (canonicalCount > 1) return 'duplicate';
  if (unfingerprinted) return 'unverified';
  if (canonicalCount === 0) return 'absent';
  if (canonicalCount === entries.length) return 'only-canonical';
  const matchesLegacyCopy = entries.some((entry) => (
    !entry.isCanonical
    && entry.fingerprint !== undefined
    && canonicalFingerprints.includes(entry.fingerprint)
  ));
  return matchesLegacyCopy ? 'matches' : 'diverges';
}

function summarizeRoots(
  skills: readonly { readonly source: string; readonly rootPath: string }[],
): readonly SkillInventoryAuditRoot[] {
  const counts = new Map<string, { source: string; path: string; directories: number }>();
  for (const skill of skills) {
    const key = `${skill.source}\u0000${skill.rootPath}`;
    const current = counts.get(key);
    if (current === undefined) {
      counts.set(key, { source: skill.source, path: skill.rootPath, directories: 1 });
    } else {
      current.directories += 1;
    }
  }
  return [...counts.values()].sort((left, right) => (
    left.source.localeCompare(right.source) || left.path.localeCompare(right.path)
  ));
}

function summarize(
  names: readonly SkillInventoryAuditName[],
  directories: number,
  roots: number,
): SkillInventoryAuditSummary {
  const count = (predicate: (entry: SkillInventoryAuditName) => boolean): number => (
    names.filter(predicate).length
  );
  return {
    directories,
    roots,
    declaredNames: names.length,
    uniqueNames: count((entry) => entry.classification === 'unique'),
    identicalNames: count((entry) => entry.classification === 'identical'),
    divergentNames: count((entry) => entry.classification === 'divergent'),
    unverifiedNames: count((entry) => entry.classification === 'unverified'),
    canonicalPresentNames: count((entry) => entry.entries.some((copy) => copy.isCanonical)),
    canonicalMatchNames: count((entry) => entry.canonicalState === 'matches'),
    canonicalDivergingNames: count((entry) => entry.canonicalState === 'diverges'),
    canonicalOnlyNames: count((entry) => entry.canonicalState === 'only-canonical'),
    canonicalAbsentNames: count((entry) => entry.canonicalState === 'absent'),
    duplicateCanonicalNames: count((entry) => entry.canonicalState === 'duplicate'),
    canonicalUnverifiedNames: count((entry) => entry.canonicalState === 'unverified'),
  };
}

function compareEntries(left: SkillInventoryAuditEntry, right: SkillInventoryAuditEntry): number {
  return entryKey(left).localeCompare(entryKey(right));
}

function entryKey(entry: SkillInventoryAuditEntry): string {
  return [
    entry.source,
    entry.rootPath,
    entry.skillPath,
    entry.fingerprint ?? '',
  ].join('\u0000');
}

function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))]
    .sort((left, right) => left.localeCompare(right));
}
