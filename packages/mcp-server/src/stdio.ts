import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { createMcpServer, type McpServerOptions } from './server.js';
import { ModernTasksProtocol } from './modern-tasks-protocol.js';
import { createModernTasksTransport } from './modern-tasks-transport.js';
import { SetOfMarksObservationStore } from './set-of-marks-service.js';
import { IncrementalVerifier } from './incremental-verifier.js';
import { RunBudgetGuard } from './run-budget.js';
import { PonytailActivationLedger } from './ponytail-runtime.js';
import { HarnessActivationLedger } from './harness-runtime.js';
import { TurnPersistenceLedger } from './turn-persistence.js';
import { createStdioRequestScope } from './request-scope.js';
import { createTrustedHostMutationApprovalProvider } from './trusted-host-approval.js';

export interface McpStdioOptions extends McpServerOptions {
  readonly onError?: (error: Error) => void;
}

type HostMutationApprovalProvider = NonNullable<McpServerOptions['hostMutationApprovalProvider']>;

export function isBenignStdioPipeError(error: Error): boolean {
  return /EPIPE|ECONNRESET|broken pipe/i.test(error.message);
}

export function resolveStdioHostMutationApprovalProvider(
  configured: McpServerOptions['hostMutationApprovalProvider'],
  factory: () => HostMutationApprovalProvider = createTrustedHostMutationApprovalProvider,
): HostMutationApprovalProvider {
  return configured ?? factory();
}

function writeStdioDiagnostic(error: Error): void {
  if (isBenignStdioPipeError(error)) {
    process.stderr.write(`unified-mpc MCP stdio: peer closed (${error.message})\n`);
    return;
  }
  process.stderr.write(`unified-mpc MCP stdio error: ${error.message}\n`);
}

export function startMcpStdio(options: McpStdioOptions): StdioServerHandle {
  const runBudgetGuard = options.runBudgetGuard ?? new RunBudgetGuard();
  const incrementalVerifier = options.incrementalVerifier ?? new IncrementalVerifier();
  const setOfMarksStore = options.setOfMarksStore ?? new SetOfMarksObservationStore();
  const ponytailActivationLedger = options.ponytailActivationLedger ?? new PonytailActivationLedger();
  const harnessActivationLedger = options.harnessActivationLedger ?? new HarnessActivationLedger();
  const turnPersistenceLedger = options.turnPersistenceLedger ?? new TurnPersistenceLedger();
  const requestScope = options.requestScope ?? createStdioRequestScope();
  const hostMutationApprovalProvider = resolveStdioHostMutationApprovalProvider(options.hostMutationApprovalProvider);
  const modernTasks = new ModernTasksProtocol(options.services, { actor: options.actor });
  const transport = createModernTasksTransport(new StdioServerTransport(), modernTasks);
  return serveStdio(
    (context) => createMcpServer({
      ...options,
      hostMutationApprovalProvider,
      runBudgetGuard,
      incrementalVerifier,
      setOfMarksStore,
      ponytailActivationLedger,
      harnessActivationLedger,
      turnPersistenceLedger,
      legacyTasksProtocol: context.era === 'legacy',
      turnPersistenceMode: options.turnPersistenceMode ?? (context.era === 'legacy' ? 'best_effort' : 'required'),
      requestScope,
    }),
    { legacy: 'serve', onerror: options.onError ?? writeStdioDiagnostic, transport },
  );
}
