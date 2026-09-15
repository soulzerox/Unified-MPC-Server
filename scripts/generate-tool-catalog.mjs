import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(repositoryRoot, 'docs', 'architecture', 'TOOL_CONTRACT.md');
const registryModulePath = path.join(repositoryRoot, 'packages', 'mcp-server', 'dist', 'tool-registry.js');
const upgradeCatalogModulePath = path.join(repositoryRoot, 'packages', 'mcp-server', 'dist', 'upgrade-catalog.js');
const runtimeFixturesModulePath = path.join(repositoryRoot, 'packages', 'mcp-server', 'dist', 'tool-runtime-fixtures.js');
const contractStartMarker = '<!-- BEGIN GENERATED TOOL REGISTRY -->';
const contractEndMarker = '<!-- END GENERATED TOOL REGISTRY -->';
const checkOnly = process.argv.includes('--check');

const { ToolRegistry } = await import(pathToFileURL(registryModulePath).href);
const { upgradeCatalogEntry } = await import(pathToFileURL(upgradeCatalogModulePath).href);
const { TOOL_RUNTIME_FIXTURES } = await import(pathToFileURL(runtimeFixturesModulePath).href);
const actor = { clientId: 'catalog-generator', clientName: 'catalog-generator' };
// The real desktop/CLI runtimes wire AgentSwarmService whenever Codex delegation is
// enabled. Supply a non-invoked placeholder here so generated advertised counts model
// the production service surface instead of accidentally hiding agent_swarm_run.
const codexEnabledRegistry = new ToolRegistry({ agentSwarm: {} }, actor, { codexToolsEnabled: true });
const tools = codexEnabledRegistry.listAll();
const defaultAdvertisedTools = new ToolRegistry({}, actor).list();
const codexAdvertisedTools = codexEnabledRegistry.list();
const defaultAdvertisedNames = new Set(defaultAdvertisedTools.map((tool) => tool.name));
const codexAdvertisedNames = new Set(codexAdvertisedTools.map((tool) => tool.name));
const defaultAdvertisedCount = defaultAdvertisedTools.length;
const codexEnabledAdvertisedCount = codexAdvertisedTools.length;
const advertisedLabel = (name) => defaultAdvertisedNames.has(name) ? 'default' : codexAdvertisedNames.has(name) ? 'Codex opt-in' : 'no';
const deliveryLabel = (name) => upgradeCatalogEntry(name)?.deliveryState ?? 'operational';
const evidenceLabel = (name) => TOOL_RUNTIME_FIXTURES[name]?.evidence?.kind ?? 'missing';
const current = await readFile(contractPath, 'utf8');
const newline = current.includes('\r\n') ? '\r\n' : '\n';
const rows = tools.map((tool, index) => {
  const readOnly = tool.annotations.readOnlyHint === true ? 'yes' : 'no';
  const destructive = tool.annotations.destructiveHint === true ? 'yes' : 'no';
  return `| ${index + 1} | \`${tool.name}\` | ${tool.permission} | ${advertisedLabel(tool.name)} | ${deliveryLabel(tool.name)} | ${evidenceLabel(tool.name)} | ${readOnly} | ${destructive} |`;
});
const block = [
  contractStartMarker,
  '## Generated live ToolRegistry index',
  '',
  `This complete inventory is generated from \`ToolRegistry.listAll()\`: **${tools.length} total tool definitions**. The runtime advertises **${defaultAdvertisedCount} tools by default** and **${codexEnabledAdvertisedCount} tools when Codex delegation plus Agent Swarm is enabled** through \`tools/list\`.`,
  'Run `pnpm docs:tools` after intentionally changing the registry; CI runs `pnpm docs:tools:check` and fails on drift.',
  '',
  '| # | Tool | Permission | Advertised | Delivery | Runtime evidence | Read-only | Destructive |',
  '| ---: | --- | --- | --- | --- | --- | :---: | :---: |',
  ...rows,
  contractEndMarker,
].join(newline);
const start = current.indexOf(contractStartMarker);
const end = current.indexOf(contractEndMarker);
let expected;
if (start >= 0 && end >= start) {
  expected = current.slice(0, start) + block + current.slice(end + contractEndMarker.length);
} else {
  const insertionPoint = current.indexOf('## Protocol and result rules');
  if (insertionPoint < 0) throw new Error('Tool contract insertion point was not found');
  expected = current.slice(0, insertionPoint) + block + newline + newline + current.slice(insertionPoint);
}

const missingEvidence = tools.filter((tool) => evidenceLabel(tool.name) === 'missing').map((tool) => tool.name);
if (missingEvidence.length > 0) throw new Error(`Runtime evidence is missing for: ${missingEvidence.join(', ')}`);

const normalizeLineEndings = (value) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

if (checkOnly) {
  if (normalizeLineEndings(current) !== normalizeLineEndings(expected)) {
    process.stderr.write(`Tool catalog drift detected: total=${tools.length}, defaultAdvertised=${defaultAdvertisedCount}, codexAdvertised=${codexEnabledAdvertisedCount}. Run: corepack pnpm@10.15.0 docs:tools\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Tool catalog is synchronized: total=${tools.length}, defaultAdvertised=${defaultAdvertisedCount}, codexAdvertised=${codexEnabledAdvertisedCount}.\n`);
  }
} else {
  await writeFile(contractPath, expected, 'utf8');
  process.stdout.write(`Generated ToolRegistry catalog: total=${tools.length}, defaultAdvertised=${defaultAdvertisedCount}, codexAdvertised=${codexEnabledAdvertisedCount}.\n`);
}
