/* global process */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function buildTime(environment = process.env) {
  const sourceDateEpoch = environment.SOURCE_DATE_EPOCH?.trim();
  if (sourceDateEpoch === undefined || sourceDateEpoch.length === 0) return new Date().toISOString();
  if (!/^\d+$/.test(sourceDateEpoch)) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer number of seconds');
  const milliseconds = Number(sourceDateEpoch) * 1000;
  if (!Number.isSafeInteger(milliseconds)) throw new Error('SOURCE_DATE_EPOCH is outside the supported date range');
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) throw new Error('SOURCE_DATE_EPOCH is outside the supported date range');
  return date.toISOString();
}

const workingDirectory = process.cwd();
const repositoryRoot = git(['rev-parse', '--show-toplevel'], workingDirectory);
const buildCommit = git(['rev-parse', '--verify', 'HEAD'], repositoryRoot);
const buildShortCommit = buildCommit.slice(0, 12);
const buildDirty = git(['status', '--porcelain'], repositoryRoot).length > 0;
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const version = String(packageJson.version ?? '').trim();
if (version.length === 0) throw new Error('Root package.json does not contain a semantic application version');

const provenance = {
  version,
  buildVersion: `${version}+${buildShortCommit}${buildDirty ? '.dirty' : ''}`,
  buildCommit,
  buildShortCommit,
  buildTime: buildTime(),
  buildDirty,
};

const outputPath = path.resolve(workingDirectory, process.argv[2] ?? 'dist/build-provenance.json');
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
process.stdout.write(`Build provenance: ${provenance.buildVersion} -> ${outputPath}\n`);
