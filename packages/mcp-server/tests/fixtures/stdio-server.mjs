/* global process */
import { startMcpStdio } from '../../dist/stdio.js';

const MODERN_TASK_ID = 'modern-stdio-shell-task';
let taskState = 'running';

function snapshot() {
  return {
    task_id: MODERN_TASK_ID,
    state: taskState,
    started_at: '2026-09-07T05:00:00.000Z',
    deadline_at: '2026-09-07T05:10:00.000Z',
    durable: true,
    truncated: false,
    ...(taskState === 'cancelled' ? { finished_at: '2026-09-07T05:01:00.000Z' } : {}),
  };
}

process.stderr.write('unified-mpc-stdio-test-diagnostic\n');
const agentsMd = '# Rules\nUse mandatory child MCP preflight.\n';
const services = {
  file: {
    async readFile(_actor, _workspaceId, request) {
      if (request.path === 'AGENTS.md') return { ok: true, value: { path: request.path, content: agentsMd, startLine: 1, endLine: 2 } };
      return { ok: false, error: { code: 'FILE_NOT_FOUND', message: `missing ${request.path}` } };
    },
    async writeFile(_actor, _workspaceId, request) {
      return { ok: true, value: { path: request.path, replacedExisting: false } };
    },
  },
  thaiRag: {
    async health() {
      return { ok: true, value: { providerId: 'thai-rag', state: 'ready', embeddingIndexGeneration: 1, components: { workerReachable: true, sqliteAvailable: true, ftsAvailable: true, vectorStoreAvailable: true, embedderAvailable: true, lexicalRetrievalAvailable: true, semanticRetrievalAvailable: true, activeJobs: [] } } };
    },
    async call() { return { ok: true, value: { content: [{ type: 'text', text: 'ok' }] } }; },
  },
  extensions: {
    async runtimePolicySnapshot() { return { ok: true, value: { ready: true, policies: [{ priority: 'P1', id: 'session-start:ask-matt', resourceId: 'ask-matt', resolvedResourceId: 'agents-skills/ask-matt', resourceType: 'skill', mandatory: true, enforcement: 'EVERY_SESSION', directive: 'Load ask-matt.', source: 'configured', available: true }] } }; },
    async readSkill(input) { return { ok: true, value: { id: input.skillId, name: 'ask-matt', description: 'Router', source: 'agents-skills', path: '/skills/ask-matt/SKILL.md', content: '# Ask Matt' } }; },
    async bootstrapMandatoryMcpServers() { return { ok: true, value: { ready: true, servers: [] } }; },
  },
  capabilities: {
    async execute(tool, request) {
      if (tool !== 'shell') return { ok: false, error: { code: 'INVALID_INPUT', message: 'unsupported tool' } };
      if (request.operation === 'run') {
        taskState = 'running';
        return { ok: true, value: snapshot() };
      }
      if (request.task_id !== MODERN_TASK_ID) {
        return { ok: false, error: { code: 'PROCESS_NOT_FOUND', message: 'Task was not found' } };
      }
      if (request.operation === 'cancel') taskState = 'cancelled';
      return { ok: true, value: snapshot() };
    },
  },
};

startMcpStdio({
  services,
  actor: { clientId: 'stdio-test', clientName: 'stdio-test' },
  activeWorkspaceScopeProvider: async () => ({ workspaceId: 'workspace-stdio', rootPath: '/tmp/workspace-stdio' }),
});
