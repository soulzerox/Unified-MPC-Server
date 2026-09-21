import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type RuntimeDeploymentReferenceKind =
  | 'configured_runtime_root'
  | 'current'
  | 'last_known_good'
  | 'deployment_candidate'
  | 'deployment_previous_active'
  | 'deployment_rollback_target';

export interface RuntimeDeploymentReference {
  readonly kind: RuntimeDeploymentReferenceKind;
  readonly path: string;
  readonly deploymentId?: string;
  readonly status?: string;
}

export interface RuntimeDeploymentReferenceSnapshot {
  readonly runtimeDir: string;
  readonly deploymentStateDir: string;
  readonly references: readonly RuntimeDeploymentReference[];
  readonly uncertainties: readonly string[];
}

export interface RuntimeDeploymentCleanupBlocker {
  readonly blocked: boolean;
  readonly reason: 'active_runtime_reference' | 'runtime_reference_unknown' | null;
  readonly references: readonly RuntimeDeploymentReference[];
  readonly uncertainties: readonly string[];
}

export interface RuntimeDeploymentReferenceOptions {
  readonly runtimeDir?: string;
  readonly deploymentStateDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
}

const ACTIVE_DEPLOYMENT_STATUSES = new Set(['pending', 'activated', 'rollback_pending', 'rollback_failed']);
const TERMINAL_DEPLOYMENT_STATUSES = new Set(['healthy', 'rolled_back', 'failed', 'failed_no_rollback']);
const ACTIVE_REFERENCE_FIELDS = [
  ['candidate_path', 'deployment_candidate'],
  ['previous_active', 'deployment_previous_active'],
  ['rollback_target', 'deployment_rollback_target'],
] as const;
const MAX_STATE_FIELD_BYTES = 16 * 1024;

export async function inspectRuntimeDeploymentReferences(
  options: RuntimeDeploymentReferenceOptions = {},
): Promise<RuntimeDeploymentReferenceSnapshot> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const runtimeDir = path.resolve(
    options.runtimeDir
      ?? env.UNIFIED_MPC_RUNTIME_DIR
      ?? path.join(env.XDG_DATA_HOME ?? path.join(homeDir, '.local', 'share'), 'unified-mpc', 'runtime'),
  );
  const deploymentStateDir = path.resolve(
    options.deploymentStateDir
      ?? env.UNIFIED_MPC_DEPLOY_STATE_DIR
      ?? path.join(env.XDG_STATE_HOME ?? path.join(homeDir, '.local', 'state'), 'unified-mpc', 'deployments'),
  );
  const references: RuntimeDeploymentReference[] = [];
  const uncertainties: string[] = [];

  await inspectConfiguredRuntimeRoot(env.UNIFIED_MPC_ROOT, references, uncertainties);
  await inspectPointer(path.join(runtimeDir, 'current'), 'current', references, uncertainties);
  await inspectPointer(path.join(runtimeDir, 'last-known-good'), 'last_known_good', references, uncertainties);
  await inspectDeploymentRecords(deploymentStateDir, references, uncertainties);

  return {
    runtimeDir,
    deploymentStateDir,
    references: dedupeReferences(references),
    uncertainties: [...new Set(uncertainties)].sort(),
  };
}

export async function runtimeDeploymentCleanupBlocker(
  candidatePath: string,
  options: RuntimeDeploymentReferenceOptions = {},
): Promise<RuntimeDeploymentCleanupBlocker> {
  const snapshot = await inspectRuntimeDeploymentReferences(options);
  if (snapshot.uncertainties.length > 0) {
    return {
      blocked: true,
      reason: 'runtime_reference_unknown',
      references: snapshot.references,
      uncertainties: snapshot.uncertainties,
    };
  }

  if (!path.isAbsolute(candidatePath)) {
    return {
      blocked: true,
      reason: 'runtime_reference_unknown',
      references: snapshot.references,
      uncertainties: ['cleanup candidate path is not absolute'],
    };
  }

  const canonicalCandidate = path.resolve(candidatePath);
  const matches = snapshot.references.filter((reference) => pathsIntersect(canonicalCandidate, reference.path));
  return matches.length === 0
    ? { blocked: false, reason: null, references: [], uncertainties: [] }
    : { blocked: true, reason: 'active_runtime_reference', references: matches, uncertainties: [] };
}

async function inspectConfiguredRuntimeRoot(
  configuredRoot: string | undefined,
  references: RuntimeDeploymentReference[],
  uncertainties: string[],
): Promise<void> {
  const value = configuredRoot?.trim();
  if (value === undefined || value.length === 0) return;
  if (!path.isAbsolute(value)) {
    uncertainties.push('configured UNIFIED_MPC_ROOT is not absolute');
    return;
  }

  let resolved = path.normalize(value);
  try {
    resolved = await realpath(value);
  } catch (error: unknown) {
    if (!hasCode(error, 'ENOENT')) {
      uncertainties.push('configured UNIFIED_MPC_ROOT could not be resolved');
      return;
    }
  }
  references.push({ kind: 'configured_runtime_root', path: resolved });
}

async function inspectPointer(
  pointerPath: string,
  kind: 'current' | 'last_known_good',
  references: RuntimeDeploymentReference[],
  uncertainties: string[],
): Promise<void> {
  let details: Stats;
  try {
    details = await lstat(pointerPath);
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) return;
    uncertainties.push(`unable to inspect runtime pointer ${path.basename(pointerPath)}`);
    return;
  }

  if (!details.isSymbolicLink()) {
    uncertainties.push(`runtime pointer ${path.basename(pointerPath)} is not a symlink`);
    return;
  }

  try {
    const target = await readlink(pointerPath);
    if (target.trim().length === 0) {
      uncertainties.push(`runtime pointer ${path.basename(pointerPath)} has an empty target`);
      return;
    }
    references.push({
      kind,
      path: path.isAbsolute(target) ? path.normalize(target) : path.resolve(path.dirname(pointerPath), target),
    });
  } catch {
    uncertainties.push(`runtime pointer ${path.basename(pointerPath)} could not be read`);
  }
}

async function inspectDeploymentRecords(
  deploymentStateDir: string,
  references: RuntimeDeploymentReference[],
  uncertainties: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(deploymentStateDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) return;
    uncertainties.push('deployment state directory could not be enumerated');
    return;
  }

  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const recordDir = path.join(deploymentStateDir, entry.name);
    const status = await readStateField(recordDir, 'status');
    if (status.kind !== 'value' || status.value.length === 0) {
      uncertainties.push(`deployment ${entry.name} has no trustworthy status`);
      continue;
    }

    if (TERMINAL_DEPLOYMENT_STATUSES.has(status.value)) continue;
    if (!ACTIVE_DEPLOYMENT_STATUSES.has(status.value)) {
      uncertainties.push(`deployment ${entry.name} has unknown status ${status.value}`);
      continue;
    }

    for (const [field, kind] of ACTIVE_REFERENCE_FIELDS) {
      const value = await readStateField(recordDir, field);
      if (value.kind !== 'value') {
        uncertainties.push(`deployment ${entry.name} status ${status.value} is missing ${field}`);
        continue;
      }
      if (field === 'candidate_path' && value.value.length === 0) {
        uncertainties.push(`deployment ${entry.name} status ${status.value} has an empty candidate_path`);
        continue;
      }
      if (value.value.length === 0) continue;
      if (!path.isAbsolute(value.value)) {
        uncertainties.push(`deployment ${entry.name} ${field} is not absolute`);
        continue;
      }
      references.push({
        kind,
        path: path.normalize(value.value),
        deploymentId: entry.name,
        status: status.value,
      });
    }
  }
}

async function readStateField(
  recordDir: string,
  field: string,
): Promise<{ readonly kind: 'value'; readonly value: string } | { readonly kind: 'missing' | 'invalid' }> {
  const filePath = path.join(recordDir, field);
  try {
    const details = await stat(filePath);
    if (!details.isFile() || details.size > MAX_STATE_FIELD_BYTES) return { kind: 'invalid' };
    return { kind: 'value', value: (await readFile(filePath, 'utf8')).trim() };
  } catch (error: unknown) {
    return hasCode(error, 'ENOENT') ? { kind: 'missing' } : { kind: 'invalid' };
  }
}

function pathsIntersect(leftPath: string, rightPath: string): boolean {
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);
  return isSameOrDescendant(left, right) || isSameOrDescendant(right, left);
}

function isSameOrDescendant(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function dedupeReferences(references: readonly RuntimeDeploymentReference[]): readonly RuntimeDeploymentReference[] {
  const seen = new Set<string>();
  const result: RuntimeDeploymentReference[] = [];
  for (const reference of references) {
    const key = `${reference.kind}\0${reference.path}\0${reference.deploymentId ?? ''}\0${reference.status ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(reference);
  }
  return result.sort((left, right) => (
    left.path.localeCompare(right.path)
    || left.kind.localeCompare(right.kind)
    || (left.deploymentId ?? '').localeCompare(right.deploymentId ?? '')
  ));
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as NodeJS.ErrnoException).code === code;
}
