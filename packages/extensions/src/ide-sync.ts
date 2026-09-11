import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';

export type PolicyPriority = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7';

export interface PolicyEntry {
  readonly priority: PolicyPriority;
  readonly resourceId: string;
  readonly resourceType: 'server' | 'skill';
  readonly mandatory: boolean;
  readonly enforcement: 'REALTIME' | 'EVERY_SESSION' | 'SAFETY_PRE_CHECK' | 'ON_DEMAND' | string;
  readonly directive: string;
}

export const DEFAULT_POLICIES: readonly PolicyEntry[] = [
  {
    priority: 'P1',
    resourceId: 'memory',
    resourceType: 'server',
    mandatory: true,
    enforcement: 'REALTIME',
    directive: 'work-log ของงานปัจจุบัน (Realtime Working Memory) — อ่านก่อนเริ่ม, เขียนทุก step สำคัญ (realtime), เชื่อมโยงเมื่อจบ',
  },
  {
    priority: 'P2',
    resourceId: 'thai-rag-mcp',
    resourceType: 'server',
    mandatory: true,
    enforcement: 'EVERY_SESSION',
    directive: 'ความจำถาวร · 100% Local RAG · recall ก่อนตอบเรื่องอดีต, remember ข้อมูลถาวร, code_search ก่อนอ่านไฟล์ยาว',
  },
  {
    priority: 'P3',
    resourceId: 'godkiller',
    resourceType: 'server',
    mandatory: true,
    enforcement: 'SAFETY_PRE_CHECK',
    directive: 'Code Intel & Safety Pre-check · gk_route วางแผน, gk_code สำรวจโค้ด, gk_task ตรวจ blast_radius ก่อนแก้โค้ด',
  },
  {
    priority: 'P4',
    resourceId: 'sequentialthinking',
    resourceType: 'server',
    mandatory: false,
    enforcement: 'ON_DEMAND',
    directive: 'วิเคราะห์/วางแผนแบบ step-by-step ที่ revise ได้ ก่อนเริ่ม task ซับซ้อน',
  },
  {
    priority: 'P5',
    resourceId: 'context7',
    resourceType: 'server',
    mandatory: false,
    enforcement: 'ON_DEMAND',
    directive: 'docs สดและตัวอย่างโค้ดตรงเวอร์ชันของ lib/framework/SDK/API ก่อนแตะ external API',
  },
  {
    priority: 'P6',
    resourceId: 'filesystem',
    resourceType: 'server',
    mandatory: false,
    enforcement: 'ON_DEMAND',
    directive: 'ไฟล์ข้ามโปรเจกต์ / batch file operations',
  },
  {
    priority: 'P7',
    resourceId: 'ui-skills',
    resourceType: 'skill',
    mandatory: false,
    enforcement: 'ON_DEMAND',
    directive: 'UI/UX & Frontend Best Practices & Skills เมื่อออกแบบหรือพัฒนา UI/UX',
  },
];

export const POLICY_BLOCK_START = '<!-- MCP-POLICY-START -->';
export const POLICY_BLOCK_END = '<!-- MCP-POLICY-END -->';

export type SyncTarget = 'all' | 'cursor' | 'cline' | 'claude' | 'antigravity' | 'opencode' | 'omp' | 'agents';

export interface IdeSyncOptions {
  readonly homeDir?: string;
  readonly workspaceRoot?: string;
  readonly policies?: readonly PolicyEntry[];
}

export class IdeSyncService {
  private readonly home: string;
  private readonly workspace: string | undefined;
  private readonly policies: readonly PolicyEntry[];

  public constructor(options: IdeSyncOptions = {}) {
    this.home = options.homeDir ?? os.homedir();
    this.workspace = options.workspaceRoot?.trim();
    this.policies = options.policies ?? DEFAULT_POLICIES;
  }

  public compile(): string {
    const lines: string[] = [
      POLICY_BLOCK_START,
      '# MCP Server Execution Priority — Mandatory Policy',
      '',
      '| Priority | Resource | Type | Enforcement | Mandatory |',
      '|---|---|---|---|---|',
    ];

    for (const p of this.policies) {
      const mandatoryText = p.mandatory ? '✅ YES' : 'Optional';
      lines.push(`| ${p.priority} | ${p.resourceId} | ${p.resourceType} | ${p.enforcement} | ${mandatoryText} |`);
    }

    lines.push('');
    lines.push('## Enforcement Rules');
    lines.push('');

    for (const p of this.policies) {
      lines.push(`${p.priority}. **${p.priority} ${p.resourceId}** (${p.enforcement}): ${p.directive}`);
    }

    lines.push('');
    lines.push(POLICY_BLOCK_END);
    return lines.join('\n');
  }

  public async sync(targets: readonly SyncTarget[] = ['all']): Promise<Result<{ readonly updatedFiles: readonly string[] }>> {
    const updatedFiles: string[] = [];
    const isAll = targets.includes('all');
    const compiled = this.compile();

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

      // 4. OpenCode / Freebuff / Agents / Codex
      if (isAll || targets.includes('opencode') || targets.includes('agents')) {
        if (this.workspace !== undefined) {
          const agentsFile = path.join(this.workspace, 'AGENTS.md');
          await updateFileWithBlock(agentsFile, compiled);
          updatedFiles.push(agentsFile);
        }
        const opencodeAgents = path.join(this.home, '.config', 'opencode', 'AGENTS.md');
        await updateFileWithBlock(opencodeAgents, compiled);
        updatedFiles.push(opencodeAgents);
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
