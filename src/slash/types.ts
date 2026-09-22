/** Command values shared by syntax, discovery and admission; no parser dependency. */
/** One parsed command; every side effect stays with the caller. */
export type Command =
  | { kind: 'ignore' }
  | { kind: 'copy' }
  | { kind: 'quit' }
  | { kind: 'panel'; panel: 'cost' | 'status' | 'help' }
  | { kind: 'remove'; target: 'workspace' | 'session'; query: string }
  | { kind: 'navigate'; target: 'workspace' | 'session'; query?: string }
  | { kind: 'latest' }
  | { kind: 'models'; args: string[] }
  | { kind: 'queue' }
  | { kind: 'newSession' }
  /** Open the saved-prompt picker, or save the following text as a shortcut prompt. */
  | { kind: 'prompts' }
  | { kind: 'savePrompt'; text: string }
  | { kind: 'history'; query: string }
  | { kind: 'sessionSearch'; command: '/ssearch' | '/wsearch'; query: string }
  | { kind: 'historySearch'; query: string }
  | { kind: 'think'; target: string }
  | { kind: 'older' }
  | { kind: 'compact' }
  /** Clear the client's own HANDOFF.md, then ask the agent to write a fresh session handoff. */
  | { kind: 'handoff' }
  /** Start the client-driven scored loop for one `loop.yaml` record. */
  | { kind: 'loop'; name: string; options: LoopOptions }
  /** Offer the `loop.yaml` records so one can be chosen instead of typed. */
  | { kind: 'loops' }
  /** Stop the running loop, running or paused. */
  | { kind: 'loopStop' }
  /** Answer a paused run, so the current artifact is judged again with the operator's addition. */
  | { kind: 'loopAnswer'; text: string }
  | { kind: 'cancel' }
  | { kind: 'approval'; allowed: boolean }
  | { kind: 'hostCommand'; line: string }
  /** A local `!` command, run on this machine rather than the host. */
  | { kind: 'shell'; command: string }
  | { kind: 'export'; destination?: string }
  | { kind: 'exportHtml'; destination?: string }
  | { kind: 'coredump'; tag?: string }
  | { kind: 'error'; message: string }
  | { kind: 'prompt'; text: string };

/** Options carried by `/loop`.
 *
 * Only the fields the operator actually typed are present, so the syntax layer validates each value
 * it sees and the application owns the defaults — command line first, then the record's `defaults`,
 * then the global ones.
 */
export interface LoopOptions {
  /** First step to run; default 1. */
  from?: number;
  /** Last step to run; default the record's last step. */
  to?: number;
  /** Passing score per step, 0-10 and possibly fractional; default the record's, else 8. */
  score?: number;
  /** Attempts allowed per step; default the record's, else 10. */
  tries?: number;
  /** Values that replace the record's own `vars` for this run, such as the document under review.
   *
   * The interactive form fills this in; the command line has no syntax for it, because the record —
   * not the syntax layer — is what knows which names exist.
   */
  vars?: Readonly<Record<string, string>>;
}
