/** Workspace/session navigation owns view intent independently of background list refreshes. */
import { array, object, string, type ObjectValue } from '../json.ts';
import type { Client } from '../transport/client.ts';
import type { HostAccess } from '../transport/host.ts';
import { sessionLabel } from '../session-title.ts';
import { resolveTarget } from './navigation.ts';

export interface NavigationState {
  screen: 'workspaces' | 'sessions' | 'chat' | 'path';
  workspaces: ObjectValue[];
  sessions: ObjectValue[];
  showAllSessions: boolean;
  workspaceId?: string;
  sessionId?: string;
}

export interface NavigationHost extends HostAccess {
  read(): Readonly<NavigationState>;
  publish(patch: Partial<NavigationState>): void;
  selection(): number;
  leave(): void;
  follow(sessionId: string): void;
}

interface Context { client: Client; signal: AbortSignal; check(): void }
interface Lists { workspaces: ObjectValue[]; sessions: ObjectValue[]; version: number }

export class SessionNavigator {
  private active?: AbortController;
  private readonly tasks = new Map<AbortController, Promise<unknown>>();
  private listsVersion = 0;
  private revision = 0;
  constructor(private readonly host: NavigationHost) {}

  get intent(): number { return this.revision; }
  /** Leaving a view invalidates the request that intended to open it. */
  cancel(): void { this.revision++; this.active?.abort(); }
  reset(): void { this.revision++; for (const abort of this.tasks.keys()) abort.abort(); }
  async settle(): Promise<void> { await Promise.allSettled(this.tasks.values()); }

  private run<T>(caller: AbortSignal | undefined, navigate: boolean, work: (context: Context) => Promise<T>): Promise<T> {
    if (navigate) this.cancel();
    const abort = new AbortController();
    if (navigate) this.active = abort;
    const selection = this.host.selection();
    const signal = AbortSignal.any([abort.signal, this.host.signal(), ...(caller ? [caller] : [])]);
    const task = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const client = this.host.require();
      const check = () => {
        signal.throwIfAborted();
        if (client !== this.host.client() || navigate && selection !== this.host.selection()) {
          throw new Error('Navigation changed while loading');
        }
      };
      check();
      return work({ client, signal, check });
    }).finally(() => {
      abort.abort();
      this.tasks.delete(abort);
      if (this.active === abort) this.active = undefined;
    });
    this.tasks.set(abort, task);
    return task;
  }

  private async load(context: Context): Promise<Lists> {
    const version = ++this.listsVersion;
    const [workspaces, sessions] = await Promise.all([
      context.client.listWorkspaces(context.signal), context.client.listSessions(undefined, context.signal),
    ]);
    context.check();
    return { workspaces, sessions, version };
  }

  private publishLists(lists: Lists): void {
    if (lists.version === this.listsVersion) this.host.publish({ workspaces: lists.workspaces, sessions: lists.sessions });
  }

  refreshLists(): Promise<void> {
    return this.run(undefined, false, async context => { this.publishLists(await this.load(context)); });
  }

  showPicker(screen: 'workspaces' | 'sessions', signal?: AbortSignal): Promise<void> {
    return this.run(signal, true, async context => {
      const lists = await this.load(context);
      this.publishLists(lists); context.check();
      this.host.publish({ screen });
    });
  }

  showChat(): boolean {
    if (this.host.read().sessionId === undefined) return false;
    this.cancel(); this.host.publish({ screen: 'chat' }); return true;
  }

  enterPath(): void { this.cancel(); this.host.publish({ screen: 'path' }); }

  private commitWorkspace(workspaceId?: string): void {
    this.host.leave();
    this.host.publish({ workspaceId, sessionId: undefined, showAllSessions: false, screen: 'sessions' });
  }

  pickWorkspace(workspaceId?: string): void { this.cancel(); this.commitWorkspace(workspaceId); }

  switchWorkspace(query?: string, signal?: AbortSignal): Promise<void> {
    if (!query) return this.showPicker('workspaces', signal);
    return this.run(signal, true, async context => {
      const lists = await this.load(context);
      const workspace = resolveTarget(lists.workspaces, query, 'workspaceId', row => [string(row.title), string(row.path)]);
      this.publishLists(lists); context.check();
      this.commitWorkspace(string(workspace.workspaceId));
    });
  }

  switchSession(query?: string, signal?: AbortSignal): Promise<void> {
    return this.run(signal, true, async context => {
      const lists = await this.load(context);
      if (!query || query === 'all') {
        this.publishLists(lists); context.check();
        this.host.publish({ screen: query === 'all' || this.host.read().workspaceId ? 'sessions' : 'workspaces', showAllSessions: query === 'all' });
      } else {
        const session = resolveTarget(lists.sessions, query, 'sessionId', row => [sessionLabel(row)]);
        this.publishLists(lists); context.check();
        this.host.follow(string(session.sessionId));
      }
    });
  }

  createWorkspace(path: string, signal?: AbortSignal): Promise<void> {
    return this.run(signal, true, async context => {
      const result = object(await context.client.call('workspace/create', { request: { path } }, context.signal));
      context.check();
      const lists = await this.load(context);
      this.publishLists(lists); context.check();
      this.commitWorkspace(string(object(result.workspace).workspaceId));
    });
  }

  createSession(signal?: AbortSignal): Promise<string> {
    return this.run(signal, true, async context => {
      const workspaceId = this.host.read().workspaceId;
      if (!workspaceId) throw new Error('Select a workspace before creating a session');
      const result = object(await context.client.call('session/create', { request: { workspaceId } }, context.signal));
      context.check();
      const sessionId = string(result.sessionId);
      this.host.follow(sessionId);
      return sessionId;
    });
  }

  get visibleSessions(): ObjectValue[] {
    const state = this.host.read();
    const sessions = state.sessions.filter(item => !this.host.client()?.archivedSessionIds.has(string(item.sessionId)));
    if (state.showAllSessions || !state.workspaceId) return sessions;
    const workspace = state.workspaces.find(item => item.workspaceId === state.workspaceId);
    const ids = new Set(array(workspace?.sessionIds ?? []).map(string));
    return sessions.filter(item => ids.has(string(item.sessionId)));
  }

  /** Longest registered path wins, with whole-segment matching for nested workspaces. */
  adoptLocalWorkspace(directory: string): string | undefined {
    const slashed = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
    const target = slashed(directory);
    if (!target) return undefined;
    let best: { id: string; length: number } | undefined;
    for (const workspace of this.host.read().workspaces) {
      const path = slashed(string(workspace.path));
      if (!path || target !== path && !target.startsWith(`${path}/`)) continue;
      if (!best || path.length > best.length) best = { id: string(workspace.workspaceId), length: path.length };
    }
    if (best) this.pickWorkspace(best.id);
    return best?.id;
  }
}
