/** Event/control subscriptions and their startup deadlines belong to one connection generation. */
import { Client, RemoteError, type Listener, type Subscription } from '../transport/client.ts';
import { controlFrame, hostEvent, readyClientId, type HostEvent } from '../transport/events.ts';
import { errorText, object, string, type Json } from '../transport/wire.ts';
import { eventResult, subscribeControl, subscribeEvents } from '../transport/dsh.ts';

export interface StreamHost {
  identified(clientId: string): void;
  event(event: HostEvent): boolean;
  changed(): void;
  /** Publish a live-metrics degradation, or clear it when a frame decodes again. */
  degraded(message: string | undefined): void;
  fail(error: Error): void;
}

export class ConnectionStreams {
  private readonly subscriptions = new Set<Subscription>();
  private readonly abort = new AbortController();
  private readonly signal: AbortSignal;
  /** Whether a control frame failed to decode in this generation, so recovery can clear it once. */
  private degradedFrame = false;
  constructor(private readonly client: Client, private readonly host: StreamHost, signal: AbortSignal) {
    this.signal = AbortSignal.any([signal, this.abort.signal]);
  }

  async start(): Promise<void> {
    let clientId = '';
    await this.follow(listener => subscribeEvents(this.client, listener), 'Host ready', value => {
      const ready = readyClientId(value);
      if (ready !== undefined) {
        clientId = ready;
        this.host.identified(clientId);
        return true;
      }
      const event = hostEvent(value);
      if (event && !this.host.event(event) && 'eventId' in event) {
        // Unknown waterfalls still need a result so the host's event chain can continue.
        void eventResult(this.client, clientId, event.eventId, { kind: 'next' })
          .catch(error => this.host.fail(new Error(errorText(error))));
      }
      return false;
    });
    await this.follow(listener => subscribeControl(this.client, listener), 'Session control baseline', value => {
      try {
        this.host.event({ kind: 'control', frame: controlFrame(value) });
        this.host.changed();
        // One undecodable frame is not a permanent condition: a frame that decodes proves live
        // metrics work again, so the degradation raised earlier in this generation ends here.
        if (this.degradedFrame) { this.degradedFrame = false; this.host.degraded(undefined); }
      } catch (error) {
        // Missing live metrics must not blind a running conversation. Only the first failure of an
        // episode is published: a baseline this client could not apply leaves every later update
        // reporting "before baseline", and that follow-up must not bury the error that caused it.
        if (!this.degradedFrame) {
          this.degradedFrame = true;
          this.host.degraded(`Live metrics degraded: ${errorText(error)}`);
        }
      }
      return true;
    }, error => {
      if (!(error instanceof RemoteError) || error.code !== 'gateway/method-unavailable') return false;
      this.host.degraded('Live metrics unavailable on this host');
      return true;
    });
  }

  close(): void {
    this.abort.abort();
    for (const subscription of this.subscriptions) subscription.cancel();
    this.subscriptions.clear();
  }

  /** Resolve the first usable frame while retaining the stream until this generation ends.
   *
   * The starter is a facade function rather than an endpoint name, so this file cannot open a
   * capability that has no row in `transport/endpoints.ts`; the timeout label is the only name it
   * still carries, and it is used for messages rather than for routing.
   */
  private follow(start: (listener: Listener) => Subscription, label: string, item: (value: Json | undefined) => boolean,
    unavailable?: (error: Error | undefined) => boolean): Promise<void> {
    this.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.signal.removeEventListener('abort', cancelled);
        if (error === undefined) resolve(); else reject(error);
      };
      const cancelled = () => finish(this.signal.reason);
      const timer = setTimeout(() => finish(new Error(`${label} timed out`)), this.client.timeoutMs);
      this.signal.addEventListener('abort', cancelled, { once: true });
      try {
        const subscription = start({
          item: value => {
            if (this.signal.aborted) return;
            if (item(value)) finish();
          },
          end: error => {
            if (this.signal.aborted) return;
            if (unavailable?.(error)) { finish(); return; }
            const reason = error ?? new Error(`${label} stream ended`);
            finish(reason); this.host.fail(reason);
          },
        });
        if (this.signal.aborted) subscription.cancel();
        else this.subscriptions.add(subscription);
      } catch (error) { finish(error); }
    });
  }
}
