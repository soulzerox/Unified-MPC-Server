import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { CanonicalSourceIdentity } from '@unified-mpc/workspace';
import ts from 'typescript';

/**
 * Slice 1 of the Code Intelligence subsystem (#131).
 *
 * Extraction only: one admitted tree, the identity Unified already resolved
 * (`resolveCanonicalSourceIdentity`), and one deterministic record per file. No
 * graph queries, no storage, no capability lane — see
 * `docs/superpowers/specs/2026-11-28-code-intelligence-slice-1-design.md`.
 *
 * Three properties carry the slice:
 *
 * - a record carries the identity it was extracted under, so a Goal overlay's
 *   file can never be served as the base ref's file;
 * - a file that fails to parse is a record with `parseError`, never a dropped
 *   file, because "no symbols" and "not read" must stay distinguishable;
 * - the same tree and identity produce byte-identical output, so downstream
 *   fingerprints mean something.
 */

export type StructuralLanguage = 'typescript' | 'javascript';

export type StructuralSymbolKind =
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'variable';

export interface StructuralSymbol {
  readonly name: string;
  readonly kind: StructuralSymbolKind;
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  /** Dotted owner chain, e.g. `Outer.inner`. Empty for top level. */
  readonly container: string;
  readonly exported: boolean;
}

export interface StructuralImport {
  /** The specifier as written, un-resolved. */
  readonly specifier: string;
  readonly kind: 'static' | 'dynamic' | 'require' | 're-export';
  readonly startLine: number;
}

export interface SourceStructuralRecord {
  /** Repo-relative, `/`-separated. Never absolute. */
  readonly path: string;
  readonly identity: CanonicalSourceIdentity;
  /** `sha256:<hex>` of the file contents that produced this record. */
  readonly fingerprint: string;
  readonly language: StructuralLanguage;
  readonly symbols: readonly StructuralSymbol[];
  readonly imports: readonly StructuralImport[];
  /** Present only when the file could not be parsed; the record still exists. */
  readonly parseError?: string;
}

export interface ExtractStructuralOptions {
  readonly repositoryRoot: string;
  readonly identity: CanonicalSourceIdentity;
  /** Repo-relative paths; an absolute path or one escaping the root is refused. */
  readonly files: readonly string[];
}

const SCRIPT_KINDS: Readonly<Record<string, { readonly language: StructuralLanguage; readonly kind: ts.ScriptKind }>> = {
  '.ts': { language: 'typescript', kind: ts.ScriptKind.TS },
  '.mts': { language: 'typescript', kind: ts.ScriptKind.TS },
  '.cts': { language: 'typescript', kind: ts.ScriptKind.TS },
  '.tsx': { language: 'typescript', kind: ts.ScriptKind.TSX },
  '.js': { language: 'javascript', kind: ts.ScriptKind.JS },
  '.mjs': { language: 'javascript', kind: ts.ScriptKind.JS },
  '.cjs': { language: 'javascript', kind: ts.ScriptKind.JS },
  '.jsx': { language: 'javascript', kind: ts.ScriptKind.JSX },
};

function refuse(file: string, reason: string): Result<never> {
  return err(appError('INVALID_INPUT', `structural extraction refused ${file}: ${reason}`));
}

/** `a/b`, never `a\b` and never an absolute path. */
function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/').replace(/^\.\//, '');
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function languageFor(file: string): { readonly language: StructuralLanguage; readonly kind: ts.ScriptKind } | undefined {
  return SCRIPT_KINDS[path.extname(file).toLowerCase()];
}

function lineOf(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function declaredName(node: ts.NamedDeclaration): string {
  const name = node.name;
  if (name === undefined) return '';
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText();
}

/** Named ancestors from the file inwards, e.g. `Outer.inner`. */
function containerOf(node: ts.Node, source: ts.SourceFile): string {
  const names: string[] = [];
  for (let current = node.parent; current !== undefined && current !== source; current = current.parent) {
    if (
      ts.isClassDeclaration(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isEnumDeclaration(current) ||
      ts.isModuleDeclaration(current)
    ) {
      const name = declaredName(current);
      if (name.length > 0) names.push(name);
    } else if (ts.isFunctionDeclaration(current)) {
      const name = declaredName(current);
      if (name.length > 0) names.push(name);
    }
  }
  return names.reverse().join('.');
}

function symbolFor(
  node: ts.Node,
  kind: StructuralSymbolKind,
  name: string,
  source: ts.SourceFile,
  exported: boolean,
): StructuralSymbol {
  return {
    name,
    kind,
    startLine: lineOf(source, node.getStart(source)),
    endLine: lineOf(source, node.getEnd()),
    container: containerOf(node, source),
    exported,
  };
}

function collectSymbols(source: ts.SourceFile): readonly StructuralSymbol[] {
  const symbols: StructuralSymbol[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      symbols.push(symbolFor(node, 'class', declaredName(node), source, hasExportModifier(node)));
    } else if (ts.isFunctionDeclaration(node)) {
      symbols.push(symbolFor(node, 'function', declaredName(node), source, hasExportModifier(node)));
    } else if (ts.isInterfaceDeclaration(node)) {
      symbols.push(symbolFor(node, 'interface', declaredName(node), source, hasExportModifier(node)));
    } else if (ts.isTypeAliasDeclaration(node)) {
      symbols.push(symbolFor(node, 'type', declaredName(node), source, hasExportModifier(node)));
    } else if (ts.isEnumDeclaration(node)) {
      symbols.push(symbolFor(node, 'enum', declaredName(node), source, hasExportModifier(node)));
    } else if (ts.isMethodDeclaration(node)) {
      // A method's export is its class's export, not a modifier of its own.
      const owner = node.parent;
      const exported = ts.isClassDeclaration(owner) ? hasExportModifier(owner) : false;
      symbols.push(symbolFor(node, 'method', declaredName(node), source, exported));
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node);
      const kind: StructuralSymbolKind = (node.declarationList.flags & ts.NodeFlags.Const) !== 0 ? 'const' : 'variable';
      for (const declaration of node.declarationList.declarations) {
        symbols.push(symbolFor(declaration, kind, declaredName(declaration), source, exported));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return symbols.sort(
    (left, right) =>
      left.startLine - right.startLine ||
      left.container.localeCompare(right.container) ||
      left.name.localeCompare(right.name),
  );
}

function specifierOf(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function collectImports(source: ts.SourceFile): readonly StructuralImport[] {
  const imports: StructuralImport[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = specifierOf(node.moduleSpecifier);
      if (specifier !== undefined) {
        imports.push({ specifier, kind: 'static', startLine: lineOf(source, node.getStart(source)) });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const specifier = specifierOf(node.moduleSpecifier);
      if (specifier !== undefined) {
        imports.push({ specifier, kind: 're-export', startLine: lineOf(source, node.getStart(source)) });
      }
    } else if (ts.isCallExpression(node)) {
      const specifier = specifierOf(node.arguments[0]);
      const line = lineOf(source, node.getStart(source));
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (specifier !== undefined) imports.push({ specifier, kind: 'dynamic', startLine: line });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && specifier !== undefined) {
        imports.push({ specifier, kind: 'require', startLine: line });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports.sort((left, right) => left.startLine - right.startLine || left.specifier.localeCompare(right.specifier));
}

function parseErrorOf(source: ts.SourceFile): string | undefined {
  // `parseDiagnostics` is the parser's own list; the public `SourceFile` type
  // does not expose it, and building a Program just to read it would need a
  // whole compiler host for one file.
  const diagnostics = (source as unknown as { readonly parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length === 0) return undefined;
  return diagnostics
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      return diagnostic.start === undefined ? message : `line ${lineOf(source, diagnostic.start)}: ${message}`;
    })
    .join('; ');
}

/** One record for one admitted file; the caller owns the read and the refusal. */
export function extractStructuralRecord(
  options: { readonly path: string; readonly identity: CanonicalSourceIdentity; readonly contents: string },
): Result<SourceStructuralRecord> {
  const known = languageFor(options.path);
  if (known === undefined) {
    return err(appError('INVALID_INPUT', `structural extraction refused ${options.path}: unsupported language`));
  }
  const source = ts.createSourceFile(options.path, options.contents, ts.ScriptTarget.Latest, true, known.kind);
  const parseError = parseErrorOf(source);
  return ok({
    path: toPosix(options.path),
    identity: options.identity,
    fingerprint: `sha256:${createHash('sha256').update(options.contents, 'utf8').digest('hex')}`,
    language: known.language,
    symbols: collectSymbols(source),
    imports: collectImports(source),
    ...(parseError === undefined ? {} : { parseError }),
  });
}

/**
 * Reads every admitted file once and returns one record each, sorted by path.
 *
 * Containment is enforced, not assumed: a path that resolves outside the root —
 * including through a symlink — or that is not a regular file is refused, and the
 * whole extraction fails rather than returning a partial set the caller did not
 * ask for.
 */
export async function extractStructuralRecords(
  options: ExtractStructuralOptions,
): Promise<Result<readonly SourceStructuralRecord[]>> {
  const realRoot = await realpath(options.repositoryRoot).catch(() => undefined);
  if (realRoot === undefined) {
    return err(appError('INVALID_INPUT', `structural extraction refused the root: ${options.repositoryRoot} is not readable`));
  }

  const records: SourceStructuralRecord[] = [];
  for (const file of [...options.files].sort((left, right) => left.localeCompare(right))) {
    const requested = path.resolve(realRoot, file);
    if (!isInside(realRoot, requested)) return refuse(file, 'the path is outside the admitted repository root');

    const realFile = await realpath(requested).catch(() => undefined);
    if (realFile === undefined) return refuse(file, 'the path does not exist');
    if (!isInside(realRoot, realFile)) return refuse(file, 'the path resolves outside the admitted repository root');
    // `realpath` resolves `..` that a symlink introduced, so the check above must
    // run again on the resolved path — a link inside the tree can still point out.
    const stats = await stat(realFile).catch(() => undefined);
    if (stats === undefined) return refuse(file, 'the path is not readable');
    if (!stats.isFile()) return refuse(file, 'the path is not a regular file');

    const contents = await readFile(realFile, 'utf8').catch(() => undefined);
    if (contents === undefined) return refuse(file, 'the path is not readable as UTF-8');

    const record = extractStructuralRecord({ path: toPosix(path.relative(realRoot, realFile)), identity: options.identity, contents });
    if (!record.ok) return record;
    records.push(record.value);
  }
  return ok(records);
}
