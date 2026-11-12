import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSmokeChildEnv } from './smoke-runtime-child-env.mjs';

const temporaryRoot = path.join(os.tmpdir(), 'unified-mpc-smoke-child-env');

const baseEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/operator',
  XDG_DATA_HOME: '/home/operator/.local/share',
  UNIFIED_MPC_DATA_PATH: '/home/operator/.local/share/unified-mpc',
  UNIFIED_MPC_WORKSPACE: '/home/operator/work',
  UNIFIED_MPC_PORT: '18765',
};

function assertInsideTemporaryRoot(value, label) {
  const relative = path.relative(temporaryRoot, value);
  assert.equal(
    relative.startsWith('..') || path.isAbsolute(relative),
    false,
    `${label} must stay inside the throwaway root, got ${value}`,
  );
}

test('redirects every home-derived root the storage identity guard inspects', () => {
  const env = createSmokeChildEnv({ temporaryRoot, baseEnv });
  // `inspectStorageIdentity` derives its historical candidates from HOME,
  // XDG_DATA_HOME and os.homedir() (which prefers $HOME on Linux). A single
  // one left at the operator's real path makes the smoke fail with
  // STORAGE_IDENTITY_DRIFT on any machine that has run unified-mpc before.
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME']) {
    assertInsideTemporaryRoot(env[key], key);
  }
  assert.notEqual(env.HOME, baseEnv.HOME);
  assert.notEqual(env.XDG_DATA_HOME, baseEnv.XDG_DATA_HOME);
});

test('moves the runtime workspace, data root and port into the throwaway root', () => {
  const env = createSmokeChildEnv({ temporaryRoot, baseEnv });
  assertInsideTemporaryRoot(env.UNIFIED_MPC_WORKSPACE, 'UNIFIED_MPC_WORKSPACE');
  assertInsideTemporaryRoot(env.UNIFIED_MPC_DATA_PATH, 'UNIFIED_MPC_DATA_PATH');
  assert.equal(env.UNIFIED_MPC_DATA_PATH, path.join(temporaryRoot, 'data'));
  // Port 0 keeps the smoke off the live desktop runtime's port.
  assert.equal(env.UNIFIED_MPC_PORT, '0');
});

test('keeps the rest of the parent environment', () => {
  const env = createSmokeChildEnv({ temporaryRoot, baseEnv });
  assert.equal(env.PATH, baseEnv.PATH);
  const extra = createSmokeChildEnv({ temporaryRoot, baseEnv: { SMOKE_ONLY: 'kept' } });
  assert.equal(extra.SMOKE_ONLY, 'kept');
});
