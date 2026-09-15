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
import type { AnswerValue, HistorySearch } from './types.ts';
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

/** Client-generated prompts remembered for recall suppression; a bounded run needs far fewer. */
const MAX_INTERNAL_PROMPTS = 512;

/** Flatten one transcript prompt into the single line the composer recalls. */
export function promptText(value: string): string { return value.replace(/\r?\n/g, ' ').trim(); }

/** Model dialog step: the catalog plus the provider or model being inspected. */
export interface ModelState { catalog: ObjectValue; provider?: string; model?: ObjectValue }

/** Panels the reader opened; visibility and query text only, so the UI owns them.
 *
 * One container rather than one flag per call site, so the composition root has a single panel set
 * to gate keys, reset on a session switch and close from a command. Every session panel's rows come
 * from the selected record and its cursor is focus held by `Picker`; the one exception is `prompts`,
 * which lists a client-global file and is therefore not derived from the record.
 */
export interface PanelState {
  thoughts: boolean;
  queue: boolean;
  /** Saved shortcut prompts opened by `/prompt`; a client-global list, kept here for one registry. */
  prompts?: boolean;
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
  answers: Record<string, AnswerValue['answers']>;
  option?: OptionState;
  approval?: { eventId: string; index: number };
}

/** Client-owned state of the selected session, reset whenever another session is opened.
 *
 * It holds the record, the prompt index, the reading view and the local interaction
 * state because all five belong to one session and none of them is owned by the host beyond what the
 * record mirrors; everything derivable from `Telemetry` or `CostLedger` stays out (see the design's
 * §5.7.6). The record is referenced here and nowhere else, so "the selected session" has one entry.
 */
export class SessionInfo {
  /** The selected session's record. Replaced — never mutated in place — when another session opens. */
  record: Transcript = new Transcript();
  readonly prompts = new PromptIndex();
  /** Detached history window the reader jumped to; released by `closeWindow` and `reset`. */
  window?: Transcript;
  readonly interaction: InteractionState = { answers: {} };

  constructor(public sessionId = '') {}

  /** Forget everything a previous session owned, keeping this instance identity-stable for `State`. */
  reset(sessionId = ''): void {
    this.sessionId = sessionId;
    this.closeWindow();
    releaseHistoryLayout(this.record);
    this.record.dispose();
    this.record = new Transcript();
    this.prompts.reset();
    this.interaction.answers = {}; this.interaction.option = undefined; this.interaction.approval = undefined;
  }

  /** Release the detached history window, if the reader has one open. */
  closeWindow(): void {
    const window = this.window;
    if (!window) return;
    releaseHistoryLayout(window); window.dispose();
    this.window = undefined;
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
  /** Prompts the client sent on the operator's behalf; their durable echo never enters recall.
   *
   * Kept across `reset()` so re-opening the session in the same process stays clean, and bounded
   * because an agent loop can send a prompt per attempt.
   */
  private readonly internal = new Set<string>();

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

  /** Forget one session's prompts and cursor; client-generated suppression is process-wide. */
  reset(): void {
    this.entries = []; this.bytes = 0; this.newestSeq = -1; this.complete = false; this.shed = false;
    this.position = undefined; this.draft = '';
  }

  /** Remember one prompt the client sent itself, so its durable echo never enters recall.
   *
   * An agent loop submits many turns; without this they would crowd out what the operator typed.
   * @param value - Prompt text the client sent on the operator's behalf.
   */
  suppress(value: string): void {
    const text = promptText(value);
    if (!text) return;
    this.internal.delete(text); this.internal.add(text);
    while (this.internal.size > MAX_INTERNAL_PROMPTS) {
      const oldest = this.internal.values().next().value;
      if (oldest === undefined) break;
      this.internal.delete(oldest);
    }
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
    const text = promptText(value);
    if (this.internal.has(text)) return;
    const entry = { seq: this.newestSeq, text, durable: false };
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
      .filter(value => !this.internal.has(value.text) && this.retainable(value));
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
    // A prompt the client itself sent (an agent loop) is durable history, but not composer recall.
    if (this.internal.has(entry.text) || !this.retainable(entry)) return;
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
    const all = value.prompts.filter(prompt => prompt.text !== '')
      .map(prompt => ({ seq: prompt.seq, text: prompt.text }));
    let prompts = all, complete = value.complete;
    let bytes = all.reduce((sum, prompt) => sum + prompt.text.length * 2, 0);
    // One session can hold more prompt text than the whole budget. Keep its newest prompts that fit
    // and record the entry as incomplete, so a later open still fetches the older part instead of
    // trusting a list with a hole at the front.
    if (bytes > this.maxBytes) {
      let start = all.length, kept = 0;
      for (let index = all.length - 1; index >= 0; index--) {
        const size = all[index]!.text.length * 2;
        if (kept + size > this.maxBytes) break;
        kept += size; start = index;
      }
      prompts = all.slice(start); bytes = kept; complete = false;
    }
    this.drop(sessionId);
    const entry = { prompts, complete, bytes };
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
