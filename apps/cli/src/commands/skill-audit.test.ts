import { describe, expect, it } from 'vitest';
import { err, ok } from '@unified-mpc/domain';
import type { SkillInventoryAuditReport } from '@unified-mpc/extensions';
import {
  formatSkillInventoryAudit,
  parseSkillAuditArgs,
  skillAuditExitCode,
} from './skill-audit.js';
import { parseCliArgs, runCli, type CliDependencies } from '../index.js';

function emptyReport(overrides: Partial<SkillInventoryAuditReport['summary']> = {}): SkillInventoryAuditReport {
  return {
    schemaVersion: 1,
    names: [],
    roots: [],
    skipped: [],
    summary: {
      directories: 0,
      roots: 0,
      declaredNames: 0,
      uniqueNames: 0,
      identicalNames: 0,
      divergentNames: 0,
      unverifiedNames: 0,
      canonicalPresentNames: 0,
      canonicalMatchNames: 0,
      canonicalDivergingNames: 0,
      canonicalOnlyNames: 0,
      canonicalAbsentNames: 0,
      duplicateCanonicalNames: 0,
      canonicalUnverifiedNames: 0,
      ...overrides,
    },
  };
}

const divergentReport: SkillInventoryAuditReport = {
  schemaVersion: 1,
  names: [
    {
      name: 'alpha',
      canonicalId: 'skill:alpha',
      classification: 'divergent',
      canonicalState: 'diverges',
      variantFingerprints: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
      canonicalFingerprints: ['bbbbbbbbbbbbbbbb'],
      entries: [
        {
          source: 'claude-skills',
          rootPath: '/home/user/.claude/skills',
          skillPath: '/home/user/.claude/skills/alpha/SKILL.md',
          isCanonical: false,
          fingerprint: 'aaaaaaaaaaaaaaaa',
        },
        {
          source: 'unified-mpc-skills',
          rootPath: '/data/extensions/skills',
          skillPath: '/data/extensions/skills/alpha/SKILL.md',
          isCanonical: true,
          fingerprint: 'bbbbbbbbbbbbbbbb',
        },
      ],
    },
  ],
  roots: [
    { source: 'claude-skills', path: '/home/user/.claude/skills', directories: 1 },
    { source: 'unified-mpc-skills', path: '/data/extensions/skills', directories: 1 },
  ],
  skipped: [],
  summary: {
    directories: 2,
    roots: 2,
    declaredNames: 1,
    uniqueNames: 0,
    identicalNames: 0,
    divergentNames: 1,
    unverifiedNames: 0,
    canonicalPresentNames: 1,
    canonicalMatchNames: 0,
    canonicalDivergingNames: 1,
    canonicalAbsentNames: 0,
    duplicateCanonicalNames: 0,
  },
};

describe('parseSkillAuditArgs', () => {
  it('accepts the documented forms', () => {
    expect(parseSkillAuditArgs(['audit'])).toEqual({ ok: true, value: { kind: 'skill-audit', json: false } });
    expect(parseSkillAuditArgs(['audit', '--json'])).toEqual({ ok: true, value: { kind: 'skill-audit', json: true } });
    expect(parseSkillAuditArgs(['audit', '--canonical-root', '/tmp/canonical', '--workspace', '/tmp/ws'])).toEqual({
      ok: true,
      value: { kind: 'skill-audit', json: false, canonicalRoot: '/tmp/canonical', workspaceRoot: '/tmp/ws' },
    });
  });

  it('rejects incomplete and unknown flags', () => {
    const cases: ReadonlyArray<readonly [readonly string[], string]> = [
      [['audit', '--json', '--json'], 'Usage: unified-mpc skill audit'],
      [['audit', '--canonical-root'], 'Missing value for option: --canonical-root'],
      [['audit', '--workspace'], 'Missing value for option: --workspace'],
      [['audit', '--workspace', '   '], 'Usage: unified-mpc skill audit'],
      [['audit', '--bogus'], 'Unknown option: --bogus'],
      [['audit', 'extra'], 'Unexpected argument: extra'],
      [['install'], 'Usage: unified-mpc skill audit'],
    ];
    for (const [args, expected] of cases) {
      const parsed = parseSkillAuditArgs(args);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error.message).toContain(expected);
    }
  });
});

describe('formatSkillInventoryAudit', () => {
  it('summarizes an inventory that needs no decision', () => {
    const lines = formatSkillInventoryAudit(emptyReport({ directories: 3, roots: 2, declaredNames: 1, uniqueNames: 1 }));
    expect(lines.split('\n')).toEqual([
      'skill inventory: 3 directories across 2 roots, 1 declared names',
      '  unique 1 · identical 0 · divergent 0 · unverified 0',
      'canonical 0 matching · 0 diverging · 0 only copy · 0 absent · 0 duplicate · 0 unverified',
      'no Skill name needs a precedence decision',
    ]);
  });

  it('lists the copies behind a decision and points at the full report', () => {
    const lines = formatSkillInventoryAudit(divergentReport);
    expect(lines).toContain('names needing a decision (1):');
    expect(lines).toContain('  alpha  [divergent] canonical diverges  variants 2');
    expect(lines).toMatch(/aaaaaaaaaaaa\s+claude-skills\s+\/home\/user\/\.claude\/skills\/alpha\/SKILL\.md/);
    expect(lines).toMatch(/bbbbbbbbbbbb\s+canonical\s+\/data\/extensions\/skills\/alpha\/SKILL\.md/);
    expect(lines).toContain('use --json for the full inventory, including identical and unique names');
  });

  it('reports copies the audit could not fingerprint', () => {
    const report: SkillInventoryAuditReport = {
      ...emptyReport({ unverifiedNames: 1 }),
      names: [{
        name: 'gamma',
        canonicalId: 'skill:gamma',
        classification: 'unverified',
        canonicalState: 'unverified',
        variantFingerprints: [],
        canonicalFingerprints: [],
        entries: [{
          source: 'claude-skills',
          rootPath: '/home/user/.claude/skills',
          skillPath: '/home/user/.claude/skills/gamma/SKILL.md',
          isCanonical: false,
        }],
      }],
      skipped: [{ skillPath: '/home/user/.claude/skills/gamma/SKILL.md', reason: 'symbolic links are not staged' }],
    };
    const lines = formatSkillInventoryAudit(report);
    expect(lines).toContain('  gamma  [unverified] canonical unverified');
    expect(lines).not.toMatch(/gamma\s+\[unverified\][^\n]*variants/);
    expect(lines).toMatch(/unfingerprintable\s+claude-skills\s+\/home\/user\/\.claude\/skills\/gamma\/SKILL\.md/);
    expect(lines).toContain('unfingerprintable copies (1):');
    expect(lines).toContain('  /home/user/.claude/skills/gamma/SKILL.md  symbolic links are not staged');
  });

  it('partitions the canonical line so every declared name is counted once', () => {
    const lines = formatSkillInventoryAudit(emptyReport({
      declaredNames: 6,
      canonicalMatchNames: 1,
      canonicalDivergingNames: 1,
      canonicalOnlyNames: 1,
      canonicalAbsentNames: 1,
      duplicateCanonicalNames: 1,
      canonicalUnverifiedNames: 1,
    }));
    expect(lines.split('\n')).toContain(
      'canonical 1 matching · 1 diverging · 1 only copy · 1 absent · 1 duplicate · 1 unverified',
    );
  });
});

describe('skillAuditExitCode', () => {
  it('fails only on a duplicate canonical name', () => {
    expect(skillAuditExitCode(divergentReport)).toBe(0);
    expect(skillAuditExitCode(emptyReport({ duplicateCanonicalNames: 1 }))).toBe(1);
  });
});

describe('skill audit CLI dispatch', () => {
  const baseDependencies: CliDependencies = {
    status: async () => ({ workspaceCount: 0 }),
    workspaceAdd: async () => err({ code: 'INTERNAL_ERROR', message: 'unused', recoverable: true }),
    workspaceList: async () => [],
    mcpStdio: async () => err({ code: 'INTERNAL_ERROR', message: 'unused', recoverable: true }),
    mcpHttp: async () => err({ code: 'INTERNAL_ERROR', message: 'unused', recoverable: true }),
    doctor: async () => ({ checks: [], exitCode: 0 }),
    codexDoctor: async () => ok({
      status: { installed: true, binaryPath: '/usr/local/bin/codex', version: '1.0.0' },
    }),
  };

  it('parses as the skill-audit command', () => {
    expect(parseCliArgs(['skill', 'audit', '--json'])).toEqual({
      ok: true,
      value: { kind: 'skill-audit', json: true },
    });
  });

  it('prints the operator projection and passes the roots through', async () => {
    const output: string[] = [];
    const requested: unknown[] = [];
    const dependencies: CliDependencies = {
      ...baseDependencies,
      skillAudit: async (input) => {
        requested.push(input);
        return ok(divergentReport);
      },
      write: (text) => output.push(text),
    };
    const code = await runCli(
      ['skill', 'audit', '--canonical-root', '/tmp/canonical', '--workspace', '/tmp/ws'],
      dependencies,
    );
    expect(code).toBe(0);
    expect(requested).toEqual([{ canonicalRoot: '/tmp/canonical', workspaceRoot: '/tmp/ws' }]);
    expect(output.join('\n')).toContain('skill inventory: 2 directories across 2 roots');
  });

  it('prints the unprojected report with --json', async () => {
    const output: string[] = [];
    const dependencies: CliDependencies = {
      ...baseDependencies,
      skillAudit: async () => ok(divergentReport),
      write: (text) => output.push(text),
    };
    const code = await runCli(['skill', 'audit', '--json'], dependencies);
    expect(code).toBe(0);
    expect(JSON.parse(output.join('\n'))).toMatchObject({ schemaVersion: 1, summary: { divergentNames: 1 } });
  });

  it('exits 1 when a canonical duplicate exists', async () => {
    const dependencies: CliDependencies = {
      ...baseDependencies,
      skillAudit: async () => ok(emptyReport({ duplicateCanonicalNames: 1 })),
      write: () => undefined,
    };
    expect(await runCli(['skill', 'audit'], dependencies)).toBe(1);
  });

  it('reports a missing service and a failed audit', async () => {
    const errors: string[] = [];
    expect(await runCli(['skill', 'audit'], { ...baseDependencies, writeError: (text) => errors.push(text) })).toBe(1);
    expect(errors[0]).toContain('not available');

    const failing: CliDependencies = {
      ...baseDependencies,
      skillAudit: async () => err({
        code: 'INTERNAL_ERROR',
        message: 'boom',
        recoverable: true,
      }),
      writeError: (text) => errors.push(text),
    };
    expect(await runCli(['skill', 'audit'], failing)).toBe(1);
    expect(errors[1]).toContain('boom');
  });
});
