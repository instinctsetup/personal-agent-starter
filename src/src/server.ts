import { createServer } from 'node:http';
import type { Memory } from './memory/db.js';
export async function serve(memory:Memory,port=8787) {
  const server=createServer((request,response)=>{
    response.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Cache-Control','no-store');
    if(request.method!=='GET'||!['127.0.0.1:8787',`127.0.0.1:${(server.address() as any)?.port}`].includes(request.headers.host??'')){response.writeHead(403).end();return;}
    if(request.url==='/health'){response.setHeader('Content-Type','application/json');response.end('{"ok":true}');return;}
    if(request.url!=='/'){response.writeHead(404).end();return;}
    const escape=(value:unknown)=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
    const tasks=memory.db.prepare('SELECT id,status,steps FROM tasks ORDER BY rowid DESC LIMIT 100').all();
    response.setHeader('Content-Type','text/html; charset=utf-8');
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Personal Agent | Local status</title><style>body{margin:0;background:#090e20;color:#dce8ff;font:16px system-ui;line-height:1.6}main{max-width:960px;margin:60px auto;padding:24px}small{color:#66e2ee;letter-spacing:.15em}h1{font-size:clamp(30px,6vw,52px);margin:12px 0}p{color:#aeb8d1}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:16px;border-bottom:1px solid #303958}td:first-child{overflow-wrap:anywhere}section{padding:24px;background:#121a32;border:1px solid #6d5bcc;border-radius:18px;overflow:auto}th{color:#9c89ff}</style><main><small>LOCAL FIRST / HUMAN REVIEWED</small><h1>Personal Agent</h1><p>A private, read-only view. Refresh to update. Resume tasks in your terminal.</p><section><table><tr><th>Task</th><th>State</th><th>Steps</th></tr>${tasks.map(t=>`<tr><td>${escape(t.id)}</td><td>${escape(t.status)}</td><td>${escape(t.steps)}</td></tr>`).join('')||'<tr><td colspan="3">No tasks yet. Start one in your terminal.</td></tr>'}</table></section></main></html>`);
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve());});return server;
}
