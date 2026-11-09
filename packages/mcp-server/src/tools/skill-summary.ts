import type { SkillSummary } from '@unified-mpc/extensions';

/**
 * A skill row is cheap until it is multiplied by the catalog: on this host 136
 * skills made a default `skills_list` 112 KB, of which the description text was
 * 53% and three path variants per skill another 26%. The paths are runtime
 * bookkeeping, not routing information, so both listing surfaces (`skills_list`
 * and `skill_match`) keep identity plus a description preview and report every
 * clip instead of forwarding whole records.
 */
export const SKILL_SUMMARY_OMITTED_FIELDS = ['rootPath', 'skillPath', 'canonicalSkillPath'] as const;
export const SKILL_DESCRIPTION_PREVIEW_CHARS = 200;

export interface SkillSummaryRow {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly trustTier?: SkillSummary['trustTier'];
  readonly description: string;
  readonly descriptionTruncated: boolean;
}

/**
 * Two active ids that declare one logical `name`. The catalog advertises the
 * declared name, so a duplicate is invisible row by row: on a real host the
 * same Skill could be listed twice under `ui-ux-pro-max` while every count
 * looked correct. Reported, never enforced here — dropping a directory is the
 * installer/registry transaction's job, not a listing's.
 */
export interface DuplicateSkillName {
  readonly name: string;
  readonly ids: readonly string[];
}

export interface SkillCatalogSummary {
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly detail: 'summary';
  readonly omittedFields: readonly string[];
  readonly hint: string;
  readonly duplicateNames: readonly DuplicateSkillName[];
  readonly skills: readonly SkillSummaryRow[];
}

export interface SkillCatalogSummaryOptions {
  /** Keeps at most this many rows; the counts still describe the whole match. */
  readonly limit?: number;
}

export function summarizeSkillCatalog(
  skills: readonly SkillSummary[],
  options: SkillCatalogSummaryOptions = {},
): SkillCatalogSummary {
  // An unusable limit means "no cap" (the pre-existing behavior), never an
  // empty list: a caller that mangles the value should see the catalog, not
  // silence.
  const cap = options.limit === undefined
    ? undefined
    : Number.isFinite(options.limit) ? Math.max(0, Math.trunc(options.limit)) : undefined;
  const kept = cap === undefined ? skills : skills.slice(0, cap);
  const truncated = kept.length < skills.length;
  return {
    total: skills.length,
    returned: kept.length,
    truncated,
    detail: 'summary',
    omittedFields: SKILL_SUMMARY_OMITTED_FIELDS,
    hint: truncated
      ? `showing ${kept.length} of ${skills.length} matches ranked by relevance; pass a larger limit or use skills_list with the same query for every match`
      : `descriptions are ${SKILL_DESCRIPTION_PREVIEW_CHARS}-character previews of the text skill_match ranks; read one skill with skills_read for its complete text, or use skills_list with detail=full for the unprojected catalog`,
    duplicateNames: collectDuplicateNames(skills),
    skills: kept.map(summarizeSkillRow),
  };
}

/**
 * Counts the whole catalog, not `kept`: on a large host the colliding id is
 * exactly the row a `limit` drops, and an invisible duplicate is the defect
 * this reports.
 */
function collectDuplicateNames(skills: readonly SkillSummary[]): DuplicateSkillName[] {
  const idsByName = new Map<string, Set<string>>();
  for (const skill of skills) {
    // Fixtures can hand over partial rows; a listing must not throw because one
    // skill lacks identity.
    if (typeof skill.name !== 'string' || skill.name.length === 0) continue;
    if (typeof skill.id !== 'string' || skill.id.length === 0) continue;
    const ids = idsByName.get(skill.name) ?? new Set<string>();
    ids.add(skill.id);
    idsByName.set(skill.name, ids);
  }
  return [...idsByName.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([name, ids]) => ({ name, ids: [...ids].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function summarizeSkillRow(skill: SkillSummary): SkillSummaryRow {
  // Fixture and legacy callers can hand over rows without every field; a
  // listing must not throw because one skill lacks a description.
  const description = typeof skill.description === 'string' ? skill.description : '';
  const truncated = description.length > SKILL_DESCRIPTION_PREVIEW_CHARS;
  return {
    id: skill.id,
    name: skill.name,
    source: skill.source,
    ...(skill.trustTier === undefined ? {} : { trustTier: skill.trustTier }),
    description: truncated ? `${description.slice(0, SKILL_DESCRIPTION_PREVIEW_CHARS)}…` : description,
    descriptionTruncated: truncated,
  };
}
