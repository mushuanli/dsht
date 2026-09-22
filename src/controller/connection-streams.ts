/** Event/control subscriptions and their startup deadlines belong to one connection generation. */
import { Client, RemoteError, type Subscription } from '../transport/client.ts';
import { controlFrame, hostEvent, type HostEvent } from '../transport/events.ts';
import { errorText, object, string, type Json } from '../transport/wire.ts';

export interface StreamHost {
  identified(clientId: string): void;
  event(event: HostEvent): boolean;
  changed(): void;
  degraded(message: string): void;
  fail(error: Error): void;
}

export class ConnectionStreams {
  private readonly subscriptions = new Set<Subscription>();
  private readonly abort = new AbortController();
  private readonly signal: AbortSignal;
  constructor(private readonly client: Client, private readonly host: StreamHost, signal: AbortSignal) {
    this.signal = AbortSignal.any([signal, this.abort.signal]);
  }

  async start(): Promise<void> {
    let clientId = '';
    await this.follow('$events', 'Host ready timed out', value => {
      const frame = object(value);
      if (frame.type === 'ready') {
        clientId = string(frame.clientId);
        this.host.identified(clientId);
        return true;
      }
      const event = hostEvent(frame);
      if (event && !this.host.event(event) && 'eventId' in event) {
        // Unknown waterfalls still need a result so the host's event chain can continue.
        void this.client.call('$events/result', { clientId, eventId: event.eventId, outcome: { kind: 'next' } })
          .catch(error => this.host.fail(new Error(errorText(error))));
      }
      return false;
    });
    await this.follow('session/control', 'Session control baseline timed out', value => {
      try {
        this.host.event({ kind: 'control', frame: controlFrame(value) });
        this.host.changed();
      } catch (error) {
        // Missing live metrics must not blind a running conversation.
        this.host.degraded(`Live metrics degraded: ${errorText(error)}`);
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

  /** Resolve the first usable frame while retaining the stream until this generation ends. */
  private follow(endpoint: string, timeout: string, item: (value: Json | undefined) => boolean,
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
      const timer = setTimeout(() => finish(new Error(timeout)), this.client.timeoutMs);
      this.signal.addEventListener('abort', cancelled, { once: true });
      try {
        const subscription = this.client.subscribe(endpoint, {}, {
          item: value => {
            if (this.signal.aborted) return;
            if (item(value)) finish();
          },
          end: error => {
            if (this.signal.aborted) return;
            if (unavailable?.(error)) { finish(); return; }
            const reason = error ?? new Error(`${endpoint} stream ended`);
            finish(reason); this.host.fail(reason);
          },
        });
        if (this.signal.aborted) subscription.cancel();
        else this.subscriptions.add(subscription);
      } catch (error) { finish(error); }
    });
  }
}
