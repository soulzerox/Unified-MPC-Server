import { describe, expect, it } from 'vitest';
import { planArtifactGc, type GcRootSet } from './artifact-gc.js';

const H = (n: string): string => n.repeat(64).slice(0, 64);
const entries = (...hashes: string[]): readonly { path: string; contentHash: string }[] =>
  hashes.map((contentHash, index) => ({ path: `f${index}.ts`, contentHash }));

function roots(overrides: Partial<GcRootSet> = {}): GcRootSet {
  return {
    canonicalRefManifests: [],
    pinnedManifests: [],
    goalOverlayBases: [],
    indexJobManifests: [],
    ...overrides,
  };
}

describe('artifact GC reachability plan (#210 U17)', () => {
  it('retains an artifact referenced only by a pin', async () => {
    const plan = planArtifactGc({
      roots: roots({ pinnedManifests: [entries(H('1'))] }),
      candidates: [H('1'), H('2')],
    });
    expect(plan).toMatchObject({ status: 'planned' });
    if (plan.status !== 'planned') throw new Error('unexpected');
    expect(plan.unreachable).toEqual([H('2')]);
    expect(plan.reachable).toEqual([H('1')]);
  });

  it('retains an artifact reachable only through a goal overlay base', async () => {
    const plan = planArtifactGc({
      roots: roots({ goalOverlayBases: [entries(H('3'))] }),
      candidates: [H('3')],
    });
    expect(plan).toMatchObject({ status: 'planned' });
    if (plan.status !== 'planned') throw new Error('unexpected');
    expect(plan.unreachable).toEqual([]);
  });

  it('marks artifacts referenced by no root as unreachable, deduped and sorted', async () => {
    const plan = planArtifactGc({
      roots: roots({
        canonicalRefManifests: [entries(H('1'), H('2'))],
        indexJobManifests: [entries(H('2'))],
      }),
      candidates: [H('5'), H('4'), H('5'), H('2')],
    });
    expect(plan).toMatchObject({ status: 'planned' });
    if (plan.status !== 'planned') throw new Error('unexpected');
    expect(plan.unreachable).toEqual([H('4'), H('5')]);
  });

  it('refuses to plan when no reachability roots were supplied', () => {
    const plan = planArtifactGc({ roots: roots(), candidates: [H('1')] });
    expect(plan).toMatchObject({ status: 'refused' });
    if (plan.status !== 'refused') throw new Error('unexpected');
    expect(plan.reason).toMatch(/root/);
  });

  it('never returns a reachable artifact as unreachable across every root kind', () => {
    const plan = planArtifactGc({
      roots: {
        canonicalRefManifests: [entries(H('a'))],
        pinnedManifests: [entries(H('b'))],
        goalOverlayBases: [entries(H('c'))],
        indexJobManifests: [entries(H('d'))],
      },
      candidates: [H('a'), H('b'), H('c'), H('d'), H('e')],
    });
    if (plan.status !== 'planned') throw new Error('unexpected');
    expect(plan.unreachable).toEqual([H('e')]);
  });
});
