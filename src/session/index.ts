/** Session domain: the selected session, its transcript, layout, telemetry and navigation. */
export { SessionController } from './controller.ts';
export { contentText, toolLine, Transcript } from './transcript.ts';
export type { Message, MessagePart, ThoughtEntry } from './transcript.ts';
export { historyLayout, layoutStats, releaseHistoryLayout } from './history.ts';
export { markdownCacheStats } from './markdown.ts';
export type { HistoryRow, Reasoning, RowKind } from './history.ts';
export { Telemetry } from './telemetry.ts';
export type { QueuedInput } from './telemetry.ts';
export { DEFAULT_HISTORY_LIMITS, historyLimits } from './memory.ts';
export type { HistoryLimits } from './memory.ts';
export { navigationCommand, resolveTarget, sessionLabel } from './navigation.ts';
export { activeReference, fileMention, fileReferences } from './references.ts';
export type { FileReference } from './references.ts';
export { saveSessionLog } from './export.ts';
export type { HistorySearch, RemovalTarget } from './types.ts';
export type { ConnectionView } from './connection-view.ts';
