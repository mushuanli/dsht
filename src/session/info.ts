/** Session-owned prompt index: every user prompt of the selected session, plus its recall cursor.
 *
 * The index replaces a plain bounded recall buffer. Each durable entry carries the sequence it came
 * from, so an entry evicted by the budgets stays recoverable: the loaded window refills anything the
 * transcript still holds, and `session/page` refetches anything older than the window. Budgets
 * therefore bound memory without deciding reachability — which is what a base-200 buffer got wrong.
 *
 * Locally submitted slash commands never become durable records, so they are retained too, marked as
 * non-durable. A durable echo of a locally recorded prompt upgrades that entry instead of adding a
 * second copy, keeping the refill boundary (the oldest durable sequence) exact.
 */
import { releaseHistoryLayout, type Reasoning } from './history.ts';
import { Transcript } from './transcript.ts';
import type { HistorySearch } from './types.ts';
import type { ObjectValue } from '../transport/wire.ts';

/** A durable user prompt as the transcript reports it, before retention. */
export interface PromptRecord { seq: number; text: string }

/** One retained prompt: its text, plus the durable sequence when the host also recorded it. */
export interface PromptEntry extends PromptRecord { durable: boolean }

/** How many prompts one session may retain, and how much text they may occupy. */
export interface PromptLimits { maxEntries: number; maxBytes: number }

/** Default balance: a long session's whole prompt list, since prompts are far smaller than history. */
export const DEFAULT_PROMPT_LIMITS: PromptLimits = { maxEntries: 2000, maxBytes: 512 * 1024 };

/** Longest single prompt worth recalling; a larger one is skipped rather than truncated in place. */
const MAX_ENTRY_CHARS = 128 * 1024;

/** Flatten one transcript prompt into the single line the composer recalls. */
export function promptText(value: string): string { return value.replace(/\r?\n/g, ' ').trim(); }

/** The selected session's composer: its draft, the caret in it, and a draft a dialog parked aside. */
export interface ComposerState { draft: string; cursor: number; parked: string }

/** How the selected session's record is being read: which window, where, and what is expanded.
 *
 * Everything here changes how the record renders, which is why it is session state rather than a
 * transient panel flag; the record's content stays in `Transcript`. `window` is a strong reference
 * released by `closeWindow`, and the layout cache keyed by it is a weak one.
 */
export interface ViewState {
  /** Detached record shown instead of the live transcript while reading jumped-to history. */
  window?: Transcript;
  scroll: number;
  /** Reading protection: reclamation pauses until the reader returns to the live end. */
  pinned: boolean;
  /** Message sequences whose reasoning is expanded beyond the default fold. */
  folds: ReadonlySet<number>;
  /** Fold mode for the live attempt's completed reasoning. */
  liveReasoning: Reasoning;
}

/** Composer-adjacent `@` reference menu: the highlighted row and the draft that dismissed it. */
export interface ReferenceState { index: number; dismissed?: string }

/** Model dialog step: the catalog plus the provider or model being inspected. */
export interface ModelState { catalog: ObjectValue; provider?: string; model?: ObjectValue }

/** Panels the reader opened for the selected session.
 *
 * Only visibility and query text: every panel's rows come from the record, so closing one loses
 * nothing and a session switch may clear all of it. The row cursor inside a panel is not here — it
 * is focus, held by `Picker` and reset through its `key`.
 */
export interface PanelState {
  thoughts: boolean;
  queue: boolean;
  model?: ModelState;
  history?: { query: string; contentSearch: boolean; matches?: HistorySearch };
  search?: { query: string; items: ObjectValue[]; hasMore: boolean };
}

/** Keyboard state of one pending question's options. */
export interface OptionState { key: string; cursor: number; selected: string[]; custom: boolean }

/** Local answer state for host waterfalls: question answers collected so far, and the keyboard
 *  selection of an approval or of a question's options. The waterfall itself stays in
 *  `SessionController.interactions`, which is derived per session on every publish.
 */
export interface InteractionState {
  answers: Record<string, ObjectValue[]>;
  option?: OptionState;
  approval?: { eventId: string; index: number };
}

/** Client-owned state of the selected session, reset whenever another session is opened.
 *
 * It holds the record, the prompt index, the composer, the reading view and the local interaction
 * state because all five belong to one session and none of them is owned by the host beyond what the
 * record mirrors; everything derivable from `Telemetry` or `CostLedger` stays out (see the design's
 * §5.7.6). The record is referenced here and nowhere else, so "the selected session" has one entry.
 */
export class SessionInfo {
  /** The selected session's record. Replaced — never mutated in place — when another session opens. */
  record: Transcript = new Transcript();
  readonly prompts = new PromptIndex();
  readonly composer: ComposerState = { draft: '', cursor: 0, parked: '' };
  readonly view: ViewState = { scroll: 0, pinned: false, folds: new Set(), liveReasoning: 'row' };
  readonly interaction: InteractionState = { answers: {} };
  readonly reference: ReferenceState = { index: 0 };
  readonly panels: PanelState = { thoughts: false, queue: false };

  constructor(public sessionId = '') {}

  /** Forget everything a previous session owned, keeping this instance identity-stable for `State`. */
  reset(sessionId = ''): void {
    this.sessionId = sessionId;
    this.closeWindow();
    releaseHistoryLayout(this.record);
    this.record.dispose();
    this.record = new Transcript();
    this.prompts.reset();
    this.composer.draft = ''; this.composer.cursor = 0; this.composer.parked = '';
    this.view.scroll = 0; this.view.pinned = false;
    this.view.folds = new Set(); this.view.liveReasoning = 'row';
    this.interaction.answers = {}; this.interaction.option = undefined; this.interaction.approval = undefined;
    this.reference.index = 0; this.reference.dismissed = undefined;
    this.panels.thoughts = false; this.panels.queue = false;
    this.panels.model = undefined; this.panels.history = undefined; this.panels.search = undefined;
  }

  /** Release the detached history window, if the reader has one open. */
  closeWindow(): void {
    const window = this.view.window;
    if (!window) return;
    releaseHistoryLayout(window); window.dispose();
    this.view.window = undefined;
  }
}

/** Seq-ordered prompts with a recall cursor, owned by the selected session.
 *
 * `append` folds only prompts newer than the last fold, so streaming stays O(new records) and never
 * rebuilds a projection just to notice a prompt. `oldest` reports the durable boundary, and
 * `missingBefore` reports what the loaded window can refill before a page request is spent.
 */
export class PromptIndex {
  private entries: PromptEntry[] = [];
  private bytes = 0;
  private newestSeq = -1;
  private complete = false;
  private shed = false;
  private position: number | undefined;
  private draft = '';

  constructor(private readonly limits: PromptLimits = DEFAULT_PROMPT_LIMITS) {}

  /** Retained entry count, so a caller can tell an empty index from a parked cursor. */
  get length(): number { return this.entries.length; }

  /** Whether recall is parked on the oldest retained entry. */
  get atOldest(): boolean { return this.position === 0; }

  /** Newest durable sequence already folded, so the next fold scans only what arrived after it. */
  get through(): number { return this.newestSeq; }

  /** Oldest durable sequence still retained; the window refills only prompts older than this. */
  get oldest(): number | undefined {
    for (const entry of this.entries) if (entry.durable) return entry.seq;
    return undefined;
  }

  /** Retained entries in session order, oldest first. */
  get items(): readonly PromptEntry[] { return this.entries; }

  /** Retained durable prompts only, in session order: what a cache may hand to another index. */
  get durableItems(): PromptRecord[] {
    return this.entries.filter(entry => entry.durable).map(entry => ({ seq: entry.seq, text: entry.text }));
  }

  /** Whether a backfill has walked the host history to its beginning for this session. */
  get exhausted(): boolean { return this.complete; }

  /** Whether a budget eviction dropped a retained prefix, so the index is no longer contiguous with
   *  the session's first prompt and must not claim to be exhaustive. */
  get trimmed(): boolean { return this.shed; }

  /** Record that the host holds no prompts older than the ones retained.
   *
   * An index that shed a prefix cannot claim this: the dropped prompts are older than anything the
   * live window holds, so the lazy backward step could not recover them.
   */
  markComplete(): void { if (!this.shed) this.complete = true; }

  /** Forget one session's prompts and cursor. */
  reset(): void {
    this.entries = []; this.bytes = 0; this.newestSeq = -1; this.complete = false; this.shed = false;
    this.position = undefined; this.draft = '';
  }

  /** Fold one transcript scan: its prompts, plus the watermark it covered.
   *
   * The watermark advances even when the scan found no prompt, so a turn of assistant and tool
   * records is scanned once rather than again on every following frame.
   * @param value - Prompts newer than `through`, and the newest sequence the scan covered.
   */
  fold(value: { prompts: readonly PromptRecord[]; through: number }): void {
    for (const prompt of value.prompts) this.push(prompt);
    this.newestSeq = Math.max(this.newestSeq, value.through,
      value.prompts.reduce((max, prompt) => Math.max(max, prompt.seq), -1));
  }

  /** Fold prompts whose own sequences are already the watermark; entries beyond the budgets drop the
   * oldest, which stays reloadable.
   * @param values - Prompts in session order, oldest first.
   */
  append(values: readonly PromptRecord[]): void {
    this.fold({ prompts: values, through: values.reduce((max, value) => Math.max(max, value.seq), -1) });
  }

  /** Remember a locally submitted command that never becomes a durable record.
   * @param value - Submitted command text; consecutive repeats coalesce.
   */
  record(value: string): void {
    const entry = { seq: this.newestSeq, text: promptText(value), durable: false };
    if (!this.retainable(entry) || this.entries.at(-1)?.text === entry.text) return;
    this.entries.push(entry); this.bytes += entry.text.length * 2;
    this.trim();
  }

  /** Add refilled or paged prompts in front; an active cursor shifts so its entry stays selected.
   * @param values - Older durable prompts in session order, oldest first.
   * @returns How many entries were actually retained.
   */
  prepend(values: readonly PromptRecord[]): number {
    const older = values.map(value => ({ seq: value.seq, text: promptText(value.text), durable: true }))
      .filter(value => this.retainable(value));
    if (!older.length) return 0;
    this.entries = [...older, ...this.entries];
    this.bytes += older.reduce((sum, value) => sum + value.text.length * 2, 0);
    if (this.position !== undefined) this.position += older.length;
    return older.length;
  }

  /** Recall older/newer input, restoring the original unsent draft at the end.
   * @param direction - Negative for older input, positive for newer input.
   * @param current - Current composer content before beginning recall.
   * @returns Recalled input, or the original draft when returning to the newest position.
   */
  move(direction: -1 | 1, current: string): string {
    if (!this.entries.length) return current;
    if (this.position === undefined) {
      if (direction > 0) return current;
      this.position = this.entries.length; this.draft = current;
    }
    this.position = Math.max(0, Math.min(this.entries.length, this.position + direction));
    if (this.position === this.entries.length) {
      const draft = this.draft; this.resetCursor(); return draft;
    }
    return this.entries[this.position]!.text;
  }

  /** Leave recall navigation when the composer is edited or otherwise replaced. */
  resetCursor(): void { this.position = undefined; this.draft = ''; }

  /** Trim a bulk backfill down to the budgets.
   *
   * `prepend` deliberately never evicts, because a lazy backward step must not drop what it just
   * recovered. A full-history backfill is different: the excess it added is the oldest prefix, which
   * stays reloadable through the same lazy path, so it can be settled to the budgets once. */
  settle(): void { this.trim(); }

  /** Whether one entry fits the per-entry budget the composer can recall. */
  private retainable(value: PromptEntry): boolean {
    return value.text !== '' && value.text.length <= MAX_ENTRY_CHARS;
  }

  /** Retain one durable prompt; a durable echo upgrades a local entry instead of duplicating it. */
  private push(value: PromptRecord): void {
    const entry: PromptEntry = { seq: value.seq, text: promptText(value.text), durable: true };
    if (!this.retainable(entry)) return;
    const last = this.entries.at(-1);
    if (last && last.text === entry.text) { last.seq = entry.seq; last.durable = true; return; }
    this.entries.push(entry); this.bytes += entry.text.length * 2;
    this.trim();
  }

  /** Drop the oldest entries until both budgets hold; a dropped prefix stays reloadable. */
  private trim(): void {
    while (this.entries.length > this.limits.maxEntries || this.bytes > this.limits.maxBytes) {
      this.bytes -= this.entries.shift()!.text.length * 2;
      this.shed = true;
    }
  }
}

/** Bytes of prompt text the process keeps across sessions before evicting the least recently used. */
export const DEFAULT_PROMPT_CACHE_BYTES = 4 * 1024 * 1024;

/** Process-lifetime cache of one session's folded prompts, so re-opening a session and re-reading
 *  its history are not the same cost.
 *
 * Two producers write it: the cost scan, which already reads every page of every session, and the
 * open-time backfill. Only a complete entry lets an open skip the walk; a partial one is written as
 * incomplete and ignored when read, because the part it is missing is the oldest prefix — the part
 * that would still have to be fetched. Bytes are bounded across sessions by least-recently-used
 * eviction, keeping at least the newest session so one huge history is still cached.
 */
export class PromptCache {
  private entries = new Map<string, { prompts: PromptRecord[]; complete: boolean; bytes: number }>();
  private bytes = 0;
  constructor(private readonly maxBytes = DEFAULT_PROMPT_CACHE_BYTES) {}

  /** Store one session's prompts, replacing whatever it held.
   * @param sessionId - Host session identity.
   * @param value - Prompts in session order, and whether the host held no older ones.
   */
  put(sessionId: string, value: { prompts: readonly PromptRecord[]; complete: boolean }): void {
    const prompts = value.prompts.filter(prompt => prompt.text !== '')
      .map(prompt => ({ seq: prompt.seq, text: prompt.text }));
    this.drop(sessionId);
    const entry = { prompts, complete: value.complete,
      bytes: prompts.reduce((sum, prompt) => sum + prompt.text.length * 2, 0) };
    this.entries.set(sessionId, entry); this.bytes += entry.bytes;
    this.evict();
  }

  /** Fold one scanned page in front of a session's entry.
   *
   * Pages arrive newest first, so each call's prompts are older than everything already cached; the
   * entry stays incomplete until the scan reports it reached the beginning.
   * @param sessionId - Host session identity.
   * @param prompts - One page's prompts, oldest first within the page.
   * @param complete - Whether this call is the scan's final one for that session.
   */
  observe(sessionId: string, prompts: readonly PromptRecord[], complete: boolean): void {
    const current = this.entries.get(sessionId)?.prompts ?? [];
    this.put(sessionId, { prompts: [...prompts, ...current], complete });
  }

  /** Read one session's prompts, marking the entry most recently used.
   * @param sessionId - Host session identity.
   * @returns The cached prompts, or undefined when nothing is cached.
   */
  get(sessionId: string): { prompts: PromptRecord[]; complete: boolean } | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    this.entries.delete(sessionId); this.entries.set(sessionId, entry);
    return { prompts: entry.prompts, complete: entry.complete };
  }

  /** Forget one session, for example after the host rewrote its history. */
  drop(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.bytes -= entry.bytes; this.entries.delete(sessionId);
  }

  /** Evict least-recently-used sessions until the byte budget holds. */
  private evict(): void {
    for (const [sessionId, entry] of this.entries) {
      if (this.bytes <= this.maxBytes || this.entries.size === 1) return;
      this.bytes -= entry.bytes; this.entries.delete(sessionId);
    }
  }
}
