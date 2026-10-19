/** Application tracker: the live dashboard behind the Jobs tab. */
import { db } from "./db.js";

export type Application = {
  id: number; ts: number; company: string; role: string | null; portal: string | null;
  url: string | null; status: string; notes: string | null;
};

export function addApplication(a: { company: string; role?: string; portal?: string; url?: string; status?: string; notes?: string }): Application {
  const r = db.prepare("INSERT INTO applications (ts, company, role, portal, url, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(Date.now(), a.company, a.role ?? null, a.portal ?? null, a.url ?? null, a.status ?? "Applied", a.notes ?? null);
  return db.prepare("SELECT * FROM applications WHERE id = ?").get(r.lastInsertRowid) as Application;
}

export function listApplications(): Application[] {
  return db.prepare("SELECT * FROM applications ORDER BY ts DESC").all() as Application[];
}

export function updateApplication(id: number, patch: Partial<Application>): boolean {
  const cur = db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as any;
  if (!cur) return false;
  const next = { ...cur, ...patch };
  db.prepare("UPDATE applications SET company=?, role=?, portal=?, url=?, status=?, notes=? WHERE id=?")
    .run(next.company, next.role, next.portal, next.url, next.status, next.notes, id);
  return true;
}

export function deleteApplication(id: number): boolean {
  return db.prepare("DELETE FROM applications WHERE id = ?").run(id).changes > 0;
}

export function trackerCsv(): string {
  const rows = listApplications();
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return ["id,date,company,role,portal,status,url,notes",
    ...rows.map((r) => [r.id, new Date(r.ts).toISOString().slice(0, 10), esc(r.company), esc(r.role), esc(r.portal), esc(r.status), esc(r.url), esc(r.notes)].join(",")),
  ].join("\n");
}
