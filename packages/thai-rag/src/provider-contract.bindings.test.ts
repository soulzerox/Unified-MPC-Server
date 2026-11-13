import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_BINDING_DEFINITIONS,
  ERROR_CODE_VALUES,
  PROVIDER_STATUS_VALUES,
} from './provider-contract.bindings.js';
import { isThaiRagProviderErrorCode } from './provider-contract.js';

/**
 * The TypeScript wire bindings are generated from the vendored schema
 * (`thai-rag-mcp#1`). These tests fail when the checked-in file drifts from the
 * schema, when a `$defs` entry gains no binding, or when the generated
 * vocabulary moves away from the schema or Unified's error classification.
 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA_RELATIVE_PATH = 'packages/thai-rag/contract/provider-contract.v1.schema.json';
const SCHEMA_PATH = path.join(PACKAGE_ROOT, 'contract', 'provider-contract.v1.schema.json');
const BINDINGS_PATH = path.join(PACKAGE_ROOT, 'src', 'provider-contract.bindings.ts');
const GENERATOR_PATH = path.join(PACKAGE_ROOT, 'scripts', 'generate-contract-bindings.mjs');

interface SchemaDefinition {
  readonly enum?: readonly unknown[];
}

interface ContractSchema {
  readonly $defs: Readonly<Record<string, SchemaDefinition>>;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

describe('provider contract TypeScript bindings', () => {
  it('matches the checked-in schema byte for byte', () => {
    const checked = spawnSync(process.execPath, [GENERATOR_PATH, '--check'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
    });
    expect(checked.status, checked.stderr.trim()).toBe(0);
  });

  it('binds every schema definition exactly once', async () => {
    const schema = await readJson(SCHEMA_PATH) as ContractSchema;
    const bindings = await readFile(BINDINGS_PATH, 'utf8');
    const definitionNames = Object.keys(schema.$defs).sort();
    expect(Object.keys(CONTRACT_BINDING_DEFINITIONS).sort()).toEqual(definitionNames);

    const typeNames = Object.values(CONTRACT_BINDING_DEFINITIONS);
    expect(new Set(typeNames).size, 'two $defs map to the same TypeScript type').toBe(typeNames.length);
    for (const [definition, typeName] of Object.entries(CONTRACT_BINDING_DEFINITIONS)) {
      expect(
        new RegExp(`export (?:interface|type) ${typeName}\\b`).test(bindings),
        `$defs.${definition} has no exported ${typeName} binding`,
      ).toBe(true);
    }
  });

  it('keeps the generated vocabulary pinned to the schema', async () => {
    const schema = await readJson(SCHEMA_PATH) as ContractSchema;
    expect([...PROVIDER_STATUS_VALUES]).toEqual([...(schema.$defs.provider_status?.enum ?? [])]);
    expect([...ERROR_CODE_VALUES]).toEqual([...(schema.$defs.error_code?.enum ?? [])]);
    for (const code of ERROR_CODE_VALUES) {
      expect(isThaiRagProviderErrorCode(code), `schema ErrorCode '${code}' has no Unified classification`).toBe(true);
    }
  });

  it('records the schema digest the bindings were generated from', async () => {
    const schema = await readJson(SCHEMA_PATH) as ContractSchema;
    const bindings = await readFile(BINDINGS_PATH, 'utf8');
    const digest = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
    expect(bindings).toContain(`Source: ${SCHEMA_RELATIVE_PATH}`);
    expect(bindings).toContain(`Schema sha256: ${digest}`);
  });

  it('never falls back to an untyped binding', async () => {
    const bindings = await readFile(BINDINGS_PATH, 'utf8');
    expect(bindings).not.toMatch(/\bany\b/);
  });
});
