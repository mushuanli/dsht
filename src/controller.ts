/** UI state and connection generations for the standalone terminal client. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, HttpError, type Subscription } from './client.ts';
import { AuthenticationRequired } from './auth.ts';
import { resolveTarget, sessionLabel } from './navigation.ts';
import { Transcript } from './transcript.ts';
import { array, errorText, object, string, type Json, type ObjectValue } from './wire.ts';

/** State shared by the picker and conversation view. */
export interface State {
  version: number;
  online: boolean;
  busy: boolean;
  screen: 'workspaces' | 'sessions' | 'chat' | 'path';
  status: string;
  error: string;
  workspaces: ObjectValue[];
  sessions: ObjectValue[];
  showAllSessions: boolean;
  workspaceId?: string;
  sessionId?: string;
  pending: ObjectValue[];
  transcript: Transcript;
}

/** Owns reconnects and subscriptions. User commands remain single-attempt operations. */
export class Controller {
  state: State = { version: 0, online: false, busy: false, screen: 'workspaces', status: 'Connecting…',
    error: '', workspaces: [], sessions: [], showAllSessions: false, pending: [], transcript: new Transcript() };
  private observers = new Set<() => void>();
  private abort = new AbortController();
  private client: Client | undefined;
  private clientId = '';
  private follow: Subscription | undefined;
  private runTask: Promise<void> | undefined;
  private generationFailed: ((error: Error) => void) | undefined;
  private selection = 0;
  constructor(readonly base: string, token: string | undefined, readonly initialSession?: string,
    private makeClient: () => Client = () => new Client(base),
    private authenticate: (client: Client) => Promise<void> = client => client.authenticate(token ?? '')) {}

  /** React-compatible state subscription. */
  subscribe = (listener: () => void): (() => void) => {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  };
  /** Snapshot identity changes only when the controller publishes. */
  snapshot = (): State => this.state;

  /** Start one retry loop, with a fresh snapshot generation after every disconnect. */
  start(): void { this.runTask ??= this.run(); }

  /** Cancel retries and HTTP, close the socket, and wait for the loop to settle. */
  async stop(): Promise<void> {
    this.abort.abort();
    this.generationFailed?.(new Error('Client stopped'));
    await this.client?.close();
    await this.runTask;
  }

  /** Run a UI operation and expose errors without destroying the current input. */
  async perform(operation: () => Promise<void>): Promise<boolean> {
    if (this.state.busy || !this.state.online) return false;
    this.update({ busy: true, error: '' });
    try { await operation(); return true; }
    catch (error) { this.update({ error: errorText(error) }); return false; }
    finally { this.update({ busy: false }); }
  }

  /** Refresh both lists from the host, then show the requested picker. */
  async showPicker(screen: 'workspaces' | 'sessions'): Promise<void> {
    await this.releasePending();
    const [workspaces, sessions] = await Promise.all([this.host.listWorkspaces(), this.host.listSessions()]);
    this.update({ screen, workspaces, sessions });
  }

  /** Pick a workspace, or use all sessions when the identity is omitted. */
  pickWorkspace(workspaceId?: string): void {
    this.follow?.cancel();
    this.selection++;
    this.update({ workspaceId, sessionId: undefined, showAllSessions: false, transcript: new Transcript(), screen: 'sessions' });
  }

  /** Open a workspace picker, or resolve a workspace by ID, exact title/path, or unique ID prefix. */
  async switchWorkspace(query?: string): Promise<void> {
    if (!query) { await this.showPicker('workspaces'); return; }
    const workspaces = await this.host.listWorkspaces();
    const workspace = resolveTarget(workspaces, query, 'workspaceId', item => [string(item.title), string(item.path)]);
    const sessions = await this.host.listSessions();
    await this.releasePending();
    this.update({ workspaces, sessions });
    this.pickWorkspace(string(workspace.workspaceId));
  }

  /** Guide workspace selection, list all sessions with `all`, or resolve an exact session target. */
  async switchSession(query?: string): Promise<void> {
    if (!query || query === 'all') {
      await this.showPicker(query === 'all' || this.state.workspaceId ? 'sessions' : 'workspaces');
      this.update({ showAllSessions: query === 'all' });
      return;
    }
    const [workspaces, sessions] = await Promise.all([this.host.listWorkspaces(), this.host.listSessions()]);
    const session = resolveTarget(sessions, query, 'sessionId', item => [sessionLabel(item)]);
    this.update({ workspaces, sessions });
    await this.selectSession(string(session.sessionId));
  }

  /** Prompt for a host path without starting a local agent. */
  enterPath(): void { this.update({ screen: 'path' }); }

  /** Register a host directory and move to its session picker. */
  async createWorkspace(path: string): Promise<void> {
    const result = object(await this.host.call('workspace/create', { request: { path } }));
    const workspace = object(result.workspace);
    await this.showPicker('workspaces');
    this.pickWorkspace(string(workspace.workspaceId));
  }

  /** Create a session only after the user explicitly selects New session. */
  async createSession(): Promise<void> {
    if (!this.state.workspaceId) throw new Error('Select a workspace before creating a session');
    const result = object(await this.host.call('session/create', { request: { workspaceId: this.state.workspaceId } }));
    await this.selectSession(string(result.sessionId));
  }

  /** Replace the selected transcript and cancel its preceding follow stream. */
  async selectSession(sessionId: string): Promise<void> {
    await this.releasePending();
    this.follow?.cancel();
    const selection = ++this.selection;
    const transcript = new Transcript();
    const workspace = this.state.workspaces.find(item => array(item.sessionIds).includes(sessionId));
    const workspaceId = workspace ? string(workspace.workspaceId)
      : this.state.sessions.some(item => item.sessionId === sessionId) ? undefined : this.state.workspaceId;
    this.update({ sessionId, workspaceId, showAllSessions: false, transcript, screen: 'chat', status: 'Loading session…' });
    this.follow = this.host.subscribe('session/follow', {
      request: { address: { kind: 'session', sessionId }, maxMessages: 80, assistantStream: true },
    }, {
      item: value => {
        if (selection !== this.selection) return;
        try {
          transcript.accept(value);
          this.update({ transcript, status: transcript.liveText ? 'Responding…' : 'Connected' });
        } catch (error) { this.generationFailed?.(new Error(errorText(error))); }
      },
      end: error => {
        if (selection !== this.selection) return;
        transcript.ready = false;
        this.update({ status: 'Session disconnected', error: errorText(error ?? 'Session stream ended') });
      },
    });
  }

  /** Admit a prompt once; a failed response can have an uncertain delivery outcome. */
  async prompt(text: string, mode: 'queue' | 'steer' = 'queue'): Promise<void> {
    if (!this.state.transcript.ready) throw new Error('Wait for the session snapshot before sending');
    await this.host.call('session/prompt', { request: {
      sessionId: this.sessionId, requestId: randomUUID(), mode,
      content: [{ type: 'text', text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    } });
    this.update({ status: 'Accepted · waiting for host' });
  }

  /** Cancel the active turn; pending queue items remain host-owned. */
  async cancelTurn(): Promise<void> {
    await this.host.call('session/cancel', { request: { sessionId: this.sessionId } });
    this.update({ status: 'Cancellation requested' });
  }

  /** Add a page before the retained window using its fixed opening cut. */
  async older(): Promise<void> {
    const transcript = this.state.transcript;
    if (!transcript.ready || !transcript.hasMore || transcript.beforeSeq === undefined) return;
    const result = await this.host.call('session/page', { request: {
      address: { kind: 'session', sessionId: this.sessionId }, throughSeq: transcript.cursor,
      beforeSeq: transcript.beforeSeq, maxMessages: 80,
    } });
    if (transcript !== this.state.transcript) return;
    transcript.addPage(result);
    this.update({ transcript });
  }

  /** Answer the oldest selected-session interaction, after explicit user action. */
  async answer(value: Json): Promise<void> {
    const pending = this.state.pending[0];
    if (!pending) throw new Error('No pending interaction');
    await this.reply(pending, { kind: 'result', value });
    this.update({ pending: this.state.pending.filter(item => item.eventId !== pending.eventId) });
  }

  /** Restrict an approval command to an approval request. */
  async approve(allowed: boolean): Promise<void> {
    if (this.state.pending[0]?.event !== 'approval/request') throw new Error('No pending approval');
    await this.answer(allowed ? 'allowed-once' : 'rejected');
  }

  /** Present only sessions explicitly accounted to the selected workspace. */
  get visibleSessions(): ObjectValue[] {
    if (this.state.showAllSessions || !this.state.workspaceId) return this.state.sessions;
    const workspace = this.state.workspaces.find(item => item.workspaceId === this.state.workspaceId);
    const ids = new Set(array(workspace?.sessionIds ?? []).map(string));
    return this.state.sessions.filter(item => ids.has(string(item.sessionId)));
  }

  private get host(): Client {
    if (!this.client || !this.state.online) throw new Error('Not connected');
    return this.client;
  }
  private get sessionId(): string {
    if (!this.state.sessionId) throw new Error('Select a session first');
    return this.state.sessionId;
  }
  private update(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    for (const observer of this.observers) observer();
  }
  private async reply(frame: ObjectValue, outcome: ObjectValue): Promise<void> {
    await this.host.call('$events/result', { clientId: this.clientId, eventId: string(frame.eventId), outcome });
  }
  private async releasePending(): Promise<void> {
    for (const pending of this.state.pending) await this.reply(pending, { kind: 'next' });
    this.update({ pending: [] });
  }
  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.abort.signal.aborted) {
      const client = this.makeClient();
      this.client = client;
      try {
        await this.authenticate(client);
        await client.connect();
        let fail!: (error: Error) => void;
        const disconnected = new Promise<Error>(resolve => { fail = resolve; });
        this.generationFailed = fail;
        const ready = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Host ready timed out')), client.timeoutMs);
          client.subscribe('$events', {}, {
            item: value => {
              const frame = object(value);
              if (frame.type === 'ready') {
                this.clientId = string(frame.clientId);
                clearTimeout(timer);
                resolve();
              } else if (frame.type === 'waterfall') {
                if (frame.agentId === this.state.sessionId && this.state.screen === 'chat'
                  && ['approval/request', 'user-questions/request'].includes(string(frame.event))) {
                  this.update({ pending: [...this.state.pending, frame] });
                } else {
                  void client.call('$events/result', { clientId: this.clientId,
                    eventId: string(frame.eventId), outcome: { kind: 'next' } }).catch(error => fail(new Error(errorText(error))));
                }
              } else if (frame.type === 'cancel') {
                this.update({ pending: this.state.pending.filter(item => item.eventId !== frame.eventId) });
              } else if (frame.type === 'emit' && frame.event === 'api-session/status') {
                const args = array(frame.args);
                if (args[0] === this.state.sessionId) this.update({ status: args[1] ? 'Running…' : 'Idle' });
              } else if (frame.type === 'emit' && frame.event === 'api-session/error') {
                const args = array(frame.args);
                if (args[0] === this.state.sessionId) this.update({ status: 'Agent error', error: errorText(args[1]) });
              }
            },
            end: error => { clearTimeout(timer); const reason = error ?? new Error('Event stream ended'); reject(reason); fail(reason); },
          });
        });
        await ready;
        this.update({ online: true, status: 'Connected', error: '', pending: [] });
        const screen = this.state.screen;
        await this.showPicker(screen === 'sessions' ? 'sessions' : 'workspaces');
        const sessionId = this.state.sessionId ?? this.initialSession;
        if (sessionId && (screen === 'chat' || this.initialSession && !this.state.sessionId)) await this.selectSession(sessionId);
        attempt = 0;
        const error = await disconnected;
        if (!this.abort.signal.aborted) throw error;
      } catch (error) {
        if (error instanceof AuthenticationRequired || error instanceof HttpError && [401, 403].includes(error.status)) {
          this.update({ error: `${errorText(error)}. Set DSH_TOKEN and restart to log in.`, status: 'Login required' });
          return;
        }
        if (!this.abort.signal.aborted) this.update({ error: errorText(error), status: 'Reconnecting…' });
      } finally {
        this.generationFailed = undefined;
        this.selection++;
        this.state.transcript.ready = false;
        this.update({ online: false, pending: [] });
        await client.close();
      }
      if (!this.abort.signal.aborted) {
        try { await delay(Math.min(500 * 2 ** attempt++, 10_000) * (0.8 + Math.random() * 0.4), undefined,
          { signal: this.abort.signal }); } catch (error) { if (!this.abort.signal.aborted) throw error; }
      }
    }
  }
}
