/* global process */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/u;
const NON_RUNTIME_SOURCE = /(?:^|\.)(?:test|spec|bench)\.[cm]?[jt]sx?$/u;

export function checkWorkspaceDependencies(root) {
  const packages = discoverPackages(root);
  const internalNames = new Set([...packages.keys()].filter((name) => name.startsWith('@unified-mpc/')));
  const violations = [];

  for (const [packageName, workspacePackage] of packages) {
    const declared = {
      ...(workspacePackage.manifest.dependencies ?? {}),
      ...(workspacePackage.manifest.optionalDependencies ?? {}),
      ...(workspacePackage.manifest.peerDependencies ?? {}),
    };
    for (const sourcePath of runtimeSourceFiles(path.join(workspacePackage.root, 'src'))) {
      const source = fs.readFileSync(sourcePath, 'utf8');
      for (const importedPackage of runtimeInternalImports(sourcePath, source)) {
        if (!internalNames.has(importedPackage) || declared[importedPackage] !== undefined) continue;
        violations.push({
          packageName,
          importedPackage,
          sourcePath: path.relative(root, sourcePath),
        });
      }
    }
  }

  return violations.sort((left, right) =>
    left.packageName.localeCompare(right.packageName)
      || left.importedPackage.localeCompare(right.importedPackage)
      || left.sourcePath.localeCompare(right.sourcePath));
}

function discoverPackages(root) {
  const result = new Map();
  for (const group of ['apps', 'packages']) {
    const groupRoot = path.join(root, group);
    if (!fs.existsSync(groupRoot)) continue;
    for (const entry of fs.readdirSync(groupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageRoot = path.join(groupRoot, entry.name);
      const manifestPath = path.join(packageRoot, 'package.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name !== 'string' || manifest.name.length === 0) continue;
      result.set(manifest.name, { root: packageRoot, manifest });
    }
  }
  return result;
}

function runtimeSourceFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'dist' && entry.name !== 'node_modules') visit(candidate);
        continue;
      }
      if (!SOURCE_EXTENSIONS.test(entry.name) || NON_RUNTIME_SOURCE.test(entry.name)) continue;
      files.push(candidate);
    }
  };
  visit(root);
  return files;
}

function runtimeInternalImports(fileName, sourceText) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const imports = new Set();
  const add = (specifier) => {
    if (!specifier.startsWith('@unified-mpc/')) return;
    const segments = specifier.split('/');
    if (segments.length >= 2) imports.add(`${segments[0]}/${segments[1]}`);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly !== true && ts.isStringLiteralLike(node.moduleSpecifier)) add(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly !== true && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const commonJsRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (dynamicImport || commonJsRequire) add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(argumentValue('--root') ?? process.cwd());
  const violations = checkWorkspaceDependencies(root);
  if (violations.length === 0) {
    process.stdout.write('Workspace runtime dependency audit passed.\n');
  } else {
    process.stderr.write('Undeclared internal runtime dependencies detected:\n');
    for (const violation of violations) {
      process.stderr.write(
        `- ${violation.packageName} imports ${violation.importedPackage} from ${violation.sourcePath} without declaring it in dependencies/optionalDependencies/peerDependencies\n`,
      );
    }
    process.exitCode = 1;
  }
}
