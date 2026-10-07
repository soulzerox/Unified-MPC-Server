import type {
  AcceptedMergeReviewOutcome,
  CommandSpec,
  MergeEvidenceSource,
  RepositoryMergePolicy,
  VerificationMode,
} from '@unified-mpc/domain';

const VERIFICATION_MODES = new Set<VerificationMode>(['github_ci', 'local_exact_head', 'hybrid']);
const EVIDENCE_SOURCES = new Set<MergeEvidenceSource>(['github_check', 'local_command', 'external_verifier']);
const ACCEPTED_REVIEW_OUTCOMES = new Set<AcceptedMergeReviewOutcome>([
  'github_approved',
  'clean_llm_review',
  'user_override',
]);

export function parseRepositoryMergePoliciesSetting(
  value: string | null | undefined,
): readonly RepositoryMergePolicy[] | undefined {
  if (value === null || value === undefined || value.trim().length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;

  const policies: RepositoryMergePolicy[] = [];
  const repositories = new Set<string>();
  for (const entry of parsed) {
    const policy = parsePolicy(entry);
    if (policy === undefined) return undefined;
    const repositoryKey = normalizeRepository(policy.repository);
    if (repositoryKey === undefined || repositories.has(repositoryKey)) return undefined;
    repositories.add(repositoryKey);
    policies.push(policy);
  }
  return policies;
}

export function parseRepositoryMergePolicySetting(
  value: string | null | undefined,
  repository: string,
): RepositoryMergePolicy | undefined {
  const repositoryKey = normalizeRepository(repository);
  if (repositoryKey === undefined) return undefined;
  const policies = parseRepositoryMergePoliciesSetting(value);
  if (policies === undefined) return undefined;
  return policies.find((policy) => normalizeRepository(policy.repository) === repositoryKey);
}

function parsePolicy(value: unknown): RepositoryMergePolicy | undefined {
  if (!isRecord(value)) return undefined;
  const repository = boundedString(value.repository, 512);
  const defaultBranch = boundedString(value.defaultBranch, 256);
  const verificationMode = parseVerificationMode(value.verificationMode);
  if (repository === undefined || defaultBranch === undefined || verificationMode === undefined) return undefined;
  if (!Array.isArray(value.requiredGates)) return undefined;

  const requiredGates: Array<{ readonly name: string; readonly source: MergeEvidenceSource; readonly command?: CommandSpec }> = [];
  const gateNames = new Set<string>();
  for (const entry of value.requiredGates) {
    if (!isRecord(entry)) return undefined;
    const name = boundedString(entry.name, 512);
    const source = parseEvidenceSource(entry.source);
    if (name === undefined || source === undefined) return undefined;
    const command = entry.command === undefined ? undefined : parseCommandSpec(entry.command);
    if (entry.command !== undefined && command === undefined) return undefined;
    if (source !== 'local_command' && command !== undefined) return undefined;
    const normalizedName = name.toLowerCase();
    if (gateNames.has(normalizedName)) return undefined;
    gateNames.add(normalizedName);
    requiredGates.push({ name, source, ...(command === undefined ? {} : { command }) });
  }

  if (!isRecord(value.reviewPolicy) || typeof value.reviewPolicy.required !== 'boolean') return undefined;
  if (!Array.isArray(value.reviewPolicy.acceptedOutcomes)) return undefined;
  const acceptedOutcomes: AcceptedMergeReviewOutcome[] = [];
  const outcomeSet = new Set<AcceptedMergeReviewOutcome>();
  for (const entry of value.reviewPolicy.acceptedOutcomes) {
    if (typeof entry !== 'string' || !ACCEPTED_REVIEW_OUTCOMES.has(entry as AcceptedMergeReviewOutcome)) return undefined;
    const outcome = entry as AcceptedMergeReviewOutcome;
    if (outcomeSet.has(outcome)) continue;
    outcomeSet.add(outcome);
    acceptedOutcomes.push(outcome);
  }
  if (value.reviewPolicy.required && acceptedOutcomes.length === 0) return undefined;

  return {
    repository,
    defaultBranch,
    verificationMode,
    requiredGates,
    reviewPolicy: {
      required: value.reviewPolicy.required,
      acceptedOutcomes,
    },
  };
}

function normalizeRepository(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return undefined;
  return trimmed.toLowerCase();
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > maximum ? undefined : trimmed;
}

function parseCommandSpec(value: unknown): CommandSpec | undefined {
  if (!isRecord(value)) return undefined;
  const executable = boundedString(value.executable, 512);
  if (executable === undefined || !Array.isArray(value.args) || value.args.length > 128) return undefined;
  const args: string[] = [];
  for (const entry of value.args) {
    if (typeof entry !== 'string' || entry.length > 2_048) return undefined;
    args.push(entry);
  }
  const cwdRelative = value.cwdRelative === undefined ? undefined : boundedString(value.cwdRelative, 1_024);
  if (value.cwdRelative !== undefined && cwdRelative === undefined) return undefined;
  return { executable, args, ...(cwdRelative === undefined ? {} : { cwdRelative }) };
}

function parseVerificationMode(value: unknown): VerificationMode | undefined {
  return typeof value === 'string' && VERIFICATION_MODES.has(value as VerificationMode)
    ? value as VerificationMode
    : undefined;
}

function parseEvidenceSource(value: unknown): MergeEvidenceSource | undefined {
  return typeof value === 'string' && EVIDENCE_SOURCES.has(value as MergeEvidenceSource)
    ? value as MergeEvidenceSource
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
