import { parseExtensionsSettings } from './allowlist.js';
import { DEFAULT_POLICIES } from './runtime-policy.js';
import {
  EXTENSIONS_SETTINGS_SCHEMA_VERSION,
  type ExtensionsSettings,
  type PolicyEntry,
} from './types.js';

/**
 * Persisted extensions settings from before the native-capability topology carry
 * policy rows that describe the removed mandatory child MCP servers. Issue #4
 * requires an explicit, versioned reconciliation instead of silently filtering
 * those rows at read time, because the stale document is what every restart,
 * WebUI save and generated IDE policy block keeps reading.
 */

export type ExtensionsSettingsMigrationNoticeCode =
  | 'legacy-policy-migrated'
  | 'legacy-mandatory-server-removed'
  | 'user-defined-server-preserved'
  | 'user-defined-policy-preserved'
  | 'ambiguous-mandatory-server-preserved'
  | 'invalid-settings-json';

export interface ExtensionsSettingsMigrationNotice {
  readonly code: ExtensionsSettingsMigrationNoticeCode;
  readonly message: string;
  readonly resourceId?: string;
}

export interface ExtensionsSettingsMigrationResult {
  readonly settings: ExtensionsSettings;
  readonly changed: boolean;
  readonly notices: readonly ExtensionsSettingsMigrationNotice[];
}

export interface ExtensionsSettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface PersistedExtensionsSettingsMigrationReport {
  readonly status: 'current' | 'applied' | 'invalid';
  readonly previousVersion: number;
  readonly version: number;
  readonly changed: boolean;
  readonly notices: readonly ExtensionsSettingsMigrationNotice[];
}

const LEGACY_MANDATORY_SERVER_IDS: ReadonlySet<string> = new Set(['memory', 'thai-rag-mcp', 'godkiller']);

interface LegacyPolicyTarget {
  readonly resourceId: string;
  readonly targetId: string;
}

/**
 * Exact released default ids. The id plus the server resource is the provenance
 * signal: a policy that matches both came from a persisted built-in document.
 * Anything else is treated as user configuration and left untouched.
 */
const LEGACY_POLICY_TARGETS: ReadonlyMap<string, LegacyPolicyTarget> = new Map([
  ['child:memory', { resourceId: 'memory', targetId: 'memory:workspace-selective' }],
  ['pre-edit:thai-rag', { resourceId: 'thai-rag-mcp', targetId: 'code:pre-edit-context' }],
]);

function defaultPolicy(id: string): PolicyEntry | undefined {
  return DEFAULT_POLICIES.find((policy) => policy.id === id);
}

function userConfiguredServerNames(settings: ExtensionsSettings): ReadonlySet<string> {
  return new Set(Object.keys(settings.extraMcpServers).map((name) => name.trim().toLowerCase()).filter(Boolean));
}

/**
 * Deterministic and idempotent: a document that already carries the current
 * schema version and no legacy rows returns `changed: false`.
 */
export function migrateExtensionsSettings(settings: ExtensionsSettings): ExtensionsSettingsMigrationResult {
  // A document that already carries the current version is authoritative user
  // state. Migrations only ever run against pre-versioned documents, so a v2
  // policy the user re-enables is never forced back to its legacy default.
  if ((settings.settingsVersion ?? 0) >= EXTENSIONS_SETTINGS_SCHEMA_VERSION) {
    return { settings, changed: false, notices: [] };
  }

  const notices: ExtensionsSettingsMigrationNotice[] = [];
  const userServers = userConfiguredServerNames(settings);
  let changed = true;

  // Policies first: a migrated built-in policy is the strong provenance signal
  // that allows the matching mandatory-server pin to be removed.
  const migratedBuiltinServers = new Set<string>();
  let policies: readonly PolicyEntry[] | undefined;
  if (settings.policies !== undefined) {
    const migrated: PolicyEntry[] = [];
    const migratedPolicyIds = new Set<string>();
    for (const policy of settings.policies) {
      const mapped = migratePolicy(policy, userServers, notices);
      if (mapped.migrated) {
        changed = true;
        migratedBuiltinServers.add(policy.resourceId.trim().toLowerCase());
      }
      const existingIndex = migrated.findIndex((entry) => entry.id === mapped.policy.id);
      if (existingIndex === -1) {
        migrated.push(mapped.policy);
        if (mapped.migrated) migratedPolicyIds.add(mapped.policy.id);
        continue;
      }
      if (mapped.migrated) continue;
      if (migratedPolicyIds.has(mapped.policy.id)) {
        // A user-saved policy wins over a capability policy generated above.
        migrated[existingIndex] = mapped.policy;
        migratedPolicyIds.delete(mapped.policy.id);
        changed = true;
        continue;
      }
      // Duplicate user ids are unusual but are user data, not ours to drop.
      migrated.push(mapped.policy);
    }
    policies = migrated;
  }

  const mandatoryMcpServers: string[] = [];
  for (const rawName of settings.mandatoryMcpServers) {
    const name = rawName.trim();
    const key = name.toLowerCase();
    if (LEGACY_MANDATORY_SERVER_IDS.has(key)) {
      if (userServers.has(key)) {
        mandatoryMcpServers.push(rawName);
        notices.push({
          code: 'user-defined-server-preserved',
          message: `Kept ${name} mandatory because it is configured as a user-defined MCP server.`,
          resourceId: name,
        });
        continue;
      }
      const builtinPolicy = migratedBuiltinServers.has(key) || settings.policies === undefined;
      if (!builtinPolicy) {
        // A saved policy list that customizes or omits this server means the
        // provenance is ambiguous. Preserve the user's document and report it.
        mandatoryMcpServers.push(rawName);
        notices.push({
          code: 'ambiguous-mandatory-server-preserved',
          message: `Kept ${name} because its provenance is ambiguous; it no longer keeps a built-in child topology alive.`,
          resourceId: name,
        });
        continue;
      }
      changed = true;
      notices.push({
        code: 'legacy-mandatory-server-removed',
        message: `Removed the retired built-in mandatory MCP server ${name}.`,
        resourceId: name,
      });
      continue;
    }
    mandatoryMcpServers.push(rawName);
  }

  const next: ExtensionsSettings = {
    ...settings,
    mandatoryMcpServers,
    ...(policies === undefined ? {} : { policies }),
    settingsVersion: EXTENSIONS_SETTINGS_SCHEMA_VERSION,
  };
  return { settings: next, changed, notices };
}

interface MigratedPolicy {
  readonly policy: PolicyEntry;
  readonly migrated: boolean;
}

function migratePolicy(
  policy: PolicyEntry,
  userServers: ReadonlySet<string>,
  notices: ExtensionsSettingsMigrationNotice[],
): MigratedPolicy {
  const resourceKey = policy.resourceId.trim().toLowerCase();
  const legacyTarget = LEGACY_POLICY_TARGETS.get(policy.id);
  if (legacyTarget !== undefined && policy.resourceType === 'server' && legacyTarget.resourceId === resourceKey) {
    if (userServers.has(resourceKey)) {
      notices.push({
        code: 'user-defined-policy-preserved',
        message: `Kept policy ${policy.id} because ${policy.resourceId} is a user-defined MCP server.`,
        resourceId: policy.resourceId,
      });
      return { policy, migrated: false };
    }
    const replacement = defaultPolicy(legacyTarget.targetId);
    if (replacement !== undefined) {
      notices.push({
        code: 'legacy-policy-migrated',
        message: `Migrated ${policy.id} to native capability policy ${replacement.id}.`,
        resourceId: policy.resourceId,
      });
      return { policy: replacement, migrated: true };
    }
  }

  // #6d55129 moved Godkiller from a mandatory pre-edit child to an on-demand
  // safety check; persisted documents still carry the old mandatory shape.
  if (policy.id === 'code-safety:godkiller'
    && policy.resourceType === 'server'
    && resourceKey === 'godkiller'
    && policy.mandatory) {
    if (userServers.has(resourceKey)) {
      notices.push({
        code: 'user-defined-policy-preserved',
        message: `Kept policy ${policy.id} because ${policy.resourceId} is a user-defined MCP server.`,
        resourceId: policy.resourceId,
      });
      return { policy, migrated: false };
    }
    const replacement = defaultPolicy('code-safety:godkiller');
    if (replacement !== undefined) {
      notices.push({
        code: 'legacy-policy-migrated',
        message: 'Migrated the mandatory Godkiller policy to the on-demand safety policy.',
        resourceId: policy.resourceId,
      });
      return { policy: replacement, migrated: true };
    }
  }

  return { policy, migrated: false };
}

/**
 * Persisted-document entry point. Invalid JSON is reported and left untouched so
 * a malformed document is never replaced by defaults or half-written.
 */
export function ensureExtensionsSettingsMigrated(
  store: ExtensionsSettingsStore,
  key: string,
): PersistedExtensionsSettingsMigrationReport {
  const raw = store.get(key);
  if (raw === null || raw.trim().length === 0) {
    return {
      status: 'current',
      previousVersion: EXTENSIONS_SETTINGS_SCHEMA_VERSION,
      version: EXTENSIONS_SETTINGS_SCHEMA_VERSION,
      changed: false,
      notices: [],
    };
  }

  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    record = parsed as Record<string, unknown>;
  } catch {
    return {
      status: 'invalid',
      previousVersion: 0,
      version: EXTENSIONS_SETTINGS_SCHEMA_VERSION,
      changed: false,
      notices: [{
        code: 'invalid-settings-json',
        message: 'Persisted extensions settings are not a JSON object; left untouched for manual recovery.',
      }],
    };
  }

  const current = parseExtensionsSettings(raw);
  const previousVersion = current.settingsVersion ?? 0;
  const migration = migrateExtensionsSettings(current);
  if (!migration.changed) {
    return {
      status: 'current',
      previousVersion,
      version: EXTENSIONS_SETTINGS_SCHEMA_VERSION,
      changed: false,
      notices: migration.notices,
    };
  }

  const document: Record<string, unknown> = {
    ...record,
    settingsVersion: EXTENSIONS_SETTINGS_SCHEMA_VERSION,
    mandatoryMcpServers: migration.settings.mandatoryMcpServers,
    ...(migration.settings.policies === undefined ? {} : { policies: migration.settings.policies }),
  };
  store.set(key, JSON.stringify(document));
  return {
    status: 'applied',
    previousVersion,
    version: EXTENSIONS_SETTINGS_SCHEMA_VERSION,
    changed: true,
    notices: migration.notices,
  };
}
