import { appError, err, ok, type Result } from '@unified-mpc/domain';

/**
 * Phase 1 of the on-demand capability runtime (#133): the manifest contract and
 * the in-process lifecycle registry.
 *
 * #133 has three separable problems — a manifest (what a capability is and what
 * it costs), a lifecycle registry (the states, leases and generation fence), and
 * a worker supervisor with pressure signal. This module implements the first two.
 * Nothing here spawns, kills or measures a process: an `in-process` capability
 * still earns lease accounting and warm-idle reclamation, which is enough to
 * declare a gate check on-demand (#142) with a fake clock and no child processes.
 *
 * The rules the registry refuses are the point, so they are stated once here and
 * tested in `capability-registry.test.ts`:
 *
 * - a transition that is not in the table is refused, not coerced;
 * - `acquire` never resurrects `STOPPING` or `FAILED`;
 * - `leaseCount` never goes negative and a double release is an error;
 * - while a lease is held the capability cannot enter `STOPPING`, even when its
 *   idle TTL has already elapsed;
 * - `recyclable: false` keeps a capability resident for the process lifetime;
 * - a fenced capability may be ended by a stale generation, never written by it.
 */

export type CapabilityRuntimeKind = 'in-process' | 'native-worker' | 'external-process';

/**
 * `always` starts at registration, `on-demand` waits for its first acquire, and
 * `burst` starts like `on-demand` but tells phase 2 to exit after its work
 * instead of going warm.
 */
export type CapabilityActivation = 'always' | 'on-demand' | 'burst';

/** Advisory until phase 3 has a pressure signal to weigh it against. */
export type CapabilityCostClass = 'small' | 'medium' | 'large';

export type CapabilityState =
  | 'REGISTERED'
  | 'COLD'
  | 'STARTING'
  | 'ACTIVE'
  | 'WARM_IDLE'
  | 'STOPPING'
  | 'FAILED';

export interface CapabilityManifest {
  readonly id: string;
  readonly version: number;
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly externalRequires: readonly string[];
  readonly runtimeKind: CapabilityRuntimeKind;
  readonly activation: CapabilityActivation;
  readonly costClass: CapabilityCostClass;
  /** Warm-idle lifetime. `0` stops on the last release with no idle window. */
  readonly idleTtlMs: number;
  readonly startupTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly recyclable: boolean;
  readonly generationFenced: boolean;
  readonly healthProbe?: string;
}

/**
 * What a caller declares. Everything but `id` and `provides` has a documented
 * default, so a manifest says what it means and stays quiet about the rest.
 */
export interface CapabilityManifestInput {
  readonly id: string;
  readonly provides: readonly string[];
  readonly version?: number;
  readonly requires?: readonly string[];
  readonly externalRequires?: readonly string[];
  readonly runtimeKind?: CapabilityRuntimeKind;
  readonly activation?: CapabilityActivation;
  readonly costClass?: CapabilityCostClass;
  readonly idleTtlMs?: number;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly recyclable?: boolean;
  readonly generationFenced?: boolean;
  readonly healthProbe?: string;
}

export interface CapabilityTransition {
  readonly id: string;
  readonly from: CapabilityState;
  readonly to: CapabilityState;
  readonly reason: string;
  readonly at: number;
}

export interface CapabilityHealth {
  readonly id: string;
  readonly state: CapabilityState;
  readonly leaseCount: number;
  readonly highestGeneration?: number;
  readonly lastTransition?: CapabilityTransition;
}

export interface CapabilityLease {
  readonly capabilityId: string;
  readonly generation?: number;
  /** Ends this lease. A stale lease may end, it may not publish. */
  release(): Result<void>;
  /** Proves this lease still speaks for the current generation. */
  publish(): Result<void>;
}

export interface CapabilityRegistryOptions {
  /** Injected clock. Tests advance it; production reads the wall clock. */
  readonly now?: () => number;
  /**
   * The only startup this phase performs: an in-process begin, awaited inside
   * `startupTimeoutMs`. Phase 2 replaces it with a real supervisor.
   */
  readonly start?: (manifest: CapabilityManifest) => Promise<void> | void;
  /**
   * How many transitions one capability keeps. A warm capability appends two
   * entries per acquire/release, so an unbounded history grows with uptime; the
   * newest entries are the ones `health()` and a diagnosis need.
   */
  readonly maxTransitions?: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TTL_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_TRANSITIONS = 64;

const ALLOWED_TRANSITIONS: Readonly<Record<CapabilityState, readonly CapabilityState[]>> = {
  REGISTERED: ['COLD'],
  COLD: ['STARTING'],
  STARTING: ['ACTIVE', 'FAILED'],
  ACTIVE: ['WARM_IDLE', 'STOPPING'],
  WARM_IDLE: ['ACTIVE', 'STOPPING'],
  STOPPING: ['COLD', 'FAILED'],
  FAILED: ['COLD'],
};

interface CapabilityRecord {
  readonly manifest: CapabilityManifest;
  state: CapabilityState;
  leaseCount: number;
  /** Monotonic per-capability lease number, so two live leases never share an id. */
  nextLeaseId: number;
  highestGeneration?: number;
  idleSince: number;
  starting: Promise<Result<void>> | undefined;
  readonly transitions: CapabilityTransition[];
}

function invalid(message: string): Result<never> {
  return err(appError('INVALID_INPUT', message));
}

function conflict(message: string): Result<never> {
  return err(appError('CONFLICT', message, true));
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Validates one input and fills the defaults. Registration is the only caller,
 * and a manifest is immutable afterwards, so a contract change is a `version`
 * bump rather than a runtime edit.
 */
export function normalizeCapabilityManifest(input: CapabilityManifestInput): Result<CapabilityManifest> {
  if (isBlank(input.id)) return invalid('capability id must not be empty');
  if (input.provides.length === 0) return invalid(`capability ${input.id} must provide at least one token`);
  if (input.provides.some(isBlank)) return invalid(`capability ${input.id} provides a blank token`);

  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) return invalid(`capability ${input.id} version must be a positive integer`);

  const requires = input.requires ?? [];
  if (requires.includes(input.id)) {
    return invalid(`capability ${input.id} has a dependency cycle: ${input.id} -> ${input.id}`);
  }

  const idleTtlMs = input.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  if (!isNonNegativeInteger(idleTtlMs)) return invalid(`capability ${input.id} idleTtlMs must be a non-negative integer`);

  const startupTimeoutMs = input.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  if (!isNonNegativeInteger(startupTimeoutMs)) {
    return invalid(`capability ${input.id} startupTimeoutMs must be a non-negative integer`);
  }

  const shutdownTimeoutMs = input.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!isNonNegativeInteger(shutdownTimeoutMs)) {
    return invalid(`capability ${input.id} shutdownTimeoutMs must be a non-negative integer`);
  }

  return ok({
    id: input.id,
    version,
    provides: [...input.provides],
    requires: [...requires],
    externalRequires: [...(input.externalRequires ?? [])],
    runtimeKind: input.runtimeKind ?? 'in-process',
    activation: input.activation ?? 'on-demand',
    costClass: input.costClass ?? 'small',
    idleTtlMs,
    startupTimeoutMs,
    shutdownTimeoutMs,
    recyclable: input.recyclable ?? true,
    generationFenced: input.generationFenced ?? false,
    ...(input.healthProbe === undefined ? {} : { healthProbe: input.healthProbe }),
  });
}

export class CapabilityRegistry {
  private readonly records = new Map<string, CapabilityRecord>();

  public constructor(private readonly options: CapabilityRegistryOptions = {}) {}

  /**
   * Registers one manifest. `requires` is resolved against what is already
   * registered, so a dependency must be declared before its dependant: a longer
   * cycle is therefore unexpressible, and the only reachable one — a capability
   * requiring itself — is refused with the edge named.
   */
  public async register(input: CapabilityManifestInput): Promise<Result<CapabilityManifest>> {
    const normalized = normalizeCapabilityManifest(input);
    if (!normalized.ok) return normalized;
    const manifest = normalized.value;

    if (this.records.has(manifest.id)) {
      return conflict(`capability ${manifest.id} is already registered`);
    }

    for (const dependency of manifest.requires) {
      // `externalRequires` is the only place a token outside this registry may
      // be named, so a dependency only the host provides must not be borrowed
      // as a `requires` entry the registry would then try to start.
      if (!this.records.has(dependency)) {
        return invalid(`capability ${manifest.id} requires unregistered capability ${dependency}`);
      }
    }

    const record: CapabilityRecord = {
      manifest,
      state: 'REGISTERED',
      leaseCount: 0,
      nextLeaseId: 0,
      idleSince: 0,
      starting: undefined,
      transitions: [],
    };
    this.records.set(manifest.id, record);
    this.transition(record, 'COLD', 'registered');

    if (manifest.activation === 'always') {
      // Judge the whole chain before walking it: a boot that would be refused
      // one level down must not have started anything below that level first.
      const chainVerdict = this.chainVerdict(this.dependencyChain(record));
      if (!chainVerdict.ok) {
        this.records.delete(manifest.id);
        return chainVerdict;
      }
      const bootStarted: CapabilityRecord[] = [];
      const started = await this.startWithDependencies(record, 'boot', bootStarted);
      if (!started.ok) {
        // A failed boot must not leave a half-registered id behind (a retry
        // would get CONFLICT), and a dependency this boot started is `ACTIVE`
        // with no lease that the sweep would ever reclaim.
        this.releaseStarted(bootStarted);
        this.records.delete(manifest.id);
        return started;
      }
    }

    return ok(manifest);
  }

  public manifest(id: string): CapabilityManifest | undefined {
    return this.records.get(id)?.manifest;
  }

  public health(id: string): CapabilityHealth | undefined {
    const record = this.records.get(id);
    if (record === undefined) return undefined;
    const lastTransition = record.transitions.at(-1);
    return {
      id,
      state: record.state,
      leaseCount: record.leaseCount,
      ...(record.highestGeneration === undefined ? {} : { highestGeneration: record.highestGeneration }),
      ...(lastTransition === undefined ? {} : { lastTransition }),
    };
  }

  /** The transitions this capability still remembers, oldest first. */
  public transitions(id: string): readonly CapabilityTransition[] {
    return this.records.get(id)?.transitions ?? [];
  }

  /**
   * Takes a lease, starting the capability and everything on its `requires`
   * path when needed. Only the requested capability and its dependencies start;
   * unrelated capabilities are left where they are.
   */
  public async acquire(id: string, options: { readonly generation?: number } = {}): Promise<Result<CapabilityLease>> {
    const record = this.records.get(id);
    if (record === undefined) return invalid(`capability ${id} is not registered`);

    // Validate first, commit the generation only once this acquire has a lease:
    // a refused acquire must not raise the fence against the caller that holds it.
    const fence = this.checkGeneration(record, options.generation);
    if (!fence.ok) return fence;

    const verdict = this.startVerdict(record);
    if (!verdict.ok) return verdict;

    const chain = this.dependencyChain(record);
    // A dependency of a dependency can be FAILED or EVICTED, so the whole
    // chain is judged here: refusing only for the target would still walk the
    // chain far enough to spawn a COLD capability below the broken one.
    const chainVerdict = this.chainVerdict(chain);
    if (!chainVerdict.ok) return chainVerdict;

    const acquireStarted: CapabilityRecord[] = [];
    const started = await this.startWithDependencies(record, 'acquire', acquireStarted);
    if (!started.ok) {
      // A dependency this acquire started is `ACTIVE` with no lease and the
      // sweep only visits `WARM_IDLE`, so hand each one back to the idle path
      // here instead of leaving it resident for the process lifetime.
      this.releaseStarted(acquireStarted);
      return started;
    }

    if (record.state === 'WARM_IDLE') this.transition(record, 'ACTIVE', 'acquired while warm');

    const generation = options.generation;
    if (generation !== undefined) record.highestGeneration = Math.max(record.highestGeneration ?? generation, generation);
    const leaseId = record.nextLeaseId;
    record.nextLeaseId += 1;
    // The dependencies are leased by the lease that needs them: started-once
    // without accounting would leave them resident forever, and the TTL that
    // reclaims a warm capability would have nothing to reclaim them against.
    for (const dependency of chain) this.takeLease(dependency);
    this.takeLease(record);

    let released = false;
    return ok({
      capabilityId: id,
      ...(generation === undefined ? {} : { generation }),
      release: (): Result<void> => {
        if (released) return conflict(`capability ${id} lease ${leaseId} was already released`);
        released = true;
        for (const dependency of chain) this.releaseLease(dependency);
        this.releaseLease(record);
        return ok(undefined);
      },
      publish: (): Result<void> => {
        if (released) return conflict(`capability ${id} lease ${leaseId} was released and cannot publish`);
        if (!record.manifest.generationFenced) return ok(undefined);
        if (generation === undefined) return invalid(`capability ${id} is generation-fenced and this lease names no generation`);
        if (record.highestGeneration !== undefined && generation < record.highestGeneration) {
          return conflict(
            `capability ${id} lease speaks for generation ${generation}, current is ${record.highestGeneration}`,
          );
        }
        return ok(undefined);
      },
    });
  }

  /**
   * Reclaims warm capabilities whose idle TTL has elapsed. Phase 3 calls this
   * from a pressure signal; phase 1 calls it from a clock tick or a test.
   */
  public sweep(): void {
    const now = this.now();
    for (const record of this.records.values()) {
      if (record.state !== 'WARM_IDLE') continue;
      if (record.leaseCount > 0) continue;
      if (!record.manifest.recyclable) continue;
      if (now - record.idleSince < record.manifest.idleTtlMs) continue;
      this.stop(record, 'idle TTL elapsed');
    }
  }

  /** Returns a failed capability to `COLD` so the next acquire can retry it. */
  public recycle(id: string): Result<void> {
    const record = this.records.get(id);
    if (record === undefined) return invalid(`capability ${id} is not registered`);
    if (record.state !== 'FAILED') return conflict(`capability ${id} is ${record.state}, only FAILED can be recycled`);
    this.transition(record, 'COLD', 'recycled');
    return ok(undefined);
  }

  private checkGeneration(record: CapabilityRecord, generation: number | undefined): Result<void> {
    if (record.manifest.generationFenced && generation === undefined) {
      return invalid(`capability ${record.manifest.id} is generation-fenced and requires a generation`);
    }
    if (generation === undefined) return ok(undefined);
    if (!Number.isInteger(generation) || generation < 0) {
      return invalid(`capability ${record.manifest.id} generation must be a non-negative integer`);
    }
    if (record.highestGeneration !== undefined && generation < record.highestGeneration) {
      return conflict(
        `capability ${record.manifest.id} generation ${generation} is stale, highest seen is ${record.highestGeneration}`,
      );
    }
    return ok(undefined);
  }

  /**
   * Every transitive dependency of one capability, dependencies first. The
   * registration rules refused longer cycles, so the walk terminates.
   */
  private dependencyChain(record: CapabilityRecord): CapabilityRecord[] {
    const chain: CapabilityRecord[] = [];
    const walk = (current: CapabilityRecord): void => {
      for (const dependency of current.manifest.requires) {
        const dependencyRecord = this.records.get(dependency);
        if (dependencyRecord === undefined || chain.includes(dependencyRecord)) continue;
        chain.push(dependencyRecord);
        walk(dependencyRecord);
      }
    };
    walk(record);
    return chain;
  }

  private takeLease(record: CapabilityRecord): void {
    if (record.state === 'WARM_IDLE') this.transition(record, 'ACTIVE', 'leased');
    record.leaseCount += 1;
    record.idleSince = 0;
  }

  private releaseLease(record: CapabilityRecord): void {
    record.leaseCount -= 1;
    if (record.leaseCount === 0) this.releaseIdle(record);
  }

  /**
   * Starts a capability and everything on its `requires` path, depth-first and
   * dependencies before dependants. Registration refused longer cycles, so the
   * walk terminates.
   */
  private async startWithDependencies(
    record: CapabilityRecord,
    reason: string,
    started: CapabilityRecord[] = [],
  ): Promise<Result<void>> {
    for (const dependency of record.manifest.requires) {
      const dependencyRecord = this.records.get(dependency);
      if (dependencyRecord === undefined) {
        return invalid(`capability ${record.manifest.id} requires unregistered capability ${dependency}`);
      }
      const walked = await this.startWithDependencies(dependencyRecord, 'dependency', started);
      if (!walked.ok) return walked;
    }
    // `COLD` is the only state this call can have changed by starting: a record
    // that was already `ACTIVE`, `WARM_IDLE` or `STARTING` belongs to somebody
    // else, and the failure cleanup must not hand it back.
    const wasCold = record.state === 'COLD';
    const result = await this.start(record, reason);
    if (result.ok && wasCold) started.push(record);
    return result;
  }

  /**
   * Hands the records a failed start actually started back to the idle path.
   * A record another caller already leased keeps running, and one that was
   * resident before the failure is not in the list at all.
   */
  private releaseStarted(started: readonly CapabilityRecord[]): void {
    for (const record of started) {
      if (record.state === 'ACTIVE' && record.leaseCount === 0) this.releaseIdle(record);
    }
  }

  /**
   * The shared refusal: only `COLD` can start, only `ACTIVE`/`WARM_IDLE` need no
   * start and `STARTING` is already on its way. `acquire()` and an `always` boot
   * ask this for the whole `requires` chain before walking it, so a doomed
   * start spawns nothing at all.
   */
  private startVerdict(record: CapabilityRecord): Result<void> {
    if (
      record.state === 'COLD' ||
      record.state === 'ACTIVE' ||
      record.state === 'WARM_IDLE' ||
      record.state === 'STARTING'
    ) {
      return ok(undefined);
    }
    return conflict(`capability ${record.manifest.id} cannot start from ${record.state}`);
  }

  /** `startVerdict` over every dependency, so nothing below a doomed record runs. */
  private chainVerdict(chain: readonly CapabilityRecord[]): Result<void> {
    for (const record of chain) {
      const verdict = this.startVerdict(record);
      if (!verdict.ok) return verdict;
    }
    return ok(undefined);
  }

  /** `COLD -> STARTING -> ACTIVE`, or `STARTING -> FAILED` on an error or timeout. */
  private async start(record: CapabilityRecord, reason: string): Promise<Result<void>> {
    if (record.state === 'ACTIVE' || record.state === 'WARM_IDLE') return ok(undefined);
    if (record.state === 'STARTING') return record.starting ?? ok(undefined);
    const verdict = this.startVerdict(record);
    if (!verdict.ok) return verdict;

    this.transition(record, 'STARTING', reason);
    const pending = (async (): Promise<Result<void>> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), record.manifest.startupTimeoutMs);
        timer.unref();      });
      try {
        const outcome = await Promise.race([
          Promise.resolve(this.options.start?.(record.manifest)).then((): 'started' => 'started'),
          timedOut,
        ]);
        if (outcome === 'timeout') {
          this.transition(record, 'FAILED', 'startup timed out');
          return err(appError('PROCESS_TIMEOUT', `capability ${record.manifest.id} did not start in time`, true));
        }
      } catch (error) {
        this.transition(record, 'FAILED', `startup failed: ${error instanceof Error ? error.message : String(error)}`);
        return err(appError('INTERNAL_ERROR', `capability ${record.manifest.id} failed to start`, true));
      } finally {
        clearTimeout(timer);
      }
      this.transition(record, 'ACTIVE', 'started');
      return ok(undefined);
    })();
    record.starting = pending;
    try {
      return await pending;
    } finally {
      record.starting = undefined;
    }
  }

  /** What the last release leads to: warm, or straight out when the TTL is `0`. */
  private releaseIdle(record: CapabilityRecord): void {
    if (record.state !== 'ACTIVE') return;
    if (record.manifest.idleTtlMs === 0) {
      this.stop(record, 'idle TTL is zero');
      return;
    }
    record.idleSince = this.now();
    this.transition(record, 'WARM_IDLE', 'idle');
  }

  /**
   * `STOPPING -> COLD`. A capability that promised to stay resident for the
   * process lifetime (`recyclable: false`) never reaches here, and neither does
   * one holding a lease.
   */
  private stop(record: CapabilityRecord, reason: string): void {
    if (!record.manifest.recyclable || record.leaseCount > 0) return;
    if (record.state !== 'ACTIVE' && record.state !== 'WARM_IDLE') return;
    this.transition(record, 'STOPPING', reason);
    this.transition(record, 'COLD', 'stopped');
  }

  private transition(record: CapabilityRecord, to: CapabilityState, reason: string): void {
    const from = record.state;
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new Error(`capability ${record.manifest.id} cannot move ${from} -> ${to}`);
    }
    record.state = to;
    record.transitions.push({ id: record.manifest.id, from, to, reason, at: this.now() });
    const cap = this.transitionCap();
    if (record.transitions.length > cap) record.transitions.splice(0, record.transitions.length - cap);
  }

  /**
   * `maxTransitions` is clamped rather than trusted: a non-positive or
   * fractional value would empty the history (dropping the `lastTransition`
   * `health()` promises) or truncate the splice count to zero, silently
   * disabling the cap.
   */
  private transitionCap(): number {
    const configured = this.options.maxTransitions ?? DEFAULT_MAX_TRANSITIONS;
    if (!Number.isFinite(configured)) return DEFAULT_MAX_TRANSITIONS;
    return Math.max(1, Math.floor(configured));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
