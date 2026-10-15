import { describe, expect, it } from 'vitest';
import {
  classifyRevisionDelta,
  type RevisionDeltaEntry,
} from './revision-delta.js';

function entry(path: string, contentHash: string): RevisionDeltaEntry {
  return { path, contentHash };
}

describe('revision delta classifier (#210 U5)', () => {
  it('classifies unchanged, changed, added and deleted paths', () => {
    const delta = classifyRevisionDelta(
      [entry('same.ts', 'a'.repeat(64)), entry('chg.ts', 'b'.repeat(64))],
      [entry('same.ts', 'a'.repeat(64)), entry('chg.ts', 'c'.repeat(64)), entry('new.ts', 'd'.repeat(64))],
    );
    const byPath = new Map(delta.map((d) => [d.path, d.classification]));
    expect(byPath.get('same.ts')).toBe('UNCHANGED');
    expect(byPath.get('chg.ts')).toBe('CHANGED');
    expect(byPath.get('new.ts')).toBe('ADDED');
    expect(byPath.get('gone.ts')).toBeUndefined();
  });

  it('detects rename-same-content without re-embedding', () => {
    const delta = classifyRevisionDelta(
      [entry('old.ts', 'a'.repeat(64))],
      [entry('new.ts', 'a'.repeat(64))],
    );
    expect(delta).toHaveLength(1);
    expect(delta[0]).toMatchObject({
      path: 'new.ts',
      classification: 'RENAMED_SAME_CONTENT',
      contentHash: 'a'.repeat(64),
      oldPath: 'old.ts',
    });
  });

  it('does not guess rename-changed from content hashes alone', () => {
    // Pure content-hash matching cannot infer a rename whose content
    // also changed — that needs Git similarity, fed as an explicit hint
    // by a later slice. Honest output is ADDED + DELETED, never a guess.
    const delta = classifyRevisionDelta(
      [entry('old.ts', 'a'.repeat(64))],
      [entry('new.ts', 'b'.repeat(64))],
    );
    const byPath = new Map(delta.map((d) => [d.path, d.classification]));
    expect(byPath.get('new.ts')).toBe('ADDED');
    expect(byPath.get('old.ts')).toBe('DELETED');
  });

  it('marks unresolvable inputs UNVERIFIABLE instead of guessing', () => {
    const delta = classifyRevisionDelta(
      [entry('a.ts', 'not-a-hash')],
      [entry('a.ts', 'also-not-a-hash')],
    );
    expect(delta).toHaveLength(1);
    expect(delta[0]?.classification).toBe('UNVERIFIABLE');
  });
});
