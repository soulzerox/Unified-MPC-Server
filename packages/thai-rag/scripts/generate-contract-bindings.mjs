#!/usr/bin/env node
/* global console, process, URL */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generates the TypeScript wire bindings from the vendored provider contract.
 *
 * The schema is the authority (thai-rag-mcp issue #1): Unified must not keep a
 * second, hand-maintained description of `provider_result` and its `$defs`.
 * This generator only models the JSON Schema constructs the contract actually
 * uses. A keyword it cannot translate fails the build instead of being
 * silently dropped, because a silently dropped keyword is a binding that
 * claims to describe a shape it does not.
 *
 * Usage:
 *   node scripts/generate-contract-bindings.mjs           # rewrite the file
 *   node scripts/generate-contract-bindings.mjs --check   # fail if stale
 *
 * `--schema <path>` and `--out <path>` override the checked-in locations; the
 * failure-path tests use them to feed a mutated copy without touching the
 * vendored corpus.
 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA_PATH = path.join(PACKAGE_ROOT, 'contract', 'provider-contract.v1.schema.json');
const OUTPUT_PATH = path.join(PACKAGE_ROOT, 'src', 'provider-contract.bindings.ts');
const SCHEMA_REFERENCE = 'packages/thai-rag/contract/provider-contract.v1.schema.json';
const DEFINITION_REF_PREFIX = '#/$defs/';

/** Keywords that constrain values but do not change the TypeScript type. */
const ANNOTATION_KEYWORDS = new Set([
  '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples',
  'deprecated', 'readOnly', 'writeOnly', 'x-evolution',
  'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
]);
/** Keywords this generator intentionally translates. */
const STRUCTURAL_KEYWORDS = new Set([
  '$ref', 'type', 'enum', 'const', 'required', 'properties', 'items',
  'additionalProperties', 'anyOf', 'oneOf', 'propertyNames',
]);
/** Keywords that would change the emitted type but are not implemented yet. */
const UNSUPPORTED_KEYWORDS = new Set([
  'allOf', 'not', 'if', 'then', 'else', 'dependentSchemas', 'dependentRequired',
  'patternProperties', 'prefixItems', 'contains', 'unevaluatedProperties',
  'unevaluatedItems', '$dynamicRef', '$recursiveRef',
]);

function pascalCase(name) {
  const pascal = name
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join('');
  if (pascal.length === 0) throw new Error(`cannot derive a type name from '${name}'`);
  return pascal;
}

function assertSchemaObject(value, where) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be a schema object, found ${JSON.stringify(value)}`);
  }
  for (const keyword of Object.keys(value)) {
    if (UNSUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`${where} uses '${keyword}', which the bindings generator does not model`);
    }
    if (!STRUCTURAL_KEYWORDS.has(keyword) && !ANNOTATION_KEYWORDS.has(keyword)) {
      throw new Error(`${where} uses unknown schema keyword '${keyword}'`);
    }
  }
}

/** Filled by `render` so a `$ref` can be resolved while emitting a type. */
let schemaDefinitions = {};

function referenceDefinition(schema, where) {
  const reference = schema.$ref;
  if (typeof reference !== 'string' || !reference.startsWith(DEFINITION_REF_PREFIX)) {
    throw new Error(`${where} has unsupported $ref ${JSON.stringify(reference)}`);
  }
  const name = reference.slice(DEFINITION_REF_PREFIX.length);
  const definition = schemaDefinitions[name];
  if (definition === undefined) {
    throw new Error(`${where} references unknown definition '${name}'`);
  }
  return { name, definition };
}

function referenceName(schema, where) {
  return pascalCase(referenceDefinition(schema, where).name);
}

/**
 * `propertyNames` only reaches the binding when it leaves the key space open:
 * a plain string (or a reference to one). A closed set would need a mapped
 * type, so fail instead of emitting a wider `Record<string, T>` than the
 * schema allows.
 */
function assertOpenStringKeySpace(schema, where, seen = new Set()) {
  if (schema === true) return;
  assertSchemaObject(schema, where);
  if (schema.$ref !== undefined) {
    const { name, definition } = referenceDefinition(schema, where);
    if (seen.has(name)) {
      throw new Error(`${where} has a cyclic propertyNames reference through '${name}'`);
    }
    seen.add(name);
    assertOpenStringKeySpace(definition, `${where} -> $defs.${name}`, seen);
    return;
  }
  if (schema.enum !== undefined || schema.const !== undefined) {
    throw new Error(`${where} closes the property-name set, which the bindings generator does not model`);
  }
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((member, index) => {
      assertOpenStringKeySpace(member, `${where}.anyOf[${index}]`, new Set(seen));
    });
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((member, index) => {
      assertOpenStringKeySpace(member, `${where}.oneOf[${index}]`, new Set(seen));
    });
    return;
  }
  if (schema.type !== undefined && schema.type !== 'string') {
    throw new Error(
      `${where} constrains property names to ${JSON.stringify(schema.type)}, which the bindings generator does not model`,
    );
  }
}

function unionOf(types) {
  const unique = [...new Set(types)];
  return unique.join(' | ');
}

function arrayOf(itemType) {
  return `readonly ${itemType.includes(' | ') ? `(${itemType})` : itemType}[]`;
}

function objectType(schema, where) {
  const properties = schema.properties;
  const additional = schema.additionalProperties;
  const lines = [];
  if (properties !== undefined) {
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
      throw new Error(`${where}.properties must be an object`);
    }
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [name, property] of Object.entries(properties)) {
      if (property !== true && property !== false) assertSchemaObject(property, `${where}.properties.${name}`);
      const optional = required.has(name) ? '' : '?';
      const propertyType = typeOf(property, `${where}.properties.${name}`);
      lines.push(`  readonly ${name}${optional}: ${propertyType.replaceAll('\n', '\n  ')};`);
    }
  }
  if (additional !== undefined && additional !== false && additional !== true && properties !== undefined) {
    // A typed index signature next to named properties only works when every
    // named property is assignable to it. The contract does not do this today;
    // fail instead of emitting an interface TypeScript would reject.
    throw new Error(`${where} mixes named properties with a typed additionalProperties`);
  }
  if (additional === true) {
    lines.push('  readonly [key: string]: unknown;');
  } else if (additional !== undefined && additional !== false) {
    assertSchemaObject(additional, `${where}.additionalProperties`);
    return `Readonly<Record<string, ${typeOf(additional, `${where}.additionalProperties`)}>>`;
  }
  if (lines.length === 0) {
    // `{type: 'object'}` without `additionalProperties: false` allows unknown
    // keys; a closed empty object (`additionalProperties: false`) allows none.
    return additional === false ? 'Readonly<Record<string, never>>' : 'Readonly<Record<string, unknown>>';
  }
  if (lines.length === 1 && lines[0] === '  readonly [key: string]: unknown;') {
    return '{ readonly [key: string]: unknown }';
  }
  return `{\n${lines.join('\n')}\n}`;
}

function typeOf(schema, where = 'schema') {
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  assertSchemaObject(schema, where);
  if (schema.$ref !== undefined) {
    // JSON Schema 2020-12 evaluates siblings beside `$ref`; this generator
    // would return the referenced type and silently drop them.
    const siblings = Object.keys(schema).filter(
      (keyword) => STRUCTURAL_KEYWORDS.has(keyword) && keyword !== '$ref',
    );
    if (siblings.length > 0) {
      throw new Error(
        `${where} puts ${siblings.map((keyword) => `'${keyword}'`).join(', ')} beside $ref, which the bindings generator does not model`,
      );
    }
    return referenceName(schema, where);
  }
  if (schema.propertyNames !== undefined) {
    assertOpenStringKeySpace(schema.propertyNames, `${where}.propertyNames`);
  }
  if (Array.isArray(schema.anyOf)) {
    return unionOf(schema.anyOf.map((member, index) => typeOf(member, `${where}.anyOf[${index}]`)));
  }
  if (Array.isArray(schema.oneOf)) {
    return unionOf(schema.oneOf.map((member, index) => typeOf(member, `${where}.oneOf[${index}]`)));
  }
  if (Array.isArray(schema.enum)) {
    return unionOf(schema.enum.map((value) => JSON.stringify(value)));
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const declared = schema.type;
  if (Array.isArray(declared)) {
    return unionOf(declared.map((entry) => typeOf({ ...schema, type: entry, required: schema.required }, where)));
  }
  if (declared === 'string') return 'string';
  if (declared === 'integer' || declared === 'number') return 'number';
  if (declared === 'boolean') return 'boolean';
  if (declared === 'null') return 'null';
  if (declared === 'array') {
    if (schema.items === undefined) return arrayOf('unknown');
    return arrayOf(typeOf(schema.items, `${where}.items`));
  }
  if (declared === 'object' || schema.properties !== undefined || schema.additionalProperties !== undefined) {
    return objectType(schema, where);
  }
  if (declared === undefined) return 'unknown';
  throw new Error(`${where} has unsupported type ${JSON.stringify(declared)}`);
}

function render(schema, schemaReference = SCHEMA_REFERENCE) {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error('contract schema must be an object');
  }
  const definitions = schema.$defs;
  if (typeof definitions !== 'object' || definitions === null || Array.isArray(definitions)) {
    throw new Error('contract schema has no $defs object');
  }
  schemaDefinitions = definitions;

  const names = new Map();
  for (const name of Object.keys(definitions)) {
    const typeName = pascalCase(name);
    if (names.has(typeName)) {
      throw new Error(`$defs '${name}' and '${names.get(typeName)}' both map to ${typeName}`);
    }
    names.set(typeName, name);
  }

  const blocks = [[
    '/** `$defs` name -> generated TypeScript type. */',
    'export const CONTRACT_BINDING_DEFINITIONS = {',
    ...Object.keys(definitions).map((name) => `  ${name}: '${pascalCase(name)}',`),
    '} as const;',
  ].join('\n')];
  for (const [name, definition] of Object.entries(definitions)) {
    assertSchemaObject(definition, `$defs.${name}`);
    const typeName = pascalCase(name);
    if (Array.isArray(definition.enum)) {
      const values = definition.enum.map((value) => JSON.stringify(value)).join(', ');
      blocks.push([
        `export const ${name.toUpperCase()}_VALUES = [${values}] as const;`,
        `export type ${typeName} = typeof ${name.toUpperCase()}_VALUES[number];`,
      ].join('\n'));
      continue;
    }
    const body = typeOf(definition, `$defs.${name}`);
    if (body.startsWith('{\n')) {
      blocks.push(`export interface ${typeName} ${body}`);
    } else {
      blocks.push(`export type ${typeName} = ${body};`);
    }
  }

  const digest = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
  return [
    '/**',
    ' * GENERATED FILE - do not edit by hand.',
    ' *',
    ` * Source: ${schemaReference}`,
    ` * Schema sha256: ${digest}`,
    ' *',
    ' * Regenerate: corepack pnpm@10.15.0 --filter @unified-mpc/thai-rag contract:bindings',
    ' * Check:      corepack pnpm@10.15.0 --filter @unified-mpc/thai-rag contract:bindings:check',
    ' */',
    '',
    ...blocks.flatMap((block) => [block, '']),
  ].join('\n');
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a path`);
  }
  return value;
}

const schemaPath = path.resolve(argumentValue('--schema') ?? SCHEMA_PATH);
const outputPath = path.resolve(argumentValue('--out') ?? OUTPUT_PATH);
const schemaReference = schemaPath === SCHEMA_PATH
  ? SCHEMA_REFERENCE
  : path.relative(PACKAGE_ROOT, schemaPath);
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
const rendered = render(schema, schemaReference);
const check = process.argv.includes('--check');

if (check) {
  const current = await readFile(outputPath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (current === rendered) {
    console.log(`contract bindings current (${Object.keys(schema.$defs).length} definitions)`);
  } else {
    const currentLines = (current ?? '').split('\n');
    const renderedLines = rendered.split('\n');
    const index = renderedLines.findIndex((line, lineIndex) => line !== currentLines[lineIndex]);
    console.error(`contract bindings are stale at line ${index + 1 || renderedLines.length}`);
    console.error(`  generated: ${JSON.stringify(renderedLines[index] ?? '')}`);
    console.error(`  on disk:   ${JSON.stringify(currentLines[index] ?? '')}`);
    console.error('run: corepack pnpm@10.15.0 --filter @unified-mpc/thai-rag contract:bindings');
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, rendered, 'utf8');
  console.log(`wrote ${Object.keys(schema.$defs).length} contract bindings to ${path.relative(PACKAGE_ROOT, outputPath)}`);
}
