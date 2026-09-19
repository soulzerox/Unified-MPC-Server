import { describe, expect, it } from 'vitest';
import { classifyLegacyScopeMigration, planLegacyScopeMigration, type ThaiRagRegisteredWorkspace } from './legacy-migration.js';

const unified: ThaiRagRegisteredWorkspace = {
  id: '86a0931e-0851-4a1f-b802-0f2e1500b4ec',
  displayName: 'Unified MCP Server',
  rootPath: '/mnt/workspace_data/Unified MCP Server',
  realRootPath: '/mnt/workspace_data/Unified MCP Server',
};
const novel: ThaiRagRegisteredWorkspace = {
  id: '0428064c-cec8-4c3f-8c67-76cba489e942',
  displayName: 'novel-publisher',
  rootPath: '/home/qwerty/Documents/Src Code/novel-publisher',
  realRootPath: '/home/qwerty/Documents/Src Code/novel-publisher',
};

describe('planLegacyScopeMigration', () => {
  it('imports only scopes whose canonical identity is directly provable', () => {
    expect(planLegacyScopeMigration({ scope: unified.id, dataClass: 'memory', workspaces: [unified, novel] })).toEqual({
      action: 'import', workspaceId: unified.id, reason: 'canonical-workspace-id',
    });
    expect(planLegacyScopeMigration({ scope: unified.rootPath, dataClass: 'conversation', workspaces: [unified, novel] })).toEqual({
      action: 'import', workspaceId: unified.id, reason: 'exact-registered-root',
    });
    expect(planLegacyScopeMigration({ scope: novel.realRootPath, dataClass: 'conversation', workspaces: [unified, novel] })).toEqual({
      action: 'import', workspaceId: novel.id, reason: 'exact-registered-root',
    });
  });

  it('never imports basename-only legacy code scopes and reindexes a unique registered source instead', () => {
    expect(planLegacyScopeMigration({ scope: 'Unified MCP Server', dataClass: 'code-index', workspaces: [unified, novel] })).toEqual({
      action: 'reindex', workspaceId: unified.id, reason: 'basename-only-not-identity-proof',
    });
  });

  it('emits journal-compatible classifications for import, reindex, and legacy data', () => {
    expect(classifyLegacyScopeMigration({ scope: unified.id, dataClass: 'memory', workspaces: [unified] })).toEqual({
      source: unified.id, dataClass: 'memory', classification: 'imported', workspaceId: unified.id, reason: 'canonical-workspace-id',
    });
    expect(classifyLegacyScopeMigration({ scope: 'Unified MCP Server', dataClass: 'code-index', workspaces: [unified] })).toEqual({
      source: 'Unified MCP Server', dataClass: 'code-index', classification: 'reindex_required', workspaceId: unified.id, reason: 'basename-only-not-identity-proof',
    });
    expect(classifyLegacyScopeMigration({ scope: 'Unified MCP Server', dataClass: 'conversation', workspaces: [unified] })).toEqual({
      source: 'Unified MCP Server', dataClass: 'conversation', classification: 'legacy', reason: 'basename-only-not-identity-proof',
    });
  });

  it('preserves basename-only conversation memory as legacy rather than guessing a workspace UUID', () => {
    expect(planLegacyScopeMigration({ scope: 'Unified MCP Server', dataClass: 'conversation', workspaces: [unified, novel] })).toEqual({
      action: 'preserve-legacy', reason: 'basename-only-not-identity-proof',
    });
    expect(planLegacyScopeMigration({ scope: 'general', dataClass: 'conversation', workspaces: [unified, novel] })).toEqual({
      action: 'preserve-legacy', reason: 'unscoped-or-unproven',
    });
  });

  it('does not pick between two same-basename repositories', () => {
    const duplicate: ThaiRagRegisteredWorkspace = {
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Unified MCP Server',
      rootPath: '/srv/other/Unified MCP Server',
      realRootPath: '/srv/other/Unified MCP Server',
    };
    expect(planLegacyScopeMigration({ scope: 'Unified MCP Server', dataClass: 'code-index', workspaces: [unified, duplicate] })).toEqual({
      action: 'preserve-legacy', reason: 'ambiguous-workspace-identity',
    });
  });

  it('treats case/path normalization conservatively: normalized exact paths may match but names do not become paths', () => {
    expect(planLegacyScopeMigration({ scope: '/mnt/workspace_data/Unified MCP Server/', dataClass: 'conversation', workspaces: [unified] })).toEqual({
      action: 'import', workspaceId: unified.id, reason: 'exact-registered-root',
    });
    expect(planLegacyScopeMigration({ scope: 'unified mcp server', dataClass: 'conversation', workspaces: [unified] })).toEqual({
      action: 'preserve-legacy', reason: 'basename-only-not-identity-proof',
    });
  });
});
