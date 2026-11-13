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
 * JSON Schema 2020-12 evaluates siblings beside `$ref`; every emitter here
 * would return the referenced type and silently drop them.
 */
function assertNoStructuralRefSiblings(schema, where) {
  if (schema.$ref === undefined) return;
  const siblings = Object.keys(schema).filter(
    (keyword) => STRUCTURAL_KEYWORDS.has(keyword) && keyword !== '$ref',
  );
  if (siblings.length > 0) {
    throw new Error(
      `${where} puts ${siblings.map((keyword) => `'${keyword}'`).join(', ')} beside $ref, which the bindings generator does not model`,
    );
  }
}

/**
 * A union is emitted as `A | B`. JSON Schema evaluates any other structural
 * keyword beside it as an intersection, which this emitter cannot represent,
 * so fail instead of returning the union and dropping the sibling. A union
 * keyword that is not an array would otherwise fall through to `unknown`, so
 * its shape is validated here before any member is inspected.
 */
function assertNoStructuralUnionSiblings(schema, where) {
  const unions = ['anyOf', 'oneOf'].filter((keyword) => schema[keyword] !== undefined);
  if (unions.length === 0) return;
  if (unions.length > 1) {
    throw new Error(`${where} combines 'anyOf' and 'oneOf', which the bindings generator does not model`);
  }
  const [union] = unions;
  if (!Array.isArray(schema[union])) {
    throw new Error(`${where}.${union} must be an array`);
  }
  for (const keyword of Object.keys(schema)) {
    if (STRUCTURAL_KEYWORDS.has(keyword) && keyword !== union) {
      throw new Error(
        `${where} puts '${keyword}' beside a union, which the bindings generator does not model`,
      );
    }
  }
}

/**
 * `propertyNames` only reaches the binding when it leaves the key space open:
 * a plain string (or a reference to one). A closed set would need a mapped
 * type, so fail instead of emitting a wider `Record<string, T>` than the
 * schema allows. Every structural keyword is inspected, not only the first
 * applicator, because JSON Schema evaluates all of them together.
 */
function assertOpenStringKeySpace(schema, where, seen = new Set()) {
  if (schema === true) return;
  assertSchemaObject(schema, where);
  assertNoStructuralRefSiblings(schema, where);
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
  const unionKeywords = ['anyOf', 'oneOf'].filter((keyword) => schema[keyword] !== undefined);
  if (unionKeywords.length > 1) {
    throw new Error(`${where} combines 'anyOf' and 'oneOf', which the bindings generator does not model`);
  }
  for (const keyword of ['properties', 'items', 'required', 'additionalProperties', 'propertyNames']) {
    if (schema[keyword] !== undefined) {
      throw new Error(
        `${where} uses '${keyword}' on a property name, which the bindings generator does not model`,
      );
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.length === 0 || !types.every((type) => type === 'string')) {
      throw new Error(
        `${where} constrains property names to ${JSON.stringify(schema.type)}, which the bindings generator does not model`,
      );
    }
  }
  if (unionKeywords.length === 0) return;
  const keyword = unionKeywords[0];
  const members = schema[keyword];
  if (!Array.isArray(members)) {
    throw new Error(`${where}.${keyword} must be an array`);
  }
  if (members.length === 0) {
    throw new Error(`${where}.${keyword} is empty, so it closes the property-name set`);
  }
  members.forEach((member, index) => {
    assertOpenStringKeySpace(member, `${where}.${keyword}[${index}]`, new Set(seen));
  });
}

/**
 * JSON Schema types a literal can match. `assertScalarLiteral` runs first, so
 * a structural declared type can never match and is reported as a mismatch
 * instead of pretending an array or object literal was supported.
 */
function matchesDeclaredType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array':
    case 'object': return false;
    default: throw new Error(`unsupported JSON Schema type ${JSON.stringify(type)}`);
  }
}

/** `JSON.stringify` only emits a precise type for scalar literals. */
function assertScalarLiteral(value, where) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return;
  throw new Error(
    `${where} uses the non-scalar literal ${JSON.stringify(value)}, which the bindings generator does not model`,
  );
}

/**
 * `enum`/`const` are emitted as literal unions. A structural sibling would be
 * dropped, a non-scalar literal would widen to `{}`/`unknown[]`, and a `type`
 * that no literal matches would emit a type the schema can never satisfy, so
 * check all three instead of trusting the annotation.
 */
function assertLiteralSiblings(schema, where) {
  const hasEnum = schema.enum !== undefined;
  const hasConst = schema.const !== undefined;
  if (!hasEnum && !hasConst) return;
  if (hasEnum && !Array.isArray(schema.enum)) {
    throw new Error(`${where}.enum must be an array`);
  }
  if (hasEnum && hasConst) {
    throw new Error(`${where} mixes 'enum' and 'const', which the bindings generator does not model`);
  }
  for (const keyword of Object.keys(schema)) {
    if (STRUCTURAL_KEYWORDS.has(keyword) && keyword !== 'enum' && keyword !== 'const' && keyword !== 'type') {
      throw new Error(
        `${where} puts '${keyword}' beside ${hasEnum ? 'enum' : 'const'}, which the bindings generator does not model`,
      );
    }
  }
  if (hasEnum && schema.enum.length === 0) {
    throw new Error(`${where}.enum is empty, which the bindings generator does not model`);
  }
  const values = hasEnum ? schema.enum : [schema.const];
  for (const value of values) {
    assertScalarLiteral(value, `${where}.${hasEnum ? 'enum' : 'const'}`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.length === 0) {
      throw new Error(`${where}.type is empty, which the bindings generator does not model`);
    }
    for (const value of values) {
      if (!types.some((type) => matchesDeclaredType(value, type))) {
        throw new Error(
          `${where} declares type ${JSON.stringify(schema.type)} but ${hasEnum ? 'enum' : 'const'} contains ${JSON.stringify(value)}`,
        );
      }
    }
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
  assertNoStructuralRefSiblings(schema, where);
  assertNoStructuralUnionSiblings(schema, where);
  assertLiteralSiblings(schema, where);
  if (schema.$ref !== undefined) {
    return referenceName(schema, where);
  }
  if (schema.propertyNames !== undefined) {
    assertOpenStringKeySpace(schema.propertyNames, `${where}.propertyNames`);
  }
  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.length === 0) throw new Error(`${where}.anyOf is empty, which the bindings generator does not model`);
    return unionOf(schema.anyOf.map((member, index) => typeOf(member, `${where}.anyOf[${index}]`)));
  }
  if (Array.isArray(schema.oneOf)) {
    if (schema.oneOf.length === 0) throw new Error(`${where}.oneOf is empty, which the bindings generator does not model`);
    return unionOf(schema.oneOf.map((member, index) => typeOf(member, `${where}.oneOf[${index}]`)));
  }
  if (Array.isArray(schema.enum)) {
    return unionOf(schema.enum.map((value) => JSON.stringify(value)));
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const declared = schema.type;
  if (Array.isArray(declared)) {
    if (declared.length === 0) throw new Error(`${where}.type is empty, which the bindings generator does not model`);
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
    assertNoStructuralRefSiblings(definition, `$defs.${name}`);
    assertLiteralSiblings(definition, `$defs.${name}`);
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

const VALUE_FLAGS = new Set(['--schema', '--out']);

/**
 * Parse the whole command line before reading or writing anything. An option
 * this script does not implement must be an error, not a silent fallback to
 * the checked-in paths: `--check=true`, `-s path` and a stray positional have
 * all been ways to run the wrong mode by accident.
 */
function parseArguments(argv) {
  const values = new Map();
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      if (check) throw new Error("duplicate option '--check'");
      check = true;
      continue;
    }
    if (argument.startsWith('-')) {
      const separator = argument.indexOf('=');
      const flag = separator === -1 ? argument : argument.slice(0, separator);
      if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown option '${argument}'`);
      let value;
      if (separator === -1) {
        value = argv[index + 1];
        if (value === undefined || value.startsWith('-')) throw new Error(`${flag} requires a path`);
        index += 1;
      } else {
        value = argument.slice(separator + 1);
        if (value.length === 0) throw new Error(`${flag} requires a path`);
      }
      if (values.has(flag)) throw new Error(`duplicate option '${flag}'`);
      values.set(flag, value);
      continue;
    }
    throw new Error(`unexpected argument '${argument}'`);
  }
  return { check, schema: values.get('--schema'), out: values.get('--out') };
}

const options = parseArguments(process.argv.slice(2));
const schemaPath = path.resolve(options.schema ?? SCHEMA_PATH);
const outputPath = path.resolve(options.out ?? OUTPUT_PATH);
const schemaReference = schemaPath === SCHEMA_PATH
  ? SCHEMA_REFERENCE
  : path.relative(PACKAGE_ROOT, schemaPath);
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
const rendered = render(schema, schemaReference);
const check = options.check;

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
