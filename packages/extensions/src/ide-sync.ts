import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { DEFAULT_EXTENSIONS_SETTINGS, type ExtensionsSettings, type PolicyEntry, type RuntimePolicySnapshot } from './types.js';
import { DEFAULT_POLICIES as RUNTIME_DEFAULT_POLICIES, reconcileRuntimePolicies } from './runtime-policy.js';
import { McpConfigLoader } from './mcp-config-loader.js';
import { SkillCatalog } from './skill-catalog.js';

export type PolicyPriority = string;
export type { PolicyEntry } from './types.js';

export const DEFAULT_POLICIES: readonly PolicyEntry[] = RUNTIME_DEFAULT_POLICIES;

export const POLICY_BLOCK_START = '<!-- MCP-POLICY-START -->';
export const POLICY_BLOCK_END = '<!-- MCP-POLICY-END -->';

export const SYNC_TARGETS = ['all', 'cursor', 'cline', 'claude', 'antigravity', 'opencode', 'codex', 'omp', 'agents'] as const;

export type SyncTarget = (typeof SYNC_TARGETS)[number];

export interface IdeSyncOptions {
  readonly homeDir?: string;
  readonly workspaceRoot?: string;
  readonly policies?: readonly PolicyEntry[];
  readonly settings?: ExtensionsSettings;
}

export class IdeSyncService {
  private readonly home: string;
  private readonly codexHome: string;
  private readonly workspace: string | undefined;
  private readonly policies: readonly PolicyEntry[];
  private readonly settings: ExtensionsSettings;

  public constructor(options: IdeSyncOptions = {}) {
    this.home = options.homeDir ?? os.homedir();
    this.codexHome = resolveCodexHome(this.home, options.homeDir);
    this.workspace = options.workspaceRoot?.trim();
    this.policies = options.policies ?? DEFAULT_POLICIES;
    this.settings = options.settings ?? DEFAULT_EXTENSIONS_SETTINGS;
  }

  public compile(policies: readonly PolicyEntry[] = this.policies): string {
    const lines: string[] = [
      POLICY_BLOCK_START,
      '# MCP Runtime Policy — Dynamic Resource Routing',
      '',
      '| Priority | Policy | Resource | Type | Enforcement | Mandatory |',
      '|---|---|---|---|---|---|',
    ];

    for (const [index, p] of policies.entries()) {
      const mandatoryText = p.mandatory ? '✅ YES' : 'Optional';
      lines.push(`| P${index + 1} | ${p.id} | ${p.resourceId} | ${p.resourceType} | ${p.enforcement} | ${mandatoryText} |`);
    }

    lines.push('');
    lines.push('## Enforcement Rules');
    lines.push('');

    for (const [index, p] of policies.entries()) {
      lines.push(`- **P${index + 1} · ${p.id} / ${p.resourceId}** (${p.enforcement}): ${p.directive}`);
    }

    lines.push('');
    lines.push(POLICY_BLOCK_END);
    return lines.join('\n');
  }

  public async policySnapshot(): Promise<RuntimePolicySnapshot> {
    const settings: ExtensionsSettings = { ...this.settings, policies: this.policies };
    const servers = await new McpConfigLoader({ settings, homeDir: this.home, ...(this.workspace === undefined ? {} : { workspaceRoot: this.workspace }) }).discover();
    const skillsResult = await new SkillCatalog({ settings, homeDir: this.home, ...(this.workspace === undefined ? {} : { workspaceRoot: this.workspace }) }).list({});
    const skills = skillsResult.ok ? skillsResult.value.skills : [];
    return reconcileRuntimePolicies(settings, servers, skills);
  }

  public async sync(targets: readonly SyncTarget[] = ['all']): Promise<Result<{ readonly updatedFiles: readonly string[] }>> {
    const invalidTargets = validateSyncTargets(targets);
    if (invalidTargets !== undefined) return err(invalidTargets);
    const updatedFiles: string[] = [];
    const isAll = targets.includes('all');
    const compiled = this.compile((await this.policySnapshot()).policies);

    try {
      // 1. Cursor
      if (isAll || targets.includes('cursor')) {
        if (this.workspace !== undefined) {
          const cursorFile = path.join(this.workspace, '.cursor', 'rules', '00-mandatory-policy.mdc');
          const cursorContent = [
            '---',
            'description: Mandatory MCP Server and Skill Execution Priority Policy',
            'globs: *',
            'alwaysApply: true',
            '---',
            '',
            compiled,
            '',
          ].join('\n');
          await writeAtomic(cursorFile, cursorContent);
          updatedFiles.push(cursorFile);
        }
      }

      // 2. Cline
      if (isAll || targets.includes('cline')) {
        if (this.workspace !== undefined) {
          const clineWsFile = path.join(this.workspace, '.clinerules');
          await updateFileWithBlock(clineWsFile, compiled);
          updatedFiles.push(clineWsFile);
        }
        const clineHomeDir = path.join(this.home, '.cline', 'rules');
        const clineHomeFile = path.join(clineHomeDir, 'mcp-policy.md');
        await updateFileWithBlock(clineHomeFile, compiled);
        updatedFiles.push(clineHomeFile);
      }

      // 3. Antigravity
      if (isAll || targets.includes('antigravity')) {
        const agRuleFile = path.join(this.home, '.gemini', 'antigravity', 'rules', 'mcp-policy.md');
        await writeAtomic(agRuleFile, `${compiled}\n`);
        updatedFiles.push(agRuleFile);

        if (this.workspace !== undefined) {
          const agWsGemini = path.join(this.workspace, 'GEMINI.md');
          await updateFileWithBlock(agWsGemini, compiled);
          updatedFiles.push(agWsGemini);
        }
      }

      // 4. OpenCode / Freebuff / Agents / Codex share the AGENTS.md convention.
      if (isAll || targets.includes('opencode') || targets.includes('agents') || targets.includes('codex')) {
        if (this.workspace !== undefined) {
          const agentsFile = path.join(this.workspace, 'AGENTS.md');
          await updateFileWithBlock(agentsFile, compiled);
          updatedFiles.push(agentsFile);
        }
      }
      if (isAll || targets.includes('opencode') || targets.includes('agents')) {
        const opencodeAgents = path.join(this.home, '.config', 'opencode', 'AGENTS.md');
        await updateFileWithBlock(opencodeAgents, compiled);
        updatedFiles.push(opencodeAgents);
      }
      // Codex reads global instructions from `$CODEX_HOME/AGENTS.md`, which
      // defaults to `~/.codex/AGENTS.md`.
      if (isAll || targets.includes('codex')) {
        const codexAgents = path.join(this.codexHome, 'AGENTS.md');
        await updateFileWithBlock(codexAgents, compiled);
        updatedFiles.push(codexAgents);
      }

      // 5. Claude
      if (isAll || targets.includes('claude')) {
        const claudeGlobal = path.join(this.home, '.claude', 'CLAUDE.md');
        await updateFileWithBlock(claudeGlobal, compiled);
        updatedFiles.push(claudeGlobal);

        if (this.workspace !== undefined) {
          const claudeWs = path.join(this.workspace, 'CLAUDE.md');
          await updateFileWithBlock(claudeWs, compiled);
          updatedFiles.push(claudeWs);
        }
      }

      // 6. Oh My Pi
      if (isAll || targets.includes('omp')) {
        if (this.workspace !== undefined) {
          const ompWs = path.join(this.workspace, '.omp', 'system.md');
          await updateFileWithBlock(ompWs, compiled);
          updatedFiles.push(ompWs);
        }
      }

      return ok({ updatedFiles });
    } catch (error) {
      return err(appError('INTERNAL_ERROR', `Failed to sync IDE policies: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}

/**
 * Codex reads global instructions from `$CODEX_HOME/AGENTS.md`. Honor that
 * variable the same way `SkillCatalog` does, but only when the caller did not
 * pin `homeDir`: an explicit home is authoritative, so tests and embedded
 * callers are never redirected by the ambient environment.
 */
export function resolveCodexHome(home: string, explicitHome: string | undefined): string {
  const configured = explicitHome === undefined ? process.env.CODEX_HOME?.trim() : undefined;
  return configured === undefined || configured.length === 0 ? path.join(home, '.codex') : path.resolve(configured);
}

/**
 * `--targets` values reach the service through a type cast in the CLI, so an
 * unknown name must be refused here. Without this check `sync` writes nothing
 * and still reports success, leaving the caller convinced that the policy was
 * synchronized. Mirrors the install and prune target validation.
 */
function validateSyncTargets(targets: readonly SyncTarget[]): ReturnType<typeof appError> | undefined {
  if (targets.length === 0) return appError('INVALID_INPUT', 'At least one target must be specified');
  const supported = new Set<string>(SYNC_TARGETS);
  const invalid = [...new Set(targets.filter((target) => !supported.has(target)))];
  if (invalid.length === 0) return undefined;
  return appError(
    'UNSUPPORTED_TARGET',
    `Unsupported target(s): ${invalid.join(', ')}. Supported targets: ${SYNC_TARGETS.join(', ')}`,
    false,
    { invalidTargets: invalid.join(', '), supportedTargets: SYNC_TARGETS.join(', ') },
  );
}

export function replaceOrAppendPolicyBlock(existing: string, policyBlock: string): string {
  const startIndex = existing.indexOf(POLICY_BLOCK_START);
  const endIndex = existing.indexOf(POLICY_BLOCK_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
    const before = existing.slice(0, startIndex);
    const after = existing.slice(endIndex + POLICY_BLOCK_END.length);
    return `${before.trimEnd()}${before.trimEnd().length > 0 ? '\n\n' : ''}${policyBlock}${after.trimStart().length > 0 ? `\n\n${after.trimStart()}` : '\n'}`;
  }

  const trimmed = existing.trim();
  if (trimmed.length === 0) {
    return `${policyBlock}\n`;
  }
  return `${trimmed}\n\n${policyBlock}\n`;
}

async function updateFileWithBlock(filePath: string, policyBlock: string): Promise<void> {
  let existing = '';
  try {
    existing = await readFile(filePath, 'utf8');
  } catch {
    existing = '';
  }
  const updated = replaceOrAppendPolicyBlock(existing, policyBlock);
  await writeAtomic(filePath, updated);
}

export async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore temp cleanup error
    }
    throw error;
  }
}
