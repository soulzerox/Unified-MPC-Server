import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '@unified-mpc/shared';
import type { UnifiedBuildProvenance, UnifiedRuntimeAdmissionIdentity } from '@unified-mpc/mcp-server';

const DEFAULT_PROVENANCE_PATH = fileURLToPath(new URL('./build-provenance.json', import.meta.url));

export interface RuntimeAdmissionIdentityOptions {
  readonly deploymentId?: string;
  readonly startedAt?: string;
}

export function loadBuildProvenance(path = DEFAULT_PROVENANCE_PATH): UnifiedBuildProvenance {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read Unified build provenance at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isBuildProvenance(parsed)) throw new Error(`Invalid Unified build provenance at ${path}`);
  if (parsed.version !== APP_VERSION) {
    throw new Error(`Unified build provenance version mismatch: artifact=${parsed.version} runtime=${APP_VERSION}`);
  }
  const expectedBuildVersion = `${parsed.version}+${parsed.buildShortCommit}${parsed.buildDirty ? '.dirty' : ''}`;
  if (parsed.buildVersion !== expectedBuildVersion) throw new Error(`Invalid Unified build version: ${parsed.buildVersion}`);
  return parsed;
}

/** Bind admission to the immutable artifact and this exact runtime process. */
export function createRuntimeAdmissionIdentity(
  provenance: UnifiedBuildProvenance,
  options: RuntimeAdmissionIdentityOptions = {},
): UnifiedRuntimeAdmissionIdentity {
  if (!isBuildProvenance(provenance)) throw new Error('Workspace admission requires valid artifact build provenance');
  const deploymentId = options.deploymentId ?? process.env.UNIFIED_MPC_DEPLOYMENT_ID ?? `local-${process.pid}`;
  if (deploymentId.length === 0 || deploymentId.length > 128 || hasControlCharacter(deploymentId)) {
    throw new Error('Workspace admission runtime deployment identity is invalid');
  }
  const startedAt = options.startedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(startedAt))) throw new Error('Workspace admission runtime start time is invalid');
  return Object.freeze({
    runtimeDeploymentId: deploymentId,
    runtimeGeneration: randomUUID(),
    runtimeBuildVersion: provenance.buildVersion,
    runtimeBuildCommit: provenance.buildCommit,
    runtimeBuildDirty: provenance.buildDirty,
    runtimeProtocolGeneration: 1,
    runtimeStartedAt: startedAt,
  });
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function isBuildProvenance(value: unknown): value is UnifiedBuildProvenance {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.version === 'string'
    && typeof candidate.buildVersion === 'string'
    && typeof candidate.buildCommit === 'string'
    && /^[0-9a-f]{40,64}$/iu.test(candidate.buildCommit)
    && typeof candidate.buildShortCommit === 'string'
    && /^[0-9a-f]{12}$/iu.test(candidate.buildShortCommit)
    && candidate.buildCommit.toLowerCase().startsWith(candidate.buildShortCommit.toLowerCase())
    && typeof candidate.buildTime === 'string'
    && !Number.isNaN(Date.parse(candidate.buildTime))
    && typeof candidate.buildDirty === 'boolean';
}
