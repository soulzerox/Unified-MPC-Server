/* global process, URL */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findStaleDeployments,
  findUnattestedDeployments,
} from './check-dist-provenance-freshness.mjs';

const scriptPath = fileURLToPath(new URL('./check-dist-provenance-freshness.mjs', import.meta.url));

/**
 * `#790`: the check only looked at `dist` directories that already carried
 * `build-provenance.json`, so deleting the file made the gate report "nothing
 * to verify" and exit 0 while the runtime could no longer report its build.
 * These tests pin that a shipped app without provenance is a failure, that a
 * checkout with no build is still a no-op, and that the staleness rule the
 * script exists for keeps working.
 */

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('deployment build provenance freshness', () => {
  it('reports a shipped app whose dist has no provenance', () => {
    const root = fixtureRoot();
    writeManifest(root, 'cli', { name: '@unified-mpc/cli', bin: { 'unified-mpc': './dist/index.js' } });
    writeArtifact(root, 'cli', 'index.js', 1_700_000_000_000);

    const { checked, violations } = findStaleDeployments(root);
    const unattested = findUnattestedDeployments(root);

    assert.deepEqual(checked, []);
    assert.deepEqual(violations, []);
    assert.equal(unattested.length, 1);
    assert.equal(unattested[0].distDirectory, path.join(root, 'apps', 'cli', 'dist'));
  });

  it('reports a shipped app whose string bin has no provenance', () => {
    const root = fixtureRoot();
    writeManifest(root, 'cli', { name: '@unified-mpc/cli', bin: './dist/index.js' });
    writeArtifact(root, 'cli', 'index.js', 1_700_000_000_000);

    const unattested = findUnattestedDeployments(root);

    assert.equal(unattested.length, 1);
    assert.equal(unattested[0].distDirectory, path.join(root, 'apps', 'cli', 'dist'));
  });

  it('ignores an app dist that ships no executable', () => {
    const root = fixtureRoot();
    writeManifest(root, 'web', { name: '@unified-mpc/web' });
    writeArtifact(root, 'web', 'index.html', 1_700_000_000_000);

    assert.deepEqual(findUnattestedDeployments(root), []);
  });

  it('treats a checkout with no dist as nothing to verify', () => {
    const root = fixtureRoot();
    writeManifest(root, 'cli', { name: '@unified-mpc/cli', bin: './dist/index.js' });

    assert.deepEqual(findUnattestedDeployments(root), []);
    assert.deepEqual(findStaleDeployments(root).checked, []);
  });

  it('reports an artifact newer than its provenance', () => {
    const root = fixtureRoot();
    writeManifest(root, 'cli', { name: '@unified-mpc/cli', bin: './dist/index.js' });
    const provenance = writeProvenance(root, 'cli', 1_700_000_000_000);
    writeArtifact(root, 'cli', 'index.js', 1_700_000_005_000);

    const { checked, violations } = findStaleDeployments(root, { toleranceMs: 0 });

    assert.equal(checked.length, 1);
    assert.equal(checked[0].provenancePath, provenance);
    assert.equal(violations.length, 1);
    assert.deepEqual(
      violations[0].newerFiles.map((file) => path.basename(file.path)),
      ['index.js'],
    );
    assert.deepEqual(findUnattestedDeployments(root), []);
  });

  it('accepts a deployment whose provenance is newer than its artifacts', () => {
    const root = fixtureRoot();
    writeManifest(root, 'cli', { name: '@unified-mpc/cli', bin: './dist/index.js' });
    writeArtifact(root, 'cli', 'index.js', 1_700_000_000_000);
    writeProvenance(root, 'cli', 1_700_000_005_000);

    const { checked, violations } = findStaleDeployments(root, { toleranceMs: 0 });

    assert.equal(checked.length, 1);
    assert.deepEqual(violations, []);
    assert.deepEqual(findUnattestedDeployments(root), []);
  });

  it('fails when a built CLI lost its provenance before the gate runs', () => {
    const root = fixtureRoot();
    writeManifest(root, 'cli', { name: '@unified-mpc/cli', bin: { 'unified-mpc': './dist/index.js' } });
    writeArtifact(root, 'cli', 'index.js', 1_700_000_000_000);

    const result = spawnSync(process.execPath, [scriptPath, '--root', root], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unattested deployment artifacts/u);
    assert.match(result.stderr, /apps\/cli\/dist/u);
    assert.doesNotMatch(result.stdout, /nothing to verify/u);
  });

  it('reports both an unattested and a stale deployment in one run', () => {
    const root = fixtureRoot();
    writeManifest(root, 'cli', { name: '@unified-mpc/cli', bin: './dist/index.js' });
    writeArtifact(root, 'cli', 'index.js', 1_700_000_000_000);
    writeManifest(root, 'worker', { name: '@unified-mpc/worker', bin: { worker: './dist/index.js' } });
    writeProvenance(root, 'worker', 1_700_000_000_000);
    writeArtifact(root, 'worker', 'index.js', 1_700_000_005_000);

    const result = spawnSync(process.execPath, [scriptPath, '--root', root], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unattested deployment artifacts: apps\/cli\/dist/u);
    assert.match(result.stderr, /Stale deployment artifacts: 1 file in apps\/worker\/dist/u);
    assert.match(result.stderr, /the deployment must not stay without a build identity/u);
    assert.match(result.stderr, /the provenance describes the artifacts it ships with/u);
    assert.doesNotMatch(result.stdout, /Deployment provenance is fresh/u);
  });

  it('stays a no-op when the checkout was never built', () => {
    const root = fixtureRoot();
    writeManifest(root, 'cli', { name: '@unified-mpc/cli', bin: './dist/index.js' });

    const result = spawnSync(process.execPath, [scriptPath, '--root', root], { encoding: 'utf8' });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /nothing to verify/u);
  });
});

function fixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'unified-mpc-provenance-'));
  roots.push(root);
  return root;
}

function writeManifest(root, app, manifest) {
  const appRoot = path.join(root, 'apps', app);
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify(manifest), 'utf8');
}

function writeArtifact(root, app, name, mtimeMs) {
  const artifactPath = path.join(root, 'apps', app, 'dist', name);
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, '// built\n', 'utf8');
  utimesSync(artifactPath, new Date(mtimeMs), new Date(mtimeMs));
  return artifactPath;
}

function writeProvenance(root, app, mtimeMs) {
  const provenancePath = path.join(root, 'apps', app, 'dist', 'build-provenance.json');
  mkdirSync(path.dirname(provenancePath), { recursive: true });
  writeFileSync(provenancePath, JSON.stringify({ buildVersion: '0.0.0-test' }), 'utf8');
  utimesSync(provenancePath, new Date(mtimeMs), new Date(mtimeMs));
  return provenancePath;
}
