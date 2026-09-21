import type { ResourceAdmissionClass, ResourceAdmissionLease } from '@unified-mpc/workspace';
import type { SqliteDatabase } from './database.js';

export type ManagedResourceBindingClass = Extract<ResourceAdmissionClass, 'goal_process' | 'delegated_agent'>;
export type ManagedResourceBindingState = 'active' | 'termination_unverified' | 'released';

export interface ManagedResourceBinding {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly resourceClass: ManagedResourceBindingClass;
  readonly cost: number;
  readonly logicalHandle: string;
  readonly platform: 'linux' | 'darwin';
  readonly pid: number;
  readonly processStartedAt: string;
  readonly state: ManagedResourceBindingState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoreManagedResourceBinding {
  readonly lease: ResourceAdmissionLease & { readonly resourceClass: ManagedResourceBindingClass };
  readonly logicalHandle: string;
  readonly platform: 'linux' | 'darwin';
  readonly pid: number;
  readonly processStartedAt: string;
  readonly createdAt: string;
}

interface ManagedResourceBindingRow {
  readonly operation_id: string;
  readonly workspace_id: string;
  readonly session_id: string;
  readonly resource_class: string;
  readonly cost: number;
  readonly logical_handle: string;
  readonly platform: string;
  readonly pid: number;
  readonly process_started_at: string;
  readonly state: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export class ManagedResourceBindingStoreError extends Error {
  public constructor(
    public readonly reason: 'invalid_binding' | 'operation_conflict' | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'ManagedResourceBindingStoreError';
  }
}

export class SqliteManagedResourceBindingRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public storeActive(input: StoreManagedResourceBinding): ManagedResourceBinding {
    const normalized = normalizeInput(input);
    this.database.connection.prepare(`
      INSERT INTO managed_resource_bindings (
        operation_id, workspace_id, session_id, resource_class, cost,
        logical_handle, platform, pid, process_started_at,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(operation_id) DO NOTHING
    `).run(
      normalized.lease.operationId,
      normalized.lease.workspaceId,
      normalized.lease.sessionId,
      normalized.lease.resourceClass,
      normalized.lease.cost,
      normalized.logicalHandle,
      normalized.platform,
      normalized.pid,
      normalized.processStartedAt,
      normalized.createdAt,
      normalized.createdAt,
    );

    const stored = this.get(normalized.lease.operationId);
    if (stored === undefined) throw new ManagedResourceBindingStoreError('corrupt', 'Managed resource binding disappeared after write');
    if (!sameImmutableBinding(stored, normalized)) {
      throw new ManagedResourceBindingStoreError(
        'operation_conflict',
        `Managed resource operation '${normalized.lease.operationId}' already identifies different durable ownership`,
      );
    }
    if (stored.state === 'released') {
      throw new ManagedResourceBindingStoreError(
        'operation_conflict',
        `Managed resource operation '${normalized.lease.operationId}' was already released and cannot be resurrected`,
      );
    }
    return stored;
  }

  public get(operationId: string): ManagedResourceBinding | undefined {
    requireIdentifier(operationId, 'operationId');
    const row = this.database.connection.prepare(
      'SELECT * FROM managed_resource_bindings WHERE operation_id = ?',
    ).get(operationId);
    return row === undefined ? undefined : this.toBinding(this.requireRow(row));
  }

  public listUnreleased(): readonly ManagedResourceBinding[] {
    const rows = this.database.connection.prepare(`
      SELECT * FROM managed_resource_bindings
      WHERE state != 'released'
      ORDER BY created_at ASC, operation_id ASC
    `).all();
    return rows.map((row) => this.toBinding(this.requireRow(row)));
  }

  public markTerminationUnverified(operationId: string, updatedAt: string): ManagedResourceBinding | undefined {
    requireIdentifier(operationId, 'operationId');
    requireIso(updatedAt, 'updatedAt');
    this.database.connection.prepare(`
      UPDATE managed_resource_bindings
      SET state = 'termination_unverified', updated_at = ?
      WHERE operation_id = ? AND state != 'released'
    `).run(updatedAt, operationId);
    return this.get(operationId);
  }

  public markReleased(operationId: string, updatedAt: string): ManagedResourceBinding | undefined {
    requireIdentifier(operationId, 'operationId');
    requireIso(updatedAt, 'updatedAt');
    this.database.connection.prepare(`
      UPDATE managed_resource_bindings
      SET state = 'released', updated_at = ?
      WHERE operation_id = ?
    `).run(updatedAt, operationId);
    return this.get(operationId);
  }

  private toBinding(row: ManagedResourceBindingRow): ManagedResourceBinding {
    const resourceClass = managedResourceClass(row.resource_class, 'corrupt');
    const platform = managedPlatform(row.platform, 'corrupt');
    const state = managedState(row.state, 'corrupt');
    requireIdentifier(row.operation_id, 'operation_id', 'corrupt');
    requireIdentifier(row.workspace_id, 'workspace_id', 'corrupt');
    requireIdentifier(row.session_id, 'session_id', 'corrupt');
    requireIdentifier(row.logical_handle, 'logical_handle', 'corrupt', 512);
    requirePositiveInteger(row.cost, 'cost', 'corrupt');
    requirePositiveInteger(row.pid, 'pid', 'corrupt');
    requireIso(row.process_started_at, 'process_started_at', 'corrupt');
    requireIso(row.created_at, 'created_at', 'corrupt');
    requireIso(row.updated_at, 'updated_at', 'corrupt');
    return {
      operationId: row.operation_id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      resourceClass,
      cost: row.cost,
      logicalHandle: row.logical_handle,
      platform,
      pid: row.pid,
      processStartedAt: row.process_started_at,
      state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private requireRow(value: unknown): ManagedResourceBindingRow {
    if (!isRecord(value)) throw new ManagedResourceBindingStoreError('corrupt', 'Managed resource binding row is invalid');
    const stringKeys = [
      'operation_id', 'workspace_id', 'session_id', 'resource_class', 'logical_handle',
      'platform', 'process_started_at', 'state', 'created_at', 'updated_at',
    ];
    if (!stringKeys.every((key) => typeof value[key] === 'string')
      || typeof value.cost !== 'number'
      || typeof value.pid !== 'number') {
      throw new ManagedResourceBindingStoreError('corrupt', 'Managed resource binding row has invalid columns');
    }
    return value as unknown as ManagedResourceBindingRow;
  }
}

function normalizeInput(input: StoreManagedResourceBinding): StoreManagedResourceBinding {
  requireIdentifier(input.lease.operationId, 'lease.operationId');
  requireIdentifier(input.lease.workspaceId, 'lease.workspaceId');
  requireIdentifier(input.lease.sessionId, 'lease.sessionId');
  const resourceClass = managedResourceClass(input.lease.resourceClass);
  requirePositiveInteger(input.lease.cost, 'lease.cost');
  requireIdentifier(input.logicalHandle, 'logicalHandle', 'invalid_binding', 512);
  const platform = managedPlatform(input.platform);
  requirePositiveInteger(input.pid, 'pid');
  requireIso(input.processStartedAt, 'processStartedAt');
  requireIso(input.createdAt, 'createdAt');
  return {
    lease: { ...input.lease, resourceClass },
    logicalHandle: input.logicalHandle,
    platform,
    pid: input.pid,
    processStartedAt: input.processStartedAt,
    createdAt: input.createdAt,
  };
}

function sameImmutableBinding(stored: ManagedResourceBinding, input: StoreManagedResourceBinding): boolean {
  return stored.operationId === input.lease.operationId
    && stored.workspaceId === input.lease.workspaceId
    && stored.sessionId === input.lease.sessionId
    && stored.resourceClass === input.lease.resourceClass
    && stored.cost === input.lease.cost
    && stored.logicalHandle === input.logicalHandle
    && stored.platform === input.platform
    && stored.pid === input.pid
    && stored.processStartedAt === input.processStartedAt
    && stored.createdAt === input.createdAt;
}

function managedResourceClass(
  value: unknown,
  reason: ManagedResourceBindingStoreError['reason'] = 'invalid_binding',
): ManagedResourceBindingClass {
  if (value !== 'goal_process' && value !== 'delegated_agent') {
    throw new ManagedResourceBindingStoreError(reason, 'Managed resource class is invalid');
  }
  return value;
}

function managedPlatform(
  value: unknown,
  reason: ManagedResourceBindingStoreError['reason'] = 'invalid_binding',
): 'linux' | 'darwin' {
  if (value !== 'linux' && value !== 'darwin') {
    throw new ManagedResourceBindingStoreError(reason, 'Managed resource platform is invalid');
  }
  return value;
}

function managedState(
  value: unknown,
  reason: ManagedResourceBindingStoreError['reason'] = 'invalid_binding',
): ManagedResourceBindingState {
  if (value !== 'active' && value !== 'termination_unverified' && value !== 'released') {
    throw new ManagedResourceBindingStoreError(reason, 'Managed resource binding state is invalid');
  }
  return value;
}

function requireIdentifier(
  value: unknown,
  label: string,
  reason: ManagedResourceBindingStoreError['reason'] = 'invalid_binding',
  maxChars = 128,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxChars) {
    throw new ManagedResourceBindingStoreError(reason, `${label} is invalid`);
  }
}

function requirePositiveInteger(
  value: unknown,
  label: string,
  reason: ManagedResourceBindingStoreError['reason'] = 'invalid_binding',
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ManagedResourceBindingStoreError(reason, `${label} is invalid`);
  }
}

function requireIso(
  value: unknown,
  label: string,
  reason: ManagedResourceBindingStoreError['reason'] = 'invalid_binding',
): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ManagedResourceBindingStoreError(reason, `${label} is invalid`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
