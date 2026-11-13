import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
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

interface MutableDefinition {
  [keyword: string]: unknown;
}

interface MutableContractSchema {
  $defs: Record<string, MutableDefinition>;
}

interface GeneratorRun {
  readonly status: number | null;
  readonly stderr: string;
}

interface GeneratorRunWithOutput extends GeneratorRun {
  readonly outputWritten: boolean;
}

function definition(schema: MutableContractSchema, name: string): MutableDefinition {
  const value = schema.$defs[name];
  if (value === undefined) throw new Error(`schema has no $defs.${name}`);
  return value;
}

/**
 * Runs the generator against a mutated copy of the vendored schema, so a guard
 * cannot regress into a silent widening without a test noticing. The copy and
 * the output live in the OS temp directory; the vendored corpus is never
 * written.
 */
async function runGeneratorWith(
  mutate: (schema: MutableContractSchema) => void,
  options: { readonly inlineFlags?: boolean } = {},
): Promise<GeneratorRun> {
  const schema = await readJson(SCHEMA_PATH) as MutableContractSchema;
  mutate(schema);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'contract-bindings-'));
  try {
    const schemaPath = path.join(directory, 'schema.json');
    const outputPath = path.join(directory, 'bindings.ts');
    await writeFile(schemaPath, JSON.stringify(schema), 'utf8');
    const argumentsWithPaths = options.inlineFlags === true
      ? [`--schema=${schemaPath}`, `--out=${outputPath}`]
      : ['--schema', schemaPath, '--out', outputPath];
    const result = spawnSync(
      process.execPath,
      [GENERATOR_PATH, ...argumentsWithPaths],
      { cwd: PACKAGE_ROOT, encoding: 'utf8' },
    );
    return { status: result.status, stderr: result.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Runs the generator with an explicit argument list and reports whether it
 * wrote the output file, so a rejected command line cannot be mistaken for a
 * silent write to the checked-in path.
 */
async function runGeneratorWithArguments(
  argumentsFor: (directory: string) => string[],
): Promise<GeneratorRunWithOutput> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'contract-bindings-'));
  try {
    const outputPath = path.join(directory, 'bindings.ts');
    const result = spawnSync(
      process.execPath,
      [GENERATOR_PATH, ...argumentsFor(directory)],
      { cwd: PACKAGE_ROOT, encoding: 'utf8' },
    );
    const outputWritten = await readFile(outputPath, 'utf8').then(() => true, () => false);
    return { status: result.status, stderr: result.stderr, outputWritten };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

describe('contract bindings generator rejects an unmodelled schema', () => {
  it('refuses an unsupported keyword', async () => {
    const run = await runGeneratorWith((schema) => {
      definition(schema, 'provider_status').allOf = [{ type: 'string' }];
    });
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain("uses 'allOf'");
  });

  it('refuses two definitions that collapse onto one type name', async () => {
    const run = await runGeneratorWith((schema) => {
      schema.$defs.provider__status = { type: 'string' };
    });
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain('both map to ProviderStatus');
  });

  it('refuses a propertyNames set closed by an enum', async () => {
    const run = await runGeneratorWith((schema) => {
      definition(schema, 'expected_paths').propertyNames = { type: 'string', enum: ['src/a.ts'] };
    });
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain('closes the property-name set');
  });

  it('refuses a propertyNames set closed through anyOf', async () => {
    const run = await runGeneratorWith((schema) => {
      definition(schema, 'expected_paths').propertyNames = {
        anyOf: [{ type: 'string' }, { enum: ['src/a.ts'] }],
      };
    });
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain('closes the property-name set');
  });

  it('refuses structural keywords beside $ref', async () => {
    const run = await runGeneratorWith((schema) => {
      const target = definition(schema, 'code_index_data');
      for (const keyword of Object.keys(target)) delete target[keyword];
      target.$ref = '#/$defs/code_index_publication_data';
      target.required = ['job_id'];
    });
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain('beside $ref');
  });

  it('refuses named properties mixed with a typed additionalProperties', async () => {
    const run = await runGeneratorWith((schema) => {
      definition(schema, 'provider_error').additionalProperties = { type: 'string' };
    });
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain('mixes named properties with a typed additionalProperties');
  });

  it('refuses a propertyNames $ref that also closes the key set', async () => {
    const run = await runGeneratorWith((schema) => {
      definition(schema, 'expected_paths').propertyNames = {
        $ref: '#/$defs/relative_path',
        enum: ['src/a.ts'],
      };
    });
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain('beside $ref');
  });

  it('keeps annotation siblings beside $ref', async () => {
    const run = await runGeneratorWith((schema) => {
      const target = definition(schema, 'code_index_data');
      for (const keyword of Object.keys(target)) delete target[keyword];
      target.$ref = '#/$defs/code_index_publication_data';
      target.description = 'A publication, including a cancelled one, or a dry-run plan.';
    });
    expect(run.status, run.stderr.trim()).toBe(0);
  });

  it('does not mistake a $ref shared by two propertyNames branches for a cycle', async () => {
    const run = await runGeneratorWith((schema) => {
      definition(schema, 'expected_paths').propertyNames = {
        anyOf: [
          { $ref: '#/$defs/relative_path' },
          { $ref: '#/$defs/relative_path' },
        ],
      };
    });
    expect(run.status, run.stderr.trim()).toBe(0);
  });

  it('honours the --flag=value form instead of falling back to the checked-in paths', async () => {
    const run = await runGeneratorWith((schema) => {
      definition(schema, 'expected_paths').propertyNames = { type: 'string', enum: ['src/a.ts'] };
    }, { inlineFlags: true });
    // The mutated schema must be the one read: falling back to the checked-in
    // schema would succeed and silently ignore the override.
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain('closes the property-name set');
  });

  it('refuses an unknown option before reading or writing anything', async () => {
    const run = await runGeneratorWithArguments((directory) => [
      '--schemaa',
      SCHEMA_PATH,
      '--out',
      path.join(directory, 'bindings.ts'),
    ]);
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain("unknown option '--schemaa'");
    expect(run.outputWritten).toBe(false);
  });

  it('refuses a propertyNames schema that mixes anyOf and oneOf', async () => {
    const run = await runGeneratorWith((schema) => {
      definition(schema, 'expected_paths').propertyNames = {
        anyOf: [{ type: 'string' }],
        oneOf: [{ enum: ['src/a.ts'] }],
      };
    });
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain("combines 'anyOf' and 'oneOf'");
  });

  it('refuses a non-string type beside a propertyNames union', async () => {
    const run = await runGeneratorWith((schema) => {
      definition(schema, 'expected_paths').propertyNames = {
        anyOf: [{ type: 'string' }],
        type: 'number',
      };
    });
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain('constrains property names to "number"');
  });

  it('refuses an empty propertyNames union', async () => {
    const run = await runGeneratorWith((schema) => {
      definition(schema, 'expected_paths').propertyNames = { anyOf: [] };
    });
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain('anyOf is empty, so it closes the property-name set');
  });

  it('refuses structural keywords beside enum', async () => {
    const run = await runGeneratorWith((schema) => {
      definition(schema, 'provider_status').properties = { extra: { type: 'string' } };
    });
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain("puts 'properties' beside enum");
  });

  it('refuses an enum whose declared type no value matches', async () => {
    const run = await runGeneratorWith((schema) => {
      definition(schema, 'provider_status').type = 'number';
    });
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain('declares type "number" but enum contains "ok"');
  });

  it('keeps a compatible type beside enum', async () => {
    const run = await runGeneratorWith((schema) => {
      definition(schema, 'provider_status').type = ['string', 'null'];
    });
    expect(run.status, run.stderr.trim()).toBe(0);
  });

  it('refuses a nested $ref with a structural sibling', async () => {
    const run = await runGeneratorWith((schema) => {
      const properties = definition(schema, 'provider_result').properties as Record<string, MutableDefinition>;
      properties.status.required = ['status'];
    });
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain('beside $ref');
  });

  it('refuses a top-level enum definition with a $ref sibling', async () => {
    const run = await runGeneratorWith((schema) => {
      definition(schema, 'provider_status').$ref = '#/$defs/error_code';
    });
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain('beside $ref');
  });

  it('refuses --check=value instead of silently writing', async () => {
    const run = await runGeneratorWithArguments((directory) => [
      `--schema=${SCHEMA_PATH}`,
      `--out=${path.join(directory, 'bindings.ts')}`,
      '--check=true',
    ]);
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain("unknown option '--check=true'");
    expect(run.outputWritten).toBe(false);
  });

  it('refuses a single-dash option', async () => {
    const run = await runGeneratorWithArguments((directory) => [
      '-s',
      SCHEMA_PATH,
      '--out',
      path.join(directory, 'bindings.ts'),
    ]);
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain("unknown option '-s'");
    expect(run.outputWritten).toBe(false);
  });

  it('refuses a bare positional argument', async () => {
    const run = await runGeneratorWithArguments(() => [SCHEMA_PATH]);
    expect(run.status, run.stderr.trim()).not.toBe(0);
    expect(run.stderr).toContain(`unexpected argument '${SCHEMA_PATH}'`);
  });
});
