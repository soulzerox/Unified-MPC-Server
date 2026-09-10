> **Future — not in v0.1.** The Universal Engineering Harness is deferred per ADR 0001 (gateway-first): the gateway carries no agent-execution authority. Required seams: ExecutionPipeline + EventEnvelope (locked in v0.1). Re-entry criteria: harness threat model + turn-limit/cancellation/rollback tests against the seam. Primary source preserved below. Status: docs/FUTURE.md entry 1.

# Universal Engineering Harness — Architecture & Guardrails

The Universal Engineering Harness is the core execution supervisor embedded inside the Unified MCP Server. It intercepts tool calls across every connected consumer (Cursor, Cline, OpenCode, Oh My Pi, Claude Code, Antigravity, Unified CLI, and ChatGPT Web Connector) to enforce software engineering discipline.

## Purpose

A raw language model generates text; an engineering harness turns that model into a reliable software engineer. The harness wraps model execution in automated verification, strict bounds, continuous state tracking, and atomic rollbacks.

## The Five Subsystems

The harness organizes its guarantees into five co-located subsystems:

### 1. Instructions (Context Injection & Constraints)
- **Single Source of Truth**: Compiles and delivers project constraints (`AGENTS.md`, `.clinerules`, `.cursor/rules`, `.omp/system.md`) and mandatory priority tables (P1–P7) into the system prompt of every connected client.
- **Directory Pages**: Generates concise repo maps and symbol indexes so models query focused file paths rather than scanning whole directories.

### 2. Tooling (Safety Sandboxing & PathJail)
- **PathJail**: Enforces file access boundaries. Rejects any attempt to read or write outside the project root (`..` path traversal).
- **Blast Radius Pre-check**: Queries `godkiller` and `thai-rag-mcp` before modifying files to compute dependency edges and affected symbol count. Rejects changes that exceed safety thresholds without explicit confirmation.
- **Protected Operations**: Intercepts destructive shell commands (`rm -rf`, `git reset --hard`, `git push --force`) at the tool gateway.

### 3. Environment (Deterministic Execution)
- **Runtime Discovery**: Detects project build toolchain (`pnpm`, `npm`, `uv`, `cargo`, `go`) and identifies primary test commands.
- **Isolated Execution**: Executes downstream processes with scoped environment variables, preventing access to host credentials.

### 4. State (Continuity & Checkpointing)
- **Continuity Ledger**: Maintains `PROGRESS.md` and P1 `memory` graph entries turn-by-turn to eliminate context-window amnesia.
- **Git Checkpoints**: Automatically creates a temporary git stash or checkpoint branch before running multi-file edits.
- **Rollback Sentinel**: If an execution cycle ends with unrecoverable test failures, automatically reverts to the pre-task git checkpoint.

### 5. Feedback & Verification (Maker-Checker Loop)
- **Generator-Evaluator Split**: The model that generates code never evaluates its own completion. The harness acts as the independent evaluator.
- **Automated Verification Loop**:
  1. Agent writes or modifies code.
  2. Harness triggers linter, typechecker (`tsc`), and test runner (`vitest`, `pytest`).
  3. If verification fails (non-zero exit): extracts exact compiler diagnostics and stack traces, then feeds actionable stderr back to the model for self-correction.
  4. If verification passes: approves task completion and commits state.

## Lifecycle Controls

Inspired by production harness engineering SDKs, every task execution is bounded by explicit limits:

| Control | Default | Action on Exceeded |
|---|---|---|
| Max Turns | 10 turns | Halts execution, reports `MAX_TURNS_EXCEEDED` |
| Tool Timeout | 60 seconds | Sends SIGTERM to downstream process, returns timeout error |
| Token / Cost Budget | Configurable | Terminates loop, prevents infinite model spending |
| Cancellation Token | Active on all calls | Client disconnect or user abort triggers graceful shutdown |

## Seam & Module Interface

The harness lives behind a clean seam in `src/core/harness/`:

```typescript
interface EngineeringHarness {
  // Pre-flight validation before a tool is executed
  preFlight(toolName: string, args: unknown): Promise<PreFlightResult>;

  // Post-flight verification after a tool modifies state
  postFlight(toolName: string, result: unknown): Promise<PostFlightVerification>;

  // Autonomous self-healing execution loop
  runVerifiedTask(spec: TaskSpec): Promise<TaskOutcome>;

  // Rollback to last clean checkpoint
  rollback(checkpointId: string): Promise<void>;
}
```
