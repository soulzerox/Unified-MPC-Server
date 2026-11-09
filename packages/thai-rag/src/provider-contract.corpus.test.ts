import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THAI_RAG_PROVIDER_ID } from './canonical-workspace.js';
import {
  THAI_RAG_CANCEL_CONTRACT_FINGERPRINT,
  THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION,
  THAI_RAG_CONSTRAINT_RESOLUTION_CONTRACT_FINGERPRINT,
  THAI_RAG_CONTRACT_FINGERPRINT,
  THAI_RAG_CONTRACT_VERSION,
  THAI_RAG_INDEX_JOB_CONTRACT_VERSION,
  THAI_RAG_LEGACY_ADOPTION_CONTRACT_FINGERPRINT,
  THAI_RAG_PROVIDER_ERROR_CODE_MAP,
  isThaiRagProviderErrorCode,
  mapThaiRagProviderErrorCode,
  parseThaiRagHandshakePayload,
  validateThaiRagHandshake,
} from './provider-contract.js';

/**
 * Runs the published Thai-RAG provider contract corpus against Unified's
 * boundary readers. The corpus is vendored verbatim at a pinned commit
 * (`packages/thai-rag/contract/PROVENANCE.json`), so a provider-side change
 * that Unified cannot read fails here instead of at runtime.
 */
const CONTRACT_ROOT = fileURLToPath(new URL('../contract', import.meta.url));
const DESCRIPTIVE_FILES = new Set(['PROVENANCE.json', 'VENDORED.md']);

interface Provenance {
  readonly sourceRepository: string;
  readonly sourceCommit: string;
  readonly files: Readonly<Record<string, string>>;
}

interface CorpusExpectation {
  readonly status: string;
  readonly error_codes: readonly string[];
}

interface CorpusEntry {
  readonly file: string;
  readonly operation: string;
  readonly state: string;
  readonly expect: CorpusExpectation;
}

interface CorpusIndex {
  readonly schema: string;
  readonly fixtures: readonly CorpusEntry[];
}

interface FixtureMetadata {
  readonly provider_name: string;
  readonly provider_version: string;
  readonly contract_version: string;
  readonly contract_fingerprint: string;
  readonly index_job_contract_version: string;
  readonly generation: {
    readonly contract: string;
    readonly embedding: string;
    readonly index: string;
    readonly storage: string;
  };
  readonly embedding: {
    readonly profile: string;
    readonly model: string;
    readonly dimension: number;
  };
}

interface FixtureError {
  readonly code: string;
  readonly message?: string;
}

interface ProviderFixture {
  readonly status: string;
  readonly data?: unknown;
  readonly metadata: FixtureMetadata;
  readonly errors?: readonly FixtureError[];
}

interface SchemaDefinition {
  readonly additionalProperties?: boolean;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly enum?: readonly string[];
}

interface ProviderSchema {
  readonly $defs: Readonly<Record<string, SchemaDefinition>>;
}

/** Every fingerprint the runtime accepts, with the index-job contract it attests. */
const SUPPORTED_FINGERPRINTS = new Map<string, string>([
  [THAI_RAG_CONTRACT_FINGERPRINT, THAI_RAG_INDEX_JOB_CONTRACT_VERSION],
  [THAI_RAG_CANCEL_CONTRACT_FINGERPRINT, THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION],
  [THAI_RAG_LEGACY_ADOPTION_CONTRACT_FINGERPRINT, THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION],
  [THAI_RAG_CONSTRAINT_RESOLUTION_CONTRACT_FINGERPRINT, THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION],
]);

async function readContractJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(CONTRACT_ROOT, relativePath), 'utf8')) as unknown;
}

/** Repository-relative, posix-separated file list under the vendored contract. */
async function listContractFiles(directory = CONTRACT_ROOT, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listContractFiles(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

async function loadCorpus(): Promise<{ index: CorpusIndex; fixtures: ReadonlyMap<string, ProviderFixture> }> {
  const index = await readContractJson('fixtures/index.json') as CorpusIndex;
  const fixtures = new Map<string, ProviderFixture>();
  for (const entry of index.fixtures) {
    fixtures.set(entry.file, await readContractJson(entry.file) as ProviderFixture);
  }
  return { index, fixtures };
}

describe('Thailand-RAG provider contract corpus', () => {
  it('vendors the published corpus verbatim at the recorded commit', async () => {
    const provenance = await readContractJson('PROVENANCE.json') as Provenance;
    expect(provenance.sourceRepository).toBe('soulzerox/thai-rag-mcp');
    expect(provenance.sourceCommit).toMatch(/^[a-f0-9]{40}$/);

    const onDisk = (await listContractFiles()).filter((file) => !DESCRIPTIVE_FILES.has(file));
    expect(onDisk).toEqual(Object.keys(provenance.files).sort());

    for (const file of onDisk) {
      const digest = createHash('sha256').update(await readFile(path.join(CONTRACT_ROOT, file))).digest('hex');
      expect(digest, `${file} no longer matches PROVENANCE.json; refresh the vendored copy instead of editing it`).toBe(provenance.files[file]);
    }
  });

  it('describes exactly the vendored fixtures and their published error codes', async () => {
    const { index, fixtures } = await loadCorpus();
    const listed = index.fixtures.map((entry) => entry.file).sort();
    const vendored = (await listContractFiles()).filter((file) => file.startsWith('fixtures/') && file !== 'fixtures/index.json');
    expect(listed).toEqual(vendored);
    expect(index.schema).toBe('provider-contract.v1.schema.json');

    for (const entry of index.fixtures) {
      const fixture = fixtures.get(entry.file);
      expect(fixture, entry.file).toBeDefined();
      if (fixture === undefined) continue;
      const actualCodes = [...new Set((fixture.errors ?? []).map((error) => error.code))].sort();
      expect(actualCodes, `${entry.file} publishes different error codes than fixtures/index.json`).toEqual([...entry.expect.error_codes].sort());
      expect(entry.expect.status, `${entry.file} expects a status the schema does not publish`).toBe(fixture.status);
    }
  });

  it('keeps the schema error vocabulary inside the Unified classification table', async () => {
    const schema = await readContractJson('provider-contract.v1.schema.json') as ProviderSchema;
    const versioned = schema.$defs.error_code?.enum ?? [];
    expect(versioned.length).toBeGreaterThan(0);
    for (const code of versioned) {
      expect(isThaiRagProviderErrorCode(code), `schema ErrorCode '${code}' has no Unified classification`).toBe(true);
    }
    const unifiedCodes = new Set(THAI_RAG_PROVIDER_ERROR_CODE_MAP.values());
    expect([...unifiedCodes].sort()).toEqual(['CONFLICT', 'FILE_NOT_FOUND', 'INVALID_INPUT', 'PERMISSION_DENIED']);
  });

  it('keeps the closed source_identity field set aligned with the native request', async () => {
    const schema = await readContractJson('provider-contract.v1.schema.json') as ProviderSchema;
    const sourceIdentity = schema.$defs.source_identity;
    expect(sourceIdentity, 'schema has no source_identity definition').toBeDefined();
    if (sourceIdentity === undefined) return;
    expect(sourceIdentity.additionalProperties).toBe(false);
    expect(Object.keys(sourceIdentity.properties ?? {}).sort()).toEqual([
      'commit_sha',
      'manifest_id',
      'ref',
      'repository_id',
      'revision_id',
      'tree_oid',
    ]);
    expect([...(sourceIdentity.required ?? [])].sort()).toEqual(['manifest_id', 'repository_id']);

    const nativeExample = await readContractJson('examples/index-request-native.json') as {
      readonly source_identity?: Readonly<Record<string, unknown>>;
    };
    const sent = Object.keys(nativeExample.source_identity ?? {});
    expect(sent.length).toBeGreaterThan(0);
    for (const field of sent) {
      expect(Object.keys(sourceIdentity.properties ?? {}), `native example sends '${field}', which the closed schema refuses`).toContain(field);
    }
  });

  it.each([
    { fixture: 'fixtures/health-ready.json', allowedDegradedCapabilities: undefined, reason: undefined },
    { fixture: 'fixtures/health-degraded-embedding.json', allowedDegradedCapabilities: ['embedder', 'semantic_retrieval'], reason: undefined },
    // The envelope status is `unavailable`, but the handshake state stays
    // `degraded`: Unified refuses it because storage/FTS are not available,
    // and reports that as `health-degraded` rather than `health-unavailable`.
    { fixture: 'fixtures/health-unavailable-storage.json', allowedDegradedCapabilities: undefined, reason: 'health-degraded' },
  ])('reads $fixture through the payload reader with the documented verdict', async ({ fixture: file, allowedDegradedCapabilities, reason }) => {
    const fixture = await readContractJson(file) as ProviderFixture;
    const parsed = parseThaiRagHandshakePayload(fixture);
    expect(parsed.ok, `${file} does not parse as a handshake payload`).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.providerId).toBe(THAI_RAG_PROVIDER_ID);
    expect(parsed.value.contractVersion).toBe(THAI_RAG_CONTRACT_VERSION);
    expect(parsed.value.contractFingerprint).toBe(fixture.metadata.contract_fingerprint);

    const validated = validateThaiRagHandshake(parsed.value, allowedDegradedCapabilities === undefined ? {} : { allowedDegradedCapabilities });
    if (reason === undefined) {
      expect(validated.ok, `${file} is refused by the handshake validator: ${validated.ok ? '' : validated.error.message}`).toBe(true);
    } else {
      expect(validated.ok, `${file} should be refused`).toBe(false);
      if (!validated.ok) expect(validated.error.details?.reason).toBe(reason);
    }
  });

  it('publishes a supported handshake identity in every fixture', async () => {
    const { fixtures } = await loadCorpus();
    expect(fixtures.size).toBeGreaterThan(0);
    for (const [file, fixture] of fixtures) {
      const { metadata } = fixture;
      expect(metadata.provider_name, `${file} claims another provider`).toBe(THAI_RAG_PROVIDER_ID);
      expect(metadata.contract_version).toBe(THAI_RAG_CONTRACT_VERSION);
      const expectedIndexJobVersion = SUPPORTED_FINGERPRINTS.get(metadata.contract_fingerprint);
      expect(expectedIndexJobVersion, `${file} uses a fingerprint the runtime does not support`).toBeDefined();
      expect(metadata.index_job_contract_version, `${file} attests a different index-job contract`).toBe(expectedIndexJobVersion);
      expect(metadata.generation.contract).toBe(metadata.contract_fingerprint);
      expect(metadata.generation.embedding).toBe(metadata.embedding.profile);

      for (const error of fixture.errors ?? []) {
        expect(isThaiRagProviderErrorCode(error.code), `${file} publishes unmapped ErrorCode '${error.code}'`).toBe(true);
        expect(['CONFLICT', 'FILE_NOT_FOUND', 'INVALID_INPUT', 'PERMISSION_DENIED']).toContain(mapThaiRagProviderErrorCode(error.code));
      }
    }
  });
});
