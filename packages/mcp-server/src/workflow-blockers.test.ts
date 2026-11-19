import { describe, expect, it } from 'vitest';
import { explainMutationBlockers } from './workflow-blockers.js';

const optedIn = { mutate: 'require_preparation', mutateOpaque: 'allow' } as const;
const optedInAndOpaqueRefused = { mutate: 'require_preparation', mutateOpaque: 'refuse' } as const;
const byDefault = { mutate: 'auto_prepare', mutateOpaque: 'allow' } as const;

describe('explainMutationBlockers', () => {
  it('says a default workspace prepares evidence on demand instead of reporting a barrier it does not have', () => {
    const projection = explainMutationBlockers({ gate: byDefault, harness: 'inactive' });

    expect(projection).toMatchObject({ phase: 'mutate', mode: 'auto_prepare', evaluated: true, blocked: false });
    expect(projection.blockers).toEqual([]);
    expect(projection.note).toContain('prepares evidence on demand');
  });

  it('names the action that clears each blocker, in the order the gate raises them', () => {
    const projection = explainMutationBlockers({
      gate: optedIn,
      harness: 'active',
      requestedPaths: ['src/a.ts', 'src/b.ts'],
      preparedPaths: ['src/a.ts'],
    });

    expect(projection).toMatchObject({ blocked: true, evaluated: true });
    expect(projection.blockers).toEqual([{
      code: 'preparation_missing',
      detail: 'src/b.ts',
      clearedBy: 'Run prepare_code_change for this path against the current workspace state',
    }]);
  });

  it('reports staleness as its own blocker, because the fix is a different sequence', () => {
    const projection = explainMutationBlockers({ gate: optedIn, harness: 'stale', requestedPaths: ['src/a.ts'], preparedPaths: ['src/a.ts'] });

    expect(projection.blockers).toEqual([{
      code: 'harness_stale',
      clearedBy: 'The workspace harness changed: run workspace_bootstrap, then prepare_code_change again',
    }]);
  });

  it('does not demand a path a stale harness would never be asked about', () => {
    // The seam returns on `harness_stale` before the preparation check, so the
    // projection must not tell an operator to prepare a path yet.
    const projection = explainMutationBlockers({ gate: optedIn, harness: 'stale', requestedPaths: ['src/a.ts'] });

    expect(projection.blockers.map((blocker) => blocker.code)).toEqual(['harness_stale']);
  });

  it('treats a harness this session never activated as the refusal the gate would give', () => {
    const projection = explainMutationBlockers({ gate: optedIn, harness: 'unknown', unreadable: 'no_activation', requestedPaths: ['src/a.ts'] });

    // The gate refuses in this state (an absent harness is `inactive`), so the
    // projection reports that refusal rather than inventing "unblocked" — and only
    // that refusal: the seam returns before it reads a preparation, so demanding a
    // path here would claim a step the gate never asks for.
    expect(projection).toMatchObject({ blocked: true, evaluated: false });
    expect(projection.blockers.map((blocker) => blocker.code)).toEqual(['harness_inactive']);
    expect(projection.blockers[0]?.clearedBy).toContain('workspace_bootstrap');
    expect(projection.note).toContain('No harness is active for this session');
  });

  it('says which read failed, so an unreadable harness is not reported as an absent one', () => {
    const projection = explainMutationBlockers({ gate: optedIn, harness: 'unknown', unreadable: 'agents_md' });

    expect(projection).toMatchObject({ blocked: true, evaluated: false });
    expect(projection.note).toContain('AGENTS.md');
    // `workspace_bootstrap` re-reads the same file and fails the same way, so the
    // action names the read instead of a command that cannot clear it.
    expect(projection.blockers[0]?.clearedBy).toContain('AGENTS.md read itself fails');
  });

  it('does not call an unreadable harness a missing fact for a posture that never reads it', () => {
    const projection = explainMutationBlockers({ gate: byDefault, harness: 'unknown', unreadable: 'no_activation' });

    expect(projection).toMatchObject({ blocked: false, evaluated: true });
    expect(projection.blockers).toEqual([]);
  });

  it('drops a preparation the seam would have wiped when the workspace source moved', () => {
    const projection = explainMutationBlockers({
      gate: optedIn,
      harness: 'active',
      requestedPaths: ['src/a.ts'],
      preparedPaths: ['src/a.ts'],
      sourceMoved: true,
    });

    expect(projection.blockers.map((blocker) => blocker.code)).toEqual(['preparation_missing']);
    expect(projection.note).toContain('source moved');
  });

  it('names the opaque half instead of implying the whole phase is satisfied', () => {
    const projection = explainMutationBlockers({ gate: optedInAndOpaqueRefused, harness: 'active' });

    expect(projection).toMatchObject({ blocked: false, evaluated: true });
    expect(projection.note).toContain('mutateOpaque: refuse');
  });
});
