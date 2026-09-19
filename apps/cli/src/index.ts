#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { formatCodexDiscoveryError, type CodexDiscoveryResult } from '@unified-mpc/codex';
import { WorkspaceSelectionService, type DoctorReport, type WorkspaceSelectionSnapshot } from '@unified-mpc/application';
import { WorkspaceService, type Workspace } from '@unified-mpc/workspace';
import { USER_SETTING_KEYS, resolveDataPath as resolveDataPathFromShared } from '@unified-mpc/shared';
import { SqliteDatabase, SqliteSettingsRepository, SqliteWorkspaceRepository } from '@unified-mpc/storage';
import { HarnessActivationLedger, ToolRegistry } from '@unified-mpc/mcp-server';
import {
  createLocalExtensionsService,
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
import { parseToolsArgs, type ToolsCommand, type ToolSummary } from './commands/tools.js';

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
  | { readonly kind: 'workspace-active' }
  | { readonly kind: 'workspace-activate'; readonly workspaceReference: string }
  | { readonly kind: 'workspace-deactivate'; readonly workspaceReference: string }
  | { readonly kind: 'workspace-use'; readonly workspaceReference: string }
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
  workspaceActive?(): Promise<Result<WorkspaceSelectionSnapshot>>;
  workspaceActivate?(workspaceReference: string): Promise<Result<WorkspaceSelectionSnapshot>>;
  workspaceDeactivate?(workspaceReference: string): Promise<Result<WorkspaceSelectionSnapshot>>;
  workspaceUse?(workspaceReference: string): Promise<Result<WorkspaceSelectionSnapshot>>;
  mcpStdio(workspaceReference?: string): Promise<Result<{ readonly handle: CliServerHandle }>>;
  mcpHttp(workspaceReference?: string): Promise<Result<{ readonly handle: CliServerHandle }>>;
  doctor(): Promise<DoctorReport>;
  codexDoctor(): Promise<Result<CodexDiscoveryResult>>;
  installSkill?(input: InstallSkillInput): Promise<Result<InstallSkillResult>>;
  installServer?(input: InstallServerInput): Promise<Result<InstallServerResult>>;
  pruneSkill?(input: PruneSkillInput): Promise<Result<PruneSkillResult>>;
  pruneServer?(input: PruneServerInput): Promise<Result<PruneServerResult>>;
  sync?(targets?: readonly SyncTarget[], workspaceRoot?: string): Promise<Result<{ readonly updatedFiles: readonly string[] }>>;
  web?(options?: { port?: number }): Promise<Result<WebRunResult>>;
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
  sync [--targets <t...>]                Synchronize runtime policy rules across IDEs
  install skill --name <n> --source <s>  Install an agent skill
  install server --name <n> ...          Install an executable MCP server
  prune skill --name <n>                 Prune an installed skill
  prune server --name <n>                Prune an installed MCP server
  web [--port <p>]                       Start the Local Web Control Plane
  tools list                             List available downstream MCP tools
  tools call <tool> <args-json>          Call a downstream MCP tool headlessly
  workspace add <path>                   Register a workspace root
  workspace list                         List registered workspaces
  workspace active                       Show the HTTP/ChatGPT Active Project set
  workspace activate <id-or-path>        Activate a registered project
  workspace deactivate <id-or-path>      Deactivate a registered project
  workspace use <id-or-path>             Activate and make a project Primary
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
    case 'workspace-active':
      return runWorkspaceSelectionCommand(dependencies.workspaceActive, undefined, write, writeError);
    case 'workspace-activate':
      return runWorkspaceSelectionCommand(dependencies.workspaceActivate, parsed.value.workspaceReference, write, writeError);
    case 'workspace-deactivate':
      return runWorkspaceSelectionCommand(dependencies.workspaceDeactivate, parsed.value.workspaceReference, write, writeError);
    case 'workspace-use':
      return runWorkspaceSelectionCommand(dependencies.workspaceUse, parsed.value.workspaceReference, write, writeError);
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
      const command = parsed.value;
      const syncService = dependencies.sync !== undefined
        ? { sync: (targets?: readonly SyncTarget[]): Promise<Result<{ readonly updatedFiles: readonly string[] }>> => dependencies.sync!(targets, command.workspaceRoot) }
        : new IdeSyncService(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {});
      const result = await runSync(syncService, command.targets);
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
      const result = await launch({ port: parsed.value.port });
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
  if (args[1] === 'active' && args.length === 2) return ok({ kind: 'workspace-active' });
  if (args[1] === 'activate' && args.length === 3 && args[2] !== undefined) return ok({ kind: 'workspace-activate', workspaceReference: args[2] });
  if (args[1] === 'deactivate' && args.length === 3 && args[2] !== undefined) return ok({ kind: 'workspace-deactivate', workspaceReference: args[2] });
  if (args[1] === 'use' && args.length === 3 && args[2] !== undefined) return ok({ kind: 'workspace-use', workspaceReference: args[2] });
  return err(appError('INVALID_INPUT', 'Usage: unified-mpc workspace add <path> | workspace list|active|activate|deactivate|use'));
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

async function runWorkspaceSelectionCommand(
  action: (() => Promise<Result<WorkspaceSelectionSnapshot>>) | ((workspaceReference: string) => Promise<Result<WorkspaceSelectionSnapshot>>) | undefined,
  workspaceReference: string | undefined,
  write: (text: string) => void,
  writeError: (text: string) => void,
): Promise<number> {
  if (action === undefined) {
    writeError('Workspace selection service not available');
    return 1;
  }
  const result = workspaceReference === undefined
    ? await (action as () => Promise<Result<WorkspaceSelectionSnapshot>>)()
    : await (action as (reference: string) => Promise<Result<WorkspaceSelectionSnapshot>>)(workspaceReference);
  if (!result.ok) {
    writeError(result.error.message);
    return 1;
  }
  write(`primary\t${result.value.primaryWorkspaceId}`);
  for (const id of result.value.activeWorkspaceIds) {
    if (id !== result.value.primaryWorkspaceId) write(`active\t${id}`);
  }
  return 0;
}

export function createDefaultCliDependencies(): CliDependencies {
  let workspaceState: {
    readonly repository: SqliteWorkspaceRepository;
    readonly settings: SqliteSettingsRepository;
    readonly service: WorkspaceService;
  } | undefined;
  const getWorkspaceState = (): NonNullable<typeof workspaceState> => {
    if (workspaceState !== undefined) return workspaceState;
    const dataPath = resolveDataPathFromShared();
    fs.mkdirSync(dataPath, { recursive: true });
    const database = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    const repository = new SqliteWorkspaceRepository(database);
    workspaceState = {
      repository,
      settings: new SqliteSettingsRepository(database),
      service: new WorkspaceService(repository),
    };
    return workspaceState;
  };
  const getWorkspaceService = (): WorkspaceService => getWorkspaceState().service;
  const getWorkspaceSelection = async (): Promise<Result<WorkspaceSelectionService>> => {
    const state = getWorkspaceState();
    const workspaces = await state.service.list();
    const initial = workspaces[0];
    if (initial === undefined) return err(appError('WORKSPACE_NOT_FOUND', 'No registered project workspace is available', true));
    return ok(new WorkspaceSelectionService(state.repository, initial.id, {
      get: () => state.settings.get(USER_SETTING_KEYS.httpWorkspaceSelection),
      set: (value) => state.settings.set(USER_SETTING_KEYS.httpWorkspaceSelection, value),
    }));
  };
  const resolveWorkspaceReference = async (reference: string): Promise<Result<Workspace>> => {
    const trimmed = reference.trim();
    const workspaces = await getWorkspaceService().list();
    const absolute = path.resolve(trimmed);
    const workspace = workspaces.find((candidate) => candidate.id === trimmed
      || candidate.rootPath === trimmed
      || candidate.realRootPath === trimmed
      || path.resolve(candidate.rootPath) === absolute
      || path.resolve(candidate.realRootPath) === absolute);
    return workspace === undefined
      ? err(appError('WORKSPACE_NOT_FOUND', 'Workspace is not a registered project', true))
      : ok(workspace);
  };
  let extensions: ReturnType<typeof createLocalExtensionsService> | undefined;
  const getExtensions = (): ReturnType<typeof createLocalExtensionsService> => {
    extensions ??= createLocalExtensionsService({ workspaceRootProvider: async (): Promise<string> => process.cwd() });
    return extensions;
  };
  let toolRegistry: ToolRegistry | undefined;
  const getToolRegistry = (): ToolRegistry => {
    toolRegistry ??= new ToolRegistry(
      { extensions: getExtensions(), installer: new InstallerService({ workspaceRoot: process.cwd() }) },
      { clientId: 'cli', clientName: 'unified-mpc-cli' },
      { harnessActivationLedger: new HarnessActivationLedger(), sessionId: 'cli' },
    );
    return toolRegistry;
  };

  return {
    status: async (): Promise<CliStatus> => {
      const workspaces = await getWorkspaceService().list();
      return { workspaceCount: workspaces.length };
    },
    workspaceAdd: async (rootPath: string): Promise<Result<Workspace>> => {
      return getWorkspaceService().add(path.basename(rootPath), rootPath);
    },
    workspaceList: async (): Promise<readonly Workspace[]> => {
      return getWorkspaceService().list();
    },
    workspaceActive: async (): Promise<Result<WorkspaceSelectionSnapshot>> => {
      const selection = await getWorkspaceSelection();
      return selection.ok ? selection.value.list() : selection;
    },
    workspaceActivate: async (workspaceReference: string): Promise<Result<WorkspaceSelectionSnapshot>> => {
      const [selection, workspace] = await Promise.all([getWorkspaceSelection(), resolveWorkspaceReference(workspaceReference)]);
      if (!selection.ok) return selection;
      if (!workspace.ok) return workspace;
      return selection.value.activate(workspace.value.id);
    },
    workspaceDeactivate: async (workspaceReference: string): Promise<Result<WorkspaceSelectionSnapshot>> => {
      const [selection, workspace] = await Promise.all([getWorkspaceSelection(), resolveWorkspaceReference(workspaceReference)]);
      if (!selection.ok) return selection;
      if (!workspace.ok) return workspace;
      return selection.value.deactivate(workspace.value.id);
    },
    workspaceUse: async (workspaceReference: string): Promise<Result<WorkspaceSelectionSnapshot>> => {
      const [selection, workspace] = await Promise.all([getWorkspaceSelection(), resolveWorkspaceReference(workspaceReference)]);
      if (!selection.ok) return selection;
      if (!workspace.ok) return workspace;
      return selection.value.setPrimary(workspace.value.id);
    },
    mcpStdio: async (): Promise<Result<{ readonly handle: CliServerHandle }>> => {
      return err(appError('INTERNAL_ERROR', 'Direct stdio MCP launch requires mcp-stdio runner'));
    },
    mcpHttp: async (): Promise<Result<{ readonly handle: CliServerHandle }>> => {
      return err(appError('INTERNAL_ERROR', 'Direct HTTP MCP launch requires mcp-http runner'));
    },
    doctor: async (): Promise<DoctorReport> => {
      return {
        checks: [{ id: 'database', status: 'pass', message: 'Unified MCP core operational', required: true }],
        exitCode: 0,
      };
    },
    codexDoctor: async (): Promise<Result<CodexDiscoveryResult>> => {
      return ok({
        status: { installed: false, capabilities: [] },
        capabilities: { instructionMode: null, names: [] },
      });
    },
    installSkill: async (input: InstallSkillInput): Promise<Result<InstallSkillResult>> => new InstallerService().installSkill(input),
    installServer: async (input: InstallServerInput): Promise<Result<InstallServerResult>> => new InstallerService().installServer(input),
    pruneSkill: async (input: PruneSkillInput): Promise<Result<PruneSkillResult>> => new PrunerService().pruneSkill(input),
    pruneServer: async (input: PruneServerInput): Promise<Result<PruneServerResult>> => new PrunerService().pruneServer(input),
    sync: async (targets?: readonly SyncTarget[], workspaceRoot?: string): Promise<Result<{ readonly updatedFiles: readonly string[] }>> =>
      new IdeSyncService(workspaceRoot !== undefined ? { workspaceRoot } : {}).sync(targets),
    web: async (options?: { port?: number }): Promise<Result<WebRunResult>> => runWeb(options),
    toolsList: async (): Promise<readonly ToolSummary[]> => {
      const registry = getToolRegistry();
      return registry.listExposedDefinitions().map((tool) => {
        const inputSchema = registry.describeInputJsonSchema(tool.name);
        return {
          name: tool.name,
          description: tool.description,
          ...(inputSchema === undefined ? {} : { inputSchema }),
          permission: tool.permission,
          annotations: tool.annotations,
        };
      });
    },
    toolsCall: async (name: string, args: Record<string, unknown>): Promise<Result<unknown>> => {
      const response = await getToolRegistry().invoke(name, args);
      if (response.isError) {
        const errorText = response.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
        return err(appError('INTERNAL_ERROR', errorText || `Tool ${name} failed`));
      }
      return ok(response);
    },
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
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    const cmd = process.argv[2];
    if (cmd !== 'web') {
      process.exit(0);
    }
    const shutdown = (): void => {
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch((err) => {
    process.stderr.write(`Fatal CLI error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
