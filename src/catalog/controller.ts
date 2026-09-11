/** Model routes, reasoning efforts and agent-preset metadata for the selected session. */
import type { Client } from '../transport/client.ts';
import type { HostAccess } from '../transport/host.ts';
import { array, errorText, object, string, type ObjectValue } from '../transport/wire.ts';
import type { ControllerStore } from '../state.ts';

/** Owns model-catalog and preset loads for the selected session. */
export class CatalogController {
  private presetClient?: Client;
  private revision = 0;
  private tasks = new Set<Promise<void>>();
  constructor(private readonly store: ControllerStore, private readonly host: HostAccess) {}

  /** Drop generation-scoped catalog state at the start of a connection generation. */
  reset(): void {
    this.store.update({ modelError: undefined, defaultModel: undefined, presets: undefined, presetError: undefined });
  }

  /** Wait for every in-flight catalog task, so shutdown leaves no pending request. */
  async settle(): Promise<void> { await Promise.all(this.tasks); }

  /** Load the optional preset roster once per connection, only when a session names a preset. */
  loadPresetNames(): void {
    const client = this.host.client();
    if (!client || !this.store.state.online || this.presetClient === client) return;
    this.presetClient = client;
    const task = client.call('agentPresets/list', {}).then(value => {
      if (client === this.host.client()) this.store.update({ presets: array(object(value).presets).map(object), presetError: undefined });
    }).catch(error => {
      if (client === this.host.client()) this.store.update({ presets: [], presetError: errorText(error) });
    });
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  /** Fetch current model routes and adapter-owned reasoning choices for the selected session.
   * @returns Host catalog; provider failures remain available to the selector.
   */
  async modelCatalog(): Promise<ObjectValue> {
    const sessionId = this.sessionId;
    const selection = this.store.selection();
    const value = object(await this.host.require().call('session/modelCatalog', {}));
    if (selection !== this.store.selection() || sessionId !== this.store.state.sessionId) throw new Error('Session changed while loading models');
    return value;
  }

  /** Select the next request's model; the host also attempts to save its deployment default.
   * @param provider - Host provider route ID.
   * @param model - Exact model ID.
   * @param reasoningEffort - Optional adapter-owned effort ID; omission uses its default.
   */
  async selectModel(provider: string, model: string, reasoningEffort?: string): Promise<void> {
    const sessionId = this.sessionId;
    const selection = this.store.selection();
    const selected = object(object(await this.host.require().call('session/selectModel', { request: {
      sessionId, provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    } })).selected);
    if (selection !== this.store.selection() || sessionId !== this.store.state.sessionId) return;
    this.store.update({ status: `Next request: ${string(selected.provider)} / ${string(selected.model)}${selected.reasoningEffort ? ` · ${string(selected.reasoningEffort)}` : ''}` });
    this.refresh();
  }

  /** Reload the default route and provider failures without touching session state. */
  refresh(): void {
    const client = this.host.client();
    if (!client) return;
    const revision = ++this.revision;
    const task = client.call('session/modelCatalog', {}).then(value => {
      if (client === this.host.client() && revision === this.revision) this.store.update({ defaultModel: object(object(value).default), modelError: undefined });
    }, error => {
      if (client === this.host.client() && revision === this.revision) this.store.update({ defaultModel: undefined, modelError: errorText(error) });
    }).catch(error => {
      if (client === this.host.client() && revision === this.revision) this.store.update({ defaultModel: undefined, modelError: errorText(error) });
    });
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  /** @returns The selected session identity, or a `Select a session first` failure. */
  private get sessionId(): string {
    const id = this.store.state.sessionId;
    if (!id) throw new Error('Select a session first');
    return id;
  }
}
