import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type {
  InstallServerInput,
  InstallServerResult,
  InstallSkillInput,
  InstallSkillResult,
  InstallTarget,
  InstallScope,
} from '@unified-mpc/extensions';

export interface InstallSkillCommand {
  readonly kind: 'install-skill';
  readonly name: string;
  readonly source: string;
  readonly targets: readonly InstallTarget[];
  readonly scope?: InstallScope;
  readonly workspaceRoot?: string;
}

export interface InstallServerCommand {
  readonly kind: 'install-server';
  readonly name: string;
  readonly transport: 'stdio' | 'sse' | 'http';
  readonly command?: string;
  readonly source?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly cwd?: string;
  readonly targets: readonly InstallTarget[];
  readonly scope?: InstallScope;
  readonly workspaceRoot?: string;
}

export function parseInstallSkillArgs(args: readonly string[]): Result<InstallSkillCommand> {
  if (args.length < 2) {
    return err(appError('INVALID_INPUT', 'Usage: unified-mpc install skill <name> <source> [--targets <t1,t2,...>] [--scope global|workspace]'));
  }

  const name = args[0]!.trim();
  const source = args[1]!.trim();
  if (name.length === 0 || source.length === 0) {
    return err(appError('INVALID_INPUT', 'Skill name and source path are required'));
  }

  let targets: InstallTarget[] = ['all'];
  let scope: InstallScope = 'global';
  let workspaceRoot: string | undefined;

  for (let i = 2; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--targets' && args[i + 1] !== undefined) {
      targets = args[i + 1]!.split(',').map((t) => t.trim() as InstallTarget).filter(Boolean);
      i += 1;
    } else if (flag === '--scope' && args[i + 1] !== undefined) {
      scope = args[i + 1]!.trim() as InstallScope;
      i += 1;
    } else if (flag === '--workspace' && args[i + 1] !== undefined) {
      workspaceRoot = args[i + 1]!.trim();
      i += 1;
    }
  }

  return ok({
    kind: 'install-skill',
    name,
    source,
    targets,
    scope,
    ...(workspaceRoot ? { workspaceRoot } : {}),
  });
}

export function parseInstallServerArgs(args: readonly string[]): Result<InstallServerCommand> {
  if (args.length < 1) {
    return err(appError('INVALID_INPUT', 'Usage: unified-mpc install server <name> [--command <cmd> | --url <url>]'));
  }

  const name = args[0]!.trim();
  if (name.length === 0) {
    return err(appError('INVALID_INPUT', 'Server name is required'));
  }

  let transport: 'stdio' | 'sse' | 'http' | undefined;
  let command: string | undefined;
  let source: string | undefined;
  let serverArgs: string[] | undefined;
  let env: Record<string, string> | undefined;
  let url: string | undefined;
  let cwd: string | undefined;
  let targets: InstallTarget[] = ['all'];
  let scope: InstallScope = 'global';
  let workspaceRoot: string | undefined;

  for (let i = 1; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--command' && args[i + 1] !== undefined) {
      command = args[i + 1]!.trim();
      i += 1;
    } else if (flag === '--source' && args[i + 1] !== undefined) {
      source = args[i + 1]!.trim();
      i += 1;
    } else if (flag === '--args' && args[i + 1] !== undefined) {
      serverArgs = args[i + 1]!.split(',').map((a) => a.trim()).filter(Boolean);
      i += 1;
    } else if (flag === '--env' && args[i + 1] !== undefined) {
      env = {};
      const pairs = args[i + 1]!.split(',');
      for (const pair of pairs) {
        const [k, ...v] = pair.split('=');
        if (k !== undefined && k.trim().length > 0) {
          env[k.trim()] = v.join('=').trim();
        }
      }
      i += 1;
    } else if (flag === '--url' && args[i + 1] !== undefined) {
      url = args[i + 1]!.trim();
      i += 1;
    } else if (flag === '--transport' && args[i + 1] !== undefined) {
      transport = args[i + 1]!.trim() as 'stdio' | 'sse' | 'http';
      i += 1;
    } else if (flag === '--targets' && args[i + 1] !== undefined) {
      targets = args[i + 1]!.split(',').map((t) => t.trim() as InstallTarget).filter(Boolean);
      i += 1;
    } else if (flag === '--scope' && args[i + 1] !== undefined) {
      scope = args[i + 1]!.trim() as InstallScope;
      i += 1;
    } else if (flag === '--cwd' && args[i + 1] !== undefined) {
      cwd = args[i + 1]!.trim();
      i += 1;
    } else if (flag === '--workspace' && args[i + 1] !== undefined) {
      workspaceRoot = args[i + 1]!.trim();
      i += 1;
    }
  }

  const effectiveTransport: 'stdio' | 'sse' | 'http' = transport ?? (url !== undefined ? 'sse' : 'stdio');

  if (effectiveTransport === 'stdio') {
    const hasCommand = command !== undefined && command.length > 0;
    const hasSource = source !== undefined && source.length > 0;
    if (hasCommand === hasSource) {
      return err(appError('INVALID_INPUT', 'Server with stdio transport requires exactly one of --command or --source'));
    }
  }

  if ((effectiveTransport === 'http' || effectiveTransport === 'sse') && (url === undefined || url.length === 0)) {
    return err(appError('INVALID_INPUT', `Server with ${effectiveTransport} transport requires --url`));
  }

  return ok({
    kind: 'install-server',
    name,
    transport: effectiveTransport,
    ...(command ? { command } : {}),
    ...(source ? { source } : {}),
    ...(serverArgs ? { args: serverArgs } : {}),
    ...(env ? { env } : {}),
    ...(url ? { url } : {}),
    ...(cwd ? { cwd } : {}),
    targets,
    scope,
    ...(workspaceRoot ? { workspaceRoot } : {}),
  });
}

export async function runInstallSkill(
  service: { installSkill(input: InstallSkillInput): Promise<Result<InstallSkillResult>> },
  input: InstallSkillInput,
): Promise<Result<InstallSkillResult>> {
  return service.installSkill(input);
}

export async function runInstallServer(
  service: { installServer(input: InstallServerInput): Promise<Result<InstallServerResult>> },
  input: InstallServerInput,
): Promise<Result<InstallServerResult>> {
  return service.installServer(input);
}

