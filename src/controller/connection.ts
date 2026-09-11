/** Owns the physical connection, its generations, and the host event subscriptions. */
import { setTimeout as delay } from 'node:timers/promises';
import { AuthenticationRequired } from '../transport/auth.ts';
import { Client, HttpError, RemoteError } from '../transport/client.ts';
import { array, errorText, object, string, type ObjectValue } from '../transport/wire.ts';
import type { HostAccess } from '../transport/host.ts';
import { Telemetry } from '../session/telemetry.ts';
import type { ConnectionView } from '../session/connection-view.ts';
import type { ControllerStore } from '../state.ts';

/** Connection inputs resolved by the CLI or a library consumer. */
export interface ConnectionOptions {
  base: string;
  token: string | undefined;
  initialSession: string | undefined;
  /** Factory for one generation's client; replaced in tests. */
  makeClient: () => Client;
  /** Authentication used by every generation, including reconnects. */
  authenticate: (client: Client) => Promise<void>;
}

/** Reactions the controller facade owes to connection lifecycle and host events. */
export interface ConnectionListener {
  /** A new generation starts; domains drop generation-scoped state. */
  begin(): void;
  /** The event stream is ready and the control baseline is applied. */
  ready(): Promise<void>;
  /** The generation ended and its socket is closed. */
  ended(): Promise<void>;
  /** Deliver a host waterfall; return true when a domain retained it for an answer. */
  waterfall(frame: ObjectValue): boolean;
  /** The host cancelled a waterfall a domain retained. */
  cancelled(eventId: string): void;
  /** The host reported one session's running state. */
  status(sessionId: string, running: boolean): void;
  /** The host reported one session's error. */
  error(sessionId: unknown, error: unknown): void;
  /** Model catalogs may have changed. */
  invalidated(): void;
  /** A turn finished, so billing may refresh. */
  idle(): void;
}

/** Projection keys this client consumes; the host retains every other capability. */
const RETAINED_PROJECTIONS = new Set(['title', 'modelSelection', 'contextPressure', 'tokenUsage', 'sessionStats', 'agentPreset']);

/** Host events that invalidate the model catalog. */
const CATALOG_EVENTS = ['llm/adapters-updated', 'settings/document-updated', 'credentials/reference-updated'];

/** Owns reconnects, subscriptions and the telemetry generation. User commands remain single-attempt operations. */
export class ConnectionController implements HostAccess, ConnectionView {
  telemetry = new Telemetry(RETAINED_PROJECTIONS);
  clientId = '';
  private readonly runningUpdates = new Map<string, boolean>();
  private readonly observedRunningAt = new Map<string, number>();
  private current: Client | undefined;
  private readonly abort = new AbortController();
  private runTask: Promise<void> | undefined;
  private generationFailed: ((error: Error) => void) | undefined;
  constructor(private readonly store: ControllerStore, private readonly options: ConnectionOptions, private readonly listener: ConnectionListener) {}

  /** Start one retry loop, with a fresh snapshot generation after every disconnect. */
  start(): void { this.runTask ??= this.run(); }

  /** Cancel retries and HTTP, close the socket, and wait for the loop to settle. */
  async stop(): Promise<void> {
    this.abort.abort();
    this.generationFailed?.(new Error('Client stopped'));
    await this.current?.close();
    await this.runTask;
  }

  /** @returns The connected client, or undefined while offline. */
  client(): Client | undefined { return this.current; }

  /** @returns The connected client, or throws while offline. */
  require(): Client {
    if (!this.current || !this.store.state.online) throw new Error('Not connected');
    return this.current;
  }

  /** @returns Whether the current generation applied its host baseline. */
  online(): boolean { return this.store.state.online; }

  /** @returns The client lifetime signal. */
  signal(): AbortSignal { return this.abort.signal; }

  /** @returns The projection store of the current generation. */
  telemetryView(): Telemetry { return this.telemetry; }

  /** @returns Cached host running state, or undefined when never reported. */
  runningFor(sessionId: string): boolean | undefined { return this.runningUpdates.get(sessionId); }

  /** @returns When this client first observed the session, for the elapsed-time fallback. */
  observedAt(sessionId: string): number | undefined { return this.observedRunningAt.get(sessionId); }

  /** Record an observation start for a session this client just opened. */
  observe(sessionId: string): void { if (!this.observedRunningAt.has(sessionId)) this.observedRunningAt.set(sessionId, Date.now()); }

  /** Fail the current generation, so the controller reopens a snapshot. */
  fail(error: Error): void { this.generationFailed?.(error); }

  /** Answer one retained host waterfall through the event-result endpoint. */
  async reply(frame: ObjectValue, outcome: ObjectValue): Promise<void> {
    await this.require().call('$events/result', { clientId: this.clientId, eventId: string(frame.eventId), outcome });
  }

  /** Run one generation, then retry with bounded jittered backoff until stopped. */
  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.abort.signal.aborted) {
      this.runningUpdates.clear();
      this.observedRunningAt.clear();
      this.telemetry = new Telemetry(RETAINED_PROJECTIONS);
      this.listener.begin();
      const client = this.options.makeClient();
      this.current = client;
      try {
        await this.options.authenticate(client);
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
                if (this.listener.waterfall(frame)) return;
                void client.call('$events/result', { clientId: this.clientId,
                  eventId: string(frame.eventId), outcome: { kind: 'next' } }).catch(error => fail(new Error(errorText(error))));
              } else if (frame.type === 'cancel') {
                this.listener.cancelled(string(frame.eventId));
              } else if (frame.type === 'emit' && frame.event === 'api-session/status') {
                this.acceptStatus(array(frame.args));
              } else if (frame.type === 'emit' && CATALOG_EVENTS.includes(String(frame.event))) {
                this.listener.invalidated();
              } else if (frame.type === 'emit' && frame.event === 'api-session/error') {
                const args = array(frame.args);
                this.listener.error(args[0], args[1]);
              }
            },
            end: error => { clearTimeout(timer); const reason = error ?? new Error('Event stream ended'); reject(reason); fail(reason); },
          });
        });
        await ready;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Session control baseline timed out')), client.timeoutMs);
          client.subscribe('session/control', {}, {
            item: value => {
              try {
                this.telemetry.accept(value);
                this.store.update({});
                clearTimeout(timer); resolve();
              } catch (error) { clearTimeout(timer); reject(error); fail(new Error(errorText(error))); }
            },
            end: error => {
              clearTimeout(timer);
              if (error instanceof RemoteError && error.code === 'gateway/method-unavailable') {
                this.store.update({ controlError: 'Live metrics unavailable on this host' }); resolve();
              } else { const reason = error ?? new Error('Session control stream ended'); reject(reason); fail(reason); }
            },
          });
        });
        await this.listener.ready();
        attempt = 0;
        const error = await disconnected;
        if (!this.abort.signal.aborted) throw error;
      } catch (error) {
        if (error instanceof AuthenticationRequired || error instanceof HttpError && [401, 403].includes(error.status)) {
          this.store.update({ error: `${errorText(error)}. Set DSH_TOKEN and restart to log in.`, status: 'Login required' });
          return;
        }
        if (!this.abort.signal.aborted) this.store.update({ error: errorText(error), status: 'Reconnecting…' });
      } finally {
        this.generationFailed = undefined;
        this.store.update({ online: false, pending: [] });
        await client.close();
        await this.listener.ended();
      }
      if (!this.abort.signal.aborted) {
        try { await delay(Math.min(500 * 2 ** attempt++, 10_000) * (0.8 + Math.random() * 0.4), undefined,
          { signal: this.abort.signal }); } catch (error) { if (!this.abort.signal.aborted) throw error; }
      }
    }
  }

  /** Apply one `api-session/status` notification to the running maps and the session view. */
  private acceptStatus(args: readonly unknown[]): void {
    const sessionId = string(args[0]);
    if (typeof args[1] !== 'boolean') throw new Error('Invalid session running state');
    if (args[1] && !this.runningUpdates.get(sessionId)) this.observedRunningAt.set(sessionId, Date.now());
    if (!args[1]) this.observedRunningAt.delete(sessionId);
    this.runningUpdates.set(sessionId, args[1]);
    this.listener.status(sessionId, args[1]);
    if (!args[1]) this.listener.idle();
  }
}
