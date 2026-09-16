/** Owns the physical connection, its generations, and the host event subscriptions. */
import { setTimeout as delay } from 'node:timers/promises';
import { AuthenticationRequired } from '../transport/auth.ts';
import { Client, HttpError, RemoteError } from '../transport/client.ts';
import { errorText, object, string, type Json } from '../transport/wire.ts';
import { controlFrame, hostEvent, type HostEvent } from '../transport/events.ts';
import type { HostAccess } from '../transport/host.ts';
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
  /** Route one normalized host event, so a feature never calls another feature directly. */
  event(event: HostEvent): boolean;
}

/** Owns the physical connection: reconnects, subscriptions and generation lifecycle.
 *
 * Host running state, projections and interactions belong to the session domain; this class only
 * decodes wire frames into `HostEvent` and hands them to the application, which routes them on.
 * User commands remain single-attempt operations.
 */
export class ConnectionController implements HostAccess, ConnectionView {
  clientId = '';
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

  /** Fail the current generation, so the controller reopens a snapshot. */
  fail(error: Error): void { this.generationFailed?.(error); }

  /** Answer one retained host waterfall through the event-result endpoint. */
  async reply(eventId: string, outcome: Json): Promise<void> {
    await this.require().call('$events/result', { clientId: this.clientId, eventId, outcome });
  }

  /** Run one generation, then retry with bounded jittered backoff until stopped. */
  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.abort.signal.aborted) {
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
                return;
              }
              const event = hostEvent(frame);
              if (!event) return;
              if (this.listener.event(event)) return;
              // An unanswered waterfall would block the host's event chain, so it is always settled.
              if ('eventId' in event) {
                void client.call('$events/result', { clientId: this.clientId,
                  eventId: event.eventId, outcome: { kind: 'next' } }).catch(error => fail(new Error(errorText(error))));
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
                this.listener.event({ kind: 'control', frame: controlFrame(value) });
                this.store.update({});
                clearTimeout(timer); resolve();
              } catch (error) {
                // Live metrics are not worth the connection: a frame this client cannot decode is
                // reported and skipped, because failing the generation would blind a running turn.
                clearTimeout(timer);
                this.store.update({ controlError: `Live metrics degraded: ${errorText(error)}` });
                resolve();
              }
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
          this.store.update({ operation: { ...this.store.state.operation, error: `${errorText(error)}. Set DSH_TOKEN and restart to log in.` }, status: 'Login required' });
          return;
        }
        if (!this.abort.signal.aborted) this.store.update({ operation: { ...this.store.state.operation, error: errorText(error) }, status: 'Reconnecting…' });
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
}
