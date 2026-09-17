import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = ['apps', 'packages'];
const sourceExtensions = new Set(['.cjs', '.json', '.jsonc', '.js', '.mjs', '.ts', '.tsx']);
const forbiddenTokens = [
  ['record', '_', 'turn'].join(''),
  ['turn', '-', 'persistence'].join(''),
  ['turn', '-', 'transcript', '-', 'spool'].join(''),
  ['trusted', '-', 'memory', '-', 'rag', '-', 'adapter'].join(''),
];
const removedSourcePaths = [
  ['packages', 'mcp-server', 'src', ['turn', '-', 'persistence'].join('') + '.ts'],
  ['packages', 'mcp-server', 'src', ['turn', '-', 'transcript', '-', 'spool'].join('') + '.ts'],
  ['packages', 'mcp-server', 'src', ['trusted', '-', 'memory', '-', 'rag', '-', 'adapter'].join('') + '.ts'],
].map((segments) => path.join(repoRoot, ...segments));

const sourceFiles = [];
const collectSourceFiles = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'coverage') continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(entryPath);
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      sourceFiles.push(entryPath);
    }
  }
};

for (const sourceRoot of sourceRoots) collectSourceFiles(path.join(repoRoot, sourceRoot));

const staleReferences = [];
for (const sourceFile of sourceFiles) {
  const source = readFileSync(sourceFile, 'utf8');
  for (const token of forbiddenTokens) {
    if (source.includes(token)) staleReferences.push(`${path.relative(repoRoot, sourceFile)} contains ${token}`);
  }
}
for (const removedSourcePath of removedSourcePaths) {
  if (existsSync(removedSourcePath)) staleReferences.push(`${path.relative(repoRoot, removedSourcePath)} still exists`);
}

if (staleReferences.length > 0) {
  throw new Error(`Native RAG migration guard failed:\n${staleReferences.join('\n')}`);
}

const mcpPackageRoot = path.join(repoRoot, 'packages', 'mcp-server');
const workspacePackages = new Map();
for (const entry of readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageRoot = path.join(repoRoot, 'packages', entry.name);
  const packageJsonPath = path.join(packageRoot, 'package.json');
  if (!existsSync(packageJsonPath)) continue;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  workspacePackages.set(packageJson.name, { root: packageRoot, dependencies: packageJson.dependencies ?? {} });
}

const dependencyNames = new Set();
const visitPackage = (packageName) => {
  if (dependencyNames.has(packageName)) return;
  const packageInfo = workspacePackages.get(packageName);
  if (packageInfo === undefined) return;
  dependencyNames.add(packageName);
  for (const dependencyName of Object.keys(packageInfo.dependencies)) visitPackage(dependencyName);
};
visitPackage('@unified-mpc/mcp-server');

for (const packageName of dependencyNames) {
  const packageRoot = workspacePackages.get(packageName)?.root;
  if (packageRoot === undefined) continue;
  rmSync(path.join(packageRoot, 'dist'), { recursive: true, force: true });
  rmSync(path.join(packageRoot, 'tsconfig.tsbuildinfo'), { force: true });
}

const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const build = spawnSync(corepack, ['pnpm@10.15.0', '--filter', '@unified-mpc/mcp-server...', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (build.error !== undefined) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
if (!existsSync(path.join(mcpPackageRoot, 'dist', 'index.js'))) {
  throw new Error('Native RAG migration clean build did not emit packages/mcp-server/dist/index.js');
}

process.stdout.write('Native RAG migration source and clean-build guards passed.\n');
