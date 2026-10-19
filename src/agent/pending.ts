// In-memory pending actions (confirmations and open questions). Nothing
// side-effecting runs until its pending action is approved through the UI.
import { randomUUID } from 'node:crypto';

export interface PendingAction {
  id: string;
  kind: 'mail-send' | 'apply-submit' | 'linkedin-submit' | 'generic';
  summary: string;
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
}

export interface OpenQuestions {
  id: string;
  questions: string[];
  createdAt: number;
  status: 'open' | 'answered' | 'expired';
}

const TTL_MS = 15 * 60_000;

export class PendingManager {
  private actions = new Map<string, PendingAction & { resolve: (ok: boolean) => void }>();
  private questions = new Map<string, OpenQuestions & { resolve: (answers: Record<string, string> | null) => void }>();

  askConfirmation(kind: PendingAction['kind'], summary: string): { action: PendingAction; wait: Promise<boolean> } {
    const id = randomUUID().slice(0, 8);
    let resolve!: (ok: boolean) => void;
    const wait = new Promise<boolean>((r) => (resolve = r));
    const action: PendingAction = { id, kind, summary, createdAt: Date.now(), status: 'pending' };
    this.actions.set(id, { ...action, resolve });
    setTimeout(() => {
      const a = this.actions.get(id);
      if (a && a.status === 'pending') {
        a.status = 'expired';
        a.resolve(false);
      }
    }, TTL_MS).unref();
    return { action, wait };
  }

  decide(id: string, approved: boolean): PendingAction | undefined {
    const a = this.actions.get(id);
    if (!a || a.status !== 'pending') return a ? { ...a, resolve: undefined } as unknown as PendingAction : undefined;
    a.status = approved ? 'approved' : 'rejected';
    a.resolve(approved);
    return { ...a } as PendingAction;
  }

  listPending(): PendingAction[] {
    return [...this.actions.values()].filter((a) => a.status === 'pending').map(({ resolve: _r, ...a }) => a);
  }

  askQuestions(questions: string[]): { card: OpenQuestions; wait: Promise<Record<string, string> | null> } {
    const id = randomUUID().slice(0, 8);
    let resolve!: (a: Record<string, string> | null) => void;
    const wait = new Promise<Record<string, string> | null>((r) => (resolve = r));
    const card: OpenQuestions = { id, questions, createdAt: Date.now(), status: 'open' };
    this.questions.set(id, { ...card, resolve });
    setTimeout(() => {
      const q = this.questions.get(id);
      if (q && q.status === 'open') {
        q.status = 'expired';
        q.resolve(null);
      }
    }, TTL_MS).unref();
    return { card, wait };
  }

  /** Oldest open question card, if any. */
  currentQuestions(): (OpenQuestions & { resolve: (a: Record<string, string> | null) => void }) | undefined {
    for (const q of this.questions.values()) if (q.status === 'open') return q;
    return undefined;
  }

  answerQuestions(id: string, answers: Record<string, string>): boolean {
    const q = this.questions.get(id);
    if (!q || q.status !== 'open') return false;
    q.status = 'answered';
    q.resolve(answers);
    return true;
  }
}
