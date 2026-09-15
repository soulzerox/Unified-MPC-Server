import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { isMachineRootPath, type Workspace, type WorkspaceRepository } from '@unified-mpc/workspace';

export interface WorkspaceSelectionSnapshot {
  readonly primaryWorkspaceId: string;
  readonly activeWorkspaceIds: readonly string[];
}

export interface WorkspaceSelectionStore {
  get(): string | null;
  set(value: string): void;
}

export class WorkspaceSelectionService {
  private memory: string | null = null;

  public constructor(
    private readonly repository: WorkspaceRepository,
    private readonly initialWorkspaceId: string,
    private readonly store?: WorkspaceSelectionStore,
  ) {}

  public async list(): Promise<Result<WorkspaceSelectionSnapshot>> {
    const state = await this.state();
    return state.ok ? ok(this.snapshot(state.value)) : state;
  }

  public async activeWorkspaces(): Promise<Result<readonly Workspace[]>> {
    const state = await this.state();
    if (!state.ok) return state;
    const byId = new Map(state.value.projects.map((project) => [project.id, project]));
    return ok(state.value.activeWorkspaceIds.map((id) => byId.get(id)).filter((project): project is Workspace => project !== undefined));
  }

  public async activate(workspaceId: string): Promise<Result<WorkspaceSelectionSnapshot>> {
    const state = await this.state();
    if (!state.ok) return state;
    if (!state.value.projects.some((project) => project.id === workspaceId)) return this.notRegistered();
    const active = state.value.activeWorkspaceIds.includes(workspaceId) ? state.value.activeWorkspaceIds : [...state.value.activeWorkspaceIds, workspaceId];
    return this.save(state.value.primaryWorkspaceId, active);
  }

  public async deactivate(workspaceId: string): Promise<Result<WorkspaceSelectionSnapshot>> {
    const state = await this.state();
    if (!state.ok) return state;
    if (!state.value.projects.some((project) => project.id === workspaceId)) return this.notRegistered();
    if (!state.value.activeWorkspaceIds.includes(workspaceId)) return ok(this.snapshot(state.value));
    if (state.value.activeWorkspaceIds.length === 1) return err(appError('CONFLICT', 'At least one Active Project is required', true));
    const active = state.value.activeWorkspaceIds.filter((id) => id !== workspaceId);
    return this.save(state.value.primaryWorkspaceId === workspaceId ? active[0]! : state.value.primaryWorkspaceId, active);
  }

  public async setPrimary(workspaceId: string): Promise<Result<WorkspaceSelectionSnapshot>> {
    const state = await this.state();
    if (!state.ok) return state;
    if (!state.value.projects.some((project) => project.id === workspaceId)) return this.notRegistered();
    return this.save(workspaceId, [workspaceId, ...state.value.activeWorkspaceIds.filter((id) => id !== workspaceId)]);
  }

  private async state(): Promise<Result<ResolvedSelection>> {
    const projects = (await this.repository.list()).filter((project) => !isMachineRootPath(project.realRootPath) && !isMachineRootPath(project.rootPath));
    if (projects.length === 0) return err(appError('WORKSPACE_NOT_FOUND', 'No registered project workspace is available', true));
    const ids = new Set(projects.map((project) => project.id));
    const fallback = ids.has(this.initialWorkspaceId) ? this.initialWorkspaceId : projects[0]!.id;
    const parsed = parseSelection(this.store?.get() ?? this.memory);
    const active = [...new Set(parsed?.activeWorkspaceIds ?? [])].filter((id) => ids.has(id));
    if (active.length === 0) active.push(fallback);
    const primary = parsed !== null && ids.has(parsed.primaryWorkspaceId) && active.includes(parsed.primaryWorkspaceId) ? parsed.primaryWorkspaceId : active[0]!;
    return ok({ projects, primaryWorkspaceId: primary, activeWorkspaceIds: [primary, ...active.filter((id) => id !== primary)] });
  }

  private save(primaryWorkspaceId: string, activeWorkspaceIds: readonly string[]): Result<WorkspaceSelectionSnapshot> {
    const snapshot = { primaryWorkspaceId, activeWorkspaceIds: [primaryWorkspaceId, ...activeWorkspaceIds.filter((id) => id !== primaryWorkspaceId)] };
    const encoded = JSON.stringify(snapshot);
    if (this.store === undefined) this.memory = encoded;
    else this.store.set(encoded);
    return ok(snapshot);
  }

  private snapshot(value: WorkspaceSelectionSnapshot): WorkspaceSelectionSnapshot {
    return { primaryWorkspaceId: value.primaryWorkspaceId, activeWorkspaceIds: [...value.activeWorkspaceIds] };
  }

  private notRegistered<T>(): Result<T> {
    return err(appError('WORKSPACE_NOT_FOUND', 'Workspace is not a registered project', true));
  }
}

interface ResolvedSelection extends WorkspaceSelectionSnapshot {
  readonly projects: readonly Workspace[];
}

function parseSelection(value: string | null): WorkspaceSelectionSnapshot | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as { primaryWorkspaceId?: unknown; activeWorkspaceIds?: unknown };
    if (typeof parsed.primaryWorkspaceId !== 'string' || !Array.isArray(parsed.activeWorkspaceIds)) return null;
    return {
      primaryWorkspaceId: parsed.primaryWorkspaceId,
      activeWorkspaceIds: parsed.activeWorkspaceIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
    };
  } catch {
    return null;
  }
}
