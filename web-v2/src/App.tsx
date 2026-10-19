import React, { useEffect, useRef, useState } from "react";

/* ---------- types ---------- */
type Event = {
  ts: number; run_id: string; kind: string; role?: string; text?: string;
  tool?: string; input?: any; result?: any; error?: string; duration_ms?: number; state?: string;
  id?: string; action?: string; summary?: string; payload?: Record<string, any>;
  service?: string; fields?: { key: string; label: string; secret: boolean }[];
};
type App_ = { id: number; ts: number; company: string; role?: string; portal?: string; url?: string; status: string; notes?: string };


const ICONS: Record<string, string> = {
  chat: "M4 5h16v10H8l-4 4V5z",
  browser: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3.5 3 14 0 18M12 3c-3 3.5-3 14 0 18",
  jobs: "M4 8h16v11H4zM9 8V5h6v3M4 13h16",
  drive: "M8 4l8 12H4L8 4zM12 8l4 8h4",
  inbox: "M4 5h16v14H4zM4 7l8 6 8-6",
  vault: "M6 11V7a6 6 0 0112 0v4M5 11h14v9H5zM12 15v2",
  send: "M4 12l16-7-5 16-4-6-7-3z",
  tool: "M14 7a4 4 0 105.4 5.4L21 14l-3 3-2-2-3 3-2-2 3-3-2-2 3-3 1.4 1.4A4 4 0 0014 7z",
};
function Icon({ name, size = 16, className = "" }: { name: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={ICONS[name] || ICONS.chat} />
    </svg>
  );
}

const TABS = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "browser", label: "Browser", icon: "browser" },
  { id: "jobs", label: "Jobs & Tracker", icon: "jobs" },
  { id: "drive", label: "Drive & Docs", icon: "drive" },
  { id: "inbox", label: "Inbox & Outreach", icon: "inbox" },
  { id: "vault", label: "Vault & Scheduler", icon: "vault" },
] as const;

export default function App() {
  const [tab, setTab] = useState<string>("chat");
  const [events, setEvents] = useState<Event[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    fetch("/api/history").then(r => r.json()).then(d => {
      setEvents(d.messages.map((m: any) => ({ ...m.body, ts: m.ts, run_id: m.run_id })));
    });
    let ws: WebSocket, retry: any;
    const connect = () => {
      ws = new WebSocket(`ws://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => { setConnected(false); retry = setTimeout(connect, 1500); };
      ws.onmessage = (ev) => setEvents(prev => [...prev.slice(-400), JSON.parse(ev.data)]);
    };
    connect();
    return () => { clearTimeout(retry); ws?.close(); };
  }, []);

  return (
    <div className="flex h-screen bg-[#0a0e14] text-slate-100">
      <aside className="w-56 shrink-0 border-r border-slate-800 bg-[#0d1117] flex flex-col">
        <div className="px-4 py-4 border-b border-slate-800">
          <div className="font-bold text-lg">Personal Agent</div>
          <div className="text-xs text-slate-400">v2.0 · local-first</div>
        </div>
        <nav className="flex-1 py-2">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`w-full text-left px-4 py-2.5 text-sm flex gap-3 items-center hover:bg-slate-800/50 ${tab === t.id ? "bg-slate-800 text-white border-r-2 border-sky-400" : "text-slate-300"}`}>
              <Icon name={t.icon} className="shrink-0" />{t.label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-slate-800 text-xs text-slate-400 flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-400" : "bg-red-400"}`} />
          {connected ? "daemon live" : "reconnecting…"}
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        {tab === "chat" && <ChatTab events={events} />}
        {tab === "jobs" && <JobsTab />}
        {tab === "vault" && <VaultTab />}
        {tab !== "chat" && tab !== "jobs" && tab !== "vault" && <PlaceholderTab name={TABS.find(t => t.id === tab)!.label} />}
      </main>
    </div>
  );
}

/* ================= CHAT ================= */
function ChatTab({ events }: { events: Event[] }) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [events.length]);

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {events.length === 0 && (
          <div className="text-slate-500 text-sm mt-16 text-center">
            <div className="text-3xl mb-3">🤖</div>
            Try: <Cmd>search 2028 batch AI internships</Cmd> · <Cmd>connect model</Cmd> · <Cmd>send mail to x@y.com</Cmd> · <Cmd>track Google - STEP intern</Cmd>
          </div>
        )}
        {events.map((e, i) => <EventView key={i} e={e} />)}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-slate-800 p-4">
        <div className="flex gap-2 max-w-4xl mx-auto">
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()}
            placeholder="Tell your agent what to do…"
            className="flex-1 bg-[#161b22] border border-slate-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-sky-500" />
          <button onClick={send} className="bg-sky-600 hover:bg-sky-500 rounded-xl px-5 text-sm font-semibold">Send</button>
        </div>
      </div>
    </div>
  );
}
const Cmd = ({ children }: { children: string }) => (
  <code className="bg-slate-800 px-1.5 py-0.5 rounded text-sky-300 text-xs">{children}</code>
);

function EventView({ e }: { e: Event }) {
  if (e.kind === "text") {
    const mine = e.role === "user";
    return (
      <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
        <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${mine ? "bg-sky-700 rounded-br-sm" : "bg-[#161b22] border border-slate-800 rounded-bl-sm"}`}>
          {e.text}
        </div>
      </div>
    );
  }
  if (e.kind === "tool_call") {
    return <div className="text-xs text-slate-500 pl-2">⚙️ running <b className="text-slate-300">{e.tool}</b>…</div>;
  }
  if (e.kind === "tool_result") {
    return <ToolCard e={e} />;
  }
  if (e.kind === "approval") {
    return <ApprovalCard e={e} />;
  }
  if (e.kind === "setup_form") {
    return <SetupCard e={e} />;
  }
  if (e.kind === "error") {
    return <div className="max-w-[75%] rounded-xl px-4 py-2 text-sm bg-red-950 border border-red-800 text-red-200">⚠ {e.text}</div>;
  }
  return null;
}

function ToolCard({ e }: { e: Event }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="max-w-[75%]">
      <button onClick={() => setOpen(!open)} className="w-full text-left bg-[#10151d] border border-slate-800 rounded-xl px-4 py-2 text-xs hover:border-slate-600">
        <span className={e.state === "error" ? "text-red-400" : "text-emerald-400"}>{e.state === "error" ? "✗" : "✓"}</span>
        {" "}<b className="text-slate-300">{e.tool}</b>
        <span className="text-slate-500"> · {e.duration_ms} ms {open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <pre className="mt-1 bg-[#0d1117] border border-slate-800 rounded-xl p-3 text-[11px] overflow-x-auto max-h-64 overflow-y-auto text-slate-400">
          {JSON.stringify({ input: e.input, result: e.result, error: e.error }, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ApprovalCard({ e }: { e: Event }) {
  const [payload, setPayload] = useState(JSON.stringify(e.payload, null, 2));
  const [editing, setEditing] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const decide = async (decision: "approved" | "rejected") => {
    let body: any = { decision };
    if (decision === "approved" && editing) {
      try { body.payload = JSON.parse(payload); } catch { alert("Payload is not valid JSON"); return; }
    }
    const r = await fetch(`/api/approvals/${e.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    setDone(d.ok ? decision : "already resolved");
  };
  return (
    <div className="max-w-[75%] rounded-xl border border-amber-700/60 bg-amber-950/30 p-4">
      <div className="text-xs uppercase tracking-wide text-amber-400 mb-1">Approval required · {e.action}</div>
      <div className="text-sm mb-2">{e.summary}</div>
      {done ? <div className="text-xs text-slate-400 italic">{done}</div> : (<>
        {editing
          ? <textarea value={payload} onChange={ev => setPayload(ev.target.value)} rows={6}
              className="w-full bg-[#0d1117] border border-slate-700 rounded-lg p-2 text-xs font-mono mb-2" />
          : <pre className="bg-[#0d1117] border border-slate-800 rounded-lg p-2 text-xs overflow-x-auto mb-2">{payload}</pre>}
        <div className="flex gap-2">
          <button onClick={() => decide("approved")} className="bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 text-xs font-semibold">Approve &amp; Run</button>
          <button onClick={() => setEditing(!editing)} className="bg-slate-700 hover:bg-slate-600 rounded-lg px-3 py-1.5 text-xs">{editing ? "Preview" : "Edit Payload"}</button>
          <button onClick={() => decide("rejected")} className="bg-red-800 hover:bg-red-700 rounded-lg px-3 py-1.5 text-xs">Reject</button>
        </div>
      </>)}
    </div>
  );
}

function SetupCard({ e }: { e: Event }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const submit = async () => {
    setStatus("validating…");
    const r = await fetch("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: e.service, values }) });
    const d = await r.json();
    setStatus(d.ok ? "saved ✓" : "saved (validation failed - check the chat)");
  };
  return (
    <div className="max-w-[75%] rounded-xl border border-sky-800 bg-sky-950/30 p-4">
      <div className="text-xs uppercase tracking-wide text-sky-400 mb-2">Connect {e.service}</div>
      {(e.fields || []).map(f => (
        <label key={f.key} className="block mb-2 text-xs text-slate-400">
          {f.label}
          <input type={f.secret ? "password" : "text"} value={values[f.key] || ""}
            onChange={ev => setValues(v => ({ ...v, [f.key]: ev.target.value }))}
            className="mt-1 w-full bg-[#0d1117] border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-sky-500" />
        </label>
      ))}
      <div className="flex items-center gap-3">
        <button onClick={submit} className="bg-sky-600 hover:bg-sky-500 rounded-lg px-4 py-1.5 text-xs font-semibold">Save &amp; validate</button>
        {status && <span className="text-xs text-slate-400">{status}</span>}
      </div>
      <div className="text-[11px] text-slate-500 mt-2">Secrets are AES-256-GCM encrypted locally (data/, mode 600). Nothing leaves this machine.</div>
    </div>
  );
}

/* ================= JOBS ================= */
function JobsTab() {
  const [apps, setApps] = useState<App_[]>([]);
  const [company, setCompany] = useState(""); const [role, setRole] = useState("");
  const load = () => fetch("/api/tracker").then(r => r.json()).then(d => setApps(d.applications));
  useEffect(() => { load(); }, []);
  const add = async () => {
    if (!company.trim()) return;
    await fetch("/api/tracker", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company, role }) });
    setCompany(""); setRole(""); load();
  };
  const setStatus = async (id: number, status: string) => {
    await fetch(`/api/tracker/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
    load();
  };
  const statuses = ["Applied", "Cold Mailed", "Replied", "Rejected", "Scam Flagged"];
  return (
    <div className="p-6 overflow-y-auto h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Application tracker</h2>
        <a href="/api/tracker.csv" className="text-xs bg-slate-800 hover:bg-slate-700 rounded-lg px-3 py-1.5">Export CSV</a>
      </div>
      <div className="flex gap-2 mb-4">
        <input value={company} onChange={e => setCompany(e.target.value)} placeholder="Company"
          className="bg-[#161b22] border border-slate-700 rounded-lg px-3 py-2 text-sm" />
        <input value={role} onChange={e => setRole(e.target.value)} placeholder="Role"
          className="bg-[#161b22] border border-slate-700 rounded-lg px-3 py-2 text-sm" />
        <button onClick={add} className="bg-sky-600 hover:bg-sky-500 rounded-lg px-4 text-sm">Add</button>
      </div>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-slate-400 text-xs border-b border-slate-800">
          <th className="py-2">Date</th><th>Company</th><th>Role</th><th>Portal</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          {apps.map(a => (
            <tr key={a.id} className="border-b border-slate-800/50">
              <td className="py-2 text-slate-400 text-xs">{new Date(a.ts).toLocaleDateString()}</td>
              <td className="font-medium">{a.company}</td>
              <td className="text-slate-300">{a.role}</td>
              <td className="text-slate-400 text-xs">{a.portal}</td>
              <td>
                <select value={a.status} onChange={ev => setStatus(a.id, ev.target.value)}
                  className="bg-[#161b22] border border-slate-700 rounded-lg px-2 py-1 text-xs">
                  {statuses.map(s => <option key={s}>{s}</option>)}
                </select>
              </td>
              <td>{a.url && <a href={a.url} target="_blank" className="text-sky-400 text-xs">link ↗</a>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {apps.length === 0 && <div className="text-slate-500 text-sm mt-8 text-center">Nothing tracked yet. Applications you run through the agent land here automatically.</div>}
    </div>
  );
}

/* ================= VAULT ================= */
function VaultTab() {
  const [entries, setEntries] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>({});
  useEffect(() => {
    fetch("/api/vault").then(r => r.json()).then(d => setEntries(d.entries));
    fetch("/api/settings").then(r => r.json()).then(setSettings);
  }, []);
  return (
    <div className="p-6 overflow-y-auto h-full space-y-6">
      <section>
        <h2 className="text-lg font-semibold mb-2">Credential vault</h2>
        <div className="text-xs text-slate-500 mb-3">AES-256-GCM encrypted · stored in local SQLite · never logged</div>
        {entries.length === 0
          ? <div className="text-slate-500 text-sm">Empty. Say <Cmd>connect email</Cmd> or <Cmd>connect unstop</Cmd> in chat.</div>
          : <ul className="space-y-1">{entries.map((v, i) => (
              <li key={i} className="bg-[#161b22] border border-slate-800 rounded-lg px-3 py-2 text-sm flex justify-between">
                <span>{v.service}</span><span className="text-slate-400">{v.username}</span>
              </li>))}</ul>}
      </section>
      <section>
        <h2 className="text-lg font-semibold mb-2">Model router</h2>
        <div className="text-sm text-slate-300 bg-[#161b22] border border-slate-800 rounded-lg p-3">
          Active model: <b>{settings.model}</b>{settings.model_key_set ? " (key saved)" : " - no key, offline mock provider"}
          <div className="text-xs text-slate-500 mt-1">Switch models by saying <Cmd>connect model</Cmd> in chat.</div>
        </div>
      </section>
    </div>
  );
}

function PlaceholderTab({ name }: { name: string }) {
  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold mb-2">{name}</h2>
      <div className="text-slate-500 text-sm">This module is being wired up in the v2.0 build.</div>
    </div>
  );
}
