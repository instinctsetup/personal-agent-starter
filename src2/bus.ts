/** Typed event bus: everything the agent does streams to WS clients + chat log. */
import { db } from "./db.js";

export type AgentEvent = {
  ts: number;
  run_id: string;
  kind: "text" | "tool_call" | "tool_result" | "approval" | "status" | "error" | "token" | "setup_form";
  [k: string]: unknown;
};

type Listener = (e: AgentEvent) => void;
const listeners = new Set<Listener>();

export function onEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(e: AgentEvent, persist = true) {
  for (const fn of listeners) fn(e);
  if (persist && e.kind !== "token") {
    db.prepare("INSERT INTO messages (ts, role, kind, body, run_id) VALUES (?, ?, ?, ?, ?)")
      .run(e.ts, e.kind === "approval" ? "agent" : (e.role as string) || "agent", e.kind, JSON.stringify(e), e.run_id);
  }
}

export function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
