/** Session-owned draft, temporary editors and async submission ownership. */
import { useLayoutEffect, useRef, useState } from 'react';
import { errorText } from '../../text.ts';

/** A local editor borrows Enter until it is saved or dismissed. */
export interface ComposerIntent {
  hint: string;
  emptyNotice: string;
  successNotice?: string;
  commit(text: string): Promise<boolean>;
}

/** Identity of a submitted draft, even if a later edit has identical text. */
export interface DraftReceipt {
  readonly sessionId: string | undefined;
  readonly revision: number;
}

interface ComposerOptions {
  sessionId: string | undefined;
  /** Read at completion too, before React necessarily renders a session change. */
  currentSession(): string | undefined;
  resetRecall(): void;
  messageStarted(): void;
  notify(message: string): void;
}

/** Owns editor state only; command interpretation and keyboard routing stay in App. */
export function useComposer(options: ComposerOptions) {
  const [input, setInputValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [intent, publishIntent] = useState<ComposerIntent>();
  const current = useRef({ sessionId: options.sessionId, revision: 0, input: '', parked: '', intent: undefined as ComposerIntent | undefined });
  const mounted = useRef(false);
  const saving = useRef(new WeakSet<ComposerIntent>());

  function replace(value: string) {
    current.current.input = value;
    current.current.revision += 1;
    setInputValue(value);
    setCursor(value.length);
  }

  function setIntent(value: ComposerIntent | undefined) {
    current.current.intent = value;
    publishIntent(value);
  }

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useLayoutEffect(() => {
    if (current.current.sessionId === options.sessionId) return;
    current.current.sessionId = options.sessionId;
    current.current.parked = '';
    setIntent(undefined);
    replace('');
  }, [options.sessionId]);

  function setInput(value: string, recalled = false) {
    if (!recalled) options.resetRecall();
    if (current.current.input === '' && value !== '' && !value.startsWith('/')) options.messageStarted();
    replace(value);
  }

  function capture(): DraftReceipt {
    return { sessionId: current.current.sessionId, revision: current.current.revision };
  }

  function owns(receipt: DraftReceipt) {
    return mounted.current && receipt.sessionId === options.currentSession()
      && receipt.sessionId === current.current.sessionId && receipt.revision === current.current.revision;
  }

  function consume(receipt: DraftReceipt) {
    if (owns(receipt)) setInput('');
  }

  /** A slow recall must neither replace newer typing nor move its recall cursor. */
  function recallIfCurrent(receipt: DraftReceipt, read: () => string) {
    if (owns(receipt)) setInput(read(), true);
  }

  /** Returns true whenever an editor handled Enter, including an already pending save. */
  async function commit(raw: string): Promise<boolean> {
    const editor = current.current.intent;
    if (!editor) return false;
    if (saving.current.has(editor)) return true;
    const text = raw.trim();
    if (!text) { options.notify(editor.emptyNotice); return true; }
    const receipt = capture();
    const active = () => mounted.current && current.current.intent === editor
      && receipt.sessionId === options.currentSession() && receipt.sessionId === current.current.sessionId;
    saving.current.add(editor);
    try {
      if (await editor.commit(text) && active()) {
        if (editor.successNotice) options.notify(editor.successNotice);
        // Continued typing remains in edit mode for the next explicit save.
        if (owns(receipt)) { setIntent(undefined); consume(receipt); }
      }
    } catch (error) {
      if (active()) options.notify(errorText(error));
    } finally { saving.current.delete(editor); }
    return true;
  }

  /** Parking/restoring is not a recall or a new message, so it does not move the reader. */
  function interactionChanged(answerPending: boolean, pending: boolean) {
    if (answerPending) {
      setIntent(undefined);
      if (current.current.input !== '') {
        current.current.parked = current.current.input;
        replace('');
      }
    } else if (!pending && current.current.parked !== '') {
      const parked = current.current.parked;
      current.current.parked = '';
      replace(parked);
    }
  }

  return { input, cursor, intent, setInput, setCursor, setIntent, capture, consume, recallIfCurrent, commit, interactionChanged };
}
