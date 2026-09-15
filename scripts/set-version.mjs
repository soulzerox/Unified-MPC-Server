import console from 'node:console';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetVersion = process.argv[2];

async function updatePackageJson(filePath, newVersion) {
  const content = await readFile(filePath, 'utf8');
  const pkg = JSON.parse(content);
  pkg.version = newVersion;
  await writeFile(filePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`Updated ${path.relative(rootDir, filePath)} -> ${newVersion}`);
}

async function syncAllVersions() {
  const rootPkgPath = path.join(rootDir, 'package.json');
  const rootPkg = JSON.parse(await readFile(rootPkgPath, 'utf8'));
  const version = targetVersion || rootPkg.version;
  const name = rootPkg.name || 'unified-mpc';

  console.log(`Synchronizing single source of truth for name "${name}" and version "${version}"...`);

  // 1. Root package.json
  await updatePackageJson(rootPkgPath, version);

  // 2. Apps package.json
  const appsDir = path.join(rootDir, 'apps');
  const appEntries = await readdir(appsDir, { withFileTypes: true });
  for (const entry of appEntries) {
    if (entry.isDirectory()) {
      const pkgPath = path.join(appsDir, entry.name, 'package.json');
      try {
        await updatePackageJson(pkgPath, version);
      } catch {
        // skip if no package.json
      }
    }
  }

  // 3. Packages package.json
  const packagesDir = path.join(rootDir, 'packages');
  const packageEntries = await readdir(packagesDir, { withFileTypes: true });
  for (const entry of packageEntries) {
    if (entry.isDirectory()) {
      const pkgPath = path.join(packagesDir, entry.name, 'package.json');
      try {
        await updatePackageJson(pkgPath, version);
      } catch {
        // skip if no package.json
      }
    }
  }

  // 4. Update packages/ipc-contracts/src/index.ts
  const ipcContractsPath = path.join(rootDir, 'packages', 'ipc-contracts', 'src', 'index.ts');
  let ipcContractsContent = await readFile(ipcContractsPath, 'utf8');
  ipcContractsContent = ipcContractsContent
    .replace(/export const APP_NAME = ['"][^'"]+['"];/, `export const APP_NAME = '${name}';`)
    .replace(/export const APP_VERSION = ['"][^'"]+['"];/, `export const APP_VERSION = '${version}';`);
  await writeFile(ipcContractsPath, ipcContractsContent, 'utf8');
  console.log(`Updated packages/ipc-contracts/src/index.ts -> ${name} v${version}`);

  // 5. Update packages/shared/src/index.ts
  const sharedPath = path.join(rootDir, 'packages', 'shared', 'src', 'index.ts');
  let sharedContent = await readFile(sharedPath, 'utf8');
  sharedContent = sharedContent
    .replace(/export const APP_NAME = ['"][^'"]+['"];/, `export const APP_NAME = '${name}';`)
    .replace(/export const APP_VERSION = ['"][^'"]+['"];/, `export const APP_VERSION = '${version}';`);
  await writeFile(sharedPath, sharedContent, 'utf8');
  console.log(`Updated packages/shared/src/index.ts -> ${name} v${version}`);

  // 6. Update tests/packaging/desktop-packaging.test.ts
  const testPackagingPath = path.join(rootDir, 'tests', 'packaging', 'desktop-packaging.test.ts');
  try {
    let testContent = await readFile(testPackagingPath, 'utf8');
    testContent = testContent
      .replace(/pins the product release to v[0-9.]+/g, `pins the product release to v${version}`)
      .replace(/expect\(rootPackage\.version\)\.toBe\(['"][^'"]+['"]\);/g, `expect(rootPackage.version).toBe('${version}');`)
      .replace(/expect\(desktopPackage\.version\)\.toBe\(['"][^'"]+['"]\);/g, `expect(desktopPackage.version).toBe('${version}');`)
      .replace(/expect\(packageJson\.version, packagePath\)\.toBe\(['"][^'"]+['"]\);/g, `expect(packageJson.version, packagePath).toBe('${version}');`)
      .replace(/expect\(ipcContracts\)\.toContain\(["']APP_VERSION = ['"][^'"]+['"]["']\);/g, `expect(ipcContracts).toContain("APP_VERSION = '${version}'");`)
      .replace(/expect\(shared\)\.toContain\(["']APP_VERSION = ['"][^'"]+['"]["']\);/g, `expect(shared).toContain("APP_VERSION = '${version}'");`);
    await writeFile(testPackagingPath, testContent, 'utf8');
    console.log(`Updated tests/packaging/desktop-packaging.test.ts -> v${version}`);
  } catch {
    // skip if missing
  }

  // 7. Update Desktop UI version assertion.
  const mutationSafetyUiTestPath = path.join(rootDir, 'apps', 'desktop', 'tests', 'mutation-safety-ui.test.ts');
  try {
    let testContent = await readFile(mutationSafetyUiTestPath, 'utf8');
    testContent = testContent
      .replace(/renders the actual [0-9.]+ application version/g, `renders the actual ${version} application version`)
      .replace(/expect\(APP_VERSION\)\.toBe\(['"][^'"]+['"]\);/g, `expect(APP_VERSION).toBe('${version}');`)
      .replace(/expect\(markup\)\.toContain\(['"]v[0-9.]+['"]\);/g, `expect(markup).toContain('v${version}');`);
    await writeFile(mutationSafetyUiTestPath, testContent, 'utf8');
    console.log(`Updated apps/desktop/tests/mutation-safety-ui.test.ts -> v${version}`);
  } catch {
    // skip if missing
  }

  // 8. Update concise README current-version references without rewriting release history.
  const readmePaths = [path.join(rootDir, 'README.md')];
  for (const readmePath of readmePaths) {
    try {
      let readmeContent = await readFile(readmePath, 'utf8');
      readmeContent = readmeContent
      .replace(/## Current (?:version|source \/ release candidate|release): v[0-9.]+/g, `## Current version: v${version}`)
      .replace(/apps\/desktop\/dist\/installers\/unified-mpc-Setup-[0-9.]+\.exe/g, 'apps/desktop/dist/installers/unified-mpc-Setup-' + version + '.exe')
      .replace(/apps\/desktop\/dist\/installers\/unified-mpc-Portable-[0-9.]+\.exe/g, 'apps/desktop/dist/installers/unified-mpc-Portable-' + version + '.exe')
      .replace(/current v[0-9.]+ `ToolRegistry`/g, 'current v' + version + ' `ToolRegistry`')
      .replace(/## v[0-9.]+ release status/g, `## v${version} release status`)
      .replace(/Release `v[0-9.]+`/g, `Release \`v${version}\``);
      await writeFile(readmePath, readmeContent, 'utf8');
      console.log(`Updated ${path.basename(readmePath)} -> v${version}`);
    } catch {
      // skip if missing
    }
  }

  // 9. Update current-version Markdown references without rewriting release history.
  const markdownTargets = [
    ['.github/RELEASE_CHECKLIST.md', (content) => content
      .replace(/\*\*Current (?:version|release candidate):\*\* `v[0-9.]+`/g, `**Current version:** ` + '`v' + version + '`')
      .replace(/(portable executable `unified-mpc-Portable-)[0-9.]+(\.exe`)/g, (_match, prefix, suffix) => prefix + version + suffix)],
    ['docs/USAGE_TH.md', (content) => content
      .replace(/unified-mpc v[0-9.]+/g, `unified-mpc v${version}`)
      .replace(/unified-mpc-Setup-[0-9.]+\.exe/g, `unified-mpc-Setup-${version}.exe`)
      .replace(/unified-mpc-Portable-[0-9.]+\.exe/g, `unified-mpc-Portable-${version}.exe`)],
    ['docs/development/PACKAGING_WINDOWS.md', (content) => content
      .replace(/For v[0-9.]+:/g, `For v${version}:`)
      .replace(/current v[0-9.]+ packaging contract/g, `current v${version} packaging contract`)
      .replace(/unified-mpc-Setup-[0-9.]+\.exe/g, `unified-mpc-Setup-${version}.exe`)
      .replace(/unified-mpc-Portable-[0-9.]+\.exe/g, `unified-mpc-Portable-${version}.exe`)],
    ['docs/UNIFIED_MPC_CAPABILITIES.md', (content) => content.replace(/unified-mpc v[0-9.]+/g, `unified-mpc v${version}`).replace(/ความสามารถหลักใน v[0-9.]+ คือ:/g, `ความสามารถหลักใน v${version} คือ:`)],
    ['docs/architecture/MULTI_WORKSPACE_CONCURRENCY.md', (content) => content.replace(/current v[0-9.]+ runtime contract/g, `current v${version} runtime contract`)],
    ['docs/architecture/TOOL_CONTRACT.md', (content) => content.replace(/snapshot synchronized for `v[0-9.]+`/g, `snapshot synchronized for ` + '`v' + version + '`')],
    ['docs/architecture/UPGRADE_ARCHITECTURE.md', (content) => content.replace(/checkpoint synchronized for `v[0-9.]+`/g, `checkpoint synchronized for ` + '`v' + version + '`')],
  ];
  for (const [relativePath, update] of markdownTargets) {
    const targetPath = path.join(rootDir, relativePath);
    try {
      const content = await readFile(targetPath, 'utf8');
      await writeFile(targetPath, update(content), 'utf8');
      console.log(`Updated ${relativePath} -> v${version}`);
    } catch {
      // optional/local documentation may be absent in a public checkout
    }
  }

  // 10. Update current runtime/user-facing version strings without touching dated plans/evidence.
  const sourceTargets = [
    ['packages/application/src/agent-swarm-service.ts', (content) => content.replace(/Agent swarm v[0-9.]+ supports read_only access only/g, `Agent swarm v${version} supports read_only access only`)],
    ['packages/mcp-server/src/tool-registry.ts', (content) => content.replace(/v[0-9.]+ enforces read-only child sandboxes/g, `v${version} enforces read-only child sandboxes`)],
  ];
  for (const [relativePath, update] of sourceTargets) {
    const targetPath = path.join(rootDir, relativePath);
    const content = await readFile(targetPath, 'utf8');
    await writeFile(targetPath, update(content), 'utf8');
    console.log(`Updated ${relativePath} -> v${version}`);
  }

  console.log(`\nAll versions successfully synchronized to ${name} v${version}!`);
}

void syncAllVersions();
