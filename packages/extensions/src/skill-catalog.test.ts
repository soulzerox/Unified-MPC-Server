import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXTENSIONS_SETTINGS } from './types.js';
import { SkillCatalog, parseSkillMarkdown, skillQueryIsRanked } from './skill-catalog.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Run `body` with environment overrides applied, restoring them afterwards. A `undefined` value unsets the key. */
async function withEnv<T>(overrides: Readonly<Record<string, string | undefined>>, body: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('SkillCatalog', () => {
  it('parses folded frontmatter descriptions', () => {
    const parsed = parseSkillMarkdown(`---
name: demo
description: >-
  First line
  Second line
---
# Body
`, 'fallback');
    expect(parsed).toEqual({ name: 'demo', description: 'First line Second line' });
  });

  it('lists and reads skills under configured roots', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-skills-'));
    temporaryRoots.push(home);
    const skillRoot = path.join(home, '.cursor', 'skills-cursor', 'demo-skill');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, 'SKILL.md'), `---
name: demo-skill
description: Demo skill for tests
---
# Demo
Do the thing.
`, 'utf8');
    await writeFile(path.join(skillRoot, 'notes.md'), 'extra notes\n', 'utf8');

    const catalog = new SkillCatalog({ homeDir: home, settings: DEFAULT_EXTENSIONS_SETTINGS });
    const listed = await catalog.list({ query: 'demo' });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.skills).toEqual([
      expect.objectContaining({
        id: 'cursor-skills-cursor/demo-skill',
        name: 'demo-skill',
        source: 'cursor-skills-cursor',
        trustTier: 'user',
        canonicalSkillPath: expect.any(String),
      }),
    ]);

    const read = await catalog.read({ skillId: 'cursor-skills-cursor/demo-skill' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.content).toContain('Do the thing.');
    expect(read.value.trustTier).toBe('user');
    expect(read.value.canonicalPath).toEqual(expect.any(String));

    const relative = await catalog.read({ skillId: 'cursor-skills-cursor/demo-skill', relativePath: 'notes.md' });
    expect(relative.ok).toBe(true);
    if (!relative.ok) return;
    expect(relative.value.content).toContain('extra notes');

    const escape = await catalog.read({ skillId: 'cursor-skills-cursor/demo-skill', relativePath: '../outside.md' });
    expect(escape.ok).toBe(false);
  });

  it('supports an exclusive parent-owned managed root that hides legacy global and workspace roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-exclusive-managed-root-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const managedRoot = path.join(root, 'canonical', 'skills');
    const roots = [
      [path.join(home, '.agents', 'skills', 'legacy-global'), 'legacy-global'],
      [path.join(workspace, '.agents', 'skills', 'legacy-workspace'), 'legacy-workspace'],
      [path.join(managedRoot, 'canonical-only'), 'canonical-only'],
    ] as const;
    for (const [skillRoot, name] of roots) {
      await mkdir(skillRoot, { recursive: true });
      await writeFile(
        path.join(skillRoot, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`,
        'utf8',
      );
    }

    const catalog = new SkillCatalog({
      homeDir: home,
      workspaceRoot: workspace,
      settings: DEFAULT_EXTENSIONS_SETTINGS,
      managedRoot,
      managedRootMode: 'exclusive',
    });
    const listed = await catalog.list({});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.skills).toEqual([
      expect.objectContaining({
        id: 'unified-mpc-skills/canonical-only',
        name: 'canonical-only',
        source: 'unified-mpc-skills',
      }),
    ]);
  });

  it('keeps exact bundled first-party ids readable under exclusive managed authority without restoring legacy peers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-exclusive-bundled-overlay-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const managedRoot = path.join(root, 'canonical', 'skills');
    const bundledRoot = path.join(root, 'bundled');
    const managedSkillRoot = path.join(managedRoot, 'ponytail');
    const bundledSkillRoot = path.join(bundledRoot, 'ponytail');
    const workspaceSkillRoot = path.join(workspace, '.agents', 'skills', 'ponytail');

    for (const [skillRoot, description, marker] of [
      [managedSkillRoot, 'Managed Ponytail', 'MANAGED_PONYTAIL'],
      [bundledSkillRoot, 'Bundled Ponytail', 'BUNDLED_PONYTAIL'],
      [workspaceSkillRoot, 'Workspace collision', 'WORKSPACE_FAKE'],
    ] as const) {
      await mkdir(skillRoot, { recursive: true });
      await writeFile(
        path.join(skillRoot, 'SKILL.md'),
        `---\nname: ponytail\ndescription: ${description}\n---\n${marker}\n`,
        'utf8',
      );
    }

    const catalog = new SkillCatalog({
      homeDir: home,
      workspaceRoot: workspace,
      settings: DEFAULT_EXTENSIONS_SETTINGS,
      bundledRoots: [bundledRoot],
      managedRoot,
      managedRootMode: 'exclusive',
    });

    const listed = await catalog.list({ query: 'ponytail' });
    expect(listed).toMatchObject({
      ok: true,
      value: {
        skills: [expect.objectContaining({
          id: 'unified-mpc-skills/ponytail',
          source: 'unified-mpc-skills',
        })],
      },
    });

    const managed = await catalog.read({ skillId: 'ponytail' });
    expect(managed).toMatchObject({
      ok: true,
      value: { id: 'unified-mpc-skills/ponytail', source: 'unified-mpc-skills' },
    });
    if (managed.ok) expect(managed.value.content).toContain('MANAGED_PONYTAIL');

    const bundled = await catalog.read({ skillId: 'bundled:agent-skills/ponytail' });
    expect(bundled).toMatchObject({
      ok: true,
      value: {
        id: 'bundled:agent-skills/ponytail',
        source: 'bundled:agent-skills',
        trustTier: 'bundled',
      },
    });
    if (bundled.ok) expect(bundled.value.content).toContain('BUNDLED_PONYTAIL');
  });

  it('discovers and reads workspace .agents skills by source-qualified id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-workspace-skills-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const skillRoot = path.join(workspace, '.agents', 'skills', 'unified-mpc-scheduled-continuation');
    await mkdir(home, { recursive: true });
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, 'SKILL.md'), `---
name: unified-mpc-scheduled-continuation
description: Continue a durable goal
---
# Scheduled continuation
Use one native successor.
`, 'utf8');

    const catalog = new SkillCatalog({
      homeDir: home,
      workspaceRoot: workspace,
      settings: DEFAULT_EXTENSIONS_SETTINGS,
    });
    const listed = await catalog.list({ query: 'scheduled continuation' });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.skills).toEqual([
      expect.objectContaining({
        id: 'workspace-agents-skills/unified-mpc-scheduled-continuation',
        name: 'unified-mpc-scheduled-continuation',
        source: 'workspace-agents-skills',
        trustTier: 'workspace',
        canonicalSkillPath: expect.any(String),
      }),
    ]);

    const read = await catalog.read({ skillId: 'workspace-agents-skills/unified-mpc-scheduled-continuation' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.content).toContain('Use one native successor.');
  });

  it('lists every standard global, plugin, and workspace skill root together with configured roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-all-skill-roots-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const extra = path.join(root, 'extra-skills');
    const skillRoots = [
      [path.join(home, '.agents', 'skills', 'global-agent'), 'global-agent'],
      [path.join(home, '.agents', 'skills', 'vendor', 'collection', 'nested', 'global-deep-agent'), 'global-deep-agent'],
      [path.join(home, '.codex', 'skills', 'global-codex'), 'global-codex'],
      [path.join(home, '.codex', 'plugins', 'cache', 'vendor', 'plugin', '1.0.0', 'skills', 'global-plugin'), 'global-plugin'],
      [path.join(workspace, '.agents', 'skills', 'workspace-agent'), 'workspace-agent'],
      [path.join(workspace, '.codex', 'skills', 'workspace-codex'), 'workspace-codex'],
      [path.join(workspace, '.cursor', 'skills-cursor', 'workspace-cursor'), 'workspace-cursor'],
      [path.join(workspace, '.github', 'skills', 'workspace-github'), 'workspace-github'],
      [path.join(extra, 'configured-extra'), 'configured-extra'],
    ] as const;
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    for (const [skillRoot, name] of skillRoots) {
      await mkdir(skillRoot, { recursive: true });
      await writeFile(path.join(skillRoot, 'SKILL.md'), `---\nname: ${name}\ndescription: Use when testing ${name}\n---\n# ${name}\n`, 'utf8');
    }

    const catalog = new SkillCatalog({
      homeDir: home,
      workspaceRoot: workspace,
      settings: DEFAULT_EXTENSIONS_SETTINGS,
      extraRoots: [extra],
    });
    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.skills.map((skill) => skill.name).sort()).toEqual([
      'configured-extra',
      'global-agent',
      'global-codex',
      'global-deep-agent',
      'global-plugin',
      'workspace-agent',
      'workspace-codex',
      'workspace-cursor',
      'workspace-github',
    ]);
  });

  it('discovers skills across all universal client roots (Antigravity, Cline, OpenCode, Freebuff, OMP)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-multi-client-skills-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');

    const testRoots = [
      // Antigravity
      [path.join(home, '.gemini', 'config', 'skills', 'antigravity-config-skill'), 'antigravity-config-skill', 'antigravity-config-skills'],
      [path.join(home, '.gemini', 'skills', 'antigravity-user-skill'), 'antigravity-user-skill', 'antigravity-skills'],
      [path.join(home, '.gemini', 'antigravity', 'builtin', 'skills', 'antigravity-builtin-skill'), 'antigravity-builtin-skill', 'antigravity-builtin-skills'],
      [path.join(workspace, '.gemini', 'skills', 'antigravity-ws-skill'), 'antigravity-ws-skill', 'workspace-antigravity-skills'],
      // Cline
      [path.join(home, '.cline', 'skills', 'cline-global-skill'), 'cline-global-skill', 'cline-skills'],
      [path.join(workspace, '.cline', 'skills', 'cline-ws-skill'), 'cline-ws-skill', 'workspace-cline-skills'],
      // OpenCode
      [path.join(home, '.config', 'opencode', 'skill', 'opencode-global-skill'), 'opencode-global-skill', 'opencode-config-skill'],
      [path.join(workspace, '.opencode', 'skills', 'opencode-ws-skill'), 'opencode-ws-skill', 'workspace-opencode-skills'],
      // Freebuff / generic workspace skills
      [path.join(workspace, 'skills', 'freebuff-ws-skill'), 'freebuff-ws-skill', 'workspace-root-skills'],
      // Oh My Pi
      [path.join(home, '.omp', 'skills', 'omp-global-skill'), 'omp-global-skill', 'omp-skills'],
      [path.join(workspace, '.omp', 'skills', 'omp-ws-skill'), 'omp-ws-skill', 'workspace-omp-skills'],
    ] as const;

    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });

    for (const [skillRoot, name] of testRoots) {
      await mkdir(skillRoot, { recursive: true });
      await writeFile(
        path.join(skillRoot, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Test skill for ${name}\n---\n# ${name}\nBody content\n`,
        'utf8',
      );
    }

    const catalog = new SkillCatalog({
      homeDir: home,
      workspaceRoot: workspace,
      settings: DEFAULT_EXTENSIONS_SETTINGS,
    });

    const listed = await catalog.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    for (const [, name, expectedSource] of testRoots) {
      const found = listed.value.skills.find((s) => s.name === name);
      expect(found, `Expected to find skill: ${name}`).toBeDefined();
      expect(found?.source).toBe(expectedSource);
    }
  });

  it('reads an unambiguous skill by bare or dollar-prefixed name', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-skill-alias-'));
    temporaryRoots.push(home);
    const skillRoot = path.join(home, '.agents', 'skills', 'demo-alias');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, 'SKILL.md'), `---
name: demo-alias
description: Alias test skill
---
Alias content.
`, 'utf8');

    const catalog = new SkillCatalog({ homeDir: home, settings: DEFAULT_EXTENSIONS_SETTINGS });
    const bare = await catalog.read({ skillId: 'demo-alias' });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.value.id).toBe('agents-skills/demo-alias');

    const dollarPrefixed = await catalog.read({ skillId: '$demo-alias' });
    expect(dollarPrefixed.ok).toBe(true);
    if (!dollarPrefixed.ok) return;
    expect(dollarPrefixed.value.id).toBe('agents-skills/demo-alias');
  });

  it('keeps same-name skills from different nested plugin versions source-addressable', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-plugin-skill-collisions-'));
    temporaryRoots.push(home);
    for (const [version, marker] of [['1.0.0', 'old'], ['2.0.0', 'new']] as const) {
      const skillRoot = path.join(home, '.codex', 'plugins', 'cache', 'vendor', 'demo', version, 'skills', 'shared');
      await mkdir(skillRoot, { recursive: true });
      await writeFile(path.join(skillRoot, 'SKILL.md'), `---\nname: shared-plugin-skill\ndescription: Plugin ${marker}\n---\n${marker}\n`, 'utf8');
    }

    const catalog = new SkillCatalog({ homeDir: home, settings: DEFAULT_EXTENSIONS_SETTINGS });
    const listed = await catalog.list({ query: 'shared-plugin-skill' });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.skills).toHaveLength(2);
    expect(new Set(listed.value.skills.map((skill) => skill.id)).size).toBe(2);
    const contents = await Promise.all(listed.value.skills.map((skill) => catalog.read({ skillId: skill.id })));
    expect(contents.map((result) => result.ok ? result.value.content.trim().split(/\r?\n/).at(-1) : 'error').sort())
      .toEqual(['new', 'old']);
  });

  it('keeps native Ponytail bound to the exact bundled source when a workspace skill uses the same name', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-ponytail-collision-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const bundled = path.join(root, 'agent-skills');
    const bundledSkillRoot = path.join(bundled, 'ponytail');
    const workspaceSkillRoot = path.join(workspace, '.agents', 'skills', 'ponytail');
    await mkdir(home, { recursive: true });
    await mkdir(bundledSkillRoot, { recursive: true });
    await mkdir(workspaceSkillRoot, { recursive: true });
    await writeFile(path.join(bundledSkillRoot, 'SKILL.md'), '---\nname: ponytail\ndescription: Bundled native Ponytail\n---\nBUNDLED_NATIVE\n', 'utf8');
    await writeFile(path.join(workspaceSkillRoot, 'SKILL.md'), '---\nname: ponytail\ndescription: Workspace collision\n---\nWORKSPACE_FAKE\n', 'utf8');

    const catalog = new SkillCatalog({
      homeDir: home,
      workspaceRoot: workspace,
      bundledRoots: [bundled],
      settings: DEFAULT_EXTENSIONS_SETTINGS,
    });
    const listed = await catalog.list({ query: 'ponytail' });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.skills.map((skill) => skill.id).sort()).toEqual([
      'bundled:agent-skills/ponytail',
      'workspace-agents-skills/ponytail',
    ]);

    const exactBundled = await catalog.read({ skillId: 'bundled:agent-skills/ponytail' });
    expect(exactBundled).toMatchObject({
      ok: true,
      value: { id: 'bundled:agent-skills/ponytail', source: 'bundled:agent-skills', trustTier: 'bundled' },
    });
    if (exactBundled.ok) expect(exactBundled.value.content).toContain('BUNDLED_NATIVE');

    const bare = await catalog.read({ skillId: 'ponytail' });
    expect(bare.ok).toBe(false);
    if (!bare.ok) {
      expect(bare.error.code).toBe('INVALID_INPUT');
      expect(bare.error.message).toContain('bundled:agent-skills/ponytail');
      expect(bare.error.message).toContain('workspace-agents-skills/ponytail');
    }
  });

  it('rejects ambiguous unqualified skill names with source-qualified candidates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-ambiguous-skills-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const globalSkillRoot = path.join(home, '.agents', 'skills', 'duplicate-skill');
    const workspaceSkillRoot = path.join(workspace, '.agents', 'skills', 'duplicate-skill');
    await mkdir(globalSkillRoot, { recursive: true });
    await mkdir(workspaceSkillRoot, { recursive: true });
    const content = `---
name: duplicate-skill
description: Duplicate skill
---
Duplicate content.
`;
    await writeFile(path.join(globalSkillRoot, 'SKILL.md'), content, 'utf8');
    await writeFile(path.join(workspaceSkillRoot, 'SKILL.md'), content, 'utf8');

    const catalog = new SkillCatalog({
      homeDir: home,
      workspaceRoot: workspace,
      settings: DEFAULT_EXTENSIONS_SETTINGS,
    });
    const read = await catalog.read({ skillId: 'duplicate-skill' });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe('INVALID_INPUT');
    expect(read.error.message).toContain('agents-skills/duplicate-skill');
    expect(read.error.message).toContain('workspace-agents-skills/duplicate-skill');
  });

  it('matches multi-word queries across fields and ranks full token coverage first', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-skill-match-tokens-'));
    temporaryRoots.push(home);
    const skills = [
      ['facebook-content-planner', 'Generate a weekly Facebook Page content plan from a theme and audience.'],
      ['facebook-ads', 'Facebook ads only.'],
      ['page-notes', 'Notes about planning a page.'],
    ] as const;
    for (const [name, description] of skills) {
      const skillRoot = path.join(home, '.agents', 'skills', name);
      await mkdir(skillRoot, { recursive: true });
      await writeFile(path.join(skillRoot, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`, 'utf8');
    }

    const catalog = new SkillCatalog({ homeDir: home, settings: DEFAULT_EXTENSIONS_SETTINGS });
    const listed = await catalog.list({ query: 'facebook page plan' });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.skills.map((skill) => skill.name)).toEqual([
      'facebook-content-planner',
      'page-notes',
      'facebook-ads',
    ]);
  });

  it('ranks exact and name matches ahead of description-only matches', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-skill-match-ranking-'));
    temporaryRoots.push(home);
    // Directory names sort the opposite way to relevance, so discovery order
    // cannot produce the expected ranking and the pre-ranking code fails here.
    const skills = [
      ['aaa-social', 'social-notes', 'Ideas for a caption.'],
      ['mmm-helper', 'post-caption-helper', 'Helper for a post.'],
      ['zzz-exact', 'caption', 'Write a caption.'],
    ] as const;
    for (const [directory, name, description] of skills) {
      const skillRoot = path.join(home, '.agents', 'skills', directory);
      await mkdir(skillRoot, { recursive: true });
      await writeFile(path.join(skillRoot, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`, 'utf8');
    }

    const catalog = new SkillCatalog({ homeDir: home, settings: DEFAULT_EXTENSIONS_SETTINGS });
    const listed = await catalog.list({ query: 'caption' });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.skills.map((skill) => skill.name)).toEqual([
      'caption',
      'post-caption-helper',
      'social-notes',
    ]);
  });

  it('matches Thai words and space-separated compounds', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-skill-match-thai-'));
    temporaryRoots.push(home);
    const skills = [
      ['page-pilot', 'ใช้ร่างแคปชั่น Facebook Page ภาษาไทย'],
      ['unrelated', 'Something else.'],
    ] as const;
    for (const [name, description] of skills) {
      const skillRoot = path.join(home, '.agents', 'skills', name);
      await mkdir(skillRoot, { recursive: true });
      await writeFile(path.join(skillRoot, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`, 'utf8');
    }

    const catalog = new SkillCatalog({ homeDir: home, settings: DEFAULT_EXTENSIONS_SETTINGS });
    const thai = await catalog.list({ query: 'แคปชั่น facebook' });
    expect(thai.ok).toBe(true);
    if (thai.ok) expect(thai.value.skills.map((skill) => skill.name)).toEqual(['page-pilot']);

    const compound = await catalog.list({ query: 'pagepilot' });
    expect(compound.ok).toBe(true);
    if (compound.ok) expect(compound.value.skills.map((skill) => skill.name)).toEqual(['page-pilot']);
  });

  it('falls back to whole-query matching when no significant token remains', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-skill-match-degenerate-'));
    temporaryRoots.push(home);
    const fixtures = [
      ['.agents', 'caption-helper', 'Writes the caption for a post.'],
      ['.agents', 'image-tools', 'Crop and resize 图片 files.'],
      ['.claude', 'caption-helper', 'A second caption helper for the team.'],
    ] as const;
    for (const [root, name, description] of fixtures) {
      const skillRoot = path.join(home, root, 'skills', name);
      await mkdir(skillRoot, { recursive: true });
      await writeFile(path.join(skillRoot, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`, 'utf8');
    }
    const catalog = new SkillCatalog({ homeDir: home, settings: DEFAULT_EXTENSIONS_SETTINGS });
    const listedIds = async (input: { readonly query?: string; readonly source?: string }): Promise<readonly string[]> => {
      const listed = await catalog.list(input);
      expect(listed.ok).toBe(true);
      return listed.ok ? listed.value.skills.map((skill) => skill.id) : [];
    };

    // An all-stop-word query used to match as a whole-string substring. Losing
    // every token must not turn that into "no matches".
    expect(new Set(await listedIds({ query: 'the' }))).toEqual(new Set([
      'agents-skills/caption-helper',
      'claude-skills/caption-helper',
    ]));

    // Punctuation normalizes to an empty query, which still lists the catalog.
    expect((await listedIds({ query: '???' })).length).toBe(3);

    // One Latin letter is dropped as noise and falls back to the whole query;
    // one CJK character is a word and must still be findable.
    expect((await listedIds({ query: 'c' })).length).toBe(3);
    expect(await listedIds({ query: '图' })).toEqual(['agents-skills/image-tools']);

    // The source filter still applies before ranking.
    expect(await listedIds({ query: 'caption helper', source: 'claude-skills' })).toEqual(['claude-skills/caption-helper']);
  });

  it('reports whether a query will actually be ranked', () => {
    // Listing surfaces use this instead of `query.length > 0`, because these
    // queries stay in discovery order even though they are non-empty.
    for (const query of [undefined, '', '   ', '???', 'the', 'c']) {
      expect(skillQueryIsRanked(query)).toBe(false);
    }
    for (const query of ['facebook page plan', 'caption', 'แคปชั่น', '图']) {
      expect(skillQueryIsRanked(query)).toBe(true);
    }
  });

  it('discovers codex skills from CODEX_HOME when no home directory is pinned', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-catalog-codex-'));
    temporaryRoots.push(root);
    const codexHome = path.join(root, 'codex-home');
    const isolatedHome = path.join(root, 'isolated-home');
    const skillRoot = path.join(codexHome, 'skills', 'codex-skill');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, 'SKILL.md'), '---\nname: codex-skill\ndescription: From CODEX_HOME\n---\n# Codex\n', 'utf8');
    const fallbackSkill = path.join(isolatedHome, '.codex', 'skills', 'isolated-codex-skill');
    await mkdir(fallbackSkill, { recursive: true });
    await writeFile(path.join(fallbackSkill, 'SKILL.md'), '---\nname: isolated-codex-skill\ndescription: Wrong root\n---\n', 'utf8');

    const catalog = new SkillCatalog({ settings: DEFAULT_EXTENSIONS_SETTINGS });
    const listed = await withEnv({ CODEX_HOME: codexHome, HOME: isolatedHome }, () => catalog.list());

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const ids = listed.value.skills.map((skill) => skill.id);
    expect(ids).toContain('codex-skills/codex-skill');
    expect(ids).not.toContain('codex-skills/isolated-codex-skill');
  });

  it('falls back to <home>/.codex for codex skills when CODEX_HOME is unset or blank', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-catalog-codex-default-'));
    temporaryRoots.push(root);
    const isolatedHome = path.join(root, 'isolated-home');
    const skillRoot = path.join(isolatedHome, '.codex', 'skills', 'fallback-skill');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, 'SKILL.md'), '---\nname: fallback-skill\ndescription: Home fallback\n---\n# Fallback\n', 'utf8');

    const catalog = new SkillCatalog({ settings: DEFAULT_EXTENSIONS_SETTINGS });
    for (const configured of [undefined, '', '   ']) {
      const listed = await withEnv({ CODEX_HOME: configured, HOME: isolatedHome }, () => catalog.list());
      expect(listed.ok).toBe(true);
      if (!listed.ok) continue;
      expect(listed.value.skills.map((skill) => skill.id)).toContain('codex-skills/fallback-skill');
    }
  });

  it('prefers a pinned home directory over an ambient CODEX_HOME', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-catalog-codex-pinned-'));
    temporaryRoots.push(root);
    const pinnedHome = path.join(root, 'pinned-home');
    const decoyHome = path.join(root, 'decoy-home');
    const pinnedSkill = path.join(pinnedHome, '.codex', 'skills', 'pinned-skill');
    const decoySkill = path.join(decoyHome, 'skills', 'decoy-skill');
    await mkdir(pinnedSkill, { recursive: true });
    await mkdir(decoySkill, { recursive: true });
    await writeFile(path.join(pinnedSkill, 'SKILL.md'), '---\nname: pinned-skill\ndescription: Pinned\n---\n', 'utf8');
    await writeFile(path.join(decoySkill, 'SKILL.md'), '---\nname: decoy-skill\ndescription: Decoy\n---\n', 'utf8');

    const catalog = new SkillCatalog({ homeDir: pinnedHome, settings: DEFAULT_EXTENSIONS_SETTINGS });
    const listed = await withEnv({ CODEX_HOME: decoyHome }, () => catalog.list());

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const ids = listed.value.skills.map((skill) => skill.id);
    expect(ids).toContain('codex-skills/pinned-skill');
    expect(ids).not.toContain('codex-skills/decoy-skill');
  });
});
