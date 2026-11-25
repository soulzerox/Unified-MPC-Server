import { realpath } from 'node:fs/promises';

import {
  CapabilityRegistry,
  CapabilitySupervisor,
  type CapabilityLease,
  type CapabilityManifest,
  type CapabilityManifestInput,
  type CapabilityProcessPort,
  type CapabilityWorkerSpec,
  type EvictionCandidate,
  type PressureTier,
  type ResolveWorkerCwd,
  type WorkerPipes,
} from '@unified-mpc/capabilities';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { ProcessManagerMcpClientFactory, type McpClientFactory } from '@unified-mpc/extensions';
import { ProcessMemoryPressureProbe, type ResourcePressureProbe } from '@unified-mpc/workspace';

/**
 * Phase 3 of the on-demand capability runtime (#133): the pressure driver and
 * the first supervised worker, wired for the runtime.
 *
 * The driver is one interval sweep with no state of its own: sample memory
 * pressure, ask the supervisor which ids that tier may reclaim, reclaim them.
 * The worker is the native Thai-RAG provider, whose child moves under
 * `ProcessManager` through `ProcessManagerMcpClientFactory`; the provider
 * driver's admission, anchors and restart semantics are untouched.
 *
 * Rules that decide whether this is safe, and are tested in
 * `capability-pressure.test.ts`:
 *
 * - every tick asks the registry to sweep warm idle workers, because an idle TTL
 *   is elapsed time rather than a symptom — a healthy host still has to reclaim;
 * - a `normal` sample reclaims nothing, so pressure eviction is free on a
 *   healthy host;
 * - a tick that is still running makes the next one a no-op, so a slow reclaim
 *   cannot stack;
 * - a rejected reclaim is reported and skipped, never thrown into the interval;
 * - `cwd` is resolved once, against the canonical install root, the provider's
 *   own sources root, or a canonical registered workspace root, and refused
 *   otherwise — a sibling or nested path is refused, never contained.
 */

export const THAI_RAG_WORKER_ID = 'thai-rag-provider';

/** The manifest the phase-3 design froze; `recyclable` is the whole point. */
export const THAI_RAG_WORKER_MANIFEST: CapabilityManifestInput = {
  id: THAI_RAG_WORKER_ID,
  provides: ['pre_edit_context', 'code_index', 'code_search', 'code_context'],
  runtimeKind: 'external-process',
  activation: 'on-demand',
  costClass: 'large',
  idleTtlMs: 5 * 60_000,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000,
  recyclable: true,
  generationFenced: false,
};

export const CAPABILITY_PRESSURE_INTERVAL_MS = 30_000;

/** What the sweep needs; structural so a test fake needs no runtime. */
export interface CapabilityPressureSweepPort {
  readonly registry: {
    snapshot(): readonly EvictionCandidate[];
    reclaim(id: string): Promise<Result<void>>;
    /** Stops warm workers whose idle TTL elapsed; time-based, not pressure-based. */
    sweep(): Promise<void>;
    /**
     * The stop a `reclaim` left waiting on a lease. Optional: a port that cannot
     * report it is never nudged, which is the pre-phase-4 behaviour.
     */
    health?(id: string): { readonly pendingStop?: string } | undefined;
  };
  readonly supervisor: {
    evictionPlan(tier: PressureTier, snapshot: readonly EvictionCandidate[]): readonly string[];
    /**
     * Leased ids a `critical` sweep may *mark* for a stop. `evictionPlan` never
     * returns these (a lease forbids a kill), so without this plan no reclaim
     * writes the mark the nudge below depends on, and a leased worker is never
     * evicted at any tier.
     */
    pendingEvictionPlan(tier: PressureTier, snapshot: readonly EvictionCandidate[]): readonly string[];
  };
}

export interface CapabilityPressureDriverOptions extends CapabilityPressureSweepPort {
  readonly probe?: ResourcePressureProbe;
  readonly intervalMs?: number;
  /** A failed reclaim is reported here; the next tick retries it. */
  readonly onError?: (error: unknown) => void;
  /**
   * Releases the one lane that holds a leased worker's lease, so the stop a
   * `reclaim` marked can run. `true` when the lane was released. Only asked at
   * `critical`, and only after a reclaim left a `pendingStop` behind.
   */
  readonly requestEviction?: (id: string) => Promise<boolean>;
  /** Injected only so a test can drive the interval without real timers. */
  readonly timers?: {
    readonly setInterval: typeof setInterval;
    readonly clearInterval: typeof clearInterval;
  };
}

export interface CapabilityPressureDriver {
  /** One sweep. Never rejects. */
  tick(): Promise<void>;
  start(): void;
  close(): void;
}

export function createCapabilityPressureDriver(options: CapabilityPressureDriverOptions): CapabilityPressureDriver {
  const probe = options.probe ?? new ProcessMemoryPressureProbe();
  const intervalMs = options.intervalMs ?? CAPABILITY_PRESSURE_INTERVAL_MS;
  const report = options.onError ?? ((error: unknown): void => {
    process.stderr.write(`capability pressure sweep failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  const timers = options.timers ?? { setInterval, clearInterval };
  let sweeping = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      // An idle TTL is time, not a symptom: a released worker must not wait for
      // memory pressure to be reclaimed, or a warm 5-minute provider stays up for
      // as long as the host is healthy. The registry owns that rule (`sweep`),
      // skipping leased and non-recyclable ids itself.
      await options.registry.sweep();
      const tier = probe.sample().state;
      if (tier === 'normal') return;
      const snapshot = options.registry.snapshot();
      const plan = [...options.supervisor.evictionPlan(tier, snapshot)];
      // A leased id is absent from `evictionPlan` by design, so it has to be
      // planned separately or its `pendingStop` is never written and the nudge
      // below has nothing to follow. Only when a callback can release the lane:
      // without one, marking would evict on a release nobody asked for.
      if (tier === 'critical' && options.requestEviction !== undefined) {
        for (const id of options.supervisor.pendingEvictionPlan(tier, snapshot)) {
          if (!plan.includes(id)) plan.push(id);
        }
      }
      const blocked: string[] = [];
      for (const id of plan) {
        const reclaimed = await options.registry.reclaim(id);
        if (!reclaimed.ok) {
          report(reclaimed.error);
          continue;
        }
        // A leased id is only marked: the stop runs on the last release, and
        // that release is what the nudge asks for. A reclaim that stopped the
        // worker leaves no mark, so nothing is nudged for it.
        if (tier === 'critical' && options.requestEviction !== undefined
          && options.registry.health?.(id)?.pendingStop !== undefined) {
          blocked.push(id);
        }
      }
      for (const id of blocked) {
        try {
          if (!await options.requestEviction!(id)) report(appError('CONFLICT', `capability ${id} kept its lease; pressure could not release it`));
        } catch (error: unknown) {
          report(error);
        }
      }
    } catch (error: unknown) {
      report(error);
    } finally {
      sweeping = false;
    }
  };

  return {
    tick,
    start(): void {
      if (timer !== undefined) return;
      timer = timers.setInterval(() => {
        void tick();
      }, intervalMs);
      timer.unref?.();
    },
    close(): void {
      if (timer === undefined) return;
      timers.clearInterval(timer);
      timer = undefined;
    },
  };
}

/**
 * The one `cwd` allowlist: the canonical provider install root, the provider's
 * own sources root (`extraRoots`), or a canonical registered workspace root.
 * Comparison is equality, so a sibling or nested path is refused. Anything else
 * is a registration failure reported at boot, not at first call.
 */
export function createWorkerCwdResolver(options: {
  readonly installRoot: string;
  readonly workspaceRoots: () => Promise<readonly string[]>;
  /**
   * Runtime-owned roots the provider itself creates (its sources root). Not user
   * input: the driver's launch asks for exactly this cwd.
   */
  readonly extraRoots?: readonly string[];
}): ResolveWorkerCwd {
  return async (requested: string): Promise<Result<string>> => {
    const resolved = await realpath(requested).catch(() => undefined);
    if (resolved === undefined) {
      return err(appError('INVALID_INPUT', `capability worker cwd ${requested} cannot be resolved`, false));
    }
    const installRoot = await realpath(options.installRoot).catch(() => options.installRoot);
    if (resolved === installRoot) return ok(resolved);
    for (const extra of options.extraRoots ?? []) {
      if (await realpath(extra).catch(() => extra) === resolved) return ok(resolved);
    }
    const roots = await options.workspaceRoots().catch(() => [] as readonly string[]);
    for (const root of roots) {
      const canonical = await realpath(root).catch(() => root);
      if (canonical === resolved) return ok(resolved);
    }
    return err(appError('PERMISSION_DENIED', `capability worker cwd ${resolved} is neither the provider install root nor a registered workspace`, false));
  };
}

export interface ThaiRagWorkerLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ThaiRagCapabilityRuntime {
  readonly registry: CapabilityRegistry;
  readonly supervisor: CapabilitySupervisor;
  readonly factory: ProcessManagerMcpClientFactory;
  readonly driver: CapabilityPressureDriver;
  readonly manifest: CapabilityManifest;
  /** Stops the sweep, then stops any worker still alive. */
  close(): Promise<void>;
}

export interface ThaiRagCapabilityRuntimeOptions {
  readonly launch: ThaiRagWorkerLaunch;
  readonly installRoot: string;
  readonly extraCwdRoots?: readonly string[];
  readonly workspaceRoots: () => Promise<readonly string[]>;
  readonly probe?: ResourcePressureProbe;
  readonly intervalMs?: number;
  /** Sweep failures and a lease release the registry refused are reported here. */
  readonly onError?: (error: unknown) => void;
  /**
   * #133 phase 4: releases the lane that holds a leased worker's lease, so a
   * `critical` reclaim can run. Absent means leased workers are never evicted.
   */
  readonly requestEviction?: (id: string) => Promise<boolean>;
  /** Injected only so a test can avoid spawning a real child. */
  readonly processManager?: CapabilityProcessPort;
}

/**
 * A worker that died leaves its id `FAILED`, and `acquire` can never succeed
 * from there. `true` only when nothing is alive or unverified: recycling a
 * `stop-unverified` id could spawn a second child beside a live one.
 */
export function canRecycleDeadWorker(
  health: { readonly state: string } | undefined,
  worker: { readonly processId?: string | undefined; readonly stopUnverified?: boolean | undefined } | undefined,
): boolean {
  return health?.state === 'FAILED' && worker?.processId === undefined && worker?.stopUnverified !== true;
}

/** Implementation-once; a caller may hold nothing but the wiring below. */
export type ThaiRagCapabilityRuntimeResult = Result<ThaiRagCapabilityRuntime>;

/**
 * The runtime is built synchronously (boot does not await registration), so the
 * provider driver gets a factory immediately and the worker's registration
 * settles behind it. A refused registration is therefore a connection failure on
 * the first provider call, not a boot failure.
 */
export interface ThaiRagCapabilityWiring {
  readonly factory: McpClientFactory;
  readonly ready: Promise<ThaiRagCapabilityRuntimeResult>;
  /** Starts the sweep as soon as the worker is registered; safe to call once. */
  start(): void;
  close(): Promise<void>;
}

export function wireThaiRagCapability(options: ThaiRagCapabilityRuntimeOptions): ThaiRagCapabilityWiring {
  const ready = createThaiRagCapabilityRuntime(options);
  let started = false;
  const factory: McpClientFactory = {
    connect: async (config, signal) => {
      const runtime = await ready;
      if (!runtime.ok) {
        throw new Error(`capability ${THAI_RAG_WORKER_ID} is unavailable: ${runtime.error.message}`);
      }
      return runtime.value.factory.connect(config, signal);
    },
  };
  return {
    factory,
    ready,
    start(): void {
      void ready.then((runtime) => {
        if (!runtime.ok || started) return;
        started = true;
        runtime.value.driver.start();
      }).catch(() => undefined);
    },
    close: async (): Promise<void> => {
      const runtime = await ready.catch(() => undefined);
      if (runtime?.ok === true) await runtime.value.close();
    },
  };
}

/**
 * One registry, one supervisor, one worker, one factory, one sweep.
 *
 * The registry needs the supervisor's `start`/`stop` and the supervisor needs the
 * registry as its lifecycle port, so the two are linked through a holder that is
 * filled before the first `acquire` — construction order, not a cycle.
 */
export async function createThaiRagCapabilityRuntime(
  options: ThaiRagCapabilityRuntimeOptions,
): Promise<Result<ThaiRagCapabilityRuntime>> {
  const holder: { supervisor?: CapabilitySupervisor } = {};
  const registry = new CapabilityRegistry({
    start: (manifest: CapabilityManifest): Promise<Result<void>> => holder.supervisor?.start(manifest) ?? Promise.resolve(ok(undefined)),
    stop: (manifest: CapabilityManifest): Promise<Result<void>> => holder.supervisor?.stop(manifest) ?? Promise.resolve(ok(undefined)),
  });
  const supervisor = new CapabilitySupervisor({
    lifecycle: registry,
    resolveWorkerCwd: createWorkerCwdResolver({
      installRoot: options.installRoot,
      workspaceRoots: options.workspaceRoots,
      ...(options.extraCwdRoots === undefined ? {} : { extraRoots: options.extraCwdRoots }),
    }),
    ...(options.processManager === undefined ? {} : { processManager: options.processManager }),
  });
  holder.supervisor = supervisor;

  const registered = await registry.register(THAI_RAG_WORKER_MANIFEST);
  if (!registered.ok) return registered;
  const manifest = registered.value;
  const spec: CapabilityWorkerSpec = {
    executable: options.launch.executable,
    args: [...options.launch.args],
    cwd: options.launch.cwd,
    // The worker carries a transport, so its pipes must stay readable.
    exposeStdio: true,
    ...(options.launch.env === undefined ? {} : { env: options.launch.env }),
    // Recyclable, but not disposable: it serves calls until the sweep evicts it,
    // so the manager's one-hour wall clock would kill a healthy provider.
    timeoutMs: 0,
  };
  const worker = await supervisor.register(manifest, spec);
  if (!worker.ok) return worker;

  const factory = new ProcessManagerMcpClientFactory({
    source: {
      // A worker that died leaves its id `FAILED`, and `acquire` can never
      // succeed from there — the provider driver expects the next call to reach a
      // fresh child (its `#766` retry path), so a dead attempt is returned to
      // `COLD` here. Only when nothing is alive or unverified: recycling a
      // `stop-unverified` id could spawn a second child beside a live one.
      acquire: async (id: string): Promise<Result<CapabilityLease>> => {
        const lease = await registry.acquire(id);
        if (lease.ok) return lease;
        const worker = supervisor.health().find((entry) => entry.id === id);
        if (!canRecycleDeadWorker(registry.health(id), worker)) return lease;
        const recycled = registry.recycle(id);
        return recycled.ok ? registry.acquire(id) : lease;
      },
      pipes: (id: string): WorkerPipes | undefined => supervisor.pipes(id),
    },
    manifestId: manifest.id,
    launch: { command: spec.executable, args: spec.args, cwd: spec.cwd },
    // A refused release happens while a session is closing, so there is no caller
    // to return the error to; the diagnostics channel is where it belongs.
    ...(options.onError === undefined ? {} : { onReleaseError: options.onError }),
  });
  const driver = createCapabilityPressureDriver({
    registry,
    supervisor,
    ...(options.probe === undefined ? {} : { probe: options.probe }),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    ...(options.requestEviction === undefined ? {} : { requestEviction: options.requestEviction }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  return ok({
    registry,
    supervisor,
    factory,
    driver,
    manifest,
    close: async (): Promise<void> => {
      driver.close();
      await supervisor.shutdown().catch(() => undefined);
    },
  });
}
