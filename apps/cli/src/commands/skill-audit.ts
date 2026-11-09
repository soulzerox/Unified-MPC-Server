import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { SkillInventoryAuditName, SkillInventoryAuditReport } from '@unified-mpc/extensions';
import { missingOptionValue, unexpectedOption } from './options.js';

export interface SkillAuditCommand {
  readonly kind: 'skill-audit';
  /** Print the unprojected report instead of the operator lines. */
  readonly json: boolean;
  /** Canonical Skill root to audit instead of the runtime's own. */
  readonly canonicalRoot?: string;
  /** Workspace root whose workspace-local Skill roots should join the audit. */
  readonly workspaceRoot?: string;
}

const SKILL_AUDIT_USAGE = 'Usage: unified-mpc skill audit [--json] [--canonical-root <path>] [--workspace <path>]';

export function parseSkillAuditArgs(args: readonly string[]): Result<SkillAuditCommand> {
  if (args[0] !== 'audit') return err(appError('INVALID_INPUT', SKILL_AUDIT_USAGE));

  let json = false;
  let canonicalRoot: string | undefined;
  let workspaceRoot: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (flag === '--json') {
      if (json) return err(appError('INVALID_INPUT', SKILL_AUDIT_USAGE));
      json = true;
      continue;
    }
    if (flag === '--canonical-root' || flag === '--workspace') {
      if (value === undefined) return missingOptionValue(flag);
      const trimmed = value.trim();
      if (trimmed.length === 0) return err(appError('INVALID_INPUT', SKILL_AUDIT_USAGE));
      if (flag === '--canonical-root') canonicalRoot = trimmed;
      else workspaceRoot = trimmed;
      index += 1;
      continue;
    }
    return unexpectedOption(flag);
  }

  return ok({
    kind: 'skill-audit',
    json,
    ...(canonicalRoot === undefined ? {} : { canonicalRoot }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  });
}

function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 12);
}

function canonicalLabel(entry: SkillInventoryAuditName): string {
  switch (entry.canonicalState) {
    case 'duplicate':
      return 'canonical duplicate';
    case 'unverified':
      return 'canonical unverified';
    case 'absent':
      return 'canonical absent';
    case 'only-canonical':
      return 'canonical only copy';
    case 'matches':
      return 'canonical matches a legacy copy';
    case 'diverges':
      return 'canonical diverges';
  }
}

function renderName(entry: SkillInventoryAuditName): string[] {
  // An unfingerprintable copy means the audit cannot state a variant count, so
  // it prints none rather than a `0` that would read as "one variant".
  const variants = entry.classification === 'unverified'
    ? ''
    : `  variants ${entry.variantFingerprints.length}`;
  const lines = [
    `  ${entry.name}  [${entry.classification}] ${canonicalLabel(entry)}${variants}`,
  ];
  for (const copy of entry.entries) {
    const fingerprint = copy.fingerprint === undefined ? 'unfingerprintable' : shortFingerprint(copy.fingerprint);
    const marker = copy.isCanonical ? 'canonical' : copy.source;
    lines.push(`    ${fingerprint}  ${marker.padEnd(24)} ${copy.skillPath}`);
  }
  return lines;
}

/**
 * Render the read-only Skill inventory projection.
 *
 * The summary is always printed; the per-name detail is limited to names that
 * need a decision — any divergence, a canonical duplicate, or evidence the
 * audit could not compute. Identical and unique names are counted only, so the
 * operator output stays readable on a host with hundreds of copies while
 * `--json` keeps the complete inventory.
 */
export function formatSkillInventoryAudit(report: SkillInventoryAuditReport): string {
  const summary = report.summary;
  const lines = [
    `skill inventory: ${summary.directories} directories across ${summary.roots} roots, ${summary.declaredNames} declared names`,
    `  unique ${summary.uniqueNames} · identical ${summary.identicalNames} · divergent ${summary.divergentNames} · unverified ${summary.unverifiedNames}`,
    `canonical ${[
      `${summary.canonicalMatchNames} matching`,
      `${summary.canonicalDivergingNames} diverging`,
      `${summary.canonicalOnlyNames} only copy`,
      `${summary.canonicalAbsentNames} absent`,
      `${summary.duplicateCanonicalNames} duplicate`,
      `${summary.canonicalUnverifiedNames} unverified`,
    ].join(' · ')}`,
  ];

  const needsDecision = report.names.filter((entry) => (
    entry.classification === 'divergent'
    || entry.classification === 'unverified'
    || entry.canonicalState === 'duplicate'
    || entry.canonicalState === 'diverges'
  ));
  if (needsDecision.length === 0) {
    lines.push('no Skill name needs a precedence decision');
  } else {
    lines.push(`names needing a decision (${needsDecision.length}):`);
    for (const entry of needsDecision) lines.push(...renderName(entry));
    lines.push('use --json for the full inventory, including identical and unique names');
  }

  if (report.skipped.length > 0) {
    lines.push(`unfingerprintable copies (${report.skipped.length}):`);
    for (const skipped of report.skipped) lines.push(`  ${skipped.skillPath}  ${skipped.reason}`);
  }
  return lines.join('\n');
}

/**
 * A duplicate canonical name is the #294 defect, so it exits non-zero and can
 * gate a check. Divergence is the expected state of a host that still keeps its
 * legacy roots, so it is reported without failing the command.
 */
export function skillAuditExitCode(report: SkillInventoryAuditReport): number {
  return report.summary.duplicateCanonicalNames > 0 ? 1 : 0;
}
