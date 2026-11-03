import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { writeAtomic } from './atomic-write.js';
import { withConfigMutationLock } from './config-mutation-lock.js';
import { DEFAULT_EXTENSIONS_SETTINGS, type ExtensionsSettings, type PolicyEntry, type RuntimePolicySnapshot } from './types.js';
import { DEFAULT_POLICIES as RUNTIME_DEFAULT_POLICIES, configuredPolicies, reconcileRuntimePolicies } from './runtime-policy.js';
import { McpConfigLoader } from './mcp-config-loader.js';
import { SkillCatalog } from './skill-catalog.js';

export { writeAtomic } from './atomic-write.js';

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

export interface ManagedPolicyRepairOptions {
  /**
   * Host-global instruction files (`~/.claude`, `~/.config/opencode`, `~/.codex`,
   * `~/.cline`, `~/.gemini`) are only repaired by the long-lived control plane.
   * A per-session stdio host repairs the active workspace only, so starting a
   * child process never rewrites instructions that belong to every project.
   */
  readonly includeGlobalTargets?: boolean;
}

export interface ManagedPolicyRepairReport {
  /** Targets considered for this run, including the ones that were absent. */
  readonly scanned: number;
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
  /** Files left alone: absent targets, and existing artifacts whose markers are ambiguous. */
  readonly skipped: readonly string[];
  readonly failed: readonly { readonly file: string; readonly message: string }[];
}

/**
 * One managed-policy artifact. `sync` creates it, `repair` only rewrites an
 * artifact that is already there: an upgrade must never invent instruction
 * files the user never had.
 */
interface ManagedPolicyTarget {
  readonly id: string;
  readonly file: string;
  readonly kind: 'managed-block' | 'cursor-file' | 'generated-file';
  /** `sync` target names that own this artifact. */
  readonly syncTargets: readonly SyncTarget[];
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
    this.settings = options.settings ?? DEFAULT_EXTENSIONS_SETTINGS;
    // An explicit policy list wins. Otherwise the persisted settings are
    // authoritative: falling back to the built-in defaults here silently
    // dropped a user's saved policy selection from the generated artifacts.
    this.policies = options.policies ?? configuredPolicies(this.settings);
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

  /**
   * Every generated artifact this service owns. Paths live here only, so `sync`
   * and `repairManagedBlocks` can never disagree about which files are managed.
   */
  private managedPolicyTargets(includeGlobalTargets: boolean = true): readonly ManagedPolicyTarget[] {
    const targets: ManagedPolicyTarget[] = [];
    if (this.workspace !== undefined) {
      targets.push(
        // 1. Cursor reads a whole generated rule file.
        { id: 'cursor-workspace', file: path.join(this.workspace, '.cursor', 'rules', '00-mandatory-policy.mdc'), kind: 'cursor-file', syncTargets: ['cursor'] },
        // 2. Cline keeps user rules and one managed block.
        { id: 'cline-workspace', file: path.join(this.workspace, '.clinerules'), kind: 'managed-block', syncTargets: ['cline'] },
        // 3. Antigravity workspace rules.
        { id: 'antigravity-workspace', file: path.join(this.workspace, 'GEMINI.md'), kind: 'managed-block', syncTargets: ['antigravity'] },
        // 4. OpenCode / Freebuff / Agents / Codex share the AGENTS.md convention.
        { id: 'agents-workspace', file: path.join(this.workspace, 'AGENTS.md'), kind: 'managed-block', syncTargets: ['opencode', 'agents', 'codex'] },
        // 5. Claude workspace memory.
        { id: 'claude-workspace', file: path.join(this.workspace, 'CLAUDE.md'), kind: 'managed-block', syncTargets: ['claude'] },
        // 6. Oh My Pi system prompt.
        { id: 'omp-workspace', file: path.join(this.workspace, '.omp', 'system.md'), kind: 'managed-block', syncTargets: ['omp'] },
      );
    }
    if (includeGlobalTargets) {
      targets.push(
        { id: 'cline-global', file: path.join(this.home, '.cline', 'rules', 'mcp-policy.md'), kind: 'managed-block', syncTargets: ['cline'] },
        { id: 'antigravity-global', file: path.join(this.home, '.gemini', 'antigravity', 'rules', 'mcp-policy.md'), kind: 'generated-file', syncTargets: ['antigravity'] },
        { id: 'opencode-global', file: path.join(this.home, '.config', 'opencode', 'AGENTS.md'), kind: 'managed-block', syncTargets: ['opencode', 'agents'] },
        // Codex reads global instructions from `$CODEX_HOME/AGENTS.md`.
        { id: 'codex-global', file: path.join(this.codexHome, 'AGENTS.md'), kind: 'managed-block', syncTargets: ['codex'] },
        { id: 'claude-global', file: path.join(this.home, '.claude', 'CLAUDE.md'), kind: 'managed-block', syncTargets: ['claude'] },
      );
    }
    return targets;
  }

  public async sync(targets: readonly SyncTarget[] = ['all']): Promise<Result<{ readonly updatedFiles: readonly string[] }>> {
    const invalidTargets = validateSyncTargets(targets);
    if (invalidTargets !== undefined) return err(invalidTargets);
    const updatedFiles: string[] = [];
    const isAll = targets.includes('all');
    const compiled = this.compile((await this.policySnapshot()).policies);

    try {
      for (const target of this.managedPolicyTargets()) {
        if (!isAll && !target.syncTargets.some((name) => targets.includes(name))) continue;
        if (target.kind === 'managed-block') {
          await updateFileWithBlock(target.file, compiled);
        } else {
          await writeAtomic(target.file, renderGeneratedFile(target.kind, compiled));
        }
        updatedFiles.push(target.file);
      }

      return ok({ updatedFiles });
    } catch (error) {
      return err(appError('INTERNAL_ERROR', `Failed to sync IDE policies: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Upgrade repair for already-generated artifacts (issue #4 §4): rewrite a
   * managed block that still describes the retired mandatory child topology.
   *
   * Unlike `sync` this never creates a file and never appends a block to a file
   * that has none, so a host that upgrades cannot suddenly start instructing an
   * IDE it never configured. Every write is atomic and every target is
   * independent: one unreadable file is reported instead of aborting the run.
   */
  public async repairManagedBlocks(
    options: ManagedPolicyRepairOptions = {},
  ): Promise<Result<ManagedPolicyRepairReport>> {
    const targets = this.managedPolicyTargets(options.includeGlobalTargets ?? true);
    let compiled: string;
    try {
      compiled = this.compile((await this.policySnapshot()).policies);
    } catch (error) {
      return err(appError('INTERNAL_ERROR', `Failed to compile IDE policies: ${errorMessage(error)}`));
    }

    // Serialize the read-modify-write pass with every other operation that
    // holds these paths through the shared config mutation lock, including a
    // second process starting against the same home/workspace. The block is
    // compiled above from the settings snapshot this run started with; the lock
    // guarantees no locked writer interleaves between reading a file and
    // replacing it, so the survivor is always one complete repair result.
    try {
      return await withConfigMutationLock(targets.map((target) => target.file), async () => {
        const updated: string[] = [];
        const unchanged: string[] = [];
        const skipped: string[] = [];
        const failed: { file: string; message: string }[] = [];

        for (const target of targets) {
          let existing: string;
          try {
            existing = await readFile(target.file, 'utf8');
          } catch (error) {
            if (isMissingFile(error)) skipped.push(target.file);
            else failed.push({ file: target.file, message: errorMessage(error) });
            continue;
          }

          // The marker gate is the whole safety property of this path: an artifact
          // is only ours to rewrite when it carries exactly one ordered managed
          // block. That covers the whole-file kinds (`cursor-file`,
          // `generated-file`) too. Every other shape is ambiguous — a half-written
          // file with one marker, a closing marker that precedes the opening one,
          // a file that repeats a marker — and rewriting part of an ambiguous file
          // is exactly how repair would append a second block or leave a stale one
          // behind, so all of them stay byte-identical and are reported as skipped.
          const startIndex = existing.indexOf(POLICY_BLOCK_START);
          const endIndex = existing.indexOf(POLICY_BLOCK_END);
          const ambiguousBlock = startIndex === -1
            || endIndex === -1
            || endIndex < startIndex
            || existing.indexOf(POLICY_BLOCK_START, startIndex + POLICY_BLOCK_START.length) !== -1
            || existing.indexOf(POLICY_BLOCK_END, endIndex + POLICY_BLOCK_END.length) !== -1;
          if (ambiguousBlock) {
            skipped.push(target.file);
            continue;
          }

          const expected = target.kind === 'managed-block'
            ? replaceOrAppendPolicyBlock(existing, compiled)
            : renderGeneratedFile(target.kind, compiled);
          if (expected === existing) {
            unchanged.push(target.file);
            continue;
          }

          try {
            await writeAtomic(target.file, expected);
            updated.push(target.file);
          } catch (error) {
            failed.push({ file: target.file, message: errorMessage(error) });
          }
        }

        return ok({ scanned: targets.length, updated, unchanged, skipped, failed });
      });
    } catch (error) {
      return err(appError('INTERNAL_ERROR', `Failed to lock managed policy files: ${errorMessage(error)}`));
    }
  }
}

function renderGeneratedFile(kind: 'cursor-file' | 'generated-file', compiled: string): string {
  if (kind === 'cursor-file') {
    return [
      '---',
      'description: Mandatory MCP Server and Skill Execution Priority Policy',
      'globs: *',
      'alwaysApply: true',
      '---',
      '',
      compiled,
      '',
    ].join('\n');
  }
  return `${compiled}\n`;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
