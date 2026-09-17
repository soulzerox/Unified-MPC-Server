import type { DiscoveredMcpServer, ExtensionsSettings, PolicyEntry, ResolvedPolicyEntry, RuntimePolicySnapshot, SkillSummary } from './types.js';

const NATIVE_PROVIDER_SERVER_IDS = new Set(['thai-rag-mcp']);

export const DEFAULT_POLICIES: readonly PolicyEntry[] = Object.freeze([
  { id: 'session-start:ask-matt', resourceId: 'ask-matt', resourceType: 'skill', mandatory: true, enforcement: 'EVERY_SESSION', directive: 'At the start of every user task, load and follow ask-matt before planning or acting.' },
  { id: 'child:memory', resourceId: 'memory', resourceType: 'server', mandatory: true, enforcement: 'REALTIME', directive: 'Use working memory proactively for current-task recall and durable progress notes.', requiredTools: ['search_nodes', 'create_entities', 'add_observations'], readOnlyTools: ['search_nodes', 'read_graph', 'open_nodes'] },
  { id: 'code-safety:godkiller', resourceId: 'godkiller', resourceType: 'server', mandatory: false, enforcement: 'ON_DEMAND', directive: 'For high-risk changes such as broad refactors, migrations, security-sensitive work, or unclear blast radius, request the curated Godkiller safety path by setting runGodkillerSafetyCheck=true on prepare_code_change.', requiredTools: ['gk_task'] },
  { id: 'optional:sequentialthinking', resourceId: 'sequentialthinking', resourceType: 'server', mandatory: false, enforcement: 'ON_DEMAND', directive: 'Use revisable step-by-step reasoning when a complex task benefits from explicit decomposition.', readOnlyTools: ['sequentialthinking'] },
  { id: 'optional:context7', resourceId: 'context7', resourceType: 'server', mandatory: false, enforcement: 'ON_DEMAND', directive: 'Use current version-specific library, framework, SDK, or API documentation before relying on external interfaces.', readOnlyTools: ['resolve-library-id', 'query-docs'] },
  { id: 'optional:filesystem', resourceId: 'filesystem', resourceType: 'server', mandatory: false, enforcement: 'ON_DEMAND', directive: 'Use cross-project or batch filesystem capabilities when ordinary workspace file tools are not sufficient.', readOnlyTools: ['read_file', 'read_text_file', 'read_media_file', 'read_multiple_files', 'list_directory', 'list_directory_with_sizes', 'directory_tree', 'search_files', 'get_file_info', 'list_allowed_directories'] },
  { id: 'optional:ui-skills', resourceId: 'ui-skills', resourceType: 'skill', mandatory: false, enforcement: 'ON_DEMAND', directive: 'Use UI/UX and frontend best-practice guidance when designing or implementing user interfaces.' },
]);

export function configuredPolicies(settings: ExtensionsSettings): readonly PolicyEntry[] {
  const legacyMandatoryNames = new Set(settings.mandatoryMcpServers.map((name) => name.trim().toLowerCase()).filter(Boolean));
  const configured = (settings.policies === undefined
    ? DEFAULT_POLICIES.filter((policy) => policy.resourceType !== 'server' || !policy.mandatory || legacyMandatoryNames.has(policy.resourceId.trim().toLowerCase()))
    : [...settings.policies])
    .filter((policy) => policy.resourceType !== 'server' || !NATIVE_PROVIDER_SERVER_IDS.has(policy.resourceId.trim().toLowerCase()));
  const configuredServers = new Set(configured
    .filter((policy) => policy.resourceType === 'server')
    .map((policy) => policy.resourceId.trim().toLowerCase()));
  const defaultMandatoryServers = new Map(DEFAULT_POLICIES
    .filter((policy) => policy.resourceType === 'server' && policy.mandatory)
    .map((policy) => [policy.resourceId.trim().toLowerCase(), policy] as const));
  for (const rawName of settings.mandatoryMcpServers) {
    const name = rawName.trim();
    const key = name.toLowerCase();
    if (name.length === 0 || configuredServers.has(key) || NATIVE_PROVIDER_SERVER_IDS.has(key)) continue;
    configured.push(defaultMandatoryServers.get(key) ?? {
      id: `legacy:mandatory:${key}`,
      resourceId: name,
      resourceType: 'server',
      mandatory: true,
      enforcement: 'EVERY_SESSION',
      directive: `Keep legacy mandatory child MCP server ${name} connected and available.`,
    });
    configuredServers.add(key);
  }
  return configured;
}

export function reconcileRuntimePolicies(settings: ExtensionsSettings, servers: readonly DiscoveredMcpServer[], skills: readonly SkillSummary[]): RuntimePolicySnapshot {
  const configured = configuredPolicies(settings);
  const resolved: UnprioritizedResolvedPolicyEntry[] = configured.map((policy) => resolveConfiguredPolicy(policy, servers, skills));
  const coveredServers = new Set(configured.filter((policy) => policy.resourceType === 'server').map((policy) => policy.resourceId.trim().toLowerCase()));
  for (const server of servers) {
    const key = server.name.trim().toLowerCase();
    if (!server.enabled || server.excluded || coveredServers.has(key) || NATIVE_PROVIDER_SERVER_IDS.has(key)) continue;
    resolved.push({ id: `auto:server:${key}`, resourceId: server.name, resourceType: 'server', mandatory: false, enforcement: 'AUTO_ROUTE', directive: `Inspect and use child MCP server ${server.name} automatically when its live tool catalog is relevant; do not wait for the user to name it.`, source: 'discovered', available: true, resolvedResourceId: server.name });
  }
  const policies: ResolvedPolicyEntry[] = resolved.map((policy, index) => ({ ...policy, priority: `P${index + 1}` }));
  return { ready: policies.filter((policy) => policy.mandatory).every((policy) => policy.available), policies };
}

type UnprioritizedResolvedPolicyEntry = Omit<ResolvedPolicyEntry, 'priority'>;

function resolveConfiguredPolicy(policy: PolicyEntry, servers: readonly DiscoveredMcpServer[], skills: readonly SkillSummary[]): UnprioritizedResolvedPolicyEntry {
  if (policy.resourceType === 'server') {
    const key = policy.resourceId.trim().toLowerCase();
    const server = servers.find((entry) => entry.name.trim().toLowerCase() === key);
    return { ...policy, source: 'configured', available: server !== undefined && server.enabled && !server.excluded, ...(server === undefined ? {} : { resolvedResourceId: server.name }) };
  }
  const key = policy.resourceId.trim().toLowerCase();
  const skill = skills.find((entry) => entry.id === policy.resourceId || entry.name.trim().toLowerCase() === key);
  return { ...policy, source: 'configured', available: skill !== undefined, ...(skill === undefined ? {} : { resolvedResourceId: skill.id }) };
}
