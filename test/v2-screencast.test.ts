import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
process.env.AGENT_DATA_DIR = `/tmp/agent-v2-cast-${process.pid}`;
const { buildApp } = await import("../src2/app.js");
const br = await import("../src2/browser.js");

test("screencast: real fps and click-to-frame latency on an animated page", { timeout: 60_000 }, async () => {
  const pageSrv = http.createServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body style="margin:0"><div id="d" style="width:1280px;height:800px"></div><script>
      let n = 0;
      setInterval(() => { n++; document.getElementById("d").style.background = "hsl(" + (n * 7) % 360 + ",70%,60%)"; }, 80);
      document.addEventListener("mousedown", () => { document.getElementById("d").style.background = "rgb(0,0,0)"; });
    </script></body></html>`);
  });
  await new Promise<void>((r) => pageSrv.listen(0, "127.0.0.1", r));
  const pageUrl = `http://127.0.0.1:${(pageSrv.address() as any).port}/`;

  const app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as any).port;

  await br.navigate(pageUrl);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: { t: number; buf: Buffer }[] = [];
  ws.on("message", (data: Buffer, isBinary: boolean) => { if (isBinary) frames.push({ t: Date.now(), buf: data }); });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "screencast", on: true }));
  await new Promise((r) => setTimeout(r, 4000));

  const fps = frames.length / 4;
  assert.ok(frames.length >= 10, `expected a frame stream, got ${frames.length}`);
  assert.equal(frames[0].buf[0], 0xff, "JPEG magic byte");
  assert.equal(frames[0].buf[1], 0xd8, "JPEG magic byte");

  const before = frames.at(-1)!.buf;
  const t0 = Date.now();
  ws.send(JSON.stringify({ type: "click", x: 400, y: 300 }));
  let latency = -1;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const f = frames.at(-1);
    if (f && f.t >= t0 && !f.buf.equals(before)) { latency = f.t - t0; break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  console.log(`  [measure] screencast ${frames.length} frames in 4s (~${fps.toFixed(1)} fps, quality ${br.castStats.quality}), click->changed-frame ${latency}ms`);
  assert.ok(latency >= 0 && latency < 2000, `click-to-changed-frame latency ${latency}ms`);

  ws.send(JSON.stringify({ type: "screencast", on: false }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(br.isScreencasting(), false, "cast stops when the last watcher leaves");
  ws.close();
  await app.close();
  pageSrv.close();
  await br.closeBrowser();
});
