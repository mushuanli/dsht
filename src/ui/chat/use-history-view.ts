/** Reading position, folds and asynchronous navigation belong to this mounted conversation view. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import type { Reasoning, SessionRender, ShellBlock } from '../../contracts.ts';
import { errorText } from '../../text.ts';
import { mergeShellRuns } from './shell-view.ts';

interface HistorySource {
  readonly version: number;
  readonly memoryRevision: number;
  readonly beforeSeq: number | undefined;
  readonly ready: boolean;
  readonly hasMore: boolean;
  readonly liveAttemptKey: string | undefined;
}
interface HistoryViewOptions<S extends HistorySource> {
  sessionId?: string;
  source: S;
  display: S;
  detached: boolean;
  width: number;
  rows: number;
  showHint: boolean;
  protect: boolean;
  enabled: boolean;
  online: boolean;
  busy: boolean;
  revision: number;
  blocks: readonly ShellBlock[];
  current(source: S): boolean;
  render(input: { transcript: S; width: number; folds: ReadonlySet<number>; liveReasoning: Reasoning }): SessionRender;
  run<T>(work: (signal: AbortSignal) => Promise<T>, label: string): Promise<T | undefined>;
  older(signal: AbortSignal, source: S): Promise<boolean>;
  open(target: number, signal: AbortSignal): Promise<boolean>;
  pin(value: boolean): void;
  closePanels(): void;
  notify(message: string): void;
}

export function useHistoryView<S extends HistorySource>(options: HistoryViewOptions<S>) {
  const [scroll, setScroll] = useState(0);
  const [folds, setFolds] = useState<ReadonlySet<number>>(new Set());
  const [liveReasoning, setLive] = useState<Reasoning>('row');
  const [anchor, setAnchor] = useState<{ source: S; target: number }>();
  const latest = useRef(options); latest.current = options;
  const mounted = useRef(true);
  const intent = useRef(0);
  const jumpAbort = useRef<AbortController | undefined>(undefined);
  const pageAbort = useRef<AbortController | undefined>(undefined);
  const lifetime = useRef(new AbortController());
  const paging = useRef(false);
  const invalidate = () => { intent.current++; jumpAbort.current?.abort(); setAnchor(undefined); };
  useEffect(() => {
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
    mounted.current = true;
    return () => {
      mounted.current = false; intent.current++;
      lifetime.current.abort(); jumpAbort.current?.abort(); pageAbort.current?.abort();
      latest.current.pin(false);
    };
  }, []);
  useEffect(() => {
    invalidate(); pageAbort.current?.abort(); setScroll(0);
  }, [options.source]);
  useEffect(() => { setFolds(new Set()); setLive('row'); }, [options.sessionId]);
  useEffect(() => { setLive('row'); }, [options.source, options.source.liveAttemptKey]);
  useEffect(() => {
    const first = options.display.beforeSeq;
    if (first !== undefined) setFolds(previous => {
      const next = new Set([...previous].filter(seq => seq >= first));
      return next.size === previous.size ? previous : next;
    });
  }, [options.display, options.display.memoryRevision]);

  const { source, display, width } = options;
  const layout = useMemo(() => options.render({ transcript: display, width, folds, liveReasoning }),
    [display, display.version, width, folds, liveReasoning]);
  const merged = useMemo(() => mergeShellRuns(layout, options.blocks, width),
    [layout, options.blocks, options.revision, width]);
  const pageSize = Math.max(1, options.rows - (options.showHint ? 1 : 0));
  const totalRows = merged.total;
  const maxScroll = Math.max(0, totalRows - pageSize);
  const previousView = useRef({ source, display, count: totalRows, first: layout.first, folds, liveReasoning });
  const previous = previousView.current;
  const prepended = previous.first !== undefined && layout.first !== undefined && layout.first < previous.first;
  const adjusted = previous.source !== source ? 0
    : scroll > 0 && previous.display === display && !prepended && previous.folds === folds && previous.liveReasoning === liveReasoning
      ? Math.max(0, scroll + totalRows - previous.count) : scroll;
  const row = anchor?.source === source ? layout.offsets.get(anchor.target) : undefined;
  const position = Math.max(0, Math.min(row === undefined ? adjusted : totalRows - pageSize - merged.hostRow(row), maxScroll));
  useLayoutEffect(() => {
    previousView.current = { source, display, count: totalRows, first: layout.first, folds, liveReasoning };
    if (position !== scroll) setScroll(position);
    if (anchor) setAnchor(undefined);
  }, [source, display, totalRows, position, scroll, folds, liveReasoning, anchor]);
  useLayoutEffect(() => { options.pin(!options.detached && (position > 0 || options.protect)); },
    [options.detached, position, options.protect, source]);

  function scrollTo(value: SetStateAction<number>): void { invalidate(); setScroll(value); }
  function setReasoningOverrides(value: SetStateAction<ReadonlySet<number>>): void { invalidate(); setFolds(value); }
  function setLiveReasoning(value: SetStateAction<Reasoning>): void { invalidate(); setLive(value); }
  function historyOperation<T>(work: (signal: AbortSignal) => Promise<T>, label = 'Loading history…'): Promise<T | undefined> {
    return options.run(signal => work(AbortSignal.any([signal, lifetime.current.signal])), label);
  }
  function scrollHistory(delta: number): void {
    if (!options.enabled) return;
    invalidate();
    const own = intent.current;
    const next = Math.max(0, Math.min(maxScroll, position + delta));
    setScroll(next);
    if (delta <= 0 || next < maxScroll || paging.current || options.busy || !options.online || !display.ready || !display.hasMore) return;
    paging.current = true;
    const abort = new AbortController(); pageAbort.current = abort;
    void historyOperation(signal => options.older(AbortSignal.any([signal, abort.signal]), display)).then(accepted => {
      if (accepted && mounted.current && latest.current.display === display && options.current(source) && intent.current === own) {
        setScroll(position + delta);
      }
    }).catch(error => {
      if (mounted.current && !(error instanceof Error && error.name === 'AbortError')) latest.current.notify(errorText(error));
    }).finally(() => { paging.current = false; if (pageAbort.current === abort) pageAbort.current = undefined; });
  }
  async function jumpHistory(target: number): Promise<void> {
    if (!options.enabled) throw new Error('Select a session first');
    invalidate();
    const own = intent.current;
    const abort = new AbortController(); jumpAbort.current = abort;
    try {
      await historyOperation(async foreground => {
        const signal = AbortSignal.any([foreground, abort.signal]);
        if (!await options.open(target, signal)) return;
        signal.throwIfAborted();
        if (!mounted.current || intent.current !== own || !options.current(source)) return;
        setAnchor({ source, target }); latest.current.closePanels();
      }, 'Jumping to a message…');
    } finally { if (jumpAbort.current === abort) jumpAbort.current = undefined; }
  }
  return { layout, merged, totalRows, pageSize, position, reasoningOverrides: folds, liveReasoning,
    setScroll: scrollTo, setReasoningOverrides, setLiveReasoning, scrollHistory, jumpHistory, historyOperation };
}
