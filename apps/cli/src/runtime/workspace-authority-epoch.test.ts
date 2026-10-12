import { describe, expect, it } from 'vitest';
import { LocalWorkspaceAuthorityEpoch } from './workspace-authority-epoch.js';

describe('local workspace registry authority epoch publisher', () => {
  it('aborts an old generation synchronously and never revives it on relink', () => {
    const epoch = new LocalWorkspaceAuthorityEpoch();
    const first = epoch.signal();
    const firstGeneration = epoch.currentGeneration();
    let synchronousAbort = false;
    first.addEventListener('abort', () => { synchronousAbort = true; });
    epoch.revokeBeforeMutation();
    expect(synchronousAbort).toBe(true);
    expect(first.aborted).toBe(true);
    expect(epoch.currentGeneration()).toBe(firstGeneration + 1);
    const second = epoch.signal();
    expect(second).not.toBe(first);
    expect(second.aborted).toBe(false);
    epoch.revokeBeforeMutation();
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(true);
    expect(epoch.signal().aborted).toBe(false);
    expect(epoch.currentGeneration()).toBe(firstGeneration + 2);
  });
});
