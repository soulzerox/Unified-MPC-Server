/**
 * GENERATED FILE - do not edit by hand.
 *
 * Source: packages/thai-rag/contract/provider-contract.v1.schema.json
 * Schema sha256: 0b8bda8207a22cc49739ace252af3881ad60b6adba311e0f21393ad553a8d208
 *
 * Regenerate: corepack pnpm@10.15.0 --filter @unified-mpc/thai-rag contract:bindings
 * Check:      corepack pnpm@10.15.0 --filter @unified-mpc/thai-rag contract:bindings:check
 */

/** `$defs` name -> generated TypeScript type. */
export const CONTRACT_BINDING_DEFINITIONS = {
  provider_status: 'ProviderStatus',
  error_code: 'ErrorCode',
  sha256: 'Sha256',
  git_object_id: 'GitObjectId',
  repository_id: 'RepositoryId',
  canonical_manifest_id: 'CanonicalManifestId',
  local_manifest_id: 'LocalManifestId',
  revision_id: 'RevisionId',
  git_ref: 'GitRef',
  relative_path: 'RelativePath',
  workspace_id: 'WorkspaceId',
  source_identity: 'SourceIdentity',
  expected_paths: 'ExpectedPaths',
  deleted_paths: 'DeletedPaths',
  requested_paths: 'RequestedPaths',
  canonical_index_request: 'CanonicalIndexRequest',
  compatibility_range: 'CompatibilityRange',
  generation_compatibility: 'GenerationCompatibility',
  embedding_compatibility: 'EmbeddingCompatibility',
  readiness: 'Readiness',
  provider_metadata: 'ProviderMetadata',
  code_index_channel_state: 'CodeIndexChannelState',
  code_index_reconciliation: 'CodeIndexReconciliation',
  code_index_publication_data: 'CodeIndexPublicationData',
  code_index_dry_run_data: 'CodeIndexDryRunData',
  code_index_data: 'CodeIndexData',
  index_status_data: 'IndexStatusData',
  code_search_item: 'CodeSearchItem',
  vector_rescue: 'VectorRescue',
  code_search_data: 'CodeSearchData',
  attach_workspace_base_data: 'AttachWorkspaceBaseData',
  provider_error: 'ProviderError',
  provider_result: 'ProviderResult',
  contract_handshake: 'ContractHandshake',
} as const;

export const PROVIDER_STATUS_VALUES = ["ok", "review_required", "degraded", "unavailable"] as const;
export type ProviderStatus = typeof PROVIDER_STATUS_VALUES[number];

export const ERROR_CODE_VALUES = ["invalid_input", "workspace_scope_required", "workspace_not_found", "index_job_not_found", "memory_not_found", "scope_denied", "storage_unavailable", "lexical_retrieval_unavailable", "vector_retrieval_degraded", "memory_reconciliation_pending", "embedding_unavailable", "stale_index", "incompatible_index", "indexing_conflict", "cancellation", "internal_failure"] as const;
export type ErrorCode = typeof ERROR_CODE_VALUES[number];

export type Sha256 = string;

export type GitObjectId = string;

export type RepositoryId = string;

export type CanonicalManifestId = string;

export type LocalManifestId = string;

export type RevisionId = string;

export type GitRef = string;

export type RelativePath = string;

export type WorkspaceId = string;

export interface SourceIdentity {
  readonly repository_id: RepositoryId;
  readonly manifest_id: CanonicalManifestId;
  readonly ref?: GitRef;
  readonly commit_sha?: GitObjectId;
  readonly tree_oid?: GitObjectId;
  readonly revision_id?: RevisionId;
}

export type ExpectedPaths = Readonly<Record<string, Sha256>>;

export type DeletedPaths = readonly RelativePath[];

export type RequestedPaths = readonly RelativePath[];

export interface CanonicalIndexRequest {
  readonly workspace_id: WorkspaceId;
  readonly source_identity?: SourceIdentity;
  readonly expected_paths?: ExpectedPaths;
  readonly deleted_paths?: DeletedPaths;
  readonly paths?: RequestedPaths;
  readonly mode?: "delta" | "full";
  readonly priority?: "blocking" | "background";
  readonly [key: string]: unknown;
}

export interface CompatibilityRange {
  readonly min: string;
  readonly max: string;
}

export interface GenerationCompatibility {
  readonly contract: Sha256;
  readonly embedding: string;
  readonly index: string;
  readonly storage: string;
}

export interface EmbeddingCompatibility {
  readonly profile: string;
  readonly model: string;
  readonly dimension: number;
  readonly preprocessing_version: string;
  readonly ready: boolean;
  readonly [key: string]: unknown;
}

export interface Readiness {
  readonly storage_ready: boolean;
  readonly fts_ready: boolean;
  readonly vector_store_ready: boolean;
  readonly embedding_ready: boolean;
  readonly workspace_ready: boolean;
}

export interface ProviderMetadata {
  readonly provider_name: "thai-rag";
  readonly provider_version: string;
  readonly contract_version: string;
  readonly contract_fingerprint: Sha256;
  readonly compatibility_range: CompatibilityRange;
  readonly index_job_contract_version: string;
  readonly generation: GenerationCompatibility;
  readonly embedding: EmbeddingCompatibility;
  readonly readiness: Readiness;
  readonly [key: string]: unknown;
}

export interface CodeIndexChannelState {
  readonly state: string;
  readonly records?: number | null;
  readonly expected_records?: number | null;
  readonly detail?: string | null;
  readonly [key: string]: unknown;
}

export interface CodeIndexReconciliation {
  readonly status: string;
  readonly stale_paths: readonly string[];
  readonly removed: number;
  readonly failed: { readonly [key: string]: unknown };
  readonly reused_active_generation: boolean;
  readonly [key: string]: unknown;
}

export interface CodeIndexPublicationData {
  readonly status: string;
  readonly cancelled: boolean;
  readonly indexed: number;
  readonly skipped: number;
  readonly unchanged: number;
  readonly policy_skipped?: number;
  readonly skip_counts?: Readonly<Record<string, number>>;
  readonly duration_s: number;
  readonly workspace: string;
  readonly generation_id: string | null;
  readonly active_generation_id?: string | null;
  readonly source_snapshot_id?: string | null;
  readonly embed_fallbacks?: number;
  readonly errors?: { readonly [key: string]: unknown };
  readonly trial_truncated?: boolean;
  readonly scoped?: boolean;
  readonly mode?: string;
  readonly source_identity?: SourceIdentity | null;
  readonly tombstones?: readonly string[];
  readonly deleted_paths?: DeletedPaths;
  readonly unfenced_paths?: readonly string[];
  readonly lexical_only: boolean;
  readonly vector_coverage: "none" | "partial" | "full";
  readonly warnings?: readonly string[];
  readonly channels?: Readonly<Record<string, CodeIndexChannelState>>;
  readonly reconciliation?: CodeIndexReconciliation;
  readonly [key: string]: unknown;
}

export interface CodeIndexDryRunData {
  readonly status: "dry_run";
  readonly dry_run: true;
  readonly workspace: string;
  readonly would_index: readonly string[];
  readonly would_delete?: readonly string[];
  readonly indexed: number;
  readonly skipped: number;
  readonly total_files: number;
  readonly duration_s: number;
  readonly trial_truncated?: boolean;
  readonly scoped?: boolean;
  readonly mode?: string;
  readonly source_identity?: SourceIdentity | null;
  readonly [key: string]: unknown;
}

export type CodeIndexData = CodeIndexPublicationData | CodeIndexDryRunData;

export interface IndexStatusData {
  readonly job_id: string;
  readonly workspace_id: WorkspaceId;
  readonly status: string;
  readonly indexed_files: number;
  readonly cancellation_requested: boolean;
  readonly cancellation_completed: boolean;
  readonly [key: string]: unknown;
}

export interface CodeSearchItem {
  readonly parent_id: string;
  readonly file_path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly symbol_name: string;
  readonly score: number;
  readonly content: string;
  readonly [key: string]: unknown;
}

export interface VectorRescue {
  readonly mode: "auto" | "off" | "always";
  readonly reason: string;
  readonly consult_requested?: boolean;
  readonly incompatible?: boolean;
  readonly consulted: boolean;
  readonly skipped?: string | null;
  readonly lexical_matches?: number;
  readonly vector_matches?: number;
  readonly semantic_error?: string | null;
  readonly [key: string]: unknown;
}

export interface CodeSearchData {
  readonly query: string;
  readonly workspace_id: WorkspaceId;
  readonly items: readonly CodeSearchItem[];
  readonly vector_rescue: VectorRescue;
  readonly warnings: readonly string[];
  readonly semantic_error: string | null;
  readonly [key: string]: unknown;
}

export interface AttachWorkspaceBaseData {
  readonly workspace_id: WorkspaceId;
  readonly base_workspace_id: WorkspaceId;
  readonly base_generation_id: string;
  readonly base_identity: SourceIdentity;
  readonly created_at: string;
  readonly [key: string]: unknown;
}

export interface ProviderError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details: { readonly [key: string]: unknown };
}

export interface ProviderResult {
  readonly status: ProviderStatus;
  readonly data: unknown;
  readonly workspace_id: string | null;
  readonly repository_id: string | null;
  readonly revision_id: RevisionId | null;
  readonly artifact_id: string | null;
  readonly repository_provenance: string | null;
  readonly trust_scope: "workspace" | "repository_provenance_unverified" | null;
  readonly operation_id: string | null;
  readonly generation: string | Readonly<Record<string, unknown>> | null;
  readonly warnings: readonly string[];
  readonly errors: readonly ProviderError[];
  readonly metadata: ProviderMetadata;
}

export interface ContractHandshake {
  readonly schema_version: 1;
  readonly provider_id: "thai-rag";
  readonly provider_version: string;
  readonly contract_version: string;
  readonly compatibility_range: CompatibilityRange;
  readonly contract_fingerprint: Sha256;
  readonly index_job_contract_version: string;
  readonly capability_contract: number;
  readonly control_mode: "unified_native" | "standalone_git" | "standalone_snapshot";
  readonly source_authority: string;
  readonly revision_manifest: boolean;
  readonly delta_index: boolean;
  readonly dirty_overlay: boolean;
  readonly expected_hash_fence: boolean;
  readonly local_structural_evidence: boolean;
  readonly local_scheduler: boolean;
  readonly local_gc: boolean;
  readonly constraint_resolution: boolean;
  readonly external_scheduler: boolean;
  readonly capabilities: readonly ("adopt_legacy_index" | "cancel_index" | "code_blast_radius" | "code_context" | "code_index" | "code_search" | "forget" | "health" | "index_status" | "pre_edit_context" | "recall" | "record_event" | "remember" | "resolve_event" | "version")[];
  readonly workspace_scope_model: "explicit_workspace_id";
  readonly result_model: "structured_provider_result";
  readonly error_model: "machine_readable_error";
  readonly generation: GenerationCompatibility;
  readonly embedding: EmbeddingCompatibility;
  readonly readiness: Readiness;
  readonly [key: string]: unknown;
}
