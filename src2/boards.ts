/** Boards: persistent, live, shareable dashboard pages generated from the app's own data.
 *  Data is resolved at request time (live by construction - no snapshots to go stale).
 *  Access: the owner's session, or anyone holding the per-board share token (?k=...). */
import { randomBytes } from "node:crypto";
import { db } from "./db.js";
import { listApplications } from "./tracker.js";
import { listSignups } from "./signup.js";
import { listJobs } from "./scheduler.js";
import { listInbox, mailConfigured } from "./mail.js";

db.exec(`CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,               -- pipeline | inbox | overview
  title TEXT NOT NULL,
  share_token TEXT NOT NULL,
  created_ts INTEGER NOT NULL
)`);

export type BoardKind = "pipeline" | "inbox" | "overview";
export type Board = { id: string; kind: BoardKind; title: string; share_token: string; created_ts: number };

const TITLES: Record<BoardKind, string> = {
  pipeline: "Job Application Pipeline",
  inbox: "Inbox Triage",
  overview: "Agent Overview",
};

export function boardKinds(): BoardKind[] { return ["pipeline", "inbox", "overview"]; }
export function isBoardKind(s: string): s is BoardKind { return (boardKinds() as string[]).includes(s); }

/** One stable board per kind: repeat "board pipeline" returns the same board (same link to bookmark). */
export function ensureBoard(kind: BoardKind): Board {
  const cur = db.prepare("SELECT * FROM boards WHERE kind = ?").get(kind) as Board | undefined;
  if (cur) return cur;
  const b: Board = {
    id: randomBytes(6).toString("hex"),
    kind,
    title: TITLES[kind],
    share_token: randomBytes(16).toString("hex"),
    created_ts: Date.now(),
  };
  db.prepare("INSERT INTO boards (id, kind, title, share_token, created_ts) VALUES (?, ?, ?, ?, ?)")
    .run(b.id, b.kind, b.title, b.share_token, b.created_ts);
  return b;
}

export function getBoard(id: string): Board | null {
  return (db.prepare("SELECT * FROM boards WHERE id = ?").get(id) as Board | undefined) ?? null;
}

export function listBoards(): Board[] {
  return db.prepare("SELECT * FROM boards ORDER BY created_ts").all() as Board[];
}

/** Kill every outstanding share link for a board. */
export function rotateShareToken(id: string): Board | null {
  const b = getBoard(id);
  if (!b) return null;
  const t = randomBytes(16).toString("hex");
  db.prepare("UPDATE boards SET share_token = ? WHERE id = ?").run(t, id);
  return { ...b, share_token: t };
}

// ---------------------------------------------------------------- data

const PIPELINE_COLUMNS = ["Scouted", "Applied", "Cold Mailed", "Replied", "Interviewing", "Offer", "Rejected", "Scam Flagged"];

export async function boardData(kind: BoardKind): Promise<unknown> {
  if (kind === "pipeline") {
    const apps = listApplications();
    const week = Date.now() - 7 * 86400_000;
    const responded = apps.filter((a) => ["Replied", "Interviewing", "Offer"].includes(a.status)).length;
    const cols = PIPELINE_COLUMNS.map((name) => ({
      name,
      cards: apps.filter((a) => a.status === name).map((a) => ({
        id: a.id, company: a.company, role: a.role, portal: a.portal, url: a.url,
        days: Math.max(0, Math.floor((Date.now() - a.ts) / 86400_000)),
      })),
    })).filter((c) => c.cards.length || ["Scouted", "Applied", "Replied", "Rejected"].includes(c.name));
    return {
      kind, stats: [
        { label: "Total", value: apps.length },
        { label: "This week", value: apps.filter((a) => a.ts > week).length },
        { label: "Responses", value: responded },
        { label: "Response rate", value: apps.length ? `${Math.round((responded / apps.length) * 100)}%` : "-" },
      ],
      columns: cols,
    };
  }
  if (kind === "inbox") {
    if (!mailConfigured()) return { kind, configured: false, messages: [] };
    try {
      const msgs = await listInbox(25);
      return {
        kind, configured: true,
        messages: msgs.map((m: any) => ({ from: m.from || "", subject: m.subject || "", date: m.date || "", snippet: (m.snippet || m.body || "").slice(0, 140) })),
      };
    } catch (e: any) {
      return { kind, configured: true, error: String(e?.message || e), messages: [] };
    }
  }
  // overview
  const apps = listApplications();
  const byStatus: Record<string, number> = {};
  for (const a of apps) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  const events = (db.prepare(
    "SELECT ts, kind, body FROM messages WHERE role = 'agent' AND kind IN ('tool_call','approval','error','status') ORDER BY id DESC LIMIT 60"
  ).all() as any[])
    .map((r) => { try { return { ts: r.ts, kind: r.kind, ...JSON.parse(r.body) }; } catch { return null; } })
    .filter(Boolean)
    .filter((e: any) => e.kind !== "status" || /plan|step/i.test(e.text || ""))
    .slice(0, 15)
    .map((e: any) => ({ ts: e.ts, kind: e.kind, text: e.summary || e.text || e.name || "" }));
  return {
    kind,
    stats: [
      { label: "Applications", value: apps.length },
      { label: "Signups", value: listSignups().length },
      { label: "Scheduled jobs", value: listJobs().filter((j) => j.enabled).length },
      ...Object.entries(byStatus).slice(0, 4).map(([k, v]) => ({ label: k, value: v })),
    ],
    events,
  };
}

// ---------------------------------------------------------------- page

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderBoardPage(board: Board, token: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(board.title)}</title><style>
:root{color-scheme:dark}
*{box-sizing:border-box;margin:0}
body{font:14px/1.5 -apple-system,'Segoe UI',Inter,Roboto,sans-serif;background:#0b0e14;color:#e6e9f0;padding:24px;max-width:1200px;margin:0 auto}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}
h1{font-size:20px;font-weight:650}
.live{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#7ee787;background:#7ee78714;border:1px solid #7ee78733;padding:3px 10px;border-radius:99px}
.live i{width:7px;height:7px;border-radius:50%;background:#7ee787;animation:p 2s infinite}
@keyframes p{50%{opacity:.35}}
#updated{font-size:12px;color:#8b93a7;margin-left:auto}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px}
.stat{background:#151a26;border:1px solid #232a3a;border-radius:12px;padding:10px 16px;min-width:110px}
.stat b{display:block;font-size:20px;font-weight:650}
.stat span{font-size:11px;color:#8b93a7;text-transform:uppercase;letter-spacing:.5px}
.board{display:flex;gap:12px;overflow-x:auto;padding-bottom:12px}
.col{flex:0 0 240px;background:#11151f;border:1px solid #1f2635;border-radius:14px;padding:12px}
.col h2{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:#8b93a7;margin-bottom:10px;display:flex;justify-content:space-between}
.col h2 em{font-style:normal;background:#232a3a;border-radius:99px;padding:0 8px}
.card{background:#1a2030;border:1px solid #2a3347;border-radius:10px;padding:10px 12px;margin-bottom:8px}
.card b{display:block;font-size:14px}
.card .role{color:#a8b3c7;font-size:12.5px}
.card .meta{display:flex;gap:8px;align-items:center;margin-top:6px;font-size:11.5px;color:#8b93a7}
.card a{color:#7aa2ff;text-decoration:none;font-size:11.5px}
.card a:hover{text-decoration:underline}
.msg{background:#151a26;border:1px solid #232a3a;border-radius:12px;padding:12px 14px;margin-bottom:8px}
.msg .f{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:#8b93a7;margin-bottom:3px}
.msg b{font-size:13.5px}
.msg p{color:#a8b3c7;font-size:12.5px;margin-top:3px}
.ev{display:flex;gap:10px;align-items:baseline;padding:7px 4px;border-bottom:1px solid #1a2030;font-size:13px}
.ev:last-child{border:0}
.ev .k{flex:0 0 84px;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;color:#8b93a7}
.ev .t{margin-left:auto;font-size:11px;color:#5c647a}
.empty{color:#5c647a;text-align:center;padding:40px 0;font-size:13px}
.err{background:#3a1d24;border:1px solid #5c2833;color:#ff9aa8;padding:12px 16px;border-radius:12px}
</style></head><body>
<header><h1>${esc(board.title)}</h1><span class="live"><i></i>live</span><span id="updated">loading…</span></header>
<main id="root"><div class="empty">Loading board…</div></main>
<script>
const ID=${JSON.stringify(board.id)}, K=${JSON.stringify(token)};
let last="";
const escH=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ago=ts=>{const m=Math.floor((Date.now()-ts)/60000);return m<1?"just now":m<60?m+"m ago":m<1440?Math.floor(m/60)+"h ago":Math.floor(m/1440)+"d ago"};
function statsHtml(st){return '<div class="stats">'+(st||[]).map(s=>'<div class="stat"><b>'+escH(s.value)+'</b><span>'+escH(s.label)+'</span></div>').join("")+"</div>"}
function render(d){
  let h="";
  if(d.kind==="pipeline"){
    h=statsHtml(d.stats)+'<div class="board">'+d.columns.map(c=>'<div class="col"><h2>'+escH(c.name)+"<em>"+c.cards.length+"</em></h2>"+
      (c.cards.length?c.cards.map(x=>'<div class="card"><b>'+escH(x.company)+"</b>"+(x.role?'<div class="role">'+escH(x.role)+"</div>":"")+
        '<div class="meta">'+(x.portal?'<span>'+escH(x.portal)+"</span>":"")+"<span>"+(x.days===0?"today":x.days+"d")+"</span>"+(x.url?'<a href="'+escH(x.url)+'" target="_blank" rel="noopener">opening ↗</a>':"")+"</div></div>").join(""):'<div class="empty">empty</div>')+"</div>").join("")+"</div>";
  } else if(d.kind==="inbox"){
    if(!d.configured) h='<div class="empty">Mail is not connected yet. Say "connect email" in the chat.</div>';
    else if(d.error) h='<div class="err">Could not read mail: '+escH(d.error)+"</div>";
    else h=d.messages.length?d.messages.map(m=>'<div class="msg"><div class="f"><span>'+escH(m.from)+"</span><span>"+escH(m.date)+"</span></div><b>"+escH(m.subject)+"</b>"+(m.snippet?"<p>"+escH(m.snippet)+"</p>":"")+"</div>").join(""):'<div class="empty">Inbox zero.</div>';
  } else {
    h=statsHtml(d.stats)+(d.events&&d.events.length?d.events.map(e=>'<div class="ev"><span class="k">'+escH(e.kind)+'</span><span>'+escH(e.text).slice(0,160)+'</span><span class="t">'+ago(e.ts)+"</span></div>").join(""):'<div class="empty">No activity yet.</div>');
  }
  document.getElementById("root").innerHTML=h;
}
async function tick(){
  try{
    const r=await fetch("/boards/"+ID+".json?k="+encodeURIComponent(K),{cache:"no-store"});
    if(r.status===401){document.getElementById("root").innerHTML='<div class="err">This share link is no longer valid.</div>';return}
    const d=await r.json(),s=JSON.stringify(d);
    if(s!==last){last=s;render(d)}
    document.getElementById("updated").textContent="updated "+new Date().toLocaleTimeString();
  }catch(e){document.getElementById("updated").textContent="reconnecting…"}
  setTimeout(tick,4000);
}
tick();
</script></body></html>`;
}
