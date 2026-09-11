import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type {
  InstallTarget,
  PruneServerInput,
  PruneServerResult,
  PruneSkillInput,
  PruneSkillResult,
} from '@unified-mpc/extensions';

export interface PruneSkillCommand {
  readonly kind: 'prune-skill';
  readonly name: string;
  readonly targets?: readonly InstallTarget[];
  readonly workspaceRoot?: string;
}

export interface PruneServerCommand {
  readonly kind: 'prune-server';
  readonly name: string;
  readonly targets?: readonly InstallTarget[];
  readonly workspaceRoot?: string;
  readonly killProcess?: boolean;
}

export function parsePruneSkillArgs(args: readonly string[]): Result<PruneSkillCommand> {
  if (args.length < 1) {
    return err(appError('INVALID_INPUT', 'Usage: unified-mpc prune skill <name> [--targets <t1,t2,...>]'));
  }

  const name = args[0]!.trim();
  if (name.length === 0) {
    return err(appError('INVALID_INPUT', 'Skill name is required'));
  }

  let targets: InstallTarget[] = ['all'];
  let workspaceRoot: string | undefined;

  for (let i = 1; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--targets' && args[i + 1] !== undefined) {
      targets = args[i + 1]!.split(',').map((t) => t.trim() as InstallTarget).filter(Boolean);
      i += 1;
    } else if (flag === '--workspace' && args[i + 1] !== undefined) {
      workspaceRoot = args[i + 1]!.trim();
      i += 1;
    }
  }

  return ok({
    kind: 'prune-skill',
    name,
    targets,
    ...(workspaceRoot ? { workspaceRoot } : {}),
  });
}

export function parsePruneServerArgs(args: readonly string[]): Result<PruneServerCommand> {
  if (args.length < 1) {
    return err(appError('INVALID_INPUT', 'Usage: unified-mpc prune server <name> [--targets <t1,t2,...>] [--no-kill]'));
  }

  const name = args[0]!.trim();
  if (name.length === 0) {
    return err(appError('INVALID_INPUT', 'Server name is required'));
  }

  let targets: InstallTarget[] = ['all'];
  let workspaceRoot: string | undefined;
  let killProcess = true;

  for (let i = 1; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--targets' && args[i + 1] !== undefined) {
      targets = args[i + 1]!.split(',').map((t) => t.trim() as InstallTarget).filter(Boolean);
      i += 1;
    } else if (flag === '--workspace' && args[i + 1] !== undefined) {
      workspaceRoot = args[i + 1]!.trim();
      i += 1;
    } else if (flag === '--no-kill') {
      killProcess = false;
    }
  }

  return ok({
    kind: 'prune-server',
    name,
    targets,
    killProcess,
    ...(workspaceRoot ? { workspaceRoot } : {}),
  });
}

export async function runPruneSkill(
  service: { pruneSkill(input: PruneSkillInput): Promise<Result<PruneSkillResult>> },
  input: PruneSkillInput,
): Promise<Result<PruneSkillResult>> {
  return service.pruneSkill(input);
}

export async function runPruneServer(
  service: { pruneServer(input: PruneServerInput): Promise<Result<PruneServerResult>> },
  input: PruneServerInput,
): Promise<Result<PruneServerResult>> {
  return service.pruneServer(input);
}
