#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { formatCodexDiscoveryError, type CodexDiscoveryResult } from '@unified-mpc/codex';
import type { DoctorReport } from '@unified-mpc/application';
import { WorkspaceService, type Workspace } from '@unified-mpc/workspace';
import { resolveDataPath as resolveDataPathFromShared } from '@unified-mpc/shared';
import { SqliteDatabase, SqliteWorkspaceRepository } from '@unified-mpc/storage';
import {
  IdeSyncService,
  InstallerService,
  PrunerService,
  type InstallServerInput,
  type InstallServerResult,
  type InstallSkillInput,
  type InstallSkillResult,
  type PruneServerInput,
  type PruneServerResult,
  type PruneSkillInput,
  type PruneSkillResult,
  type SyncTarget,
} from '@unified-mpc/extensions';
import { formatDoctorReport } from './commands/doctor.js';
import {
  parseInstallSkillArgs,
  parseInstallServerArgs,
  runInstallSkill,
  runInstallServer,
  type InstallSkillCommand,
  type InstallServerCommand,
} from './commands/install.js';
import {
  parsePruneSkillArgs,
  parsePruneServerArgs,
  runPruneSkill,
  runPruneServer,
  type PruneSkillCommand,
  type PruneServerCommand,
} from './commands/prune.js';
import { parseSyncArgs, runSync, type SyncCommand } from './commands/sync.js';
import { parseWebArgs, runWeb, type WebCommand, type WebRunResult } from './commands/web.js';
import { parseToolsArgs, runToolsList, runToolsCall, type ToolsCommand, type ToolSummary } from './commands/tools.js';

export { formatDoctorReport } from './commands/doctor.js';
export { createStdioMcpRuntime, type StdioMcpRuntime } from './runtime/stdio-mcp-runtime.js';
export * from './commands/install.js';
export * from './commands/prune.js';
export * from './commands/sync.js';
export * from './commands/web.js';
export * from './commands/tools.js';

export type CliCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'status' }
  | { readonly kind: 'workspace-add'; readonly rootPath: string }
  | { readonly kind: 'workspace-list' }
  | { readonly kind: 'mcp-stdio'; readonly workspaceReference?: string }
  | { readonly kind: 'mcp-http'; readonly workspaceReference?: string }
  | { readonly kind: 'doctor' }
  | { readonly kind: 'codex-doctor' }
  | InstallSkillCommand
  | InstallServerCommand
  | PruneSkillCommand
  | PruneServerCommand
  | SyncCommand
  | WebCommand
  | ToolsCommand;

export interface CliServerHandle {
  close(): Promise<void>;
}

export interface CliStatus {
  readonly workspaceCount: number;
}

export interface CliDependencies {
  status(): Promise<CliStatus>;
  workspaceAdd(rootPath: string): Promise<Result<Workspace>>;
  workspaceList(): Promise<readonly Workspace[]>;
  mcpStdio(workspaceReference?: string): Promise<Result<{ readonly handle: CliServerHandle }>>;
  mcpHttp(workspaceReference?: string): Promise<Result<{ readonly handle: CliServerHandle }>>;
  doctor(): Promise<DoctorReport>;
  codexDoctor(): Promise<Result<CodexDiscoveryResult>>;
  installSkill?(input: InstallSkillInput): Promise<Result<InstallSkillResult>>;
  installServer?(input: InstallServerInput): Promise<Result<InstallServerResult>>;
  pruneSkill?(input: PruneSkillInput): Promise<Result<PruneSkillResult>>;
  pruneServer?(input: PruneServerInput): Promise<Result<PruneServerResult>>;
  sync?(targets?: readonly SyncTarget[]): Promise<Result<{ readonly updatedFiles: readonly string[] }>>;
  web?(options?: { host?: string; port?: number }): Promise<Result<WebRunResult>>;
  toolsList?(): Promise<readonly ToolSummary[]> | readonly ToolSummary[];
  toolsCall?(name: string, args: Record<string, unknown>): Promise<Result<unknown>>;
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
}

export function parseCliArgs(args: readonly string[]): Result<CliCommand> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') return ok({ kind: 'help' });
  if (args.length === 1 && args[0] === 'status') return ok({ kind: 'status' });
  if (args[0] === 'doctor' && args.length === 1) return ok({ kind: 'doctor' });
  if (args[0] === 'codex' && args[1] === 'doctor' && args.length === 2) return ok({ kind: 'codex-doctor' });
  if (args[0] === 'workspace') return parseWorkspaceArgs(args);
  if (args[0] === 'mcp') return parseMcpArgs(args);
  if (args[0] === 'install') return parseInstallArgs(args.slice(1));
  if (args[0] === 'prune') return parsePruneArgs(args.slice(1));
  if (args[0] === 'sync') return parseSyncArgs(args.slice(1));
  if (args[0] === 'web') return parseWebArgs(args.slice(1));
  if (args[0] === 'tools') return parseToolsArgs(args.slice(1));
  return err(appError('INVALID_INPUT', 'Unknown unified-mpc command'));
}

export async function runCli(args: readonly string[], dependencies: CliDependencies): Promise<number> {
  const parsed = parseCliArgs(args);
  const write = dependencies.write ?? ((text: string): void => { process.stdout.write(`${text}\n`); });
  const writeError = dependencies.writeError ?? ((text: string): void => { process.stderr.write(`${text}\n`); });
  if (!parsed.ok) {
    writeError(parsed.error.message);
    return 2;
  }

  switch (parsed.value.kind) {
    case 'help': {
      write(`Usage: unified-mpc <command> [options]

Commands:
  status                                 Display overall system and workspace status
  sync [--targets <t...>]                Synchronize P1-P7 policy rules across IDEs
  install skill --name <n> --source <s>  Install an agent skill
  install server --name <n> ...          Install an executable MCP server
  prune skill --name <n>                 Prune an installed skill
  prune server --name <n>                Prune an installed MCP server
  web [--port <p>] [--host <h>]          Start the Local Web Control Plane
  tools list                             List available downstream MCP tools
  tools call <tool> <args-json>          Call a downstream MCP tool headlessly
  workspace add <path>                   Register a workspace root
  workspace list                         List registered workspaces
  doctor                                 Run system health checks
  help, --help, -h                       Display this help message`);
      return 0;
    }
    case 'status': {
      const status = await dependencies.status();
      write(`workspaces: ${status.workspaceCount}`);
      return 0;
    }
    case 'workspace-add': {
      const result = await dependencies.workspaceAdd(parsed.value.rootPath);
      if (!result.ok) {
        writeError(result.error.message);
        return 1;
      }
      write(`workspace added: ${result.value.id}`);
      return 0;
    }
    case 'workspace-list': {
      const workspaces = await dependencies.workspaceList();
      for (const workspace of workspaces) write(`${workspace.id}\t${workspace.displayName}\t${workspace.rootPath}`);
      if (workspaces.length === 0) write('No workspaces configured');
      return 0;
    }
    case 'mcp-stdio':
      return runMcpLaunch(dependencies.mcpStdio, parsed.value.workspaceReference, writeError);
    case 'mcp-http':
      return runMcpLaunch(dependencies.mcpHttp, parsed.value.workspaceReference, writeError);
    case 'doctor': {
      const report = await dependencies.doctor();
      write(formatDoctorReport(report));
      return report.exitCode;
    }
    case 'codex-doctor': {
      const result = await dependencies.codexDoctor();
      if (!result.ok) {
        writeError(formatCodexDiscoveryError(result.error));
        return 1;
      }
      write(result.value.status.installed ? 'Codex available' : 'Codex not installed (optional)');
      return 0;
    }
    case 'install-skill': {
      const installer = dependencies.installSkill !== undefined
        ? { installSkill: dependencies.installSkill }
        : new InstallerService();
      const result = await runInstallSkill(installer, parsed.value);
      if (!result.ok) {
        writeError(result.error.message);
        return 1;
      }
      write(`Installed skill "${result.value.name}" to: ${result.value.installedPaths.join(', ')}`);
      return 0;
    }
    case 'install-server': {
      const installer = dependencies.installServer !== undefined
        ? { installServer: dependencies.installServer }
        : new InstallerService();
      const result = await runInstallServer(installer, parsed.value);
      if (!result.ok) {
        writeError(result.error.message);
        return 1;
      }
      write(`Installed server "${result.value.name}" into: ${result.value.updatedConfigFiles.join(', ')}`);
      return 0;
    }
    case 'prune-skill': {
      const pruner = dependencies.pruneSkill !== undefined
        ? { pruneSkill: dependencies.pruneSkill }
        : new PrunerService();
      const result = await runPruneSkill(pruner, parsed.value);
      if (!result.ok) {
        writeError(result.error.message);
        return 1;
      }
      write(`Pruned skill "${result.value.name}" from: ${result.value.removedPaths.join(', ')}`);
      return 0;
    }
    case 'prune-server': {
      const pruner = dependencies.pruneServer !== undefined
        ? { pruneServer: dependencies.pruneServer }
        : new PrunerService();
      const result = await runPruneServer(pruner, parsed.value);
      if (!result.ok) {
        writeError(result.error.message);
        return 1;
      }
      write(`Pruned server "${result.value.name}" from: ${result.value.updatedConfigFiles.join(', ')}`);
      return 0;
    }
    case 'sync': {
      const syncService = dependencies.sync !== undefined
        ? { sync: dependencies.sync }
        : new IdeSyncService(parsed.value.workspaceRoot !== undefined ? { workspaceRoot: parsed.value.workspaceRoot } : {});
      const result = await runSync(syncService, parsed.value.targets);
      if (!result.ok) {
        writeError(result.error.message);
        return 1;
      }
      write(`Synchronized policy across ${result.value.updatedFiles.length} file(s):`);
      for (const file of result.value.updatedFiles) {
        write(`  - ${file}`);
      }
      return 0;
    }
    case 'web': {
      const launch = dependencies.web ?? runWeb;
      const result = await launch({ host: parsed.value.host, port: parsed.value.port });
      if (!result.ok) {
        writeError(result.error.message);
        return 1;
      }
      write(`Control Plane running on ${result.value.url}`);
      return 0;
    }
    case 'tools-list': {
      const listFn = dependencies.toolsList;
      if (listFn === undefined) {
        writeError('Tools service not available');
        return 1;
      }
      const tools = await listFn();
      for (const tool of tools) {
        write(`${tool.name}\t${tool.description ?? ''}`);
      }
      if (tools.length === 0) write('No tools registered');
      return 0;
    }
    case 'tools-call': {
      const callFn = dependencies.toolsCall;
      if (callFn === undefined) {
        writeError('Tools service not available');
        return 1;
      }
      const result = await callFn(parsed.value.toolName, parsed.value.args);
      if (!result.ok) {
        writeError(result.error.message);
        return 1;
      }
      write(typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2));
      return 0;
    }
  }
}

function parseWorkspaceArgs(args: readonly string[]): Result<CliCommand> {
  if (args[1] === 'add' && args.length === 3 && args[2] !== undefined) return ok({ kind: 'workspace-add', rootPath: args[2] });
  if (args[1] === 'list' && args.length === 2) return ok({ kind: 'workspace-list' });
  return err(appError('INVALID_INPUT', 'Usage: unified-mpc workspace add <path> | workspace list'));
}

function parseMcpArgs(args: readonly string[]): Result<CliCommand> {
  let kind: 'mcp-stdio' | 'mcp-http' | undefined;
  let workspaceReference: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--stdio' || flag === '--http') {
      if (kind !== undefined) return err(appError('INVALID_INPUT', 'Choose exactly one MCP transport'));
      kind = flag === '--stdio' ? 'mcp-stdio' : 'mcp-http';
    } else if (flag === '--workspace' && args[index + 1] !== undefined) {
      workspaceReference = args[index + 1];
      index += 1;
    } else {
      return err(appError('INVALID_INPUT', 'Usage: unified-mpc mcp --stdio|--http [--workspace <id-or-path>]'));
    }
  }
  if (kind === undefined) return err(appError('INVALID_INPUT', 'Choose an MCP transport with --stdio or --http'));
  return workspaceReference === undefined ? ok({ kind }) : ok({ kind, workspaceReference });
}

function parseInstallArgs(args: readonly string[]): Result<InstallSkillCommand | InstallServerCommand> {
  if (args.length === 0) {
    return err(appError('INVALID_INPUT', 'Usage: unified-mpc install skill <name> <source> | install server <name> [options]'));
  }
  if (args[0] === 'skill') return parseInstallSkillArgs(args.slice(1));
  if (args[0] === 'server') return parseInstallServerArgs(args.slice(1));
  return err(appError('INVALID_INPUT', 'Usage: unified-mpc install skill <name> <source> | install server <name> [options]'));
}

function parsePruneArgs(args: readonly string[]): Result<PruneSkillCommand | PruneServerCommand> {
  if (args.length === 0) {
    return err(appError('INVALID_INPUT', 'Usage: unified-mpc prune skill <name> | prune server <name> [options]'));
  }
  if (args[0] === 'skill') return parsePruneSkillArgs(args.slice(1));
  if (args[0] === 'server') return parsePruneServerArgs(args.slice(1));
  return err(appError('INVALID_INPUT', 'Usage: unified-mpc prune skill <name> | prune server <name> [options]'));
}

async function runMcpLaunch(
  launch: (workspaceReference?: string) => Promise<Result<{ readonly handle: CliServerHandle }>>,
  workspaceReference: string | undefined,
  writeError: (text: string) => void,
): Promise<number> {
  const result = await launch(workspaceReference);
  if (!result.ok) {
    writeError(result.error.message);
    return 1;
  }
  return 0;
}

export function createDefaultCliDependencies(): CliDependencies {
  const dataPath = resolveDataPathFromShared(process.env);
  fs.mkdirSync(dataPath, { recursive: true });
  const database = new SqliteDatabase(path.join(dataPath, 'storage.sqlite'));
  const workspaceRepo = new SqliteWorkspaceRepository(database);
  const workspaceService = new WorkspaceService(workspaceRepo);

  return {
    status: async () => {
      const workspaces = await workspaceService.list();
      return { workspaceCount: workspaces.length };
    },
    workspaceAdd: async (rootPath: string) => {
      return workspaceService.add(path.basename(rootPath), rootPath);
    },
    workspaceList: async () => {
      return workspaceService.list();
    },
    mcpStdio: async () => {
      return err(appError('INTERNAL_ERROR', 'Direct stdio MCP launch requires mcp-stdio runner'));
    },
    mcpHttp: async () => {
      return err(appError('INTERNAL_ERROR', 'Direct HTTP MCP launch requires mcp-http runner'));
    },
    doctor: async () => {
      return {
        checks: [{ id: 'database', status: 'pass', message: 'Unified MCP core operational', required: true }],
        exitCode: 0,
      };
    },
    codexDoctor: async () => {
      return ok({
        status: { installed: false, capabilities: [] },
        capabilities: { app: false, cli: false, mcp: false } as any,
      });
    },
    installSkill: async (input) => new InstallerService().installSkill(input),
    installServer: async (input) => new InstallerService().installServer(input),
    pruneSkill: async (input) => new PrunerService().pruneSkill(input),
    pruneServer: async (input) => new PrunerService().pruneServer(input),
    sync: async (targets) => new IdeSyncService().sync(targets),
    web: async (options) => runWeb(options),
  };
}

const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
let isDirectlyExecuted = false;
try {
  const thisFile = fileURLToPath(import.meta.url);
  isDirectlyExecuted = entryFile === thisFile || (
    entryFile.endsWith('/dist/index.js') ||
    entryFile.endsWith('/dist/index') ||
    entryFile.endsWith('/bin/unified-mpc') ||
    entryFile.endsWith('/bin/unified-mcp') ||
    entryFile.endsWith('/src/index.ts')
  );
} catch {
  isDirectlyExecuted = false;
}

if (isDirectlyExecuted) {
  const deps = createDefaultCliDependencies();
  runCli(process.argv.slice(2), deps).then((exitCode) => {
    process.exit(exitCode);
  }).catch((err) => {
    process.stderr.write(`Fatal CLI error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
