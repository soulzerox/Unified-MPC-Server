import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXTENSIONS_SETTINGS_KEY,
  EXTENSIONS_SETTINGS_SCHEMA_VERSION,
  POLICY_BLOCK_END,
  POLICY_BLOCK_START,
  configuredPolicies,
  parseExtensionsSettings,
  type ExtensionsSettings,
  type PolicyEntry,
} from '@unified-mpc/extensions';
import { createStdioMcpRuntime } from './stdio-mcp-runtime.js';

const RETIREMENT_MIGRATION_ID = '045_retire_turn_persistence';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Frozen copy of the released `018_turn_persistence` schema. The fixture pins
 * the historical shape instead of importing it, so a change to the live module
 * cannot silently redefine the upgrade path this test starts from.
 */
const RELEASED_TURN_PERSISTENCE_SQL = `
CREATE TABLE IF NOT EXISTS turn_persistence_completed (
  scope TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  completed_at TEXT NOT NULL,
  PRIMARY KEY(scope, turn_id, role)
);

CREATE INDEX IF NOT EXISTS idx_turn_persistence_completed_at
  ON turn_persistence_completed(completed_at DESC);

CREATE TABLE IF NOT EXISTS turn_persistence_active (
  scope TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('required','best_effort')),
  violations INTEGER NOT NULL DEFAULT 0 CHECK(violations >= 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turn_persistence_active_updated_at
  ON turn_persistence_active(updated_at DESC);
`;

/** What an install upgraded from the released #2-era build still has saved. */
const LEGACY_SETTINGS = {
  mode: 'enable_all',
  mandatoryMcpServers: ['memory', 'thai-rag-mcp', 'godkiller'],
  policies: [
    { id: 'child:memory', resourceId: 'memory', resourceType: 'server', mandatory: true, enforcement: 'REALTIME', directive: 'Use working memory proactively.', requiredTools: ['search_nodes'] },
    { id: 'pre-edit:thai-rag', resourceId: 'thai-rag-mcp', resourceType: 'server', mandatory: true, enforcement: 'EVERY_SESSION', directive: 'Use local RAG automatically.', requiredTools: ['pre_edit_context'] },
    { id: 'code-safety:godkiller', resourceId: 'godkiller', resourceType: 'server', mandatory: true, enforcement: 'SAFETY_PRE_CHECK', directive: 'Use Godkiller before code mutations.', requiredTools: ['gk_task'] },
  ],
} as const;

const STALE_POLICY_BLOCK = [
  POLICY_BLOCK_START,
  '| P1 | child:memory | memory | server | REALTIME | ✅ YES |',
  '| P2 | pre-edit:thai-rag | thai-rag-mcp | server | EVERY_SESSION | ✅ YES |',
  POLICY_BLOCK_END,
].join('\n');

type ConfiguredPolicies = ReturnType<typeof configuredPolicies>;

/**
 * The projection the upgrade promises to erase: no saved policy may describe
 * the retired mandatory child topology or a `REALTIME` turn-recording gate.
 * Runs on the raw persisted policy list, not `configuredPolicies`, because that
 * view filters retired server rows and would hide a partial migration.
 */
function legacyPolicyIds(policies: readonly PolicyEntry[]): string[] {
  return policies.filter((policy) => policy.id.startsWith('child:')
      || policy.id.startsWith('pre-edit:')
      || policy.enforcement === 'REALTIME'
      || (policy.resourceType === 'server' && (policy.resourceId.trim().toLowerCase() === 'memory' || policy.resourceId.trim().toLowerCase() === 'thai-rag-mcp'))
      || (policy.id === 'code-safety:godkiller' && policy.mandatory))
    .map((policy) => policy.id);
}

function retiredTableNames(database: DatabaseSync): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'turn_persistence%' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function migrationIds(database: DatabaseSync): string[] {
  return database
    .prepare('SELECT id FROM schema_migrations ORDER BY id')
    .all()
    .map((row) => (row as { id: string }).id);
}

function writeOldInstallDatabase(filename: string): void {
  const legacy = new DatabaseSync(filename);
  try {
    legacy.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY NOT NULL);');
    legacy.exec('CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);');
    legacy.exec(RELEASED_TURN_PERSISTENCE_SQL);
    legacy.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run('018_turn_persistence');
    legacy.prepare('INSERT INTO turn_persistence_completed (scope, turn_id, role, completed_at) VALUES (?, ?, ?, ?)')
      .run('web', 'turn-1', 'user', '2026-08-01T00:00:00.000Z');
    legacy.prepare('INSERT INTO turn_persistence_active (scope, turn_id, mode, violations, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('web', 'turn-1', 'required', 0, '2026-08-01T00:00:00.000Z');
    legacy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run(EXTENSIONS_SETTINGS_KEY, JSON.stringify(LEGACY_SETTINGS));
  } finally {
    legacy.close();
  }
}

/**
 * Reads the settings row without opening `SqliteDatabase`: that constructor
 * applies pending migrations, which would let the assertion helper substitute
 * for the startup behaviour under test. A missing row parses as defaults, so
 * callers that claim the row was migrated must assert `raw` is a string first.
 */
function readPersistedSettings(filename: string): { raw: string | null; settings: ExtensionsSettings } {
  const database = new DatabaseSync(filename);
  try {
    const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(EXTENSIONS_SETTINGS_KEY) as { value?: unknown } | undefined;
    const raw = typeof row?.value === 'string' ? row.value : null;
    return { raw, settings: parseExtensionsSettings(raw) };
  } finally {
    database.close();
  }
}

async function withIsolatedHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  try {
    return await body();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }
}

async function prepareRoots(prefix: string): Promise<{ root: string; dataPath: string; workspaceRoot: string; home: string; agentsFile: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  const dataPath = path.join(root, 'data');
  const workspaceRoot = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  await mkdir(dataPath, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(home, { recursive: true });
  return { root, dataPath, workspaceRoot, home, agentsFile: path.join(workspaceRoot, 'AGENTS.md') };
}

function workspaceRecord(workspaceRoot: string): { id: string; displayName: string; rootPath: string; realRootPath: string; createdAt: string } {
  return {
    id: 'upgrade-convergence-workspace',
    displayName: 'upgrade convergence',
    rootPath: workspaceRoot,
    realRootPath: workspaceRoot,
    createdAt: '2026-11-03T00:00:00.000Z',
  };
}

async function startAndClose(dataPath: string, workspaceRoot: string): Promise<void> {
  const runtime = createStdioMcpRuntime(dataPath, workspaceRecord(workspaceRoot));
  try {
    await runtime.managedPolicyRepairReady;
  } finally {
    await runtime.close();
  }
}

describe('upgrade convergence', () => {
  it('retires the old database, settings and policy block in a single start', async () => {
    const { dataPath, workspaceRoot, home, agentsFile } = await prepareRoots('unified-mpc-upgrade-convergence-');
    const databaseFile = path.join(dataPath, 'unified-mpc.sqlite');
    writeOldInstallDatabase(databaseFile);
    await writeFile(agentsFile, [
      '# Project notes',
      '',
      'Keep this line.',
      '',
      STALE_POLICY_BLOCK,
      '',
      'Tail content stays.',
      '',
    ].join('\n'), 'utf8');

    await withIsolatedHome(home, async () => {
      const runtime = createStdioMcpRuntime(dataPath, workspaceRecord(workspaceRoot));
      try {
        const report = await runtime.managedPolicyRepairReady;
        expect(report?.failed).toEqual([]);
        expect(report?.updated).toContain(agentsFile);
      } finally {
        await runtime.close();
      }
    });

    // Read the file with a raw `DatabaseSync` before the second start, so the
    // assertions measure what the first start wrote. Opening `SqliteDatabase`
    // here would apply the retirement migration itself and pass even if the
    // runtime had done nothing.
    const database = new DatabaseSync(databaseFile);
    try {
      expect(retiredTableNames(database)).toEqual([]);
      expect(migrationIds(database)).toContain(RETIREMENT_MIGRATION_ID);
    } finally {
      database.close();
    }

    const { raw, settings } = readPersistedSettings(databaseFile);
    expect(typeof raw).toBe('string');
    // `parseExtensionsSettings` falls back to defaults on malformed JSON, so
    // inspect the stored document too rather than letting a broken row pass.
    expect(raw).toContain('"settingsVersion"');
    expect(raw).not.toContain('child:memory');
    expect(raw).not.toContain('"REALTIME"');
    expect(settings.settingsVersion).toBe(EXTENSIONS_SETTINGS_SCHEMA_VERSION);
    expect(settings.mandatoryMcpServers).toEqual([]);
    const persistedPolicies = settings.policies ?? [];
    expect(legacyPolicyIds(persistedPolicies)).toEqual([]);
    expect(persistedPolicies.map((policy) => policy.id))
      .toEqual(expect.arrayContaining(['memory:workspace-selective', 'code:pre-edit-context']));
    expect(persistedPolicies.find((policy) => policy.resourceId === 'native-memory')).toMatchObject({
      resourceType: 'capability',
      mandatory: false,
      enforcement: 'ON_DEMAND',
    });
    expect(persistedPolicies.find((policy) => policy.resourceId === 'native-thai-rag')).toMatchObject({
      resourceType: 'capability',
      mandatory: true,
      enforcement: 'SAFETY_PRE_CHECK',
    });

    const repaired = await readFile(agentsFile, 'utf8');
    expect(repaired).toContain('# Project notes');
    expect(repaired).toContain('Keep this line.');
    expect(repaired).toContain('Tail content stays.');
    expect(repaired).toContain('memory:workspace-selective');
    expect(repaired).toContain('code:pre-edit-context');
    expect(repaired).not.toContain('child:memory');
    expect(repaired).not.toContain('REALTIME');

    // A second start on the already-converged install must change nothing.
    await withIsolatedHome(home, async () => {
      await startAndClose(dataPath, workspaceRoot);
    });
    expect(await readFile(agentsFile, 'utf8')).toBe(repaired);
  }, 30_000);

  it('gives a clean install the same native capability topology as the upgraded install', async () => {
    const upgradedRoots = await prepareRoots('unified-mpc-upgraded-parity-');
    writeOldInstallDatabase(path.join(upgradedRoots.dataPath, 'unified-mpc.sqlite'));
    await withIsolatedHome(upgradedRoots.home, async () => {
      await startAndClose(upgradedRoots.dataPath, upgradedRoots.workspaceRoot);
    });

    const freshRoots = await prepareRoots('unified-mpc-clean-install-parity-');
    await withIsolatedHome(freshRoots.home, async () => {
      await startAndClose(freshRoots.dataPath, freshRoots.workspaceRoot);
    });

    const upgradedPersisted = readPersistedSettings(path.join(upgradedRoots.dataPath, 'unified-mpc.sqlite'));
    const fresh = readPersistedSettings(path.join(freshRoots.dataPath, 'unified-mpc.sqlite')).settings;
    expect(typeof upgradedPersisted.raw).toBe('string');
    expect(upgradedPersisted.raw).toContain('"settingsVersion"');
    const upgraded = upgradedPersisted.settings;

    for (const settings of [upgraded, fresh]) {
      expect(settings.settingsVersion).toBe(EXTENSIONS_SETTINGS_SCHEMA_VERSION);
      // Check each pin separately: `not.toEqual(expect.arrayContaining([...]))`
      // would still pass if an install kept only one of the two retired children.
      expect(settings.mandatoryMcpServers).not.toContain('memory');
      expect(settings.mandatoryMcpServers).not.toContain('thai-rag-mcp');
      expect(legacyPolicyIds(settings.policies ?? [])).toEqual([]);
    }

    // The upgraded document only carries the three policies it saved before the
    // upgrade, while the clean install also gets defaults that never existed in
    // that document. Pin both sets so a regression that drops either is visible.
    const upgradedIds = configuredPolicies(upgraded).map((policy) => policy.id).sort();
    const freshIds = configuredPolicies(fresh).map((policy) => policy.id).sort();
    expect(upgradedIds).toEqual(['code-safety:godkiller', 'code:pre-edit-context', 'memory:workspace-selective']);
    expect(freshIds).toEqual([
      'code-safety:godkiller',
      'code:pre-edit-context',
      'memory:workspace-selective',
      'optional:context7',
      'optional:filesystem',
      'optional:sequentialthinking',
      'optional:ui-skills',
      'session-start:ask-matt',
    ]);

    // Both paths must agree on the entries that replaced the retired child
    // topology, including their resource type, enforcement and mandatory flag.
    const shape = (policies: ConfiguredPolicies): string[] => policies
      .filter((policy) => policy.resourceId === 'native-memory' || policy.resourceId === 'native-thai-rag')
      .map((policy) => `${policy.resourceId}:${policy.resourceType}:${policy.enforcement}:${policy.mandatory}`)
      .sort();
    expect(shape(configuredPolicies(fresh))).toEqual(shape(configuredPolicies(upgraded)));
  }, 30_000);
});
