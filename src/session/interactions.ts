/** Retained host requests and one response owner per interaction instance. */
import type { HostEvent } from '../transport/events.ts';
import type { Json } from '../json.ts';
import type { AnswerValue, PendingInteraction } from './types.ts';

export interface InteractionHost {
  focused(): PendingInteraction | undefined;
  admit(sessionId: string, dispatch: () => Promise<void>): Promise<void>;
  reply(eventId: string, outcome: Json): Promise<void>;
  changed(): void;
}

export class SessionInteractions {
  private readonly entries = new Map<string, PendingInteraction>();
  private readonly responding = new Map<PendingInteraction, Promise<void>>();
  constructor(private readonly host: InteractionHost) {}

  clear(): void { this.entries.clear(); }
  async settle(): Promise<void> { await Promise.allSettled(this.responding.values()); }

  pendingFor(sessionId: string | undefined): PendingInteraction[] {
    return [...this.entries.values()].filter(frame => frame.sessionId === sessionId);
  }

  counts(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const frame of this.entries.values()) {
      if (frame.sessionId !== '') counts.set(frame.sessionId, (counts.get(frame.sessionId) ?? 0) + 1);
    }
    return counts;
  }

  accept(event: HostEvent): boolean {
    if (event.kind === 'approval-request') {
      this.entries.set(event.eventId, { kind: 'approval', eventId: event.eventId, sessionId: event.sessionId, description: event.description });
    } else if (event.kind === 'question-request') {
      this.entries.set(event.eventId, { kind: 'question', eventId: event.eventId, sessionId: event.sessionId, questions: event.questions });
    } else return false;
    this.host.changed();
    return true;
  }

  cancelled(eventId: string): void { this.entries.delete(eventId); this.host.changed(); }

  async answer(value: AnswerValue): Promise<void> {
    const pending = this.host.focused();
    if (pending?.kind !== 'question') throw new Error('No pending question');
    await this.respond(pending, { kind: 'result', value });
  }

  async approve(allowed: boolean): Promise<void> {
    const pending = this.host.focused();
    if (pending?.kind !== 'approval') throw new Error('No pending approval');
    await this.respond(pending, { kind: 'result', value: allowed ? 'allowed-once' : 'rejected' });
  }

  async dismissQuestion(): Promise<void> {
    const pending = this.host.focused();
    if (pending?.kind !== 'question') throw new Error('No pending question');
    await this.respond(pending, { kind: 'rejected', error: {
      name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED',
    } });
  }

  private respond(pending: PendingInteraction, outcome: Json): Promise<void> {
    const existing = this.responding.get(pending);
    if (existing) return existing;
    // Reserve synchronously; the next Enter joins this response instead of issuing a conflicting one.
    const response = Promise.resolve().then(() => this.host.admit(pending.sessionId, () => {
      // Admission may have waited. Cancellation or a replayed request invalidates the captured object.
      if (this.entries.get(pending.eventId) !== pending) throw new Error('Interaction is no longer pending');
      return this.host.reply(pending.eventId, outcome);
    })).then(() => {
      if (this.entries.get(pending.eventId) === pending) {
        this.entries.delete(pending.eventId);
        this.host.changed();
      }
    });
    this.responding.set(pending, response);
    const release = () => { this.responding.delete(pending); };
    void response.then(release, release);
    return response;
  }
}
