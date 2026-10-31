import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type {
  InstallServerInput,
  InstallServerResult,
  InstallSkillInput,
  InstallSkillResult,
  InstallTarget,
  InstallScope,
} from '@unified-mpc/extensions';
import { missingOptionValue, unexpectedOption } from './options.js';

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
  if (name.startsWith('-')) {
    return err(appError('INVALID_INPUT', `Skill name must not start with '-': "${name}"`));
  }
  if (source.startsWith('-')) {
    return err(appError('INVALID_INPUT', `Skill source must not start with '-': "${source}"`));
  }

  let targets: InstallTarget[] = ['all'];
  let scope: InstallScope = 'global';
  let workspaceRoot: string | undefined;

  for (let i = 2; i < args.length; i += 1) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (flag === '--targets') {
      if (value === undefined) return missingOptionValue(flag);
      targets = value.split(',').map((t) => t.trim() as InstallTarget).filter(Boolean);
      i += 1;
    } else if (flag === '--scope') {
      if (value === undefined) return missingOptionValue(flag);
      scope = value.trim() as InstallScope;
      i += 1;
    } else if (flag === '--workspace') {
      if (value === undefined) return missingOptionValue(flag);
      workspaceRoot = value.trim();
      i += 1;
    } else {
      return unexpectedOption(flag);
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
  if (name.startsWith('-')) {
    return err(appError('INVALID_INPUT', `Server name must not start with '-': "${name}"`));
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
    const flag = args[i]!;
    const value = args[i + 1];
    if (flag === '--command') {
      if (value === undefined) return missingOptionValue(flag);
      command = value.trim();
      i += 1;
    } else if (flag === '--source') {
      if (value === undefined) return missingOptionValue(flag);
      source = value.trim();
      i += 1;
    } else if (flag === '--args') {
      if (value === undefined) return missingOptionValue(flag);
      serverArgs = value.split(',').map((a) => a.trim()).filter(Boolean);
      i += 1;
    } else if (flag === '--env') {
      if (value === undefined) return missingOptionValue(flag);
      env = {};
      const pairs = value.split(',');
      for (const pair of pairs) {
        const [k, ...v] = pair.split('=');
        if (k !== undefined && k.trim().length > 0) {
          env[k.trim()] = v.join('=').trim();
        }
      }
      i += 1;
    } else if (flag === '--url') {
      if (value === undefined) return missingOptionValue(flag);
      url = value.trim();
      i += 1;
    } else if (flag === '--transport') {
      if (value === undefined) return missingOptionValue(flag);
      transport = value.trim() as 'stdio' | 'sse' | 'http';
      i += 1;
    } else if (flag === '--targets') {
      if (value === undefined) return missingOptionValue(flag);
      targets = value.split(',').map((t) => t.trim() as InstallTarget).filter(Boolean);
      i += 1;
    } else if (flag === '--scope') {
      if (value === undefined) return missingOptionValue(flag);
      scope = value.trim() as InstallScope;
      i += 1;
    } else if (flag === '--cwd') {
      if (value === undefined) return missingOptionValue(flag);
      cwd = value.trim();
      i += 1;
    } else if (flag === '--workspace') {
      if (value === undefined) return missingOptionValue(flag);
      workspaceRoot = value.trim();
      i += 1;
    } else {
      return unexpectedOption(flag);
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

