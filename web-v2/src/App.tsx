import React, { useEffect, useRef, useState } from "react";

/* ---------- types ---------- */
type Event = {
  ts: number; run_id: string; kind: string; role?: string; text?: string;
  tool?: string; input?: any; result?: any; error?: string; duration_ms?: number; state?: string;
  id?: string; action?: string; summary?: string; payload?: Record<string, any>;
  label?: string; elapsed_s?: number; service?: string; fields?: { key: string; label: string; secret: boolean }[];
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
  traces: "M4 19V10m5 9V5m5 14v-7m5 7v-4M2 21h20",
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
  { id: "traces", label: "Traces", icon: "traces" },
] as const;

type SysSettings = { model?: string; model_provider?: string; model_key_set?: boolean; email_configured?: boolean; email_user?: string; linkedin_on?: boolean };

export default function App() {
  const [tab, setTab] = useState<string>("chat");
  const [events, setEvents] = useState<Event[]>([]);
  const [connected, setConnected] = useState(false);
  const [sys, setSys] = useState<SysSettings>({});
  const [auth, setAuth] = useState<{ enabled: boolean; authed: boolean } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    fetch("/api/auth/status").then(r => r.json()).then(setAuth).catch(() => setAuth({ enabled: false, authed: true }));
  }, []);

  useEffect(() => {
    const load = () => fetch("/api/settings").then(r => r.json()).then(setSys).catch(() => {});
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const loadHistory = () => fetch("/api/history").then(r => r.json()).then(d => {
      setEvents(d.messages.map((m: any) => ({ ...m.body, ts: m.ts, run_id: m.run_id })));
    }).catch(() => {});
    loadHistory();
    let ws: WebSocket, retry: any;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); loadHistory(); };
      ws.onclose = () => { setConnected(false); retry = setTimeout(connect, 1500); };
      ws.onmessage = (ev) => setEvents(prev => [...prev.slice(-400), JSON.parse(ev.data)]);
    };
    connect();
    return () => { clearTimeout(retry); ws?.close(); };
  }, []);

  if (auth === null) return <div className="h-screen bg-[#0a0e14]" />;
  if (auth.enabled && !auth.authed) return <LoginScreen onLogin={() => setAuth({ enabled: true, authed: true })} />;

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
        <div className="px-4 py-3 border-t border-slate-800 text-xs text-slate-400 space-y-1.5">
          <div className="flex items-center gap-2" title="Active model">
            <span className={`w-2 h-2 rounded-full shrink-0 ${sys.model_key_set ? "bg-emerald-400" : "bg-slate-600"}`} />
            <span className="truncate">{sys.model || "…"}{sys.model_key_set ? "" : " (no key)"}</span>
          </div>
          <div className="flex items-center gap-2" title="Email account">
            <span className={`w-2 h-2 rounded-full shrink-0 ${sys.email_configured ? "bg-emerald-400" : "bg-slate-600"}`} />
            <span className="truncate">{sys.email_configured ? sys.email_user || "email connected" : "email not connected"}</span>
          </div>
          <div className="flex items-center gap-2" title="LinkedIn assist">
            <span className={`w-2 h-2 rounded-full shrink-0 ${sys.linkedin_on ? "bg-emerald-400" : "bg-slate-600"}`} />
            <span className="truncate">linkedin {sys.linkedin_on ? "on" : "off"}</span>
          </div>
          <div className="flex items-center gap-2 pt-1 border-t border-slate-800/60">
            <span className={`w-2 h-2 rounded-full shrink-0 ${connected ? "bg-emerald-400" : "bg-red-400"}`} />
            {connected ? "daemon live" : "reconnecting…"}
          </div>
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        {tab === "chat" && <ChatTab events={events} />}
        {tab === "jobs" && <JobsTab />}
        {tab === "vault" && <VaultTab />}
        {tab === "browser" && <BrowserTab />}
        {tab === "inbox" && <InboxTab />}
        {tab === "drive" && <DriveTab />}
        {tab === "traces" && <TracesTab />}
        {!["chat", "jobs", "vault", "browser", "inbox", "drive", "traces"].includes(tab) && <PlaceholderTab name={TABS.find(t => t.id === tab)!.label} />}
      </main>
    </div>
  );
}

/* ================= CHAT ================= */
function ChatTab({ events }: { events: Event[] }) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  // the newest status event decides whether a "waiting" indicator is still live
  const lastStatus = [...events].reverse().find(e => e.kind === "status");
  const waiting = lastStatus && lastStatus.state === "waiting" ? (lastStatus as Event & { label?: string }) : null;
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
            Try: <Cmd>search 2028 batch AI internships</Cmd> · <Cmd>connect gemini</Cmd> · <Cmd>send mail to x@y.com</Cmd> · <Cmd>track Google - STEP intern</Cmd>
          </div>
        )}
        {events.filter(e => e.kind !== "status").map((e, i) => <EventView key={i} e={e} />)}
        {waiting && <div className="text-xs text-amber-300 pl-2 animate-pulse">⏳ {waiting.text || `${waiting.label || "Working"}...`} (stops automatically if it takes too long)</div>}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-slate-800 p-4">
        <div className="flex gap-1.5 max-w-4xl mx-auto mb-2 flex-wrap">
          {[["Check my inbox", "check my email"], ["Hunt internships", "hunt SDE internships summer 2027"], ["Applications", "applications"], ["Draft an email", "send mail to "], ["help", "help"]].map(([label, cmd]) => (
            <button key={label} onClick={() => cmd.endsWith(" ") ? setInput(cmd) : (setInput(""), fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: cmd }) }))}
              className="text-[11px] bg-[#161b22] border border-slate-700 hover:border-sky-500 hover:text-sky-300 rounded-full px-3 py-1 text-slate-400">{label}</button>
          ))}
        </div>
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
    return e.action === "send_email" ? <EmailApprovalCard e={e} /> : <ApprovalCard e={e} />;
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

function EmailApprovalCard({ e }: { e: Event }) {
  const p = (e.payload || {}) as { to?: string; from?: string; subject?: string; body?: string };
  const [f, setF] = useState({ to: p.to || "", from: p.from || "", subject: p.subject || "", body: p.body || "" });
  const [editing, setEditing] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const decide = async (decision: "approved" | "rejected") => {
    const r = await fetch(`/api/approvals/${e.id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(decision === "approved" ? { decision, payload: f } : { decision }),
    });
    const d = await r.json();
    setDone(d.ok ? (decision === "approved" ? "sent ✓" : "cancelled - nothing sent") : "already resolved");
  };
  const set = (k: keyof typeof f) => (ev: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: ev.target.value });
  const row = (label: string, k: keyof typeof f) => (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-xs text-slate-500">{label}</span>
      {editing
        ? <input value={f[k]} onChange={set(k)} className="flex-1 bg-[#0d1117] border border-slate-700 rounded-lg px-2 py-1 text-sm outline-none focus:border-emerald-500" />
        : <span className="text-slate-200 text-sm">{f[k] || <span className="text-slate-500">(none)</span>}</span>}
    </div>
  );
  return (
    <div className="max-w-[75%] rounded-xl border border-emerald-700/60 bg-emerald-950/20 p-4">
      <div className="text-xs uppercase tracking-wide text-emerald-400 mb-2">Email draft · nothing sends until you press Send</div>
      {done ? <div className="text-xs text-slate-400 italic">{done}</div> : (<>
        <div className="space-y-1.5 mb-2">
          {row("To", "to")}
          {row("From", "from")}
          {row("Subject", "subject")}
          {editing
            ? <textarea value={f.body} onChange={set("body")} rows={8}
                className="w-full bg-[#0d1117] border border-slate-700 rounded-lg p-2 text-sm outline-none focus:border-emerald-500" />
            : <div className="bg-[#0d1117] border border-slate-800 rounded-lg p-3 text-sm whitespace-pre-wrap">{f.body}</div>}
        </div>
        <div className="flex gap-2">
          <button onClick={() => decide("approved")} className="bg-emerald-600 hover:bg-emerald-500 rounded-lg px-4 py-1.5 text-xs font-semibold">Send</button>
          <button onClick={() => setEditing(!editing)} className="bg-slate-700 hover:bg-slate-600 rounded-lg px-3 py-1.5 text-xs">{editing ? "Preview" : "Edit"}</button>
          <button onClick={() => decide("rejected")} className="bg-red-800 hover:bg-red-700 rounded-lg px-3 py-1.5 text-xs">Cancel</button>
        </div>
      </>)}
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
          : <div className="bg-[#0d1117] border border-slate-800 rounded-lg p-2 text-xs mb-2 max-h-48 overflow-y-auto">
              {Object.entries(e.payload || {}).map(([k, v]) => (
                <div key={k} className="flex gap-2 py-0.5">
                  <span className="w-20 shrink-0 text-slate-500">{k}</span>
                  <span className="text-slate-200 whitespace-pre-wrap break-all">{String(v)}</span>
                </div>
              ))}
            </div>}
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
  const statuses = ["Scouted", "Applied", "Cold Mailed", "Replied", "Rejected", "Scam Flagged"];
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
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${a.status === "Applied" ? "bg-emerald-400" : a.status === "Replied" ? "bg-sky-400" : a.status === "Rejected" ? "bg-red-400" : a.status === "Scouted" ? "bg-violet-400" : a.status === "Cold Mailed" ? "bg-amber-400" : "bg-slate-500"}`} />
                  <select value={a.status} onChange={ev => setStatus(a.id, ev.target.value)}
                    className="bg-[#161b22] border border-slate-700 rounded-lg px-2 py-1 text-xs">
                    {statuses.map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
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
function SchedulerSection() {
  const [jobs, setJobs] = useState<any[]>([]);
  const load = () => fetch("/api/jobs").then(r => r.json()).then(d => setJobs(d.jobs));
  useEffect(() => { load(); const id = setInterval(load, 10000); return () => clearInterval(id); }, []);
  const fmt = (ts: number) => ts >= 9e15 ? "-" : new Date(ts).toLocaleString();
  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">Scheduler</h2>
      <div className="text-xs text-slate-500 mb-3">Recurring + one-shot jobs. Say <code className="bg-slate-800 px-1.5 py-0.5 rounded text-sky-300 text-xs">every 2 hours search AI internships</code> or <code className="bg-slate-800 px-1.5 py-0.5 rounded text-sky-300 text-xs">at 18:30 tracker</code> in chat.</div>
      {jobs.filter(j => j.next_ts < 9e15).length === 0 && <div className="text-slate-500 text-sm">No jobs yet.</div>}
      <div className="space-y-2">
        {jobs.filter(j => j.next_ts < 9e15).map(j => (
          <div key={j.id} className="flex items-center gap-3 bg-[#161b22] border border-slate-800 rounded-lg px-3 py-2 text-sm">
            <div className="flex-1">
              <div>{j.spec.command}</div>
              <div className="text-xs text-slate-500">{j.spec.interval_min ? `every ${j.spec.interval_min} min` : "once"} - next {fmt(j.next_ts)}{j.last_run ? ` - last ran ${fmt(j.last_run)}` : ""}</div>
            </div>
            <button onClick={async () => { await fetch(`/api/jobs/${j.id}/toggle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !j.enabled }) }); load(); }}
              className={`text-xs px-2 py-1 rounded ${j.enabled ? "bg-emerald-700" : "bg-slate-600"}`}>{j.enabled ? "on" : "paused"}</button>
            <button onClick={async () => { await fetch(`/api/jobs/${j.id}`, { method: "DELETE" }); load(); }}
              className="text-xs px-2 py-1 rounded bg-red-900/60 hover:bg-red-800">delete</button>
          </div>
        ))}
      </div>
    </section>
  );
}

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
          Active model: <b>{settings.model}</b> <span className="text-slate-400">({settings.model_provider === "gemini" ? "Google Gemini" : "OpenAI-compatible"})</span>{settings.model_key_set ? " (key saved)" : " - no key, offline mock provider"}
          <div className="text-xs text-slate-500 mt-1">Switch models by saying <Cmd>connect gemini</Cmd> (free Google key) or <Cmd>connect model</Cmd> (OpenAI-compatible) in chat.</div>
        </div>
      </section>
      <SchedulerSection />
    </div>
  );
}


function BrowserTab() {
  const [url, setUrl] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [started, setStarted] = useState(false); // flips the placeholder to the <img> once, then pixels update via ref (no re-render, focus stays put)
  const [live, setLive] = useState(true);
  const [control, setControl] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const typeRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // live view, two modes:
  //  - screencast: CDP pushes JPEG frames over a dedicated websocket into a <canvas>
  //    (10-15 fps, self-pacing acks; no React re-render per frame, focus/text survive)
  //  - fallback: if no frame arrives within 3s, poll screenshots into the <img> via ref
  //    (double-buffered, still no re-render)
  const castWsRef = useRef<WebSocket | null>(null);
  const framesRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [useFallback, setUseFallback] = useState(false);
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);

  useEffect(() => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.binaryType = "blob";
    castWsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "screencast", on: true }));
      // initial paint: screencast only emits on page change, so grab one snapshot for a page that is already open
      fetch("/api/browser/screenshot").then(r => r.ok ? r.blob() : null).then(b => { if (b && b.size > 100) void draw(b); }).catch(() => {});
    };
    const draw = async (blob: Blob) => {
      try {
        const bmp = await createImageBitmap(blob);
        const ctx = canvasRef.current?.getContext("2d");
        if (ctx) { ctx.drawImage(bmp, 0, 0); setStarted(true); }
        bmp.close();
      } catch { /* a bad frame is skipped, the next one is coming */ }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") return; // JSON events belong to the main socket
      framesRef.current++;
      void draw(ev.data as Blob);
    };
    const giveUpTimer = setTimeout(() => { if (framesRef.current === 0) setUseFallback(true); }, 3000);
    const onVis = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "screencast", on: !document.hidden }));
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearTimeout(giveUpTimer);
      document.removeEventListener("visibilitychange", onVis);
      try { ws.send(JSON.stringify({ type: "screencast", on: false })); } catch { /* closing */ }
      ws.close();
      castWsRef.current = null;
    };
  }, []);

  const castSend = (msg: Record<string, unknown>) => {
    const ws = castWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && !useFallback) ws.send(JSON.stringify(msg));
    else if (msg.type === "click") fetch("/api/browser/click", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x: msg.x, y: msg.y }) });
    else if (msg.type === "type") fetch("/api/browser/type", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: msg.text }) });
    else if (msg.type === "key") fetch("/api/browser/key", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: msg.key }) });
  };

  // fallback path (no screencast): preload the next frame, swap only once it has fully loaded
  const refreshShot = () => {
    const next = new Image();
    next.onload = () => { if (imgRef.current) imgRef.current.src = next.src; };
    next.src = `/api/browser/screenshot?t=${Date.now()}`;
  };

  useEffect(() => {
    if (!live) return;
    const id = setInterval(async () => {
      if (useFallback) refreshShot();
      const st = await fetch("/api/browser/state").then(r => r.json()).catch(() => null);
      if (st) {
        setCurrent(st.url);
        setChallenge(st.challenge);
        setControl(st.user_control);
        if (st.url) setStarted(true);
      }
    }, 1200);
    return () => clearInterval(id);
  }, [live, useFallback]);

  const nav = async () => {
    if (!url.trim()) return;
    setBusy(true);
    await fetch("/api/browser/navigate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: url.trim() }) });
    setBusy(false); setStarted(true); setTimeout(refreshShot, 300);
  };

  const clickView = (e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * (1280 / rect.width));
    const y = Math.round((e.clientY - rect.top) * (800 / rect.height));
    const id = Date.now() + Math.random();
    setRipples(rs => [...rs, { id, x: e.clientX - rect.left, y: e.clientY - rect.top }]);
    setTimeout(() => setRipples(rs => rs.filter(r => r.id !== id)), 500);
    castSend({ type: "click", x, y });
    if (useFallback) setTimeout(refreshShot, 400);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-slate-800 flex gap-2 items-center">
        <input value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => e.key === "Enter" && nav()}
          placeholder="https://…" className="flex-1 bg-[#161b22] border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-sky-500" />
        <button onClick={nav} disabled={busy} className="bg-sky-600 hover:bg-sky-500 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">Go</button>
        <button onClick={async () => { await fetch("/api/browser/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: !control }) }); setControl(!control); }}
          className={`rounded-lg px-4 py-2 text-sm font-semibold ${control ? "bg-amber-600 hover:bg-amber-500" : "bg-slate-700 hover:bg-slate-600"}`}>
          {control ? "You are driving" : "Take control"}
        </button>
        <button onClick={() => setLive(v => !v)} className="bg-slate-700 hover:bg-slate-600 rounded-lg px-3 py-2 text-sm">{live ? "Pause view" : "Resume view"}</button>
      </div>
      {challenge && (
        <div className="px-4 py-2 bg-amber-900/40 border-b border-amber-700 text-amber-200 text-sm">
          {challenge === "captcha" ? "CAPTCHA detected - click " : "2FA / verification detected - click "}
          <b>Take control</b> and solve it, then hand control back.
        </div>
      )}
      <div className="flex-1 overflow-auto bg-black/40 flex items-start justify-center p-3">
        <div className="relative max-w-full">
          {useFallback ? (
            <img ref={imgRef} src="/api/browser/screenshot" onClick={clickView}
              className="max-w-full rounded-lg border border-slate-700 cursor-crosshair select-none" alt="live browser" draggable={false} />
          ) : (
            <canvas ref={canvasRef} width={1280} height={800} onClick={clickView}
              className="max-w-full rounded-lg border border-slate-700 cursor-crosshair select-none" />
          )}
          {ripples.map(r => (
            <span key={r.id} className="absolute pointer-events-none rounded-full border-2 border-sky-400"
              style={{ left: r.x - 12, top: r.y - 12, width: 24, height: 24, animation: "pa-ripple 0.5s ease-out forwards" }} />
          ))}
          {!started && !current && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm text-center bg-[#0a0e14] rounded-lg pointer-events-none">
              <div>Nothing open yet. Enter a URL above, or say <code className="bg-slate-800 px-1.5 py-0.5 rounded text-sky-300 text-xs">open google.com</code> in chat.</div>
            </div>
          )}
        </div>
      </div>
      <div className="p-2 border-t border-slate-800 flex gap-2 items-center text-xs text-slate-400">
        <span className="truncate flex-1">{current || "no page"}</span>
        <input ref={typeRef} placeholder="Type into page…" onKeyDown={async e => {
          if (e.key === "Enter" && typeRef.current?.value) {
            castSend({ type: "type", text: typeRef.current.value });
            typeRef.current.value = ""; if (useFallback) setTimeout(refreshShot, 300);
          }
        }} className="w-64 bg-[#161b22] border border-slate-700 rounded px-2 py-1 outline-none focus:border-sky-500" />
        <button onClick={async () => { await fetch("/api/browser/key", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "Enter" }) }); if (useFallback) setTimeout(refreshShot, 300); }}
          className="bg-slate-700 hover:bg-slate-600 rounded px-2 py-1">Enter</button>
      </div>
    </div>
  );
}


function InboxTab() {
  const [data, setData] = useState<any>(null);
  const [to, setTo] = useState("");
  const [body, setBody] = useState("Hi {{name}},\n\nI'm Mahesh, a sophomore in Mathematics & Computing at IIT Patna (2028 batch). I loved what {{company}} is building and I'd love to intern with your team. Recent work: github.com/instinctsetup\n\nBest,\nMahesh");
  const load = () => fetch("/api/mail/inbox").then(r => r.json()).then(setData);
  useEffect(() => { load(); }, []);
  return (
    <div className="p-6 overflow-y-auto h-full space-y-6">
      <section>
        <h2 className="text-lg font-semibold mb-2">Inbox</h2>
        {!data && <div className="text-slate-500 text-sm">Loading…</div>}
        {data && !data.configured && <div className="text-slate-500 text-sm">Email not connected. Say <code className="bg-slate-800 px-1.5 py-0.5 rounded text-sky-300 text-xs">connect email</code> in chat (Gmail + app password).</div>}
        {data?.error && <div className="text-amber-300 text-sm">{data.error}</div>}
        <div className="space-y-2">
          {(data?.messages || []).map((m: any) => (
            <div key={m.uid} className="bg-[#161b22] border border-slate-800 rounded-lg px-3 py-2 text-sm">
              <div className="flex justify-between gap-3"><b>{m.subject}</b><span className="text-xs text-slate-500 shrink-0">{m.date?.slice(0, 10)}</span></div>
              <div className="text-xs text-slate-400">{m.from}</div>
              <div className="text-xs text-slate-500 mt-1">{m.snippet}</div>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2 className="text-lg font-semibold mb-2">Cold-mail composer</h2>
        <div className="text-xs text-slate-500 mb-2">Uses {"{{name}}"} / {"{{company}}"} placeholders. Sends through the chat's approval card - nothing leaves without your Approve.</div>
        <input value={to} onChange={e => setTo(e.target.value)} placeholder="recruiter@company.com"
          className="w-full bg-[#161b22] border border-slate-700 rounded-lg px-3 py-2 text-sm mb-2 outline-none focus:border-sky-500" />
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={7}
          className="w-full bg-[#161b22] border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-sky-500" />
        <button onClick={() => fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `send mail to ${to}: ${body}` }) })}
          className="mt-2 bg-sky-600 hover:bg-sky-500 rounded-lg px-4 py-2 text-sm font-semibold">Draft + review in Chat</button>
      </section>
    </div>
  );
}


function DriveTab() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { fetch("/api/drive").then(r => r.json()).then(setData); }, []);
  return (
    <div className="p-6 overflow-y-auto h-full space-y-4">
      <h2 className="text-lg font-semibold">Drive & Docs</h2>
      {!data && <div className="text-slate-500 text-sm">Loading…</div>}
      {data && !data.configured && (
        <div className="text-slate-500 text-sm max-w-xl">
          Drive not connected. Say <code className="bg-slate-800 px-1.5 py-0.5 rounded text-sky-300 text-xs">connect drive</code> in chat
          with an OAuth client ID/secret + refresh token (one-time Google Cloud setup). Then:
          <code className="bg-slate-800 px-1.5 py-0.5 rounded text-sky-300 text-xs ml-1">upload ./report.pdf to drive</code>
          <code className="bg-slate-800 px-1.5 py-0.5 rounded text-sky-300 text-xs ml-1">sync ./docs to drive</code>
        </div>
      )}
      {data?.error && <div className="text-amber-300 text-sm">{data.error}</div>}
      <div className="space-y-2">
        {(data?.files || []).map((f: any) => (
          <div key={f.id} className="bg-[#161b22] border border-slate-800 rounded-lg px-3 py-2 text-sm flex justify-between gap-3">
            <span>{f.name}</span>
            {f.webViewLink && <a href={f.webViewLink} target="_blank" className="text-sky-400 text-xs hover:underline shrink-0">open</a>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================= TRACES ================= */
type RunSummary = { run_id: string; first_ts: number; last_ts: number; duration_ms: number; spans: number; errors: number; tools: string[] };
type Span = { id: string; run_id: string; parent_id: string | null; name: string; start_ts: number; end_ts: number | null; status: string; attrs: Record<string, any>; depth: number };

const fmtDur = (ms: number) => ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;

function attrLine(s: Span): string {
  if (s.status === "error" && s.attrs.error) return String(s.attrs.error);
  if (s.attrs.winner) return `winner: ${s.attrs.winner}`;
  if (s.attrs.cmd) return String(s.attrs.cmd);
  if (s.attrs.input && typeof s.attrs.input === "object") {
    const e = Object.entries(s.attrs.input)[0];
    if (e) return `${e[0]}: ${String(e[1]).slice(0, 60)}`;
  }
  return "";
}

function TracesTab() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [spans, setSpans] = useState<Span[]>([]);
  const [updated, setUpdated] = useState("");

  useEffect(() => {
    let dead = false;
    const tick = async () => {
      try {
        const d = await fetch("/api/traces", { cache: "no-store" }).then(r => r.json());
        if (dead) return;
        const list: RunSummary[] = d.runs || [];
        setRuns(list);
        setSel(s => (s && list.some(r => r.run_id === s)) ? s : list[0]?.run_id ?? null);
        setUpdated(new Date().toLocaleTimeString());
      } catch { /* daemon briefly unreachable */ }
      if (!dead) setTimeout(tick, 4000);
    };
    tick();
    return () => { dead = true; };
  }, []);

  useEffect(() => {
    if (!sel) { setSpans([]); return; }
    let dead = false;
    const tick = async () => {
      let wait = 4000;
      try {
        const d = await fetch(`/api/traces/${encodeURIComponent(sel)}`, { cache: "no-store" }).then(r => r.json());
        if (dead) return;
        const list: Span[] = d.spans || [];
        setSpans(list);
        if (list.some(s => s.status === "running")) wait = 1500; // live run: refresh faster
      } catch { /* keep last view */ }
      if (!dead) setTimeout(tick, wait);
    };
    tick();
    return () => { dead = true; };
  }, [sel]);

  const now = Date.now();
  const t0 = spans.length ? Math.min(...spans.map(s => s.start_ts)) : 0;
  const t1 = spans.length ? Math.max(...spans.map(s => s.end_ts || now), t0 + 1) : 1;
  const range = t1 - t0;

  return (
    <div className="flex h-full">
      <aside className="w-72 shrink-0 border-r border-slate-800 flex flex-col">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent runs</h2>
          <span className="text-[10px] text-slate-500">updated {updated || "…"}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {runs.length === 0 && (
            <div className="p-6 text-center text-slate-500 text-xs">
              No runs traced yet.<br />Chat with the agent - every tool call, model race and plan step is recorded here.
            </div>
          )}
          {runs.map(r => (
            <button key={r.run_id} onClick={() => setSel(r.run_id)}
              className={`w-full text-left px-4 py-3 border-b border-slate-800/60 hover:bg-slate-800/40 ${sel === r.run_id ? "bg-slate-800/60 border-l-2 border-l-sky-400" : ""}`}>
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.errors > 0 ? "bg-red-400" : "bg-emerald-400"}`} />
                <span className="text-xs text-slate-400">{new Date(r.first_ts).toLocaleTimeString()}</span>
                <span className="ml-auto text-xs text-slate-500">{fmtDur(r.duration_ms)}</span>
              </div>
              <div className="mt-1 text-[13px] truncate">{r.tools.slice(0, 3).join(" · ") || "run"}{r.tools.length > 3 ? ` +${r.tools.length - 3}` : ""}</div>
              <div className="mt-0.5 text-[10px] text-slate-500">
                {r.spans} span{r.spans === 1 ? "" : "s"}{r.errors > 0 ? <span className="text-red-400"> · {r.errors} error{r.errors === 1 ? "" : "s"}</span> : ""}
              </div>
            </button>
          ))}
        </div>
      </aside>
      <main className="flex-1 min-w-0 overflow-y-auto p-6">
        {!sel && <div className="text-slate-500 text-sm">Select a run on the left.</div>}
        {sel && spans.length > 0 && (
          <>
            <div className="flex items-baseline gap-3 mb-4">
              <h2 className="text-lg font-semibold">Run timeline</h2>
              <span className="text-xs text-slate-500 font-mono">{sel}</span>
              <span className="text-xs text-slate-500 ml-auto">total {fmtDur(range)}</span>
            </div>
            <div className="space-y-1">
              {spans.map(s => {
                const left = ((s.start_ts - t0) / range) * 100;
                const width = Math.max(((s.end_ts || now) - s.start_ts) / range * 100, 0.6);
                const line = attrLine(s);
                return (
                  <div key={s.id} className="flex items-center gap-3">
                    <div className="w-64 shrink-0 truncate text-xs" style={{ paddingLeft: s.depth * 16 }} title={s.name}>
                      <span className={s.depth > 0 ? "text-slate-400" : "text-slate-200 font-medium"}>{s.depth > 0 ? "↳ " : ""}{s.name}</span>
                    </div>
                    <div className="flex-1 relative h-5 bg-slate-800/40 rounded overflow-hidden">
                      <div className={`absolute top-0.5 bottom-0.5 rounded ${s.status === "error" ? "bg-red-500/80" : s.status === "running" ? "bg-amber-400/80 animate-pulse" : "bg-sky-500/70"}`}
                        style={{ left: `${left}%`, width: `${width}%` }} />
                    </div>
                    <div className="w-20 shrink-0 text-right text-[11px] text-slate-500">{fmtDur((s.end_ts || now) - s.start_ts)}</div>
                    <div className={`w-56 shrink-0 truncate text-[11px] ${s.status === "error" ? "text-red-400" : "text-slate-500"}`} title={line}>{line}</div>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 text-[11px] text-slate-600">Tip: say <span className="font-mono text-slate-400">traces</span> in chat for the text version, or <span className="font-mono text-slate-400">trace {sel.slice(0, 12)}…</span> for this run's tree.</div>
          </>
        )}
        {sel && spans.length === 0 && <div className="text-slate-500 text-sm">No spans recorded for this run.</div>}
      </main>
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

/* ripple animation for browser clicks */
if (typeof document !== "undefined" && !document.getElementById("pa-ripple-style")) {
  const st = document.createElement("style");
  st.id = "pa-ripple-style";
  st.textContent = "@keyframes pa-ripple { from { transform: scale(0.4); opacity: 1; } to { transform: scale(2.2); opacity: 0; } }";
  document.head.appendChild(st);
}

/* ================= LOGIN ================= */
function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
      if (r.ok) onLogin();
      else setErr("wrong password");
    } catch { setErr("could not reach the server"); }
    setBusy(false);
  };
  return (
    <div className="h-screen bg-[#0a0e14] text-slate-100 flex items-center justify-center">
      <div className="w-80 rounded-xl border border-slate-800 bg-[#0d1117] p-6 space-y-4">
        <div>
          <div className="font-bold text-lg">Personal Agent</div>
          <div className="text-xs text-slate-400">this control center is protected</div>
        </div>
        <input type="password" value={pw} autoFocus onChange={e => setPw(e.target.value)}
          onKeyDown={e => e.key === "Enter" && submit()} placeholder="password"
          className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm outline-none focus:border-sky-500" />
        {err && <div className="text-xs text-red-400">{err}</div>}
        <button onClick={submit} disabled={busy}
          className="w-full rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 px-3 py-2 text-sm font-medium">
          {busy ? "checking…" : "unlock"}
        </button>
      </div>
    </div>
  );
}
