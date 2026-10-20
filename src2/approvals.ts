/** Human-in-the-loop approval cards: queue, resolve (approve/reject/edit), expire. */
import { randomBytes } from "node:crypto";
import { db } from "./db.js";
import { emit, newRunId } from "./bus.js";

const EXPIRY_MS = 15 * 60 * 1000;

export type Approval = {
  id: string; action: string; summary: string; payload: Record<string, unknown>;
};

const waiters = new Map<string, { resolve: (a: { status: string; payload: any }) => void; timer: ReturnType<typeof setTimeout> }>();

export function requestApproval(action: string, summary: string, payload: Record<string, unknown>, runId = newRunId()): Approval {
  const id = randomBytes(6).toString("hex");
  db.prepare("INSERT INTO approvals (id, ts, action, summary, payload) VALUES (?, ?, ?, ?, ?)")
    .run(id, Date.now(), action, summary, JSON.stringify(payload));
  emit({ ts: Date.now(), run_id: runId, kind: "approval", id, action, summary, payload, buttons: ["approve", "edit", "reject"] });
  return { id, action, summary, payload };
}

/** Wait for the user to approve/reject/edit. Resolves {status, payload}. */
export function waitApproval(id: string, timeoutMs = EXPIRY_MS): Promise<{ status: string; payload: any }> {
  const row = db.prepare("SELECT status, payload FROM approvals WHERE id = ?").get(id) as any;
  if (row && row.status !== "pending") return Promise.resolve({ status: row.status, payload: JSON.parse(row.payload) });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (waiters.delete(id)) {
        db.prepare("UPDATE approvals SET status = 'expired', resolved_ts = ? WHERE id = ? AND status = 'pending'").run(Date.now(), id);
        resolve({ status: "expired", payload: null });
      }
    }, timeoutMs);
    waiters.set(id, { resolve, timer });
  });
}

export function resolveApproval(id: string, status: "approved" | "rejected", editedPayload?: Record<string, unknown>): boolean {
  const row = db.prepare("SELECT status, payload FROM approvals WHERE id = ?").get(id) as any;
  if (!row || row.status !== "pending") return false;
  const payload = editedPayload ?? JSON.parse(row.payload);
  db.prepare("UPDATE approvals SET status = ?, payload = ?, resolved_ts = ? WHERE id = ?")
    .run(status, JSON.stringify(payload), Date.now(), id);
  const waiter = waiters.get(id);
  if (waiter) { waiters.delete(id); clearTimeout(waiter.timer); waiter.resolve({ status, payload }); }
  return true;
}

export function getApproval(id: string) {
  return db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as any;
}
