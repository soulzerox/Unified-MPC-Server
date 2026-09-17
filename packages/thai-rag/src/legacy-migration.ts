import path from 'node:path';
import { parseCanonicalWorkspaceId, type CanonicalWorkspaceId } from './canonical-workspace.js';

export type ThaiRagLegacyDataClass = 'memory' | 'conversation' | 'code-index' | 'code-vector' | 'cpg';

export interface ThaiRagRegisteredWorkspace {
  readonly id: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly realRootPath: string;
}

export type ThaiRagLegacyMigrationDecision =
  | { readonly action: 'import'; readonly workspaceId: CanonicalWorkspaceId; readonly reason: 'canonical-workspace-id' | 'exact-registered-root' }
  | { readonly action: 'reindex'; readonly workspaceId: CanonicalWorkspaceId; readonly reason: 'basename-only-not-identity-proof' }
  | { readonly action: 'preserve-legacy'; readonly reason: 'basename-only-not-identity-proof' | 'ambiguous-workspace-identity' | 'unscoped-or-unproven' };

export function planLegacyScopeMigration(input: {
  readonly scope: string;
  readonly dataClass: ThaiRagLegacyDataClass;
  readonly workspaces: readonly ThaiRagRegisteredWorkspace[];
}): ThaiRagLegacyMigrationDecision {
  const scope = input.scope.trim();
  if (scope.length === 0) return preserve('unscoped-or-unproven');

  const parsedId = parseCanonicalWorkspaceId(scope);
  if (parsedId.ok) {
    const exact = input.workspaces.find((workspace) => workspace.id === parsedId.value);
    if (exact !== undefined) return { action: 'import', workspaceId: parsedId.value, reason: 'canonical-workspace-id' };
  }

  if (path.posix.isAbsolute(scope)) {
    const normalized = normalizeAbsolute(scope);
    const roots = input.workspaces.filter((workspace) => normalized === normalizeAbsolute(workspace.rootPath)
      || normalized === normalizeAbsolute(workspace.realRootPath));
    if (roots.length === 1) {
      const parsed = parseCanonicalWorkspaceId(roots[0]!.id);
      if (parsed.ok) return { action: 'import', workspaceId: parsed.value, reason: 'exact-registered-root' };
    }
    if (roots.length > 1) return preserve('ambiguous-workspace-identity');
    return preserve('unscoped-or-unproven');
  }

  const folded = scope.toLocaleLowerCase('en-US');
  const basenameMatches = input.workspaces.filter((workspace) => {
    const names = new Set([
      workspace.displayName.trim().toLocaleLowerCase('en-US'),
      path.posix.basename(normalizeAbsolute(workspace.rootPath)).toLocaleLowerCase('en-US'),
      path.posix.basename(normalizeAbsolute(workspace.realRootPath)).toLocaleLowerCase('en-US'),
    ]);
    return names.has(folded);
  });
  if (basenameMatches.length > 1) return preserve('ambiguous-workspace-identity');
  if (basenameMatches.length === 1) {
    const parsed = parseCanonicalWorkspaceId(basenameMatches[0]!.id);
    if (!parsed.ok) return preserve('unscoped-or-unproven');
    if (input.dataClass === 'code-index' || input.dataClass === 'code-vector' || input.dataClass === 'cpg') {
      return { action: 'reindex', workspaceId: parsed.value, reason: 'basename-only-not-identity-proof' };
    }
    return preserve('basename-only-not-identity-proof');
  }
  return preserve('unscoped-or-unproven');
}

function normalizeAbsolute(value: string): string {
  return path.posix.normalize(value.trim()).replace(/\/$/, '') || '/';
}

function preserve(reason: Extract<ThaiRagLegacyMigrationDecision, { action: 'preserve-legacy' }>['reason']): ThaiRagLegacyMigrationDecision {
  return { action: 'preserve-legacy', reason };
}
