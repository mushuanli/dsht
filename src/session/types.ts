/** Session-domain result types shared by the controller facade and the terminal UI. */

/** Resolved navigation-removal identity; empty marks a fresh blank, idle session eligible for immediate archival. */
export interface RemovalTarget { kind: 'workspace' | 'session'; id: string; name: string; path?: string; empty?: boolean }

/** Bounded search results contain navigation summaries, never complete message bodies. */
export interface HistorySearch {
  items: { seq: number; role: string; preview: string }[];
  truncated: boolean;
}
