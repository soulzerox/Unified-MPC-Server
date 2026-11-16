import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RELEASE_COMMANDS } from './release-verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MATERIALIZE_REGRESSION = 'scripts/materialize-runtime-release.test.sh';

function indexOfCommand(predicate) {
  return RELEASE_COMMANDS.findIndex(([, args]) => predicate(args));
}

test('the release gate boots the artifact it ships', () => {
  // #778 fixed the materialized smoke and #779 gave it port coverage, but
  // nothing ran the smoke itself: `release:verify` ended at the source-tree
  // smoke, so a release could pass the gate without ever booting the artifact
  // it ships.
  const materialize = indexOfCommand((args) => args.includes(MATERIALIZE_REGRESSION));
  assert.notEqual(materialize, -1, 'release:verify must run the materialized release regression');

  const build = indexOfCommand((args) => args.join(' ') === 'pnpm build');
  assert.notEqual(build, -1, 'release:verify must build before it materializes');
  assert.ok(materialize > build, 'the materialized regression runs against built output, so it needs build first');
});

test('the release gate runs the runtime-root preflight regression', () => {
  // #835: the preflight is the only thing standing between a release whose
  // import closure is incomplete and a restart that dies with
  // ERR_MODULE_NOT_FOUND, so its own regression must run in the gate.
  const preflight = indexOfCommand((args) => args.includes('scripts/validate-runtime-root.test.sh'));
  assert.notEqual(preflight, -1, 'release:verify must run the runtime-root preflight regression');
});

test('every repository script a release step runs exists', () => {
  const missing = [];
  for (const [, args] of RELEASE_COMMANDS) {
    for (const argument of args) {
      if (!argument.startsWith('scripts/')) continue;
      if (!existsSync(path.join(ROOT, argument))) missing.push(argument);
    }
  }
  assert.deepEqual(missing, [], 'a release step names a repository script that does not exist');
});
