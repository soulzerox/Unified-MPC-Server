import { describe, expect, it } from 'vitest';

import type { SourceStructuralRecord, StructuralImport, StructuralSymbol } from './structural-extractor.js';
import { definitionsOf, dependentsOf, findSymbols, impactOf, importsOf, outlineOf, repoSummary } from './structural-query.js';

function symbol(overrides: Partial<StructuralSymbol> = {}): StructuralSymbol {
  return { name: 'thing', kind: 'function', startLine: 1, endLine: 1, container: '', exported: true, ...overrides };
}

function record(overrides: Partial<SourceStructuralRecord> = {}): SourceStructuralRecord {
  return {
    path: 'a.ts',
    identity: {
      repository_id: 'repo',
      manifest_id: 'manifest',
      revision_id: 'revision',
      commit_sha: 'a'.repeat(40),
      tree_oid: 'b'.repeat(40),
      ref: 'refs/heads/main',
    },
    fingerprint: `sha256:${'1'.repeat(64)}`,
    language: 'typescript',
    symbols: [symbol()],
    imports: [],
    ...overrides,
  };
}

const records: readonly SourceStructuralRecord[] = [
  record({ path: 'b.ts', symbols: [symbol({ name: 'Thing', startLine: 5 })] }),
  record({ path: 'a.ts', symbols: [symbol({ name: 'thing', startLine: 1 }), symbol({ name: 'thing', startLine: 9, kind: 'class' })] }),
  record({
    path: 'src/c.ts',
    symbols: [],
    parseError: 'line 1: } expected.',
    imports: [
      { specifier: './a.js', kind: 'static', startLine: 1 },
      { specifier: './a', kind: 'dynamic', startLine: 3 },
    ],
  }),
];

describe('structural query', () => {
  it('finds a name across files in path then line order, and reports truncation', () => {
    const all = findSymbols(records, { name: 'thing', limit: 10 });
    if (!all.ok) throw new Error(all.error.message);
    expect(all.value.items.map((hit) => `${hit.path}:${hit.startLine}`)).toEqual(['a.ts:1', 'a.ts:9']);
    expect(all.value.truncated).toBe(false);

    const one = findSymbols(records, { name: 'thing', limit: 1 });
    if (!one.ok) throw new Error(one.error.message);
    expect(one.value.items.map((hit) => hit.startLine)).toEqual([1]);
    expect(one.value.truncated).toBe(true);
  });

  it('narrows by kind, exported and path prefix, and returns an empty page when nothing matches', () => {
    const classes = findSymbols(records, { kind: 'class', limit: 10 });
    if (!classes.ok) throw new Error(classes.error.message);
    expect(classes.value.items.map((hit) => hit.kind)).toEqual(['class']);

    const exported = findSymbols(records, { exported: false, limit: 10 });
    if (!exported.ok) throw new Error(exported.error.message);
    expect(exported.value.items).toEqual([]);

    const prefixed = findSymbols(records, { pathPrefix: 'src/', limit: 10 });
    if (!prefixed.ok) throw new Error(prefixed.error.message);
    // `src/c.ts` parses to no symbols, so a prefix that matches only a broken file
    // is an empty page, not an error.
    expect(prefixed.value.items).toEqual([]);

    const matchedPrefix = findSymbols(records, { pathPrefix: 'a', limit: 10 });
    if (!matchedPrefix.ok) throw new Error(matchedPrefix.error.message);
    expect(matchedPrefix.value.items.map((hit) => hit.path)).toEqual(['a.ts', 'a.ts']);

    // A `null` pathPrefix used to throw out of the `Result` contract; a non-string
    // name or non-boolean exported used to return a quietly empty page.
    for (const bad of [
      { pathPrefix: null as never },
      { name: null as never },
      { name: 3 as never },
      { exported: 'yes' as never },
    ]) {
      const refused = findSymbols(records, { ...bad, limit: 10 });
      expect(refused, JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }

    const kind = findSymbols(records, { kind: 'not-a-kind' as never, limit: 10 });
    expect(kind).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('is case-sensitive and exact for a definition lookup', () => {
    const exact = definitionsOf(records, { name: 'thing', limit: 10 });
    if (!exact.ok) throw new Error(exact.error.message);
    expect(exact.value.items).toHaveLength(2);

    const upper = definitionsOf(records, { name: 'Thing', limit: 10 });
    if (!upper.ok) throw new Error(upper.error.message);
    expect(upper.value.items.map((hit) => hit.path)).toEqual(['b.ts']);

    const partial = definitionsOf(records, { name: 'thin', limit: 10 });
    if (!partial.ok) throw new Error(partial.error.message);
    expect(partial.value.items).toEqual([]);
  });

  it('refuses a limit outside 1..2000, a fractional limit and an empty name', () => {
    for (const limit of [0, -1, 2_001, 1.5, Number.NaN]) {
      expect(findSymbols(records, { limit }), String(limit)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(repoSummary(records, { limit }), String(limit)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(definitionsOf(records, { name: '', limit: 10 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('reports a broken file instead of an empty one, and does not invent a path', () => {
    const broken = outlineOf(records, { path: 'src/c.ts' });
    if (!broken.ok) throw new Error(broken.error.message);
    expect(broken.value?.parseError).toMatch(/line 1/);
    expect(broken.value?.symbols).toEqual([]);

    const missing = outlineOf(records, { path: 'nope.ts' });
    if (!missing.ok) throw new Error(missing.error.message);
    expect(missing.value).toBeUndefined();

    const summary = repoSummary(records, { limit: 10 });
    if (!summary.ok) throw new Error(summary.error.message);
    expect(summary.value).toMatchObject({ fileCount: 3, symbolCount: 3, unparsedCount: 1, truncated: false });
    expect(summary.value.languages).toEqual([{ language: 'typescript', fileCount: 3, symbolCount: 3 }]);

    // The bounded part of the summary is its language breakdown, so a limit of 1
    // over two languages must say so instead of reading as the complete list.
    const twoLanguages = [...records, record({ path: 'd.js', language: 'javascript', symbols: [symbol()] })];
    const bounded = repoSummary(twoLanguages, { limit: 1 });
    if (!bounded.ok) throw new Error(bounded.error.message);
    expect(bounded.value.truncated).toBe(true);
    expect(bounded.value.languages).toHaveLength(1);
    expect(bounded.value.fileCount).toBe(4);
  });

  it('returns imports in line order, respects the limit, and keeps them attached to the file', () => {
    const outline = outlineOf(records, { path: 'src/c.ts' });
    if (!outline.ok) throw new Error(outline.error.message);
    expect(outline.value?.imports.map((entry) => entry.startLine)).toEqual([1, 3]);

    const first = importsOf(records, { path: 'src/c.ts', limit: 1 });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value?.items.map((entry: StructuralImport) => entry.specifier)).toEqual(['./a.js']);
    expect(first.value?.truncated).toBe(true);

    const missing = importsOf(records, { path: 'nope.ts', limit: 1 });
    if (!missing.ok) throw new Error(missing.error.message);
    expect(missing.value).toBeUndefined();
  });

  it('labels every dependent match heuristic and never claims a resolution', () => {
    const hits = dependentsOf(records, { path: 'a.ts', limit: 10 });
    if (!hits.ok) throw new Error(hits.error.message);
    // `./a.js` and `./a` both name a.ts, ordered by line, and each is a guess.
    expect(hits.value.items.map((hit) => `${hit.specifier}:${hit.resolution}`)).toEqual([
      './a.js:heuristic',
      './a:heuristic',
    ]);

    const unrelated = dependentsOf(records, { path: 'b.ts', limit: 10 });
    if (!unrelated.ok) throw new Error(unrelated.error.message);
    expect(unrelated.value.items).toEqual([]);
  });

  it('is a pure function: the same records queried twice give the same answer', () => {
    const first = findSymbols(records, { limit: 10 });
    const second = findSymbols(records, { limit: 10 });
    if (!first.ok || !second.ok) throw new Error('expected both queries to succeed');
    expect(first.value).toEqual(second.value);
    // The input order is not the output order: `b.ts` was first in the fixture.
    expect(first.value.items[0]?.path).toBe('a.ts');
  });
});

describe('structural impact', () => {
  it('names the changed file definitions and the files that import it, one hop only', () => {
    const impact = impactOf(records, { changedPaths: ['a.ts'], limit: 10 });
    if (!impact.ok) throw new Error(impact.error.message);

    expect(impact.value.basis).toBe('imports-only');
    expect(impact.value.truncated).toBe(false);
    const [target] = impact.value.targets;
    if (target === undefined) throw new Error('expected one target');
    expect(target.path).toBe('a.ts');
    expect(target.symbols.map((hit) => hit.startLine)).toEqual([1, 9]);
    // `src/c.ts` names `./a.js` and `./a`; the file is one lead, not two.
    expect(target.dependents.map((hit) => hit.path)).toEqual(['src/c.ts']);
    expect(target.dependentsTruncated).toBe(false);
  });

  it('reports a changed path the generation does not carry instead of calling it unaffected', () => {
    const impact = impactOf(records, { changedPaths: ['gone.ts', 'b.ts'], limit: 10 });
    if (!impact.ok) throw new Error(impact.error.message);

    expect(impact.value.missingPaths).toEqual(['gone.ts']);
    expect(impact.value.targets.map((target) => target.path)).toEqual(['b.ts']);
  });

  it('carries a parse error through, because a partial symbol list is not a complete one', () => {
    const impact = impactOf(records, { changedPaths: ['src/c.ts'], limit: 10 });
    if (!impact.ok) throw new Error(impact.error.message);
    expect(impact.value.targets[0]).toMatchObject({ path: 'src/c.ts', symbols: [], parseError: 'line 1: } expected.' });
  });

  it('bounds every list it returns and says when it did', () => {
    const impact = impactOf(records, { changedPaths: ['a.ts', 'b.ts'], limit: 1 });
    if (!impact.ok) throw new Error(impact.error.message);

    expect(impact.value.targets).toHaveLength(1);
    expect(impact.value.truncated).toBe(true);
    expect(impact.value.targets[0]?.symbolsTruncated).toBe(true);
  });

  it('spends the dependent budget on distinct files, not on repeated specifiers', () => {
    // `a.ts` is imported twice by the same file and once more by another.
    const many = [
      record({ path: 'a.ts', symbols: [symbol()] }),
      record({
        path: 'c.ts',
        symbols: [],
        imports: [
          { specifier: './a.js', kind: 'static', startLine: 1 },
          { specifier: './a', kind: 'dynamic', startLine: 3 },
        ],
      }),
      record({ path: 'd.ts', symbols: [], imports: [{ specifier: './a.js', kind: 'static', startLine: 1 }] }),
    ];

    const impact = impactOf(many, { changedPaths: ['a.ts'], limit: 2 });
    if (!impact.ok) throw new Error(impact.error.message);
    const [target] = impact.value.targets;
    if (target === undefined) throw new Error('expected one target');
    expect(target.dependents.map((hit) => hit.path)).toEqual(['c.ts', 'd.ts']);
    expect(target.dependentsTruncated).toBe(false);

    const tight = impactOf(many, { changedPaths: ['a.ts'], limit: 1 });
    if (!tight.ok) throw new Error(tight.error.message);
    expect(tight.value.targets[0]?.dependents.map((hit) => hit.path)).toEqual(['c.ts']);
    expect(tight.value.targets[0]?.dependentsTruncated).toBe(true);
  });

  it('says when the missing-path list itself was cut', () => {
    const impact = impactOf(records, { changedPaths: ['gone-a.ts', 'gone-b.ts'], limit: 1 });
    if (!impact.ok) throw new Error(impact.error.message);

    expect(impact.value.missingPaths).toHaveLength(1);
    expect(impact.value.truncated).toBe(true);
  });

  it('refuses an empty change set and a non-path entry, and dedupes repeats', () => {
    for (const changedPaths of [[], [''], [3 as never], 'a.ts' as never]) {
      expect(impactOf(records, { changedPaths: changedPaths as never, limit: 10 }))
        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }

    const deduped = impactOf(records, { changedPaths: ['b.ts', 'b.ts'], limit: 10 });
    if (!deduped.ok) throw new Error(deduped.error.message);
    expect(deduped.value.targets).toHaveLength(1);
  });
});
