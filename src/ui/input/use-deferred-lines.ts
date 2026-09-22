/** Commands explicitly accepted by the operator, waiting for their execution policy. */
import { useEffect, useRef, useState } from 'react';
import { authorize, type AuthorizeFacts, type DeferReason, type LineCommand } from '../../slash/index.ts';
import { errorText } from '../../text.ts';

interface QueuedLine { command: LineCommand; defer: DeferReason; sessionId: string | undefined }

interface DeferredFacts extends AuthorizeFacts {
  sessionId: string | undefined;
  /** Both the connection baseline and the selected conversation snapshot must be restored. */
  ready: boolean;
}

interface DeferredOptions {
  facts(): DeferredFacts;
  run(command: LineCommand): Promise<void>;
  notify(message: string): void;
}

/** Owns FIFO and in-flight state, independent of Controller and the composer's current draft. */
export function useDeferredLines(options: DeferredOptions) {
  const [lines, setLines] = useState<QueuedLine[]>([]);
  const draining = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Re-evaluate on UI publications, including connection/snapshot readiness and a completed run.
  // A synchronous reservation prevents a re-render or StrictMode replay from starting it twice.
  useEffect(() => {
    const next = lines[0];
    if (!next || draining.current) return;
    const facts = options.facts();
    if (next.sessionId !== facts.sessionId) {
      setLines(current => current.filter(line => line.sessionId === facts.sessionId));
      options.notify('Dropped a queued line: the selected session changed');
      return;
    }
    if (!facts.ready || facts.foreground || (next.defer !== 'busy' && facts.during !== 'idle')) return;
    const verdict = authorize(next.command, facts);
    if (verdict.allow && verdict.defer !== undefined) return;
    draining.current = true;
    setLines(current => current.slice(1));
    void (async () => {
      try { await options.run(verdict.allow ? verdict.command : verdict.error); }
      catch (error) { if (mounted.current) options.notify(errorText(error)); }
      finally {
        draining.current = false;
        if (mounted.current) setLines(current => [...current]);
      }
    })();
  });

  return {
    enqueue(command: LineCommand, defer: DeferReason) {
      const sessionId = options.facts().sessionId;
      setLines(current => [...current, { command, defer, sessionId }]);
    },
  };
}
