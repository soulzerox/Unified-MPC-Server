#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { startMcpHttp } from '@unified-mpc/mcp-server';
import { resolveDataPath as resolveDataPathFromShared, isUnrestricted } from '@unified-mpc/shared';
import { SqliteDatabase, SqliteSettingsRepository, SqliteWorkspaceRepository } from '@unified-mpc/storage';
import { WorkspaceService, type Workspace } from '@unified-mpc/workspace';
import { createStdioMcpRuntime } from '../runtime/stdio-mcp-runtime.js';

function envPort(): number {
  const value = Number(process.env.UNIFIED_MPC_PORT ?? 18765);
  return Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : 18765;
}

function envList(name: string): readonly string[] | undefined {
  const values = (process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return values.length === 0 ? undefined : values;
}

async function selectWorkspace(service: WorkspaceService): Promise<Workspace> {
  const requested = process.env.UNIFIED_MPC_WORKSPACE?.trim();
  if (requested === undefined) throw new Error('UNIFIED_MPC_WORKSPACE is required for HTTP MCP runtime');
  const resolved = path.resolve(requested);
  if (!fs.existsSync(resolved)) throw new Error(`Workspace path does not exist: ${resolved}`);
  const existing = (await service.list()).find((entry) => entry.realRootPath === resolved || entry.rootPath === resolved);
  if (existing !== undefined) return existing;
  const added = await service.add(path.basename(resolved) || 'Workspace', resolved);
  if (!added.ok) throw new Error(added.error.message);
  return added.value;
}

async function main(): Promise<void> {
  const dataPath = resolveDataPathFromShared();
  fs.mkdirSync(dataPath, { recursive: true });
  const database = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
  const settings = new SqliteSettingsRepository(database);
  const workspace = await selectWorkspace(new WorkspaceService(new SqliteWorkspaceRepository(database)));
  const publicHostnames = settingList(settings, 'mcp_allowed_hostnames', 'UNIFIED_MPC_MCP_ALLOWED_HOSTNAMES');
  const publicOrigins = settingList(settings, 'mcp_allowed_origins', 'UNIFIED_MPC_MCP_ALLOWED_ORIGINS');
  database.close();

  const runtime = createStdioMcpRuntime(dataPath, workspace, isUnrestricted(process.env, undefined));
  await runtime.activityReady;
  await runtime.recoveryReady;
  const handle = await startMcpHttp({
    port: envPort(),
    services: runtime.services,
    actor: runtime.actor,
    activityTracker: runtime.activityTracker,
    codexToolsEnabled: runtime.codexToolsEnabled,
    ponytailModeProvider: () => runtime.ponytailMode,
    profileProvider: runtime.profileProvider,
    authorizationModeProvider: () => 'standard',
    allowAiDeleteProvider: runtime.allowAiDeleteProvider,
    destructivePolicyProvider: runtime.destructivePolicyProvider,
    activeWorkspaceScopeProvider: runtime.activeWorkspaceScopeProvider,
    toolAvailabilitySnapshotProvider: () => runtime.toolAvailabilityService.snapshot(),
    toolAvailabilitySubscribe: (listener) => runtime.toolAvailabilityService.subscribe(listener),
    ...(publicHostnames === undefined ? {} : { allowedHostnames: publicHostnames }),
    ...(publicOrigins === undefined ? {} : { allowedOrigins: publicOrigins }),
  });
  process.stderr.write(`Unified-MPC MCP HTTP ready endpoint=${handle.endpoint.href} identity=${new URL('/_unified-mpc/identity', handle.endpoint).href}\n`);

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await handle.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
}

function settingList(settings: SqliteSettingsRepository, key: string, envName: string): readonly string[] | undefined {
  const persisted = parseList(settings.get(key));
  return persisted ?? envList(envName);
}

function parseList(value: string | null): readonly string[] | undefined {
  if (value === null) return undefined;
  const values = value.split(',').map((item) => item.trim()).filter(Boolean);
  return values.length === 0 ? undefined : values;
}

main().catch((error: unknown) => {
  process.stderr.write(`Unified-MPC MCP HTTP failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});