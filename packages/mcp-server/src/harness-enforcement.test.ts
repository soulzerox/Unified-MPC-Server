import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@unified-mpc/domain';
import type { AppErrorCode } from '@unified-mpc/domain';
import type { PermissionProfile } from '@unified-mpc/permissions';
import { ResourceAdmissionController } from '@unified-mpc/workspace';
import { ToolRegistry, type McpApplicationServices, type WorkspaceScope, type WorkspaceScopeUnavailable } from './tool-registry.js';
import { HarnessActivationLedger, hashHarnessText } from './harness-runtime.js';

const actor = { clientId: 'client-harness', clientName: 'Harness test', sessionId: 'session-harness' };
const activeWorkspaceScopeProvider = async (): Promise<WorkspaceScope> => ({ workspaceId: 'workspace-1', rootPath: '/tmp/workspace-1' });

function createHarnessServices(): {
  services: McpApplicationServices;
  writes: string[];
  childCalls: string[];
  nativeRagCalls: string[];
  nativeRagArguments: Array<{ tool: string; args: Readonly<Record<string, unknown>> }>;
  bootstrapEvents: string[];
  setAgentsMd(content: string): void;
  setHead(value: string): void;
  setHeadOnPreEdit(value: string | undefined): void;
  setThaiRagHealthError(message: string | undefined, options?: { code?: AppErrorCode }): void;
  setThaiRagActiveJobs(jobIds: readonly string[]): void;
  setThaiRagPreEditError(
    message: string | undefined,
    options?: { code?: AppErrorCode; details?: Readonly<Record<string, string | number>> },
  ): void;
  setThaiRagPreEditPayload(payload: Record<string, unknown> | undefined): void;
  setFileContent(path: string, content: string): void;
  setFileMissing(path: string): void;
} {
  const writes: string[] = [];
  const childCalls: string[] = [];
  const nativeRagCalls: string[] = [];
  const nativeRagArguments: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
  const bootstrapEvents: string[] = [];
  let agentsMd = '# Rules\nUse mandatory child MCP preflight.\n';
  let head = 'a'.repeat(40);
  let thaiRagHealthError: string | undefined;
  let thaiRagHealthCode: AppErrorCode = 'CONFLICT';
  let thaiRagActiveJobs: readonly string[] = [];
  let thaiRagPreEditError: string | undefined;
  let thaiRagPreEditCode: AppErrorCode = 'CONFLICT';
  let thaiRagPreEditDetails: Readonly<Record<string, string | number>> | undefined;
  let thaiRagPreEditPayload: Record<string, unknown> | undefined;
  let headOnPreEdit: string | undefined;
  const fileContents = new Map<string, string>();
  const missingPaths = new Set<string>();
  const fileContent = (path: string): string => fileContents.get(path) ?? `// ${path}\n`;
  const services = {
    file: {
      async readFile(_actor: unknown, _workspaceId: string, request: { path: string }) {
        if (request.path === 'AGENTS.md') return ok({ path: request.path, content: agentsMd, startLine: 1, endLine: 2 });
        if (missingPaths.has(request.path) || request.path === '.unified-mpc/project-profile.json') {
          return err(appError('FILE_NOT_FOUND', `missing ${request.path}`));
        }
        return ok({ path: request.path, content: fileContent(request.path), startLine: 1, endLine: 1 });
      },
      async writeFile(_actor: unknown, _workspaceId: string, request: { path: string }) {
        writes.push(request.path);
        return ok({ path: request.path, replacedExisting: false });
      },
    },
    git: {
      async observeWorkspace() {
        return ok({
          repositoryIdentity: 'repo-1', gitCommonDirIdentity: 'common-1', worktreeIdentity: 'worktree-1',
          branch: 'goal/one', head, statusEntries: [], dirtyFingerprint: 'dirty-1', stagedFingerprint: 'staged-1',
        });
      },
    },
    thaiRag: {
      async health() {
        if (thaiRagHealthError !== undefined) return err(appError(thaiRagHealthCode, thaiRagHealthError, true));
        return ok({
          providerId: 'thai-rag' as const,
          state: 'ready',
          embeddingIndexGeneration: 1,
          components: {
            workerReachable: true,
            sqliteAvailable: true,
            ftsAvailable: true,
            vectorStoreAvailable: true,
            embedderAvailable: true,
            lexicalRetrievalAvailable: true,
            semanticRetrievalAvailable: true,
            activeJobs: [...thaiRagActiveJobs],
          },
        });
      },
      async call(tool: string, args: Readonly<Record<string, unknown>>) {
        nativeRagCalls.push(tool);
        nativeRagArguments.push({ tool, args });
        if (tool === 'pre_edit_context' && headOnPreEdit !== undefined) {
          // The admitted source view can move while the provider is thinking.
          head = headOnPreEdit;
        }
        if (tool === 'pre_edit_context' && thaiRagPreEditError !== undefined) {
          return err(appError(thaiRagPreEditCode, thaiRagPreEditError, true, thaiRagPreEditDetails));
        }
        if (tool === 'pre_edit_context' && thaiRagPreEditPayload !== undefined) {
          return ok({ content: [{ type: 'text', text: JSON.stringify(thaiRagPreEditPayload) }] });
        }
        // The provider names the content it analyzed; the fixture derives that
        // identity from the same content the file service serves, so a ready
        // verdict binds to the target only while the fixture stays consistent.
        const requested = typeof args.file_path === 'string' ? args.file_path : '';
        return ok({ content: [{ type: 'text', text: JSON.stringify({
          status: 'ok',
          can_proceed: true,
          evidence_state: 'evidence_available',
          evidence_fresh: true,
          target_sha256: tool === 'pre_edit_context' ? hashHarnessText(fileContent(requested)) : 'a'.repeat(64),
          evidence: { code_index: 'available', storage: 'available', cpg: 'available' },
        }) }] });
      },
    },
    extensions: {
      async runtimePolicySnapshot() {
        bootstrapEvents.push('policy_snapshot');
        return ok({ ready: true, policies: [{
          priority: 'P1', id: 'session-start:ask-matt', resourceId: 'ask-matt', resolvedResourceId: 'agents-skills/ask-matt',
          resourceType: 'skill', mandatory: true, enforcement: 'EVERY_SESSION', directive: 'Load ask-matt.', source: 'configured', available: true,
        }] });
      },
      async readSkill(input: { skillId: string }) {
        bootstrapEvents.push(`skill_load:${input.skillId}`);
        return ok({ id: input.skillId, name: 'ask-matt', description: 'Router', source: 'agents-skills', path: '/skills/ask-matt/SKILL.md', content: '# Ask Matt\nUse diagnosing-bugs for hard bugs.' });
      },
      async bootstrapMandatoryMcpServers() {
        bootstrapEvents.push('mandatory_mcp');
        return ok({ ready: true, servers: [] });
      },
      async describeMcpServer(input: { server: string }) {
        if (input.server !== 'godkiller') return err(appError('NOT_FOUND', `missing ${input.server}`));
        return ok({
          server: 'godkiller',
          enabled: true,
          connected: true,
          provenance: {
            source: 'antigravity-fallback',
            trustTier: 'external',
            namespace: 'mcp:godkiller',
            descriptorFingerprint: 'c'.repeat(64),
            catalogFingerprint: '3'.repeat(64),
            drift: { detected: false, reasons: [] },
          },
          tools: [{ name: 'gk_task', description: 'Safety analysis', inputSchema: { type: 'object' }, qualifiedName: 'mcp:godkiller/gk_task' }],
        });
      },
      async callMcpTool(input: { server: string; tool: string }) {
        childCalls.push(`${input.server}/${input.tool}`);
        if (input.server === 'memory' && input.tool === 'search_nodes') return ok({ structuredContent: { entities: [], relations: [] } });
        return ok({ content: [{ type: 'text', text: JSON.stringify({
          status: 'ok',
          can_proceed: true,
          evidence_state: 'evidence_available',
          evidence: { code_index: 'available', storage: 'available', cpg: 'available' },
        }) }] });
      },
    },
  } as unknown as McpApplicationServices;
  return {
    services,
    writes,
    childCalls,
    nativeRagCalls,
    nativeRagArguments,
    bootstrapEvents,
    setAgentsMd(content: string): void { agentsMd = content; },
    setHead(value: string): void { head = value; },
    setHeadOnPreEdit(value: string | undefined): void { headOnPreEdit = value; },
    setThaiRagHealthError(message, options): void {
      thaiRagHealthError = message;
      thaiRagHealthCode = options?.code ?? 'CONFLICT';
    },
    setThaiRagActiveJobs(jobIds: readonly string[]): void { thaiRagActiveJobs = [...jobIds]; },
    setThaiRagPreEditError(message, options): void {
      thaiRagPreEditError = message;
      thaiRagPreEditCode = options?.code ?? 'CONFLICT';
      thaiRagPreEditDetails = options?.details;
    },
    setThaiRagPreEditPayload(payload: Record<string, unknown> | undefined): void { thaiRagPreEditPayload = payload; },
    setFileContent(path: string, content: string): void { fileContents.set(path, content); },
    setFileMissing(path: string): void { missingPaths.add(path); },
  };
}

describe('workspace engineering harness enforcement', () => {
  it('self-bootstraps and runs mandatory pre-edit checks when the host cannot call lifecycle tools explicitly', async () => {
    const { services, writes, childCalls, nativeRagCalls, nativeRagArguments, bootstrapEvents } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    const first = await registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const x = 1;\n',
    });
    expect(first.isError).not.toBe(true);
    expect(bootstrapEvents).toEqual(['policy_snapshot', 'skill_load:agents-skills/ask-matt', 'mandatory_mcp']);
    expect(childCalls).toEqual([]);
    expect(nativeRagCalls).toEqual(['pre_edit_context']);
    expect(nativeRagArguments[0]).toEqual({
      tool: 'pre_edit_context',
      args: { file_path: 'src/app.ts', workspace_id: 'workspace-1' },
    });
    expect(writes).toEqual(['src/app.ts']);

    const second = await registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const x = 2;\n',
    });
    expect(second.isError).not.toBe(true);
    expect(childCalls).toEqual([]);
    expect(nativeRagCalls).toEqual(['pre_edit_context', 'pre_edit_context']);
    expect(writes).toEqual(['src/app.ts', 'src/app.ts']);
  });

  it('preserves bootstrap and single-use prepared-path state across request-scoped registry recreation', async () => {
    const { services, writes, nativeRagCalls, nativeRagArguments } = createHarnessServices();
    const ledger = new HarnessActivationLedger();
    const options = { harnessActivationLedger: ledger, sessionId: 'shared-transport-session', activeWorkspaceScopeProvider };

    const bootstrapRegistry = new ToolRegistry(services, actor, options);
    expect((await bootstrapRegistry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);

    const prepareRegistry = new ToolRegistry(services, actor, options);
    expect((await prepareRegistry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1', filePath: 'src/shared.ts', proposedSymbol: 'shared',
    })).isError).not.toBe(true);
    expect(nativeRagCalls).toEqual(['pre_edit_context']);
    expect(nativeRagArguments).toEqual([{
      tool: 'pre_edit_context',
      args: { file_path: 'src/shared.ts', proposed_symbol: 'shared', workspace_id: 'workspace-1' },
    }]);

    const mutationRegistry = new ToolRegistry(services, actor, options);
    expect((await mutationRegistry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/shared.ts', content: 'export const shared = 1;\n',
    })).isError).not.toBe(true);
    expect(nativeRagCalls).toEqual(['pre_edit_context']);
    expect(writes).toEqual(['src/shared.ts']);

    const secondMutationRegistry = new ToolRegistry(services, actor, options);
    expect((await secondMutationRegistry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/shared.ts', content: 'export const shared = 2;\n',
    })).isError).not.toBe(true);
    expect(nativeRagCalls).toEqual(['pre_edit_context', 'pre_edit_context']);
    expect(writes).toEqual(['src/shared.ts', 'src/shared.ts']);
  });

  it('requires current single-use prepared-path evidence before unstaged admission recovery', async () => {
    const { services, nativeRagCalls } = createHarnessServices();
    let recoveries = 0;
    (services as { goalRunWorkspace?: McpApplicationServices['goalRunWorkspace'] }).goalRunWorkspace = {
      async recoverRunWorkspace() {
        recoveries += 1;
        return ok({ admissionGeneration: 2 });
      },
    } as McpApplicationServices['goalRunWorkspace'];
    const ledger = new HarnessActivationLedger();
    const options = { harnessActivationLedger: ledger, sessionId: 'unstaged-recovery-session', activeWorkspaceScopeProvider };
    const registry = new ToolRegistry(services, actor, options);
    const recovery = {
      expectedAdmissionGeneration: 1,
      expectedWorkspaceHead: 'a'.repeat(40),
      expectedUnstagedPaths: ['docs/generated.md'],
      expectedUnstagedDiffSha256: 'b'.repeat(64),
    };

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    await expect(registry.invoke('retry_goal_workspace_admission', {
      workspaceId: 'workspace-1', goalId: 'goal-1', leaseToken: 'lease-1', leaseGeneration: 1,
      unstagedRecovery: recovery,
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('prepare_code_change') } },
    });
    expect(recoveries).toBe(0);

    expect((await registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1', filePath: 'docs/generated.md',
    })).isError).not.toBe(true);
    expect(nativeRagCalls).toEqual(['pre_edit_context']);

    await expect(registry.invoke('retry_goal_workspace_admission', {
      workspaceId: 'workspace-1', goalId: 'goal-1', leaseToken: 'lease-1', leaseGeneration: 1,
      unstagedRecovery: recovery,
    })).resolves.toMatchObject({
      structuredContent: { outcome: 'admitted', admissionGeneration: 2 },
    });
    expect(recoveries).toBe(1);

    await expect(registry.invoke('retry_goal_workspace_admission', {
      workspaceId: 'workspace-1', goalId: 'goal-1', leaseToken: 'lease-1', leaseGeneration: 1,
      unstagedRecovery: recovery,
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('prepare_code_change') } },
    });
    expect(recoveries).toBe(1);
  });

  it('keeps standard mode fail-closed when native pre-edit is queued behind another workspace', async () => {
    const { services, nativeRagCalls, setThaiRagPreEditError } = createHarnessServices();
    setThaiRagPreEditError('workspace-a is queued behind active indexing for workspace-b', {
      details: { reason: 'workspace-indexing-busy', blockingWorkspaceId: 'workspace-b' },
    });
    const registry = new ToolRegistry(services, actor, {
      harnessActivationLedger: new HarnessActivationLedger(),
      sessionId: 'standard-pre-edit-session',
      activeWorkspaceScopeProvider,
    });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    await expect(registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1',
      filePath: 'src/standard.ts',
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'CONFLICT',
          message: expect.stringContaining('queued behind active indexing'),
          details: { reason: 'workspace-indexing-busy', blockingWorkspaceId: 'workspace-b' },
        },
      },
    });
    expect(nativeRagCalls).toEqual(['pre_edit_context']);
  });

  it('forwards a typed pre-edit provider failure instead of rewriting it into a CONFLICT', async () => {
    const { services, setThaiRagPreEditError } = createHarnessServices();
    setThaiRagPreEditError('native provider read timed out before the pre-edit verdict', {
      code: 'PROCESS_TIMEOUT',
      details: { reason: 'pre-edit-provider-timeout', attempt: 2 },
    });
    const registry = new ToolRegistry(services, actor, {
      harnessActivationLedger: new HarnessActivationLedger(),
      sessionId: 'typed-provider-failure-session',
      activeWorkspaceScopeProvider,
    });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    await expect(registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1',
      filePath: 'src/typed-failure.ts',
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'PROCESS_TIMEOUT',
          message: expect.stringContaining('Thai-RAG pre-edit check failed: native provider read timed out'),
          details: { reason: 'pre-edit-provider-timeout', attempt: 2 },
        },
      },
    });
  });

  it('forwards a typed provider health failure instead of rewriting it into a CONFLICT', async () => {
    const { services, setThaiRagHealthError } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, {
      harnessActivationLedger: new HarnessActivationLedger(),
      sessionId: 'typed-health-failure-session',
      activeWorkspaceScopeProvider,
    });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    setThaiRagHealthError('provider worker is under resource pressure', { code: 'RESOURCE_PRESSURE' });
    await expect(registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1',
      filePath: 'src/typed-health.ts',
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'RESOURCE_PRESSURE',
          message: expect.stringContaining('Native Thai-RAG provider is not ready for pre-edit diagnostics'),
        },
      },
    });
  });

  it('lets Trusted Full Bypass skip a queued native pre-edit without touching the unrelated index', async () => {
    const { services, nativeRagCalls, setThaiRagActiveJobs, setThaiRagPreEditError } = createHarnessServices();
    setThaiRagActiveJobs(['idx_other_workspace']);
    setThaiRagPreEditError('workspace-a is queued behind active indexing for workspace-b');
    const registry = new ToolRegistry(services, actor, {
      harnessActivationLedger: new HarnessActivationLedger(),
      sessionId: 'full-bypass-pre-edit-session',
      profileProvider: (): PermissionProfile => ({ name: 'full', defaults: { READ: 'ALLOW', WRITE: 'ALLOW', EXECUTE: 'ALLOW', DANGEROUS: 'ALLOW' }, allowedProjectExecutables: [] }),
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
      activeWorkspaceScopeProvider,
    });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    await expect(registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1',
      filePath: 'src/bypass.ts',
    })).resolves.toMatchObject({
      structuredContent: {
        ready: true,
        authorized: true,
        bypassed: true,
        bypassReason: 'trusted-full-bypass',
        thaiRagState: 'running',
        workspaceId: 'workspace-1',
        filePath: 'src/bypass.ts',
      },
    });
    expect(nativeRagCalls).toEqual([]);
  });

  it('uses the same Trusted Full Bypass semantics for automatic mutation preflight and audits it', async () => {
    const { services, writes, nativeRagCalls, setThaiRagActiveJobs } = createHarnessServices();
    setThaiRagActiveJobs(['idx_other_workspace']);
    const events: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry(services, actor, {
      harnessActivationLedger: new HarnessActivationLedger(),
      sessionId: 'full-bypass-auto-pre-edit-session',
      profileProvider: (): PermissionProfile => ({ name: 'full', defaults: { READ: 'ALLOW', WRITE: 'ALLOW', EXECUTE: 'ALLOW', DANGEROUS: 'ALLOW' }, allowedProjectExecutables: [] }),
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
      activeWorkspaceScopeProvider,
      activity: {
        async record(event): Promise<void> {
          events.push(event as unknown as Record<string, unknown>);
        },
      },
    });

    await expect(registry.invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/automatic-bypass.ts',
      content: 'export const automaticBypass = true;\n',
    })).resolves.not.toMatchObject({ isError: true });

    expect(nativeRagCalls).toEqual([]);
    expect(writes).toEqual(['src/automatic-bypass.ts']);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'completed',
        toolName: 'prepare_code_change',
        authorizationMode: 'full_bypass',
        resultCode: 'SUCCESS',
      }),
    ]));
  });

  it('allows Trusted Full Bypass when Thai-RAG is unavailable and restores fail-closed behavior immediately', async () => {
    const {
      services,
      nativeRagCalls,
      setThaiRagHealthError,
      setThaiRagPreEditError,
    } = createHarnessServices();
    let authorizationMode: 'standard' | 'full_bypass' = 'full_bypass';
    setThaiRagHealthError('provider unavailable');
    const registry = new ToolRegistry(services, actor, {
      harnessActivationLedger: new HarnessActivationLedger(),
      sessionId: 'full-bypass-unavailable-session',
      profileProvider: (): PermissionProfile => ({ name: 'full', defaults: { READ: 'ALLOW', WRITE: 'ALLOW', EXECUTE: 'ALLOW', DANGEROUS: 'ALLOW' }, allowedProjectExecutables: [] }),
      authorizationModeProvider: (): 'standard' | 'full_bypass' => authorizationMode,
      activeWorkspaceScopeProvider,
    });

    await expect(registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).resolves.toMatchObject({
      structuredContent: {
        ready: true,
        thaiRagBypassed: true,
        bypassReason: 'trusted-full-bypass',
        thaiRagState: 'unavailable',
      },
    });
    await expect(registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1',
      filePath: 'src/unavailable-bypass.ts',
    })).resolves.toMatchObject({
      structuredContent: {
        bypassed: true,
        thaiRagState: 'unavailable',
      },
    });
    expect(nativeRagCalls).toEqual([]);

    authorizationMode = 'standard';
    setThaiRagHealthError(undefined);
    setThaiRagPreEditError('standard mode restored');
    await expect(registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1',
      filePath: 'src/standard-restored.ts',
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('standard mode restored') } },
    });
    expect(nativeRagCalls).toEqual(['pre_edit_context']);
  });

  it('reruns mandatory pre-edit diagnostics when HEAD changes after a path was prepared', async () => {
    const { services, writes, nativeRagCalls, setHead } = createHarnessServices();
    const ledger = new HarnessActivationLedger();
    const options = { harnessActivationLedger: ledger, sessionId: 'head-drift-session', activeWorkspaceScopeProvider };
    const registry = new ToolRegistry(services, actor, options);

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    expect((await registry.invoke('prepare_code_change', { workspaceId: 'workspace-1', filePath: 'src/drift.ts' })).isError).not.toBe(true);
    expect(nativeRagCalls).toEqual(['pre_edit_context']);

    setHead('b'.repeat(40));
    expect((await registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/drift.ts', content: 'export const drift = true;\n',
    })).isError).not.toBe(true);

    expect(nativeRagCalls).toEqual(['pre_edit_context', 'pre_edit_context']);
    expect(writes).toEqual(['src/drift.ts']);
  });

  it('returns the preferred workspace goal as a non-leasing continuation hint during bootstrap', async () => {
    const { services } = createHarnessServices();
    (services as { preferredGoal?: McpApplicationServices['preferredGoal'] }).preferredGoal = {
      get: async (workspaceId: string): Promise<{ goalId: string; goalKey: string; objective: string; currentPhase: string; updatedAt: string } | null> => workspaceId === 'workspace-1' ? {
        goalId: 'goal-a',
        goalKey: 'project-goals',
        objective: 'Expose open goals in the Projects view.',
        currentPhase: 'frontend',
        updatedAt: '2026-09-16T01:00:00.000Z',
      } : null,
    };
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    await expect(registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).resolves.toMatchObject({
      structuredContent: {
        ready: true,
        preferredGoal: {
          goalId: 'goal-a',
          goalKey: 'project-goals',
          currentPhase: 'frontend',
        },
      },
    });
  });

  it('runs the optional Godkiller safety check only when explicitly requested', async () => {
    const { services, childCalls } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    const prepared = await registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1', filePath: 'src/risky.ts', proposedSymbol: 'migrateState', runGodkillerSafetyCheck: true,
    });

    expect(prepared).toMatchObject({
      structuredContent: {
        ready: true,
        filePath: 'src/risky.ts',
        checks: ['thai-rag/pre_edit_context', 'godkiller/gk_task'],
      },
    });
    expect(childCalls).toEqual(['godkiller/gk_task']);
  });

  it('refuses a workspace-scoped Godkiller shadow when optional safety analysis is requested', async () => {
    const { services, childCalls, nativeRagCalls } = createHarnessServices();
    const originalDescribe = services.extensions!.describeMcpServer.bind(services.extensions);
    services.extensions = {
      ...services.extensions,
      async describeMcpServer(input: { server: string }, signal?: AbortSignal) {
        const result = await originalDescribe(input, signal);
        if (!result.ok || input.server !== 'godkiller') return result;
        return ok({ ...result.value, provenance: { ...result.value.provenance, source: 'workspace-cursor' } });
      },
    } as typeof services.extensions;
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    await expect(registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1', filePath: 'src/risky.ts', runGodkillerSafetyCheck: true,
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('workspace-scoped Godkiller') } },
    });
    expect(childCalls).toEqual([]);
    expect(nativeRagCalls).toEqual(['pre_edit_context']);
  });

  it('fails closed when the workspace AGENTS.md harness cannot be loaded', async () => {
    const { services } = createHarnessServices();
    services.file = {
      ...services.file,
      async readFile(_actor: unknown, _workspaceId: string, request: { path: string }) {
        return err(appError('FILE_NOT_FOUND', `missing ${request.path}`));
      },
    } as typeof services.file;
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    await expect(registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('AGENTS.md') } },
    });
  });

  it('does not gate workspace bootstrap on optional child readiness', async () => {
    const { services } = createHarnessServices();
    services.extensions = {
      ...services.extensions,
      async runtimePolicySnapshot() {
        return ok({
          ready: true,
          policies: [
            {
              priority: 'P1',
              id: 'session-start:ask-matt',
              resourceId: 'ask-matt',
              resolvedResourceId: 'agents-skills/ask-matt',
              resourceType: 'skill',
              mandatory: true,
              enforcement: 'EVERY_SESSION',
              directive: 'Load ask-matt.',
              source: 'configured',
              available: true,
            },
            {
              priority: 'P2',
              id: 'optional:sequentialthinking',
              resourceId: 'sequentialthinking',
              resourceType: 'server',
              mandatory: false,
              enforcement: 'ON_DEMAND',
              directive: 'Optional child.',
              source: 'configured',
              available: false,
            },
          ],
        });
      },
      async bootstrapMandatoryMcpServers() {
        return ok({ ready: true, servers: [] });
      },
    } as typeof services.extensions;
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    await expect(registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).resolves.toMatchObject({
      structuredContent: { ready: true },
    });
  });

  it('fails workspace bootstrap when required external MCP servers are unavailable', async () => {
    const { services } = createHarnessServices();
    services.extensions = {
      ...services.extensions,
      async bootstrapMandatoryMcpServers() {
        return ok({ ready: false, servers: [{ name: 'external-required', required: true, connected: false, pinned: false, tools: [], requiredTools: [], error: 'offline' }] });
      },
    } as typeof services.extensions;
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    await expect(registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('external-required') } },
    });
  });

  it('fails workspace bootstrap when required native capabilities are unavailable', async () => {
    const { services } = createHarnessServices();
    services.extensions = {
      ...services.extensions,
      async runtimePolicySnapshot() {
        return ok({ ready: false, policies: [
          { priority: 'P1', id: 'session-start:ask-matt', resourceId: 'ask-matt', resolvedResourceId: 'agents-skills/ask-matt', resourceType: 'skill', mandatory: true, enforcement: 'EVERY_SESSION', directive: 'Load ask-matt.', source: 'configured', available: true },
          { priority: 'P2', id: 'code:pre-edit-context', resourceId: 'native-thai-rag', resourceType: 'capability', mandatory: true, enforcement: 'SAFETY_PRE_CHECK', directive: 'Use native Thai-RAG.', source: 'configured', available: false },
        ] });
      },
    } as typeof services.extensions;
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    await expect(registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('Required native capability') } },
    });
  });

  it('scopes native index status through active workspace', async () => {
    const { services, nativeRagCalls, nativeRagArguments } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, {
      harnessActivationLedger: new HarnessActivationLedger(),
      activeWorkspaceScopeProvider,
    });

    const result = await registry.invoke('rag_index_status', { workspaceId: 'workspace-1', jobId: 'idx_umcp_test' });
    expect(result.isError).not.toBe(true);
    expect(nativeRagCalls).toEqual(['index_status']);
    expect(nativeRagArguments[0]).toEqual({ tool: 'index_status', args: { job_id: 'idx_umcp_test', workspace_id: 'workspace-1' } });
  });

  it('maps working-memory categories to canonical Thai-RAG event types', async () => {
    const { services, nativeRagCalls, nativeRagArguments } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    for (const entityType of ['decision', 'requirement', 'constraint', 'preference', 'milestone', 'handoff', 'root_cause_fix', 'explicit_remember']) {
      expect((await registry.invoke('working_memory_record', { workspaceId: 'workspace-1', name: entityType, entityType, observations: ['value'] })).isError).not.toBe(true);
    }
    expect((await registry.invoke('working_memory_record', { workspaceId: 'workspace-1', name: 'default', observations: ['value'] })).isError).not.toBe(true);
    const rejected = await registry.invoke('working_memory_record', { workspaceId: 'workspace-1', name: 'invalid', entityType: 'hypothesis', observations: ['value'] });

    expect(rejected).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT', details: { reason: 'unsupported-event-type', entityType: 'hypothesis' } } } });
    expect(nativeRagCalls).toHaveLength(9);
    expect(nativeRagArguments.map(({ args }) => args.event_type)).toEqual([
      'decision', 'requirement', 'constraint', 'preference', 'milestone', 'handoff', 'root_cause_fix', 'explicit_remember', 'explicit_remember',
    ]);
    expect(nativeRagArguments[0]?.args).toMatchObject({
      workspace_id: 'workspace-1',
      event_type: 'decision',
      content: '[decision] decision\n- value',
    });
  });

  it('exposes curated native working-memory tools after bootstrap', async () => {
    const { services, nativeRagCalls } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, {
      harnessActivationLedger: new HarnessActivationLedger(),
      activeWorkspaceScopeProvider: async (): Promise<{ readonly workspaceId: string; readonly rootPath: string }> => ({ workspaceId: 'workspace-1', rootPath: '/tmp/workspace-1' }),
    });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    const searched = await registry.invoke('working_memory_search', { workspaceId: 'workspace-1', query: 'current task' });
    expect(searched.isError).not.toBe(true);
    const recorded = await registry.invoke('working_memory_record', {
      workspaceId: 'workspace-1',
      name: 'goal:workspace-1',
      observations: ['Implemented harness bootstrap'],
    });
    expect(recorded.isError).not.toBe(true);
    expect(nativeRagCalls).toEqual(['recall', 'record_event']);
  });

  it('re-bootstraps and re-runs pre-edit checks when AGENTS.md changes', async () => {
    const { services, setAgentsMd, writes, childCalls, nativeRagCalls, bootstrapEvents } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    expect((await registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const before = true;\n',
    })).isError).not.toBe(true);
    setAgentsMd('# Rules\nChanged policy.\n');

    const changed = await registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const changed = true;\n',
    });
    expect(changed.isError).not.toBe(true);
    expect(writes).toEqual(['src/app.ts', 'src/app.ts']);
    expect(childCalls).toEqual([]);
    expect(nativeRagCalls).toEqual(['pre_edit_context', 'pre_edit_context']);
    expect(bootstrapEvents.filter((entry) => entry === 'mandatory_mcp')).toHaveLength(2);
  });
});

describe('pre-edit readiness gate (#346 U10)', () => {
  it('refuses to authorize when the provider reports degraded evidence', async () => {
    const { services, setThaiRagPreEditPayload } = createHarnessServices();
    setThaiRagPreEditPayload({
      status: 'degraded',
      can_proceed: false,
      evidence_state: 'code_index_unknown',
      evidence: { code_index: 'unknown', storage: 'available', cpg: 'available' },
    });
    const registry = new ToolRegistry(services, actor, {
      harnessActivationLedger: new HarnessActivationLedger(),
      sessionId: 'readiness-gate-session',
      activeWorkspaceScopeProvider,
    });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    await expect(registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1',
      filePath: 'src/gated.ts',
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('evidence') } },
    });
  });

  async function prepareWithPayload(
    payload: Record<string, unknown> | undefined,
    filePath: string,
    arrange?: (fixture: {
      setFileContent(path: string, content: string): void;
      setFileMissing(path: string): void;
    }) => void,
  ): Promise<{
    result: Awaited<ReturnType<ToolRegistry['invoke']>>;
    nativeRagArguments: Array<{ tool: string; args: Readonly<Record<string, unknown>> }>;
  }> {
    const fixture = createHarnessServices();
    fixture.setThaiRagPreEditPayload(payload);
    arrange?.(fixture);
    const registry = new ToolRegistry(fixture.services, actor, {
      harnessActivationLedger: new HarnessActivationLedger(),
      sessionId: 'readiness-gate-session',
      activeWorkspaceScopeProvider,
    });
    await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' });
    const result = await registry.invoke('prepare_code_change', { workspaceId: 'workspace-1', filePath });
    return { result, nativeRagArguments: fixture.nativeRagArguments };
  }

  it('refuses a transport-ready verdict that does not prove target freshness', async () => {
    const { result } = await prepareWithPayload({
      status: 'ok',
      can_proceed: true,
      evidence_state: 'evidence_available',
      target_sha256: 'b'.repeat(64),
    }, 'src/stale.ts');

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('evidence_fresh') } },
    });
  });

  it('refuses a ready verdict that does not name the analyzed target', async () => {
    const { result } = await prepareWithPayload({
      status: 'ok',
      can_proceed: true,
      evidence_state: 'evidence_available',
      evidence_fresh: true,
    }, 'src/unnamed.ts');

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('target') } },
    });
  });

  it('refuses a ready verdict with a malformed target identity', async () => {
    const { result } = await prepareWithPayload({
      status: 'ok',
      can_proceed: true,
      evidence_state: 'evidence_available',
      evidence_fresh: true,
      target_sha256: 'not-a-digest',
    }, 'src/malformed.ts');

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('target') } },
    });
  });

  it('authorizes a ready verdict that proves freshness for a named target', async () => {
    const { result } = await prepareWithPayload({
      status: 'ok',
      can_proceed: true,
      evidence_state: 'evidence_available',
      evidence_fresh: true,
      target_sha256: hashHarnessText('bound content'),
    }, 'src/bound.ts', (fixture) => fixture.setFileContent('src/bound.ts', 'bound content'));

    expect(result.isError).not.toBe(true);
  });

  it('refuses a ready verdict whose identity no longer matches the target content', async () => {
    const { result } = await prepareWithPayload({
      status: 'ok',
      can_proceed: true,
      evidence_state: 'evidence_available',
      evidence_fresh: true,
      target_sha256: hashHarnessText('the content the provider analyzed'),
    }, 'src/stale-target.ts', (fixture) => fixture.setFileContent('src/stale-target.ts', 'what the target holds now'));

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: {
        code: 'CONFLICT',
        message: expect.stringContaining('stale'),
        details: { reason: 'pre-edit-target-stale' },
      } },
    });
  });

  it('refuses a ready verdict when the admitted target cannot be read', async () => {
    const { result } = await prepareWithPayload({
      status: 'ok',
      can_proceed: true,
      evidence_state: 'evidence_available',
      evidence_fresh: true,
      target_sha256: hashHarnessText('unreadable content'),
    }, 'src/gone.ts', (fixture) => fixture.setFileMissing('src/gone.ts'));

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: {
        code: 'CONFLICT',
        message: expect.stringContaining('cannot be read'),
        details: { reason: 'pre-edit-target-unreadable' },
      } },
    });
  });

  it('refuses an absolute target outside the active workspace root', async () => {
    const { result, nativeRagArguments } = await prepareWithPayload(undefined, '/tmp/other/outside.ts');

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: {
        code: 'CONFLICT',
        message: expect.stringContaining('outside the active workspace'),
        details: { reason: 'target-outside-workspace' },
      } },
    });
    expect(nativeRagArguments).toEqual([]);
  });

  it('refuses a relative target that escapes the active workspace root', async () => {
    const { result, nativeRagArguments } = await prepareWithPayload(undefined, '../../etc/passwd');

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: {
        code: 'CONFLICT',
        message: expect.stringContaining('outside the active workspace'),
        details: { reason: 'target-outside-workspace' },
      } },
    });
    expect(nativeRagArguments).toEqual([]);
  });

  it('normalizes an absolute target inside the active workspace before asking the provider', async () => {
    const { result, nativeRagArguments } = await prepareWithPayload(undefined, '/tmp/workspace-1/src/inside.ts');

    expect(result.isError).not.toBe(true);
    expect(nativeRagArguments).toEqual([
      { tool: 'pre_edit_context', args: { file_path: 'src/inside.ts', workspace_id: 'workspace-1' } },
    ]);
  });

  it('refuses a ready verdict when the admitted source view moved while evidence was prepared', async () => {
    const { result } = await prepareWithPayload({
      status: 'ok',
      can_proceed: true,
      evidence_state: 'evidence_available',
      evidence_fresh: true,
      target_sha256: hashHarnessText('// src/moved.ts\n'),
    }, 'src/moved.ts', (fixture) => fixture.setHeadOnPreEdit('b'.repeat(40)));

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: {
        code: 'CONFLICT',
        message: expect.stringContaining('source view'),
        details: { reason: 'pre-edit-source-view-changed' },
      } },
    });
  });

  it('authorizes a ready verdict while the admitted source view stays put', async () => {
    const { result } = await prepareWithPayload({
      status: 'ok',
      can_proceed: true,
      evidence_state: 'evidence_available',
      evidence_fresh: true,
      target_sha256: hashHarnessText('// src/steady.ts\n'),
    }, 'src/steady.ts');

    expect(result.isError).not.toBe(true);
  });

  it('returns a bounded exact-input preparation receipt for an authorized path', async () => {
    const { result } = await prepareWithPayload({
      status: 'ok',
      can_proceed: true,
      evidence_state: 'evidence_available',
      evidence_fresh: true,
      target_sha256: hashHarnessText('// src/receipt.ts\n'),
    }, 'src/receipt.ts');

    expect(result).toMatchObject({
      structuredContent: {
        ready: true,
        filePath: 'src/receipt.ts',
        preparationReceipt: {
          path: 'src/receipt.ts',
          workspaceId: 'workspace-1',
          targetContentHash: hashHarnessText('// src/receipt.ts\n'),
          sourceIdentity: { workspaceHead: 'a'.repeat(40), dirtyFingerprint: 'dirty-1' },
          evidenceProviderId: 'thai-rag',
          evidenceIndexGeneration: 1,
          evidenceState: 'evidence_available',
          checks: ['thai-rag/pre_edit_context'],
          preparedAt: expect.any(String),
        },
      },
    });
  });

  it('surfaces degraded per-channel evidence when refusing an unready verdict', async () => {
    const { result } = await prepareWithPayload({
      status: 'degraded',
      can_proceed: false,
      evidence_state: 'semantic_missing',
      evidence: {
        semantic: 'missing',
        channels: { parent: 'ok', lexical: 'ok', structural: 'ok', vector: 'missing' },
      },
    }, 'src/channel-degraded.ts');

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: {
        code: 'CONFLICT',
        message: expect.stringContaining('can_proceed'),
        details: {
          reason: 'pre-edit-evidence-not-ready',
          evidenceState: 'semantic_missing',
          evidenceSemantic: 'missing',
          evidenceChannelStates: 'lexical=ok,parent=ok,structural=ok,vector=missing',
        },
      } },
    });
  });

  it('refuses a verdict whose semantic channel is not current even when the envelope claims ready', async () => {
    const { result } = await prepareWithPayload({
      status: 'ok',
      can_proceed: true,
      evidence_state: 'evidence_available',
      evidence_fresh: true,
      target_sha256: hashHarnessText('// src/degraded-channel.ts\n'),
      evidence: {
        semantic: 'degraded',
        channels: { parent: 'ok', lexical: 'ok', structural: 'ok', vector: 'degraded' },
      },
    }, 'src/degraded-channel.ts');

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: {
        code: 'CONFLICT',
        message: expect.stringContaining('semantic'),
        details: {
          reason: 'pre-edit-evidence-not-ready',
          evidenceSemantic: 'degraded',
          evidenceChannelStates: 'lexical=ok,parent=ok,structural=ok,vector=degraded',
        },
      } },
    });
  });

  it('records per-channel evidence on the preparation receipt when the envelope carries it', async () => {
    const { result } = await prepareWithPayload({
      status: 'ok',
      can_proceed: true,
      evidence_state: 'semantic_available',
      evidence_fresh: true,
      target_sha256: hashHarnessText('// src/channel-receipt.ts\n'),
      evidence: {
        semantic: 'available',
        channels: { parent: 'ok', lexical: 'ok', structural: 'ok', vector: 'ok' },
      },
    }, 'src/channel-receipt.ts');

    expect(result).toMatchObject({
      structuredContent: {
        ready: true,
        filePath: 'src/channel-receipt.ts',
        preparationReceipt: {
          evidenceState: 'semantic_available',
          evidenceSemantic: 'available',
          evidenceChannels: { parent: 'ok', lexical: 'ok', structural: 'ok', vector: 'ok' },
        },
      },
    });
  });

  it('accepts a lexical-only code view as current evidence (issue #463)', async () => {
    const { result } = await prepareWithPayload({
      status: 'ok',
      can_proceed: true,
      evidence_state: 'evidence_available',
      evidence_fresh: true,
      target_sha256: hashHarnessText('// src/lexical-only.ts\n'),
      evidence: {
        semantic: 'lexical_only',
        channels: { parent: 'ok', lexical: 'ok', structural: 'ok', vector: 'lexical_only' },
      },
    }, 'src/lexical-only.ts');

    // Code indexing is FTS5-first: a view that never requested vectors is
    // current for the channel it claims. Only `missing`/`degraded` refuse.
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ready: true,
      preparationReceipt: {
        evidenceState: 'evidence_available',
        evidenceSemantic: 'lexical_only',
        evidenceChannels: { parent: 'ok', lexical: 'ok', structural: 'ok', vector: 'lexical_only' },
      },
    });
  });

  it('keeps the receipt free of per-channel fields when the envelope does not carry them', async () => {
    const { result } = await prepareWithPayload({
      status: 'ok',
      can_proceed: true,
      evidence_state: 'evidence_available',
      evidence_fresh: true,
      target_sha256: hashHarnessText('// src/legacy-envelope.ts\n'),
    }, 'src/legacy-envelope.ts');

    expect(result.isError).not.toBe(true);
    const receipt = (result.structuredContent as Record<string, unknown>).preparationReceipt as Record<string, unknown>;
    expect('evidenceSemantic' in receipt).toBe(false);
    expect('evidenceChannels' in receipt).toBe(false);
  });
});

/**
 * Demand-first pre-edit submission (#346 behaviour 5, Slice A).
 *
 * When the provider refuses with a refreshable missing/stale/degraded
 * channel, the registry submits one bounded P0 scoped-delta job through the
 * #145 waiter queue (promoted to the head) and still fails closed: the path
 * is not prepared, and the CONFLICT envelope gains flat `submission*`
 * details describing what was submitted. Undemandable verdicts (malformed
 * envelopes, permanently unavailable channels) submit nothing.
 */
interface DemandContext {
  readonly deltaArgs: ReadonlyArray<Record<string, unknown>>;
  readonly settleDeltas: () => void;
  readonly setPayload: (payload: Record<string, unknown> | undefined) => void;
  readonly preEditStates: string[];
}

function createDemandFixture(
  initialPayload: Record<string, unknown> | undefined,
  options: { queueLimit?: number; cost?: number; waitTimeoutMs?: number } = { cost: 16, waitTimeoutMs: 60 },
): {
  fixture: ReturnType<typeof createHarnessServices>;
  registry: ToolRegistry;
  context: DemandContext;
} {
  const fixture = createHarnessServices();
  const deltaArgs: Array<Record<string, unknown>> = [];
  const preEditStates: string[] = [];
  let currentPayload = initialPayload;
  const waiters = new Array<(value: unknown) => void>();
  const thaiRag = fixture.services.thaiRag as unknown as {
    call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  };
  const baseCall = thaiRag.call.bind(fixture.services.thaiRag);
  thaiRag.call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    if (tool === 'code_index') {
      deltaArgs.push(args);
      return new Promise((resolve) => { waiters.push(resolve); });
    }
    if (tool === 'pre_edit_context') {
      preEditStates.push(String((currentPayload as { evidence_state?: unknown } | undefined)?.evidence_state ?? 'missing'));
      if (currentPayload !== undefined) {
        return ok({ content: [{ type: 'text', text: JSON.stringify(currentPayload) }] });
      }
    }
    return await baseCall(tool, args);
  };
  const controller = new ResourceAdmissionController({
    globalCost: options.cost,
    workspaceCost: options.cost,
    sessionCost: options.cost,
    maxOperations: 4,
    resourceClassCost: { rag_indexing: options.cost },
  });
  const registry = new ToolRegistry(fixture.services, actor, {
    harnessActivationLedger: new HarnessActivationLedger(),
    sessionId: 'demand-first-session',
    activeWorkspaceScopeProvider,
    resourceAdmissionController: controller,
    ragIndexAdmissionCost: options.cost ?? 16,
    ...(options.queueLimit === undefined ? {} : { preEditDemandQueueLimit: options.queueLimit }),
    ...(options.waitTimeoutMs === undefined ? {} : { preEditDemandWaitTimeoutMs: options.waitTimeoutMs }),
  });
  const context: DemandContext = {
    deltaArgs,
    settleDeltas: () => {
      for (const resolve of waiters.splice(0)) resolve(ok({ indexed: true }));
    },
    setPayload: (payload) => {
      currentPayload = payload;
    },
    preEditStates,
  };
  return { fixture, registry, context };
}

function errorDetails(result: { isError?: boolean; structuredContent?: unknown }): Record<string, unknown> {
  const content = result.structuredContent as { error?: { details?: Record<string, unknown> } };
  return (content.error?.details ?? {}) as Record<string, unknown>;
}

describe('demand-first pre-edit submission (Slice A)', () => {
  const demandablePayload = (): Record<string, unknown> => ({
    status: 'degraded',
    can_proceed: false,
    evidence_state: 'semantic_missing',
    evidence: {
      semantic: 'missing',
      channels: { parent: 'ok', lexical: 'ok', structural: 'ok', vector: 'missing' },
    },
  });

  it('submits a bounded blocked delta for a refreshable channel and stays fail-closed', async () => {
    const { registry, context } = createDemandFixture(demandablePayload());
    await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' });

    const result = await registry.invoke('prepare_code_change', { workspaceId: 'workspace-1', filePath: 'src/demand-delta.ts' });
    const details = errorDetails(result as { isError?: boolean; structuredContent?: unknown });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(details).toMatchObject({
      reason: 'pre-edit-evidence-not-ready',
      evidenceState: 'semantic_missing',
      submissionPaths: 'src/demand-delta.ts',
      submissionMaxFiles: expect.any(Number),
      submissionQueueState: expect.stringMatching(/^(admitted|queued)$/),
    });
    expect(String(details.submissionOperationId)).toMatch(/^pre-edit:workspace-1:/);

    // The demand work actually runs (bounded: target path only, capped).
    expect(context.deltaArgs.length).toBe(1);
    expect(context.deltaArgs[0]).toMatchObject({
      workspace_id: 'workspace-1',
      paths: ['src/demand-delta.ts'],
      max_files: expect.any(Number),
    });
    context.settleDeltas();
  });

  it('submits nothing for an undemandable refusal', async () => {
    const payload = {
      status: 'degraded',
      can_proceed: false,
      evidence_state: 'semantic_missing',
      evidence: {
        semantic: 'missing',
        channels: { parent: 'unavailable', lexical: 'ok', structural: 'ok', vector: 'unavailable' },
      },
    };
    const { registry, context } = createDemandFixture(payload);
    await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' });

    const result = await registry.invoke('prepare_code_change', { workspaceId: 'workspace-1', filePath: 'src/nondemand.ts' });
    const details = errorDetails(result as { isError?: boolean; structuredContent?: unknown });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(details).toMatchObject({ reason: 'pre-edit-evidence-not-ready', evidenceState: 'semantic_missing' });
    expect('submissionOperationId' in details).toBe(false);
    expect(context.deltaArgs.length).toBe(0);
  });

  it('coalesces a repeat request while the same delta is in flight', async () => {
    const { registry, context } = createDemandFixture(demandablePayload());
    await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' });

    const first = await registry.invoke('prepare_code_change', { workspaceId: 'workspace-1', filePath: 'src/coalesce.ts' });
    const firstDetails = errorDetails(first as { isError?: boolean; structuredContent?: unknown });
    expect(firstDetails.submissionQueueState).toBe('admitted');
    expect(context.deltaArgs.length).toBe(1);

    const second = await registry.invoke('prepare_code_change', { workspaceId: 'workspace-1', filePath: 'src/coalesce.ts' });
    const secondDetails = errorDetails(second as { isError?: boolean; structuredContent?: unknown });

    expect(secondDetails.submissionOperationId).toEqual(firstDetails.submissionOperationId);
    expect(secondDetails.submissionQueueState).toBe('coalesced');
    expect(context.deltaArgs.length).toBe(1); // one bounded delta, not one per attempt
    context.settleDeltas();
  });

  it('refuses a submission once the demand queue is full and stays fail-closed', async () => {
    const { registry, context } = createDemandFixture(demandablePayload(), { queueLimit: 1, cost: 1 });
    await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' });

    const first = await registry.invoke('prepare_code_change', { workspaceId: 'workspace-1', filePath: 'src/full-a.ts' });
    const firstDetails = errorDetails(first as { isError?: boolean; structuredContent?: unknown });
    expect(firstDetails.submissionQueueState).toBe('admitted');
    expect(context.deltaArgs.length).toBe(1);

    const second = await registry.invoke('prepare_code_change', { workspaceId: 'workspace-1', filePath: 'src/full-b.ts' });
    const secondDetails = errorDetails(second as { isError?: boolean; structuredContent?: unknown });
    expect(secondDetails.submissionQueueState).toBe('queued');

    const third = await registry.invoke('prepare_code_change', { workspaceId: 'workspace-1', filePath: 'src/full-c.ts' });
    const thirdDetails = errorDetails(third as { isError?: boolean; structuredContent?: unknown });
    expect(thirdDetails.submissionQueueState).toBe('rejected');
    expect(thirdDetails.reason).toBe('pre-edit-evidence-not-ready');

    expect(context.deltaArgs.length).toBe(1);
    context.settleDeltas();
  });
});

describe('demand-first wait + re-check (Slice B)', () => {
  const notReadyPayload = (): Record<string, unknown> => ({
    status: 'degraded',
    can_proceed: false,
    evidence_state: 'semantic_missing',
    evidence: {
      semantic: 'missing',
      channels: { parent: 'ok', lexical: 'ok', structural: 'ok', vector: 'missing' },
    },
  });

  const READY_TARGET = 'bound content';

  it('waits for the target delta, re-checks, and authorizes when evidence becomes ready', async () => {
    const { fixture, registry, context } = createDemandFixture(notReadyPayload(), { cost: 16, waitTimeoutMs: 400 });
    fixture.setFileContent('src/demand-wait.ts', READY_TARGET);
    await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' });

    const first = await registry.invoke('prepare_code_change', { workspaceId: 'workspace-1', filePath: 'src/demand-wait.ts' });
    expect((first as { isError?: boolean }).isError).toBe(true);
    expect(context.deltaArgs.length).toBe(1);

    // A later prepare for the SAME target waits bounded for only that target's
    // own delta, then re-reads evidence once and re-checks (D2).
    const pending = registry.invoke('prepare_code_change', { workspaceId: 'workspace-1', filePath: 'src/demand-wait.ts' });
    await new Promise((resolve) => setImmediate(resolve)); // its probe must see the degraded verdict first
    context.setPayload({
      status: 'ok',
      can_proceed: true,
      evidence_state: 'evidence_available',
      evidence_fresh: true,
      target_sha256: hashHarnessText(READY_TARGET),
    });
    context.settleDeltas();
    const second = await pending;

    expect((second as { isError?: boolean }).isError).not.toBe(true);
    const body = (second as { structuredContent?: { ready?: boolean; preparationReceipt?: { evidenceState?: string } } }).structuredContent ?? {};
    expect(body.ready).toBe(true);
    expect(body.preparationReceipt?.evidenceState).toBe('evidence_available');
    // Proof of the wait→re-check chain: probe, degraded probe, ready re-check.
    expect(context.preEditStates).toEqual(['semantic_missing', 'semantic_missing', 'evidence_available']);
    expect(context.deltaArgs.length).toBe(1); // the success path submits nothing extra
  });

  it('fails closed with the bounded-wait outcome recorded when the delta does not settle', async () => {
    const { registry, context } = createDemandFixture(notReadyPayload(), { cost: 16, waitTimeoutMs: 50 });
    await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' });

    const first = await registry.invoke('prepare_code_change', { workspaceId: 'workspace-1', filePath: 'src/wait-timeout.ts' });
    const firstDetails = errorDetails(first as { isError?: boolean; structuredContent?: unknown });
    expect(firstDetails.submissionQueueState).toBe('admitted');
    expect(context.deltaArgs.length).toBe(1);

    const second = await registry.invoke('prepare_code_change', { workspaceId: 'workspace-1', filePath: 'src/wait-timeout.ts' });
    const details = errorDetails(second as { isError?: boolean; structuredContent?: unknown });

    expect((second as { isError?: boolean }).isError).toBe(true);
    expect(details).toMatchObject({
      reason: 'pre-edit-evidence-not-ready',
      submissionOperationId: firstDetails.submissionOperationId,
      submissionQueueState: 'coalesced',
      submissionWaitOutcome: 'timeout',
    });
    expect(context.deltaArgs.length).toBe(1); // no duplicate delta piled on timeout
    context.settleDeltas();
  });
});



describe('prepare_code_change active scope resolution (#428)', () => {
  const primaryScope: WorkspaceScope = { workspaceId: 'workspace-1', rootPath: '/tmp/workspace-1' };

  async function prepareWithScopeWiring(
    wiring: {
      activeWorkspaceScopesProvider?: () => readonly WorkspaceScope[] | Promise<readonly WorkspaceScope[]>;
      activeWorkspaceScopeUnavailableProvider?: () => WorkspaceScopeUnavailable | null | Promise<WorkspaceScopeUnavailable | null>;
      workspaceId?: string;
    },
    filePath: string,
    arrange?: (fixture: ReturnType<typeof createHarnessServices>) => void,
  ): Promise<{
    result: Awaited<ReturnType<ToolRegistry['invoke']>>;
    nativeRagArguments: Array<{ tool: string; args: Readonly<Record<string, unknown>> }>;
  }> {
    const { workspaceId = 'workspace-1', ...providers } = wiring;
    const fixture = createHarnessServices();
    arrange?.(fixture);
    const registry = new ToolRegistry(fixture.services, actor, {
      harnessActivationLedger: new HarnessActivationLedger(),
      sessionId: 'scope-wiring-session',
      ...providers,
    });
    await registry.invoke('workspace_bootstrap', { workspaceId });
    const result = await registry.invoke('prepare_code_change', { workspaceId, filePath });
    return { result, nativeRagArguments: fixture.nativeRagArguments };
  }

  it('normalizes an absolute target inside the primary scope when only the plural provider is wired', async () => {
    const { result, nativeRagArguments } = await prepareWithScopeWiring(
      { activeWorkspaceScopesProvider: async () => [primaryScope] },
      '/tmp/workspace-1/src/absolute.ts',
    );

    expect(result.isError).not.toBe(true);
    expect(nativeRagArguments[0]).toMatchObject({ tool: 'pre_edit_context', args: { file_path: 'src/absolute.ts' } });
  });

  it('keeps the relative form working against the same scope', async () => {
    const { result, nativeRagArguments } = await prepareWithScopeWiring(
      { activeWorkspaceScopesProvider: async () => [primaryScope] },
      'src/absolute.ts',
    );

    expect(result.isError).not.toBe(true);
    expect(nativeRagArguments[0]).toMatchObject({ args: { file_path: 'src/absolute.ts' } });
  });

  it('normalizes an absolute target against a secondary active project (#430)', async () => {
    const secondaryScope: WorkspaceScope = { workspaceId: 'workspace-2', rootPath: '/tmp/workspace-2' };
    const { result, nativeRagArguments } = await prepareWithScopeWiring(
      { activeWorkspaceScopesProvider: async () => [primaryScope, secondaryScope], workspaceId: 'workspace-2' },
      '/tmp/workspace-2/src/secondary.ts',
    );

    expect(result.isError).not.toBe(true);
    expect(nativeRagArguments[0]).toMatchObject({ tool: 'pre_edit_context', args: { file_path: 'src/secondary.ts' } });
  });

  it('keeps the relative form of a secondary active project target unchanged (#430)', async () => {
    const secondaryScope: WorkspaceScope = { workspaceId: 'workspace-2', rootPath: '/tmp/workspace-2' };
    const { result, nativeRagArguments } = await prepareWithScopeWiring(
      { activeWorkspaceScopesProvider: async () => [primaryScope, secondaryScope], workspaceId: 'workspace-2' },
      'src/secondary.ts',
    );

    expect(result.isError).not.toBe(true);
    expect(nativeRagArguments[0]).toMatchObject({ args: { file_path: 'src/secondary.ts' } });
  });

  it('still refuses an absolute target outside the secondary active project root (#430)', async () => {
    const secondaryScope: WorkspaceScope = { workspaceId: 'workspace-2', rootPath: '/tmp/workspace-2' };
    const { result, nativeRagArguments } = await prepareWithScopeWiring(
      { activeWorkspaceScopesProvider: async () => [primaryScope, secondaryScope], workspaceId: 'workspace-2' },
      '/tmp/elsewhere/src/primary.ts',
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', details: { reason: 'target-outside-workspace' } } },
    });
    expect(nativeRagArguments).toEqual([]);
  });

  it('fails closed instead of falling back to the primary root for a workspace outside the active set (#430)', async () => {
    const { result, nativeRagArguments } = await prepareWithScopeWiring(
      {
        activeWorkspaceScopesProvider: async () => [primaryScope],
        workspaceId: 'goal-worktree-1',
      },
      '/tmp/goal-worktree-1/src/worktree.ts',
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'CONFLICT',
          details: { reason: 'target-path-unresolvable', scopeReason: 'workspace-not-active' },
          message: expect.stringContaining('the requested workspace (goal-worktree-1) is not an active project'),
        },
      },
    });
    expect(nativeRagArguments).toEqual([]);
  });

  it('refuses an absolute target that escapes the primary scope', async () => {
    const { result, nativeRagArguments } = await prepareWithScopeWiring(
      { activeWorkspaceScopesProvider: async () => [primaryScope] },
      '/tmp/elsewhere/src/absolute.ts',
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', details: { reason: 'target-outside-workspace' } } },
    });
    expect(nativeRagArguments).toEqual([]);
  });

  it('refuses a relative target that escapes the primary scope', async () => {
    const { result } = await prepareWithScopeWiring(
      { activeWorkspaceScopesProvider: async () => [primaryScope] },
      '../outside.ts',
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', details: { reason: 'target-outside-workspace' } } },
    });
  });

  it.each([
    [{ reason: 'no-active-selection' } as WorkspaceScopeUnavailable, 'no active project workspace is selected', 'workspace-1'],
    [{ reason: 'workspace-row-missing', workspaceId: 'workspace-9' } as WorkspaceScopeUnavailable, 'the selected workspace (workspace-9) no longer exists', 'workspace-9'],
    [{ reason: 'workspace-archived', workspaceId: 'workspace-9' } as WorkspaceScopeUnavailable, 'the selected workspace (workspace-9) is archived', 'workspace-9'],
  ])('names the real cause when no scope exists: %o', async (unavailable, detail, workspaceId) => {
    const { result } = await prepareWithScopeWiring({
      activeWorkspaceScopesProvider: async () => [],
      activeWorkspaceScopeUnavailableProvider: async () => unavailable,
      workspaceId,
    }, '/tmp/anywhere/src/absolute.ts');

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'CONFLICT',
          details: { reason: 'target-path-unresolvable', scopeReason: unavailable.reason },
          message: expect.stringContaining(detail),
        },
      },
    });
  });

  it('does not reuse a host reason that describes a different workspace (#430)', async () => {
    const { result } = await prepareWithScopeWiring({
      activeWorkspaceScopesProvider: async () => [],
      activeWorkspaceScopeUnavailableProvider: async () => ({ reason: 'workspace-archived', workspaceId: 'workspace-1' }),
      workspaceId: 'workspace-9',
    }, '/tmp/workspace-9/src/absolute.ts');

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'CONFLICT',
          details: { reason: 'target-path-unresolvable', scopeReason: 'workspace-not-active' },
          message: expect.stringContaining('the requested workspace (workspace-9) is not an active project'),
        },
      },
    });
  });

  it('names a documentation target when the code index cannot cover it', async () => {
    const { result } = await prepareWithScopeWiring(
      { activeWorkspaceScopesProvider: async () => [primaryScope] },
      'README.md',
      (fixture) => fixture.setThaiRagPreEditPayload({
        status: 'degraded',
        can_proceed: false,
        evidence_state: 'code_index_missing',
        evidence: { storage: 'available', code_index: 'missing', cpg: 'available' },
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          details: { targetKind: 'documentation', evidenceState: 'code_index_missing' },
          message: expect.stringContaining('documentation target'),
        },
      },
    });
  });

  it('keeps the generic message when the host cannot name a cause', async () => {
    const { result } = await prepareWithScopeWiring(
      {},
      '/tmp/workspace-1/src/absolute.ts',
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          details: { reason: 'target-path-unresolvable' },
          message: expect.stringContaining('Absolute target does not resolve against an active workspace'),
        },
      },
    });
    expect(result.structuredContent).not.toMatchObject({
      error: { details: { scopeReason: expect.anything() } },
    });
  });
});
