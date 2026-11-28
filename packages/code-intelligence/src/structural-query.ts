import { appError, err, ok, type Result } from '@unified-mpc/domain';

import type {
  SourceStructuralRecord,
  StructuralImport,
  StructuralLanguage,
  StructuralSymbolKind,
} from './structural-extractor.js';

/**
 * Slice 3 of the Code Intelligence subsystem (#131): the query surface.
 *
 * A projection, not a second system. These functions take records the caller
 * already read from one stored generation, so every answer is attributable to one
 * immutable extraction and nothing here opens a database, reads a file, resolves an
 * edge or ranks a result. See
 * `docs/superpowers/specs/2026-11-28-code-intelligence-slice-3-query-design.md`.
 *
 * Three properties carry the slice:
 *
 * - bounded: every query takes a `limit` and says when it truncated, so a short
 *   answer is never mistaken for a complete one;
 * - deterministic: path (code unit), then line, then name — no locale, no score;
 * - honest: a file that failed to parse reports `parseError` instead of looking
 *   empty, and a specifier match is labelled `heuristic`, because slice 1 stores
 *   specifiers un-resolved.
 */

export const MAX_QUERY_LIMIT = 2_000;

export interface SymbolHit {
  readonly path: string;
  readonly name: string;
  readonly kind: StructuralSymbolKind;
  readonly container: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly exported: boolean;
}

export interface DependentHit {
  readonly path: string;
  readonly specifier: string;
  /** Always `heuristic`: matching an un-resolved specifier does not resolve it. */
  readonly resolution: 'heuristic';
}

export interface FileOutline {
  readonly path: string;
  readonly language: StructuralLanguage;
  readonly symbols: readonly SymbolHit[];
  readonly imports: readonly StructuralImport[];
  /** Present when the file could not be parsed; the outline is then not complete. */
  readonly parseError?: string;
}

export interface RepoSummary {
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly unparsedCount: number;
  readonly languages: readonly { readonly language: StructuralLanguage; readonly fileCount: number; readonly symbolCount: number }[];
  readonly truncated: boolean;
}

export interface QueryPage<T> {
  readonly items: readonly T[];
  readonly truncated: boolean;
}

export interface SymbolQuery {
  readonly name?: string;
  readonly kind?: StructuralSymbolKind;
  readonly exported?: boolean;
  readonly pathPrefix?: string;
  readonly limit: number;
}

export interface OutlineQuery {
  readonly path: string;
}

export interface PathQuery {
  readonly path: string;
  readonly limit: number;
}

export interface SummaryQuery {
  readonly limit: number;
}

const SYMBOL_KINDS = new Set<StructuralSymbolKind>([
  'class',
  'function',
  'method',
  'interface',
  'type',
  'enum',
  'const',
  'variable',
]);

function invalid(message: string): Result<never> {
  return err(appError('INVALID_INPUT', message));
}

function validateLimit(limit: unknown): Result<number> {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    return invalid(`a structural query needs an integer limit between 1 and ${MAX_QUERY_LIMIT}`);
  }
  return ok(limit);
}

/** Records arrive sorted by the store; an array a caller built may not be. */
function byPath(records: readonly StructuralRecordView[]): readonly StructuralRecordView[] {
  return [...records].sort((left, right) => compareCodeUnit(left.path, right.path));
}

/** Code-unit order, so the answer does not depend on the process locale. */
function compareCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** The subset every query reads; a stored record satisfies it. Exported so a caller can name it. */
export type StructuralRecordView = Pick<
  SourceStructuralRecord,
  'path' | 'language' | 'symbols' | 'imports' | 'parseError'
>;

function hitsOf(records: readonly StructuralRecordView[], matches: (record: StructuralRecordView) => boolean): SymbolHit[] {
  const hits: SymbolHit[] = [];
  for (const record of byPath(records)) {
    if (!matches(record)) continue;
    const symbols = [...record.symbols]
      .sort((left, right) => left.startLine - right.startLine || compareCodeUnit(left.name, right.name))
      .map((symbol): SymbolHit => ({
        path: record.path,
        name: symbol.name,
        kind: symbol.kind,
        container: symbol.container,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        exported: symbol.exported,
      }));
    hits.push(...symbols);
  }
  return hits;
}

function paginate<T>(items: readonly T[], limit: number): QueryPage<T> {
  return items.length > limit
    ? { items: items.slice(0, limit), truncated: true }
    : { items, truncated: false };
}

/** Symbols whose name, kind, exported flag and path match every supplied filter. */
export function findSymbols(records: readonly StructuralRecordView[], query: SymbolQuery): Result<QueryPage<SymbolHit>> {
  const limit = validateLimit(query.limit);
  if (!limit.ok) return limit;
  if (query.name !== undefined && typeof query.name !== 'string') {
    return invalid('structural query name must be a string');
  }
  if (query.exported !== undefined && typeof query.exported !== 'boolean') {
    return invalid('structural query exported must be a boolean');
  }
  if (query.kind !== undefined && !SYMBOL_KINDS.has(query.kind)) {
    return invalid(`structural query kind ${String(query.kind)} is not a symbol kind`);
  }
  if (query.pathPrefix !== undefined
    && (typeof query.pathPrefix !== 'string' || query.pathPrefix.length === 0)) {
    return invalid('structural query pathPrefix must be a non-empty string');
  }

  const hits = hitsOf(records, (record) => query.pathPrefix === undefined || record.path.startsWith(query.pathPrefix))
    .filter((hit) => (query.name === undefined || hit.name === query.name)
      && (query.kind === undefined || hit.kind === query.kind)
      && (query.exported === undefined || hit.exported === query.exported));
  return ok(paginate(hits, limit.value));
}

/** Exact, case-sensitive definitions. A prefix or a substring is not a definition. */
export function definitionsOf(
  records: readonly StructuralRecordView[],
  query: { readonly name: string; readonly limit: number },
): Result<QueryPage<SymbolHit>> {
  if (typeof query.name !== 'string' || query.name.length === 0) {
    return invalid('a definition lookup needs a non-empty name');
  }
  return findSymbols(records, { name: query.name, limit: query.limit });
}

/** One file's symbols and imports, or `undefined` when the records do not carry it. */
export function outlineOf(records: readonly StructuralRecordView[], query: OutlineQuery): Result<FileOutline | undefined> {
  if (typeof query.path !== 'string' || query.path.length === 0) {
    return invalid('a file outline needs a path');
  }
  const record = byPath(records).find((entry) => entry.path === query.path);
  if (record === undefined) return ok(undefined);

  const symbols = [...record.symbols]
    .sort((left, right) => left.startLine - right.startLine || compareCodeUnit(left.name, right.name))
    .map((symbol): SymbolHit => ({
      path: record.path,
      name: symbol.name,
      kind: symbol.kind,
      container: symbol.container,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      exported: symbol.exported,
    }));
  const imports = [...record.imports].sort((left, right) => left.startLine - right.startLine);
  return ok({
    path: record.path,
    language: record.language,
    symbols,
    imports,
    ...(record.parseError === undefined ? {} : { parseError: record.parseError }),
  });
}

/** One file's imports in line order. */
export function importsOf(
  records: readonly StructuralRecordView[],
  query: PathQuery,
): Result<QueryPage<StructuralImport> | undefined> {
  const limit = validateLimit(query.limit);
  if (!limit.ok) return limit;
  const outline = outlineOf(records, { path: query.path });
  if (!outline.ok) return outline;
  if (outline.value === undefined) return ok(undefined);
  return ok(paginate(outline.value.imports, limit.value));
}

/**
 * Files whose stored, un-resolved specifier names `path`.
 *
 * `./b.js` is not resolved to `b.ts` here: slice 1 stores the specifier as written,
 * and claiming a resolution needs the provenance levels #131 names. Every hit is
 * therefore `heuristic`, and the caller must treat it as a lead, not a proof.
 */
export function dependentsOf(records: readonly StructuralRecordView[], query: PathQuery): Result<QueryPage<DependentHit>> {
  const limit = validateLimit(query.limit);
  if (!limit.ok) return limit;
  if (typeof query.path !== 'string' || query.path.length === 0) {
    return invalid('a dependent lookup needs a path');
  }

  const hits: DependentHit[] = [];
  for (const record of byPath(records)) {
    if (record.path === query.path) continue;
    for (const imported of [...record.imports].sort((left, right) => left.startLine - right.startLine)) {
      if (!specifierNames(imported.specifier, query.path)) continue;
      hits.push({ path: record.path, specifier: imported.specifier, resolution: 'heuristic' });
    }
  }
  return ok(paginate(hits, limit.value));
}

/** Counts per language, with unparsed files kept distinct from files without symbols. */
export function repoSummary(records: readonly StructuralRecordView[], query: SummaryQuery): Result<RepoSummary> {
  const limit = validateLimit(query.limit);
  if (!limit.ok) return limit;

  const byLanguage = new Map<StructuralLanguage, { fileCount: number; symbolCount: number }>();
  let symbolCount = 0;
  let unparsedCount = 0;
  for (const record of byPath(records)) {
    symbolCount += record.symbols.length;
    if (record.parseError !== undefined) unparsedCount += 1;
    const entry = byLanguage.get(record.language) ?? { fileCount: 0, symbolCount: 0 };
    byLanguage.set(record.language, {
      fileCount: entry.fileCount + 1,
      symbolCount: entry.symbolCount + record.symbols.length,
    });
  }

  const languages = [...byLanguage]
    .map(([language, counts]) => ({ language, ...counts }))
    .sort((left, right) => compareCodeUnit(left.language, right.language));
  const page = paginate(languages, limit.value);
  return ok({
    fileCount: records.length,
    symbolCount,
    unparsedCount,
    languages: page.items,
    truncated: page.truncated,
  });
}

/**
 * Whether a stored specifier names `path` without resolving it.
 *
 * A relative specifier is compared by suffix after dropping `./` and any `../`
 * segments it is relative to, and an extension-less specifier also matches the eight
 * extensions a source can live under. Both rules are guesses, which is
 * why the hit is labelled heuristic.
 */
const SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function specifierNames(specifier: string, target: string): boolean {
  const normalised = specifier.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
  if (normalised.length === 0) return false;
  const specifierStem = normalised.replace(SOURCE_EXTENSION, '');
  const targetStem = target.replace(SOURCE_EXTENSION, '');
  if (normalised === target || normalised === targetStem) return true;
  if (specifierStem === target || specifierStem === targetStem) return true;
  // A specifier may be written relative to its own directory, so a suffix match
  // against the repo-relative target is the closest a guess can get.
  return target.endsWith(`/${normalised}`) || targetStem.endsWith(`/${specifierStem}`);
}

export interface ImpactQuery {
  /** Repo-relative paths whose change the caller wants to understand. */
  readonly changedPaths: readonly string[];
  /** Per-list bound: targets, each target's symbols, each target's dependents, missing paths. */
  readonly limit: number;
}

export interface ImpactTarget {
  readonly path: string;
  /** Definitions the changed file carries, so a caller can name what moved. */
  readonly symbols: readonly SymbolHit[];
  readonly symbolsTruncated: boolean;
  /** Files whose stored specifier names this path. One entry per file, not per import. */
  readonly dependents: readonly DependentHit[];
  readonly dependentsTruncated: boolean;
  /** Present when the changed file could not be parsed; its symbol list is then partial. */
  readonly parseError?: string;
}

export interface ImpactReport {
  /**
   * Always `imports-only`: slice 1 stores symbols and un-resolved specifiers, not
   * call/reference/extends edges, so this is not a transitive blast radius and does
   * not claim to be one.
   */
  readonly basis: 'imports-only';
  readonly targets: readonly ImpactTarget[];
  /** Changed paths the records do not carry, so the caller knows the picture is partial. */
  readonly missingPaths: readonly string[];
  readonly truncated: boolean;
}

/**
 * Bounded impact for a set of changed files, using only what slice 1 stored.
 *
 * The useful question a pre-edit or review flow asks is "what is around this change".
 * This answers the part the records can support — the changed file's definitions and
 * the files that import it — and says `imports-only` instead of implying callers,
 * references or a transitive closure that would need edge resolution.
 *
 * One hop, no depth, no ranking: a dependent is a lead, like `dependentsOf`.
 */
export function impactOf(records: readonly StructuralRecordView[], query: ImpactQuery): Result<ImpactReport> {
  const limit = validateLimit(query.limit);
  if (!limit.ok) return limit;
  if (!Array.isArray(query.changedPaths)) return invalid('impact needs a list of changed paths');
  if (query.changedPaths.length === 0) return invalid('impact needs at least one changed path');
  for (const path of query.changedPaths) {
    if (typeof path !== 'string' || path.length === 0) {
      return invalid('every changed path must be a non-empty string');
    }
  }

  const changed = [...new Set(query.changedPaths)].sort(compareCodeUnit);
  const targets: ImpactTarget[] = [];
  const missingPaths: string[] = [];

  for (const path of changed) {
    const outline = outlineOf(records, { path });
    if (!outline.ok) return outline;
    if (outline.value === undefined) {
      missingPaths.push(path);
      continue;
    }

    const dependents = dependentsOf(records, { path, limit: limit.value });
    if (!dependents.ok) return dependents;
    const seen = new Set<string>();
    const unique: DependentHit[] = [];
    const dependentsTruncated = dependents.value.truncated;
    for (const hit of dependents.value.items) {
      if (seen.has(hit.path)) continue;
      seen.add(hit.path);
      unique.push(hit);
    }

    const symbols = paginate(outline.value.symbols, limit.value);
    targets.push({
      path,
      symbols: symbols.items,
      symbolsTruncated: symbols.truncated,
      dependents: unique,
      dependentsTruncated,
      ...(outline.value.parseError === undefined ? {} : { parseError: outline.value.parseError }),
    });
  }

  const boundedTargets = paginate(targets, limit.value);
  const boundedMissing = paginate(missingPaths, limit.value);
  return ok({
    basis: 'imports-only',
    targets: boundedTargets.items,
    missingPaths: boundedMissing.items,
    truncated: boundedTargets.truncated || boundedMissing.truncated,
  });
}
