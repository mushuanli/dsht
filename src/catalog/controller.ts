/** Model routes, reasoning efforts and agent-preset metadata for the selected session. */
import type { Client } from '../transport/client.ts';
import type { HostAccess } from '../transport/host.ts';
import { array, errorText, object, string, type ObjectValue } from '../transport/wire.ts';

/** Catalog can publish its metadata and selection result, but cannot navigate or mutate sessions. */
export interface CatalogUpdate {
  defaultModel?: ObjectValue;
  modelError?: string;
  presets?: ObjectValue[];
  presetError?: string;
  status?: string;
}

export interface CatalogHost extends HostAccess {
  selection(): { revision: number; sessionId: string | undefined };
  publish(patch: CatalogUpdate): void;
}

/** Owns model-catalog and preset loads for the selected session. */
export class CatalogController {
  private presetClient?: Client;
  private revision = 0;
  private generation = new AbortController();
  private refreshAbort?: AbortController;
  private tasks = new Set<Promise<unknown>>();
  constructor(private readonly host: CatalogHost) {}

  /** Drop generation-scoped catalog state at the start of a connection generation. */
  reset(): void {
    this.close();
    this.generation = new AbortController();
    this.presetClient = undefined;
    this.host.publish({ modelError: undefined, defaultModel: undefined, presets: undefined, presetError: undefined });
  }

  /** Stop catalog requests before waiting for transport shutdown. Reset opens the next generation. */
  close(): void { this.revision++; this.generation.abort(); }

  /** Wait for every in-flight catalog task, so shutdown leaves no pending request. */
  async settle(): Promise<void> { await Promise.allSettled(this.tasks); }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return task;
  }

  private signal(caller = this.host.signal()): AbortSignal {
    return AbortSignal.any([caller, this.host.signal(), this.generation.signal]);
  }

  /** Load the optional preset roster once per connection, only when a session names a preset. */
  loadPresetNames(): void {
    const client = this.host.client();
    const signal = this.signal();
    if (!client || !this.host.online() || this.presetClient === client || signal.aborted) return;
    this.presetClient = client;
    const current = () => !signal.aborted && client === this.host.client();
    const task = client.call('agentPresets/list', {}, signal).then(value => {
      if (current()) this.host.publish({ presets: array(object(value).presets).map(object), presetError: undefined });
    }).catch(error => {
      if (current()) this.host.publish({ presets: [], presetError: errorText(error) });
    });
    this.track(task);
  }

  /** Fetch current model routes and adapter-owned reasoning choices for the selected session.
   * @returns Host catalog; provider failures remain available to the selector.
   */
  async modelCatalog(caller?: AbortSignal): Promise<ObjectValue> {
    const selection = this.selected();
    const signal = this.signal(caller);
    signal.throwIfAborted();
    return this.track((async () => {
      const value = object(await this.host.require().call('session/modelCatalog', {}, signal));
      signal.throwIfAborted();
      if (!this.isSelected(selection)) throw new Error('Session changed while loading models');
      return value;
    })());
  }

  /** Select the next request's model; the host also attempts to save its deployment default.
   * @param provider - Host provider route ID.
   * @param model - Exact model ID.
   * @param reasoningEffort - Optional adapter-owned effort ID; omission uses its default.
   */
  async selectModel(provider: string, model: string, reasoningEffort?: string, caller?: AbortSignal): Promise<void> {
    const selection = this.selected();
    const signal = this.signal(caller);
    signal.throwIfAborted();
    await this.track((async () => {
      const selected = object(object(await this.host.require().call('session/selectModel', { request: {
        sessionId: selection.sessionId, provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      } }, signal)).selected);
      signal.throwIfAborted();
      if (!this.isSelected(selection)) return;
      this.host.publish({ status: `Next request: ${string(selected.provider)} / ${string(selected.model)}${selected.reasoningEffort ? ` · ${string(selected.reasoningEffort)}` : ''}` });
      this.refresh();
    })());
  }

  /** Reload the default route and provider failures without touching session state. */
  refresh(): void {
    const client = this.host.client();
    if (!client || !this.host.online()) return;
    this.refreshAbort?.abort();
    this.refreshAbort = new AbortController();
    const signal = this.signal(this.refreshAbort.signal);
    if (signal.aborted) return;
    const revision = ++this.revision;
    const current = () => !signal.aborted && client === this.host.client() && revision === this.revision;
    const task = client.call('session/modelCatalog', {}, signal).then(value => {
      if (current()) this.host.publish({ defaultModel: object(object(value).default), modelError: undefined });
    }).catch(error => {
      if (current()) this.host.publish({ defaultModel: undefined, modelError: errorText(error) });
    });
    this.track(task);
  }

  /** @returns The selected session identity, or a `Select a session first` failure. */
  private selected(): { revision: number; sessionId: string } {
    const selected = this.host.selection();
    if (!selected.sessionId) throw new Error('Select a session first');
    return { ...selected, sessionId: selected.sessionId };
  }

  private isSelected(selection: { revision: number; sessionId: string }): boolean {
    const current = this.host.selection();
    return current.revision === selection.revision && current.sessionId === selection.sessionId;
  }
}
