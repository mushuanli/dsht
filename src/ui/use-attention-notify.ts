/**
 * The one place a notification is written, and the only stateful part of the feature.
 *
 * It observes the facts the composition root already has and writes a control sequence when they
 * change in a way the operator has to know about. Everything it decides with — the transition rule,
 * the condition, the byte sequence — lives in `notify.ts`, so this file is left with the two things a
 * hook must own: remembering the previous facts, and writing once.
 */
import { useEffect, useRef } from 'react';
import { useStdout } from 'ink';
import {
  attentionAllowed, attentionTransition, notificationBytes, notificationMessage, resolveNotify,
  type AttentionFacts, type NotificationSink,
} from './notify.ts';

/** Announce an attention transition through the terminal, once per transition.
 *
 * @param facts - Waiting interaction and busy state, as the application publishes them.
 * @param focused - Focus as the terminal reported it: true, false, or undefined while it has not
 *   answered (`attentionAllowed` treats that as "not known to be focused").
 * @param env - Environment the policy is read from; overridable for tests.
 * @param sink - Where the sequence is written; defaults to this client's stdout.
 */
export function useAttentionNotify(facts: AttentionFacts, focused: boolean | undefined, env: NodeJS.ProcessEnv = process.env,
  sink?: NotificationSink): void {
  const { stdout } = useStdout();
  const target = sink ?? stdout;
  const previous = useRef<AttentionFacts | undefined>(undefined);
  const policy = useRef(resolveNotify(env));
  useEffect(() => {
    const kind = attentionTransition(previous.current, facts);
    previous.current = { pending: facts.pending, busy: facts.busy };
    if (kind === undefined || !attentionAllowed(policy.current, focused)) return;
    const bytes = notificationBytes(policy.current.method, notificationMessage(kind), env.TMUX !== undefined);
    if (bytes !== undefined) target.write(bytes);
  }, [facts.pending, facts.busy, focused, target, env]);
}
