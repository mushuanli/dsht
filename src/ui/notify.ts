/**
 * Desktop notifications for the two moments the operator has to come back: something is waiting for
 * an answer, and the work they started has finished.
 *
 * Nothing here touches the terminal: this module decides *what* to send and *when*, and the hook in
 * `use-attention-notify.ts` writes it once. Two methods exist because terminals disagree, and the same
 * split the lifecycle code uses applies — the sequences are mechanism, the env override and the
 * "only while unfocused" rule are policy:
 *
 * * `bel` — a plain `BEL` (`\a`). tmux records a bell on the window, which is why a background window
 *   turns white under the default `window-status-bell-style reverse`.
 * * `osc9` — `OSC 9` (`\x1b]9;<text>\a`), the desktop-notification escape iTerm2, Ghostty, kitty,
 *   WezTerm and Warp understand. Inside tmux it must be wrapped in a DCS passthrough
 *   (`\x1bPtmux;\x1b\x1b]9;…\x07\x1b\\`) or tmux swallows it — and that only reaches the outer
 *   terminal when the window option `allow-passthrough` is on.
 *
 * `auto` follows the same rule the Codex CLI uses: OSC 9 where the terminal is known to support it,
 * BEL everywhere else (a multiplexer does not change which outer terminal is present).
 *
 * The default condition is "only while the pane is unfocused", which needs focus reporting to mean
 * anything. tmux forwards focus events only with `set -g focus-events on`, so an absent answer is
 * treated as *not known to be focused*: the client stays quiet once the terminal says it is focused,
 * and otherwise notifies — a condition nobody can satisfy silently would be no notification at all.
 */

/** How a notification is delivered. */
export type NotifyMethod = 'off' | 'bel' | 'osc9';

/** When a notification is worth sending. */
export type NotifyWhen = 'unfocused' | 'always';

/** The two moments worth interrupting for. */
export type AttentionKind = 'needs-input' | 'finished';

/** Resolved notification policy for one process. */
export interface NotifyOptions {
  readonly method: NotifyMethod;
  readonly when: NotifyWhen;
}

/** Something that accepts terminal control sequences. */
export interface NotificationSink { write(chunk: string): unknown }

/** The facts that decide whether a notification is due, as the composition root reads them. */
export interface AttentionFacts {
  /** Identity of the interaction waiting for the operator, when one is. */
  readonly pending?: string;
  /** Whether the selected conversation has a turn or a loop in flight. */
  readonly busy: boolean;
}

/** Terminals known to render `OSC 9` as a desktop notification, by `TERM_PROGRAM` or `TERM`.
 *
 * Windows Terminal is deliberately absent: it sets `WT_SESSION` and does not take OSC 9 the same way,
 * so it gets the bell.
 */
const OSC9_PROGRAMS = new Set(['WezTerm', 'WarpTerminal', 'ghostty']);
const OSC9_TERMS = new Set(['xterm-kitty', 'wezterm', 'wezterm-mux']);

/** Whether this terminal can be expected to show an `OSC 9` notification. */
export function supportsOsc9(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WT_SESSION !== undefined) return false;
  if (env.ITERM_SESSION_ID !== undefined) return true;
  if (env.TERM_PROGRAM !== undefined && OSC9_PROGRAMS.has(env.TERM_PROGRAM)) return true;
  return env.TERM !== undefined && OSC9_TERMS.has(env.TERM);
}

/** Read the configured policy, resolving `auto` against the terminal this client is talking to.
 *
 * An unreadable or unknown setting falls back to the default rather than failing: a notification is
 * never worth stopping the client for.
 * @param env - Environment the settings come from.
 * @returns The method and the condition to apply.
 */
export function resolveNotify(env: NodeJS.ProcessEnv = process.env): NotifyOptions {
  const requested = env.DSHT_NOTIFY;
  const method: NotifyMethod = requested === 'off' || requested === 'bel' || requested === 'osc9' ? requested
    : requested === undefined || requested === 'auto' || requested === '' ? (supportsOsc9(env) ? 'osc9' : 'bel')
    : 'bel';
  const when: NotifyWhen = env.DSHT_NOTIFY_WHEN === 'always' ? 'always' : 'unfocused';
  return { method, when };
}

/** The text one notification carries; kept short because a terminal may show it as a title. */
export function notificationMessage(kind: AttentionKind): string {
  return kind === 'needs-input' ? 'dsht needs an answer' : 'dsht finished';
}

/** The bytes that deliver one notification, or undefined when notifications are off.
 *
 * `OSC 9` inside tmux is wrapped in a DCS passthrough. The payload is the message with every ESC
 * doubled, which is what makes the wrapper unambiguous: without it, an ESC inside the text would end
 * the passthrough early.
 * @param method - Resolved method.
 * @param message - Text to show.
 * @param tmux - Whether this process runs inside tmux.
 * @returns The control sequence to write.
 */
export function notificationBytes(method: NotifyMethod, message: string, tmux: boolean): string | undefined {
  if (method === 'off') return undefined;
  if (method === 'bel') return '\u0007';
  return tmux ? `\u001bPtmux;\u001b\u001b]9;${message.replace(/\u001b/g, '\u001b\u001b')}\u0007\u001b\\` : `\u001b]9;${message}\u0007`;
}

/** Which notification, if any, a change of facts calls for.
 *
 * Only transitions count: a pending interaction that stays pending must not ring again on every
 * render, and the first observation is silent because the operator is looking at the client they just
 * started. Finishing is only a transition out of *busy*, so an idle client that stays idle says
 * nothing.
 * @param previous - Facts as of the last observation, or undefined on the first one.
 * @param next - Facts now.
 * @returns The moment to announce, or undefined when nothing changed that matters.
 */
export function attentionTransition(previous: AttentionFacts | undefined, next: AttentionFacts): AttentionKind | undefined {
  if (previous === undefined) return undefined;
  if (next.pending !== undefined && next.pending !== previous.pending) return 'needs-input';
  if (previous.busy && !next.busy) return 'finished';
  return undefined;
}

/** Whether the condition allows sending right now.
 * @param options - Resolved policy.
 * @param focused - True when the terminal reported focus, false when it reported losing it, undefined
 *   while it has not answered at all (which counts as "not known to be focused").
 * @returns Whether a notification may be written now.
 */
export function attentionAllowed(options: NotifyOptions, focused: boolean | undefined): boolean {
  return options.method !== 'off' && (options.when === 'always' || focused !== true);
}
