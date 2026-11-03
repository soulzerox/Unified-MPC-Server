import { describe, expect, it } from 'vitest';
import {
  ensureExtensionsSettingsMigrated,
  migrateExtensionsSettings,
  type ExtensionsSettingsStore,
} from './settings-migration.js';
import { configuredPolicies } from './runtime-policy.js';
import { DEFAULT_EXTENSIONS_SETTINGS, EXTENSIONS_SETTINGS_SCHEMA_VERSION, type ExtensionsSettings, type PolicyEntry } from './types.js';

const LEGACY_MEMORY_POLICY: PolicyEntry = {
  id: 'child:memory',
  resourceId: 'memory',
  resourceType: 'server',
  mandatory: true,
  enforcement: 'REALTIME',
  directive: 'Use working memory proactively for current-task recall and durable progress notes.',
  requiredTools: ['search_nodes', 'create_entities', 'add_observations'],
  readOnlyTools: ['search_nodes', 'read_graph', 'open_nodes'],
};

const LEGACY_PRE_EDIT_POLICY: PolicyEntry = {
  id: 'pre-edit:thai-rag',
  resourceId: 'thai-rag-mcp',
  resourceType: 'server',
  mandatory: true,
  enforcement: 'EVERY_SESSION',
  directive: 'Use local RAG and pre-edit context automatically when repository context is relevant.',
  requiredTools: ['pre_edit_context'],
};

const LEGACY_GODKILLER_POLICY: PolicyEntry = {
  id: 'code-safety:godkiller',
  resourceId: 'godkiller',
  resourceType: 'server',
  mandatory: true,
  enforcement: 'SAFETY_PRE_CHECK',
  directive: 'Use Godkiller code intelligence and safety checks before code mutations that require pre-edit diagnostics.',
  requiredTools: ['gk_task'],
};

const CUSTOM_SERVER_POLICY: PolicyEntry = {
  id: 'custom:server',
  resourceId: 'custom-server',
  resourceType: 'server',
  mandatory: true,
  enforcement: 'EVERY_SESSION',
  directive: 'Keep the user-defined server available.',
};

function legacySettings(overrides: Partial<ExtensionsSettings> = {}): ExtensionsSettings {
  return {
    ...DEFAULT_EXTENSIONS_SETTINGS,
    settingsVersion: 1,
    mandatoryMcpServers: ['memory', 'thai-rag-mcp', 'godkiller', 'custom-server'],
    policies: [LEGACY_MEMORY_POLICY, LEGACY_PRE_EDIT_POLICY, LEGACY_GODKILLER_POLICY, CUSTOM_SERVER_POLICY],
    ...overrides,
  };
}

class MemorySettingsStore implements ExtensionsSettingsStore {
  public readonly writes: string[] = [];

  public constructor(private readonly values = new Map<string, string>()) {}

  public get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public set(key: string, value: string): void {
    this.writes.push(value);
    this.values.set(key, value);
  }
}

describe('extensions settings migration', () => {
  it('converts persisted built-in child policies into native capability policies', () => {
    const result = migrateExtensionsSettings(legacySettings());

    expect(result.changed).toBe(true);
    expect(result.settings.settingsVersion).toBe(EXTENSIONS_SETTINGS_SCHEMA_VERSION);
    expect(result.settings.mandatoryMcpServers).toEqual(['custom-server']);
    expect(result.settings.policies).toEqual([
      expect.objectContaining({
        id: 'memory:workspace-selective',
        resourceId: 'native-memory',
        resourceType: 'capability',
        mandatory: false,
        enforcement: 'ON_DEMAND',
        requiredCapabilities: expect.arrayContaining(['rag_recall', 'rag_remember', 'workspace_memory_record', 'rag_forget']),
      }),
      expect.objectContaining({
        id: 'code:pre-edit-context',
        resourceId: 'native-thai-rag',
        resourceType: 'capability',
        mandatory: true,
        enforcement: 'SAFETY_PRE_CHECK',
        requiredCapabilities: expect.arrayContaining(['rag_pre_edit_context', 'rag_code_search']),
      }),
      expect.objectContaining({
        id: 'code-safety:godkiller',
        mandatory: false,
        enforcement: 'ON_DEMAND',
        requiredTools: ['gk_task'],
      }),
      CUSTOM_SERVER_POLICY,
    ]);
    expect(result.notices.map((notice) => notice.code)).toEqual(expect.arrayContaining([
      'legacy-policy-migrated',
      'legacy-mandatory-server-removed',
    ]));
  });

  it('is idempotent and drops a duplicate capability policy', () => {
    const once = migrateExtensionsSettings(legacySettings({
      settingsVersion: undefined,
      policies: [LEGACY_MEMORY_POLICY, {
        id: 'memory:workspace-selective',
        resourceId: 'native-memory',
        resourceType: 'capability',
        mandatory: false,
        enforcement: 'ON_DEMAND',
        directive: 'Already migrated.',
      }],
    }));
    expect(once.settings.policies).toHaveLength(1);
    expect(once.settings.policies?.[0]?.id).toBe('memory:workspace-selective');

    const twice = migrateExtensionsSettings(once.settings);
    expect(twice.changed).toBe(false);
    expect(twice.settings).toEqual(once.settings);
  });

  it('preserves a user-defined MCP server that reuses a retired built-in name', () => {
    const settings = legacySettings({
      settingsVersion: 1,
      extraMcpServers: { memory: { command: 'node', args: ['custom-memory.js'] } },
      mandatoryMcpServers: ['memory'],
      policies: [{ ...LEGACY_MEMORY_POLICY, directive: 'Use my own memory server.' }],
    });

    const result = migrateExtensionsSettings(settings);
    expect(result.settings.mandatoryMcpServers).toEqual(['memory']);
    expect(result.settings.policies).toEqual([{ ...LEGACY_MEMORY_POLICY, directive: 'Use my own memory server.' }]);
    expect(result.notices.map((notice) => notice.code)).toEqual(expect.arrayContaining([
      'user-defined-server-preserved',
      'user-defined-policy-preserved',
    ]));

    // The runtime policy surface must not filter the user's explicit server.
    expect(configuredPolicies(result.settings)).toEqual([
      expect.objectContaining({ id: 'child:memory', resourceId: 'memory', resourceType: 'server' }),
    ]);
  });

  it('never rewrites a current-version document, including a re-enabled Godkiller', () => {
    const userPolicy: PolicyEntry = {
      id: 'code-safety:godkiller',
      resourceId: 'godkiller',
      resourceType: 'server',
      mandatory: true,
      enforcement: 'SAFETY_PRE_CHECK',
      directive: 'Use Godkiller before code mutations.',
      requiredTools: ['gk_task'],
    };
    const settings: ExtensionsSettings = {
      ...DEFAULT_EXTENSIONS_SETTINGS,
      settingsVersion: EXTENSIONS_SETTINGS_SCHEMA_VERSION,
      mandatoryMcpServers: ['godkiller', 'memory'],
      policies: [userPolicy],
    };
    const result = migrateExtensionsSettings(settings);
    expect(result.changed).toBe(false);
    expect(result.settings).toBe(settings);
    expect(result.notices).toEqual([]);
  });

  it('removes retired default names from a pre-policy document', () => {
    const result = migrateExtensionsSettings({
      ...DEFAULT_EXTENSIONS_SETTINGS,
      settingsVersion: undefined,
      mandatoryMcpServers: ['memory', 'thai-rag-mcp'],
    });
    expect(result.settings.mandatoryMcpServers).toEqual([]);
    expect(result.changed).toBe(true);
  });

  it('preserves an ambiguous legacy name instead of deleting possible user data', () => {
    const result = migrateExtensionsSettings({
      ...DEFAULT_EXTENSIONS_SETTINGS,
      settingsVersion: 1,
      mandatoryMcpServers: ['memory'],
      policies: [CUSTOM_SERVER_POLICY],
    });
    expect(result.settings.mandatoryMcpServers).toEqual(['memory']);
    expect(result.notices.map((notice) => notice.code)).toContain('ambiguous-mandatory-server-preserved');
    expect(result.settings.policies).toEqual([CUSTOM_SERVER_POLICY]);
    // Preserved or not, a retired native name no longer pins a child server.
    expect(configuredPolicies(result.settings).some((policy) => policy.resourceId === 'memory')).toBe(false);
  });

  it('keeps unrelated mandatory server names and unrelated policies', () => {
    const result = migrateExtensionsSettings({
      ...DEFAULT_EXTENSIONS_SETTINGS,
      settingsVersion: 1,
      mandatoryMcpServers: ['my-private-server'],
    });
    expect(result.settings.mandatoryMcpServers).toEqual(['my-private-server']);
    expect(result.settings.policies).toBeUndefined();
    expect(result.changed).toBe(true);
  });
});

describe('persisted extensions settings reconciliation', () => {
  it('treats a missing document as current and writes nothing', () => {
    const store = new MemorySettingsStore();
    const report = ensureExtensionsSettingsMigrated(store, 'extensions');
    expect(report).toMatchObject({ status: 'current', changed: false });
    expect(store.writes).toEqual([]);
  });

  it('leaves malformed JSON untouched and reports it', () => {
    const store = new MemorySettingsStore(new Map([['extensions', '{"policies": [']]));
    const report = ensureExtensionsSettingsMigrated(store, 'extensions');
    expect(report.status).toBe('invalid');
    expect(report.notices[0]?.code).toBe('invalid-settings-json');
    expect(store.writes).toEqual([]);
    expect(store.get('extensions')).toBe('{"policies": [');
  });

  it('rewrites a legacy document once while preserving unknown top-level fields', () => {
    const legacyDocument = JSON.stringify({
      ...legacySettings(),
      futureField: { keep: true },
    });
    const store = new MemorySettingsStore(new Map([['extensions', legacyDocument]]));

    const first = ensureExtensionsSettingsMigrated(store, 'extensions');
    expect(first).toMatchObject({ status: 'applied', changed: true, previousVersion: 1 });
    expect(store.writes).toHaveLength(1);
    const persisted = JSON.parse(store.get('extensions')!) as Record<string, unknown>;
    expect(persisted.futureField).toEqual({ keep: true });
    expect(persisted.settingsVersion).toBe(EXTENSIONS_SETTINGS_SCHEMA_VERSION);
    expect(persisted.mandatoryMcpServers).toEqual(['custom-server']);

    const second = ensureExtensionsSettingsMigrated(store, 'extensions');
    expect(second).toMatchObject({ status: 'current', changed: false });
    expect(store.writes).toHaveLength(1);
  });
});
