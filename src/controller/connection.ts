/** Owns the physical connection, its generations, and the host event subscriptions. */
import { setTimeout as delay } from 'node:timers/promises';
import { AuthenticationRequired } from '../transport/auth.ts';
import { Client, HttpError } from '../transport/client.ts';
import { errorText, type Json } from '../transport/wire.ts';
import type { HostEvent } from '../transport/events.ts';
import { ConnectionStreams } from './connection-streams.ts';
import type { HostAccess } from '../transport/host.ts';
import type { ConnectionView } from '../session/connection-view.ts';

/** Connection publication cannot replace session, navigation, catalog or shell state. */
export interface ConnectionStore {
  readonly state: { readonly online: boolean };
  update(patch: Partial<{ online: boolean; status: string; lastFailure: string; controlError: string | undefined }>): void;
}

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
  constructor(private readonly store: ConnectionStore, private readonly options: ConnectionOptions, private readonly listener: ConnectionListener) {}

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
      if (this.abort.signal.aborted) break;
      const client = this.options.makeClient();
      this.current = client;
      const generation = new AbortController();
      const signal = AbortSignal.any([this.abort.signal, generation.signal]);
      let disconnect!: (error: Error) => void;
      const disconnected = new Promise<Error>(resolve => { disconnect = resolve; });
      const fail = (error: Error) => {
        if (generation.signal.aborted) return;
        generation.abort(error);
        disconnect(error);
        // End HTTP as well as streams, including requests the ready callback is awaiting.
        void client.close();
      };
      this.generationFailed = fail;
      const streams = new ConnectionStreams(client, {
        identified: id => { this.clientId = id; }, event: event => this.listener.event(event),
        changed: () => this.store.update({}), degraded: controlError => this.store.update({ controlError }), fail,
      }, signal);
      try {
        signal.throwIfAborted();
        await this.options.authenticate(client);
        signal.throwIfAborted();
        await client.connect();
        signal.throwIfAborted();
        await streams.start();
        signal.throwIfAborted();
        await this.listener.ready();
        signal.throwIfAborted();
        attempt = 0;
        const error = await disconnected;
        if (!this.abort.signal.aborted) throw error;
      } catch (error) {
        if (this.abort.signal.aborted) break;
        const reason = generation.signal.aborted ? generation.signal.reason : error;
        if (reason instanceof AuthenticationRequired || reason instanceof HttpError && [401, 403].includes(reason.status)) {
          this.store.update({ lastFailure: `${errorText(reason)}. Set DSH_TOKEN and restart to log in.`, status: 'Login required' });
          return;
        }
        this.store.update({ lastFailure: errorText(reason), status: 'Reconnecting…' });
      } finally {
        this.generationFailed = undefined;
        generation.abort();
        streams.close();
        this.clientId = '';
        this.store.update({ online: false });
        await client.close();
        if (this.current === client) this.current = undefined;
        await this.listener.ended();
      }
      if (!this.abort.signal.aborted) {
        try { await delay(Math.min(500 * 2 ** attempt++, 10_000) * (0.8 + Math.random() * 0.4), undefined,
          { signal: this.abort.signal }); } catch (error) { if (!this.abort.signal.aborted) throw error; }
      }
    }
  }
}
