#!/usr/bin/env node
/* global process */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fail when a deployed `dist` contains artifacts newer than its build provenance.
 *
 * `dist/build-provenance.json` is the only identity a running deployment reports,
 * and it is written by the `build` script after every artifact exists. A later
 * compile into the same `dist` (for example the old destructive root `typecheck`,
 * see issue #456) leaves newer code under an older label: the runtime keeps
 * serving a commit it was never built from, and `runtimeBuildDirty` cannot see it
 * because it only records whether the worktree was dirty at build time.
 */

const PROVENANCE_FILE = 'build-provenance.json';
const DEFAULT_TOLERANCE_MS = 2000;
const MAX_REPORTED_FILES = 5;

export function scanDeployments(root) {
  const absoluteRoot = path.resolve(root);
  const deployments = [];
  for (const group of ['apps', 'packages']) {
    const groupRoot = path.join(absoluteRoot, group);
    if (!fs.existsSync(groupRoot)) continue;
    for (const entry of fs.readdirSync(groupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const distDirectory = path.join(groupRoot, entry.name, 'dist');
      const provenancePath = path.join(distDirectory, PROVENANCE_FILE);
      if (!fs.existsSync(provenancePath)) continue;
      deployments.push({ distDirectory, provenancePath });
    }
  }
  return deployments;
}

export function findStaleDeployments(root, options = {}) {
  const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const checked = [];
  const violations = [];
  for (const deployment of scanDeployments(root)) {
    const provenanceTime = fs.statSync(deployment.provenancePath).mtimeMs;
    const newerFiles = [];
    let newestFile;
    for (const file of walk(deployment.distDirectory)) {
      if (file === deployment.provenancePath) continue;
      const { mtimeMs } = fs.statSync(file);
      if (newestFile === undefined || mtimeMs > newestFile.mtimeMs) newestFile = { path: file, mtimeMs };
      if (mtimeMs > provenanceTime + toleranceMs) newerFiles.push({ path: file, mtimeMs });
    }
    const record = {
      distDirectory: deployment.distDirectory,
      provenancePath: deployment.provenancePath,
      provenanceTime,
      newestFile,
      newerFiles: newerFiles.sort((left, right) => right.mtimeMs - left.mtimeMs),
      buildVersion: readBuildVersion(deployment.provenancePath),
    };
    checked.push(record);
    if (newerFiles.length > 0) violations.push(record);
  }
  return { checked, violations };
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function readBuildVersion(provenancePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
    return typeof parsed?.buildVersion === 'string' ? parsed.buildVersion : undefined;
  } catch {
    return undefined;
  }
}

function describeTolerance(milliseconds) {
  return `${milliseconds}ms`;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(argumentValue('--root') ?? process.cwd());
  const toleranceArgument = argumentValue('--tolerance-ms');
  const toleranceMs = toleranceArgument === undefined ? DEFAULT_TOLERANCE_MS : Number(toleranceArgument);
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
    process.stderr.write('--tolerance-ms must be a non-negative number of milliseconds\n');
    process.exit(2);
  }
  const { checked, violations } = findStaleDeployments(root, { toleranceMs });
  if (checked.length === 0) {
    process.stdout.write('No deployment build provenance found; nothing to verify.\n');
  } else if (violations.length === 0) {
    for (const deployment of checked) {
      process.stdout.write(
        `Deployment provenance is fresh: ${path.relative(root, deployment.provenancePath)} (${deployment.buildVersion ?? 'unknown build version'})\n`,
      );
    }
  } else {
    for (const violation of violations) {
      const provenanceLabel = `${path.relative(root, violation.provenancePath)} (${new Date(violation.provenanceTime).toISOString()}`;
      process.stderr.write(
        `Stale deployment artifacts: ${row(violation.newerFiles.length)} in ${path.relative(root, violation.distDirectory)} `
        + `are newer than ${provenanceLabel}${violation.buildVersion === undefined ? '' : `, buildVersion ${violation.buildVersion}`}`
        + `) by more than ${describeTolerance(toleranceMs)}.\n`,
      );
      for (const file of violation.newerFiles.slice(0, MAX_REPORTED_FILES)) {
        process.stderr.write(`- ${path.relative(root, file.path)} (${new Date(file.mtimeMs).toISOString()})\n`);
      }
      const hidden = violation.newerFiles.length - MAX_REPORTED_FILES;
      if (hidden > 0) process.stderr.write(`- ... and ${row(hidden)} more\n`);
    }
    process.stderr.write(
      'The deployment would report a build the runtime was not compiled from. '
      + 'Run a clean rebuild (`rm -rf apps/*/dist` plus the project `dist` directories, then `pnpm build`) '
      + 'so the provenance describes the artifacts it ships with.\n',
    );
    process.exitCode = 1;
  }
}

function row(count) {
  return `${count} file${count === 1 ? '' : 's'}`;
}
