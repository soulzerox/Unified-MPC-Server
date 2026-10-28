#!/usr/bin/env node
/* global process */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generate the non-destructive workspace typecheck configuration.
 *
 * The root gate must never emit into a package `outDir`: `apps/cli/dist` is the
 * live runtime and `dist/build-provenance.json` is only written by `build`.
 * Compiling the source tree over `dist` would silently relabel the deployment
 * (see issue #456). Each project therefore gets a `tsconfig.typecheck.json`
 * that redirects the emit into `<root>/.typecheck/<project>` and emits
 * declarations only, which is all a dependent project needs to resolve types.
 */

const ROOT_SOLUTION_NAME = 'tsconfig.typecheck.json';
const PROJECT_CONFIG_NAME = 'tsconfig.typecheck.json';
const OUTPUT_DIRECTORY = '.typecheck';

export function typecheckConfigPlan(root) {
  const absoluteRoot = path.resolve(root);
  const solutionPath = path.join(absoluteRoot, ROOT_SOLUTION_NAME);
  const projects = projectConfigs(absoluteRoot);
  const plan = projects.map((project) => {
    const outputDirectory = toPosix(path.relative(project.directory, path.join(absoluteRoot, OUTPUT_DIRECTORY, project.key)));
    const config = {
      extends: './tsconfig.json',
      compilerOptions: {
        composite: true,
        emitDeclarationOnly: true,
        outDir: outputDirectory,
        tsBuildInfoFile: `${outputDirectory}/tsconfig.tsbuildinfo`,
      },
      ...(project.references.length === 0
        ? {}
        : { references: project.references.map((reference) => ({ path: referenceConfigPath(project, reference) })) }),
    };
    return {
      path: path.join(project.directory, PROJECT_CONFIG_NAME),
      content: `${JSON.stringify(config, null, 2)}\n`,
    };
  });
  const solution = {
    files: [],
    references: projects.map((project) => ({ path: `./${project.key}/${PROJECT_CONFIG_NAME}` })),
  };
  plan.push({ path: solutionPath, content: `${JSON.stringify(solution, null, 2)}\n` });
  return plan.sort((left, right) => left.path.localeCompare(right.path));
}

export function writeTypecheckConfigs(root) {
  const written = [];
  for (const entry of typecheckConfigPlan(root)) {
    const existing = readIfPresent(entry.path);
    if (existing === entry.content) continue;
    fs.mkdirSync(path.dirname(entry.path), { recursive: true });
    fs.writeFileSync(entry.path, entry.content, 'utf8');
    written.push(entry.path);
  }
  return written;
}

export function staleTypecheckConfigs(root) {
  return typecheckConfigPlan(root)
    .filter((entry) => readIfPresent(entry.path) !== entry.content)
    .map((entry) => entry.path);
}

function projectConfigs(absoluteRoot) {
  const solution = readJson(path.join(absoluteRoot, 'tsconfig.json'));
  const references = Array.isArray(solution.references) ? solution.references : [];
  const projects = [];
  for (const reference of references) {
    if (reference === null || typeof reference !== 'object' || typeof reference.path !== 'string') {
      throw new Error(`Unsupported project reference in ${path.join(absoluteRoot, 'tsconfig.json')}`);
    }
    const configPath = reference.path.endsWith('.json')
      ? path.resolve(absoluteRoot, reference.path)
      : path.resolve(absoluteRoot, reference.path, 'tsconfig.json');
    const directory = path.dirname(configPath);
    const key = toPosix(path.relative(absoluteRoot, directory));
    const projectConfig = readJson(configPath);
    projects.push({
      key,
      directory,
      references: referencedDirectories(directory, projectConfig.references),
    });
  }
  return projects;
}

function referencedDirectories(directory, references) {
  if (!Array.isArray(references)) return [];
  return references.map((reference) => {
    if (reference === null || typeof reference !== 'object' || typeof reference.path !== 'string') {
      throw new Error(`Unsupported project reference in ${directory}`);
    }
    return reference.path.endsWith('.json')
      ? path.resolve(directory, reference.path)
      : path.resolve(directory, reference.path, 'tsconfig.json');
  });
}

function referenceConfigPath(project, referencedConfigPath) {
  if (path.basename(referencedConfigPath) !== 'tsconfig.json') {
    throw new Error(
      `Unsupported project reference ${referencedConfigPath} from ${project.key}: `
      + 'only directory references or tsconfig.json files can be redirected to a typecheck config',
    );
  }
  const target = path.join(path.dirname(referencedConfigPath), PROJECT_CONFIG_NAME);
  const relative = toPosix(path.relative(project.directory, target));
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function toPosix(file) {
  return file.split(path.sep).join('/');
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(argumentValue('--root') ?? process.cwd());
  if (process.argv.includes('--check')) {
    const stale = staleTypecheckConfigs(root);
    if (stale.length === 0) {
      process.stdout.write('Typecheck configuration is up to date.\n');
    } else {
      process.stderr.write('Stale typecheck configuration detected. Run `node scripts/generate-typecheck-configs.mjs`:\n');
      for (const file of stale) process.stderr.write(`- ${path.relative(root, file)}\n`);
      process.exitCode = 1;
    }
  } else {
    const written = writeTypecheckConfigs(root);
    if (written.length === 0) {
      process.stdout.write('Typecheck configuration is up to date.\n');
    } else {
      for (const file of written) process.stdout.write(`Wrote ${path.relative(root, file)}\n`);
    }
  }
}
