import path from 'node:path';
import {
  prepareManagedWorktreeDependencyBootstrap,
  type ManagedWorktreeDependencyBootstrapInput,
  type ManagedWorktreeDependencyBootstrapResult,
} from './dependency-cache-lifecycle.js';

export interface DelegatedWorkspaceDependencyContractInput {
  readonly parent: Omit<ManagedWorktreeDependencyBootstrapInput, 'lifecycle'>;
  readonly child: Omit<ManagedWorktreeDependencyBootstrapInput, 'lifecycle'>;
}

export interface DelegatedWorkspaceDependencyContract {
  readonly status: 'ready' | 'blocked';
  readonly parent: ManagedWorktreeDependencyBootstrapResult;
  readonly child: ManagedWorktreeDependencyBootstrapResult;
  readonly blockingReasons: readonly string[];
}

/**
 * Contract boundary for #6 delegated work: reuse #35/#34 policy, share only
 * reusable stores, and never give parent and child the same mutable tree.
 */
export async function prepareDelegatedWorkspaceDependencyContract(
  input: DelegatedWorkspaceDependencyContractInput,
): Promise<DelegatedWorkspaceDependencyContract> {
  const [parent, child] = await Promise.all([
    prepareManagedWorktreeDependencyBootstrap({ ...input.parent, lifecycle: 'goal' }),
    prepareManagedWorktreeDependencyBootstrap({ ...input.child, lifecycle: 'delegated' }),
  ]);
  const blockingReasons: string[] = [];

  if (parent.plan.status !== 'ready') blockingReasons.push('goal dependency bootstrap is blocked');
  if (child.plan.status !== 'ready') blockingReasons.push('delegated dependency bootstrap is blocked');
  if (!parent.plan.isolation.safe) blockingReasons.push('goal mutable dependency isolation is unsafe');
  if (!child.plan.isolation.safe) blockingReasons.push('delegated mutable dependency isolation is unsafe');
  if (!samePaths(parent.plan.strategy.sharedPaths, child.plan.strategy.sharedPaths)) {
    blockingReasons.push('goal and delegated workspaces must use the same shared dependency policy');
  }
  if (pathsOverlap(parent.plan.strategy.worktreeLocalPaths, child.plan.strategy.worktreeLocalPaths)) {
    blockingReasons.push('parent and delegated workspaces must not share mutable dependency trees');
  }

  return {
    status: blockingReasons.length === 0 ? 'ready' : 'blocked',
    parent,
    child,
    blockingReasons,
  };
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  const normalized = (paths: readonly string[]): Set<string> => new Set(paths.map((entry) => path.resolve(entry)));
  const leftSet = normalized(left);
  const rightSet = normalized(right);
  return leftSet.size === rightSet.size && [...leftSet].every((entry) => rightSet.has(entry));
}

function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftPath) => right.some((rightPath) => isPathInsideOrEqual(leftPath, rightPath) || isPathInsideOrEqual(rightPath, leftPath)));
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
