import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CanonicalRefState } from '@unified-mpc/domain';
import { CanonicalRefStore } from './canonical-ref-store.js';

const C100: CanonicalRefState = {
  commitSha: 'a'.repeat(40),
  treeOid: 'b'.repeat(40),
  manifestId: 'man:v1:' + 'c'.repeat(64),
};
const C101: CanonicalRefState = {
  commitSha: 'd'.repeat(40),
  treeOid: 'e'.repeat(40),
  manifestId: 'man:v1:' + 'f'.repeat(64),
};

async function tempStore(): Promise<{ store: CanonicalRefStore; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'canonical-ref-'));
  return { store: new CanonicalRefStore(dir), dir };
}

describe('durable canonical ref store (#210 U7)', () => {
  it('promotes an unset ref to the first verified state', async () => {
    const { store, dir } = await tempStore();
    try {
      const decision = await store.promote('refs/remotes/origin/main', {
        expectedCurrent: null,
        current: null,
        target: C100,
        targetVerified: true,
      });
      expect(decision.action).toBe('promote');
      expect(await store.read('refs/remotes/origin/main')).toEqual(C100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('survives a store re-open with the persisted state', async () => {
    const { store, dir } = await tempStore();
    try {
      await store.promote('refs/remotes/origin/main', {
        expectedCurrent: null,
        current: null,
        target: C100,
        targetVerified: true,
      });
      const reopened = new CanonicalRefStore(dir);
      expect(await reopened.read('refs/remotes/origin/main')).toEqual(C100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CAS-conflicts a stale promoter and keeps the winner state', async () => {
    const { store, dir } = await tempStore();
    try {
      await store.promote('refs/remotes/origin/main', {
        expectedCurrent: null,
        current: null,
        target: C100,
        targetVerified: true,
      });
      // A promoter holding a stale expected-current must lose.
      const decision = await store.promote('refs/remotes/origin/main', {
        expectedCurrent: C101,
        current: C100,
        target: C101,
        targetVerified: true,
      });
      expect(decision.action).toBe('conflict');
      expect(await store.read('refs/remotes/origin/main')).toEqual(C100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unverified targets without touching the persisted state', async () => {
    const { store, dir } = await tempStore();
    try {
      await store.promote('refs/remotes/origin/main', {
        expectedCurrent: null,
        current: null,
        target: C100,
        targetVerified: true,
      });
      const decision = await store.promote('refs/remotes/origin/main', {
        expectedCurrent: C100,
        current: C100,
        target: C101,
        targetVerified: false,
      });
      expect(decision.action).toBe('reject_unverified');
      expect(await store.read('refs/remotes/origin/main')).toEqual(C100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never leaves a partially written ref file behind', async () => {
    const { store, dir } = await tempStore();
    try {
      await store.promote('refs/remotes/origin/main', {
        expectedCurrent: null,
        current: null,
        target: C100,
        targetVerified: true,
      });
      // The persisted JSON must be complete and parseable — a crash-safe
      // tmp+rename write leaves no torn file at the final path.
      const raw = await readFile(path.join(dir, 'refs', 'remotes', 'origin', 'main.json'), 'utf8');
      expect(JSON.parse(raw)).toEqual(C100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
