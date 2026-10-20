/** Plain-English mail send: routing, model-drafted card, Send/Edit/Cancel gating, multi-account. Mock SMTP + mock model only. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";

process.env.AGENT_DATA_DIR = `/tmp/agent-v2-send-mail-${process.pid}`;
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_CHAT_DEADLINE_MS = "4000";

const { handleUserMessage, parseSendIntent, fallbackDraft } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { resolveApproval } = await import("../src2/approvals.js");
const { setSetting } = await import("../src2/db.js");
const { saveCredential } = await import("../src2/vault.js");
const { listMailAccounts, findMailAccount } = await import("../src2/mail.js");

/* ---------- mock SMTP server (plaintext, AUTH PLAIN, records messages) ---------- */
type Received = { mailFrom: string; rcptTo: string[]; data: string; authUser: string };
function mockSmtp() {
  const received: Received[] = [];
  const sockets = new Set<Socket>();
  const server = createNetServer((sock: Socket) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    let mode: "cmd" | "data" = "cmd";
    let buf = "";
    let cur: Received = { mailFrom: "", rcptTo: [], data: "", authUser: "" };
    const send = (s: string) => sock.write(s + "\r\n");
    send("220 mock.smtp ESMTP ready");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (mode === "data") {
        const idx = buf.indexOf("\r\n.\r\n");
        if (idx === -1) return;
        cur.data = buf.slice(0, idx);
        received.push(cur);
        cur = { mailFrom: "", rcptTo: [], data: "", authUser: cur.authUser };
        mode = "cmd";
        buf = buf.slice(idx + 5);
        send(`250 2.0.0 Ok: queued as mock-${received.length}`);
      }
      let end: number;
      while (mode === "cmd" && (end = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const verb = line.split(" ")[0].toUpperCase();
        if (verb === "EHLO" || verb === "HELO") { send("250-mock.smtp"); send("250-AUTH PLAIN LOGIN"); send("250 OK"); }
        else if (verb === "AUTH") {
          const parts = line.split(" ");
          if (parts[1]?.toUpperCase() === "PLAIN" && parts[2]) cur.authUser = Buffer.from(parts[2], "base64").toString("utf8").split("\x00")[1] || "";
          send("235 2.7.0 Accepted");
        }
        else if (verb === "MAIL") { cur.mailFrom = line; send("250 2.1.0 Ok"); }
        else if (verb === "RCPT") { cur.rcptTo.push(line); send("250 2.1.5 Ok"); }
        else if (verb === "DATA") { mode = "data"; send("354 End data with <CR><LF>.<CR><LF>"); }
        else if (verb === "RSET") { cur = { mailFrom: "", rcptTo: [], data: "", authUser: cur.authUser }; send("250 2.0.0 Ok"); }
        else if (verb === "QUIT") { send("221 2.0.0 Bye"); sock.end(); }
        else send("250 2.0.0 Ok");
      }
    });
  });
  server.unref();
  return new Promise<{ port: number; received: Received[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      port: (server.address() as { port: number }).port,
      received,
      close: () => { for (const s of sockets) s.destroy(); server.close(); },
    }));
  });
}

/* ---------- mock OpenAI-compatible model ---------- */
const DRAFT_REPLY = "Subject: Referral request for a summer internship\n\nHi,\n\nI hope you are doing well. I am looking for a software internship and would be grateful if you could refer me.\n\nBest,\nMahesh";
function mockModel(reply = DRAFT_REPLY) {
  const bodies: any[] = [];
  const server = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  server.unref();
  return new Promise<{ url: string; bodies: any[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      bodies,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

/* ---------- helpers ---------- */
async function runAndGrabApproval(text: string, timeoutMs = 6000) {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  const done = handleUserMessage(text).catch(() => {});
  const start = Date.now();
  let card: any;
  while (Date.now() - start < timeoutMs) {
    card = events.find((e) => e.kind === "approval");
    if (card) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return { events, card, finish: async () => { await done; off(); } };
}
const visibleTexts = (evs: any[]) => evs.filter((e) => e.kind === "text" && e.role !== "user").map((e) => e.text).join("\n");

const smtp = await mockSmtp();
const model = await mockModel();
setSetting("model_provider", "openai");
setSetting("model_base_url", model.url);
setSetting("model_api_key", "test-key");
setSetting("model", "test-model");
setSetting("email_user", "one@gmail.com");
setSetting("imap_host", "127.0.0.1");
setSetting("smtp_host", "127.0.0.1");
setSetting("smtp_port", String(smtp.port));
setSetting("smtp_secure", "0");
saveCredential("email", "one@gmail.com", "pw-one");

test.after(() => { smtp.close(); model.close(); });

test("parseSendIntent: natural phrasings route to send, read phrasings do not", () => {
  assert.equal(parseSendIntent("can u send mail to mahesh.cs1201@gmail.com asking for referal")?.to, "mahesh.cs1201@gmail.com");
  assert.equal(parseSendIntent("send mail to x@y.com: exact body")?.explicitBody, "exact body");
  assert.equal(parseSendIntent("write an email to boss@corp.com about leave")?.to, "boss@corp.com");
  assert.equal(parseSendIntent("send mail to a@b.com from c@d.com hi")?.from, "c@d.com");
  assert.equal(parseSendIntent("send mail to a@b.com from c@d.com hi")?.to, "a@b.com");
  assert.equal(parseSendIntent("check my email"), null);
  assert.equal(parseSendIntent("any new mails?"), null);
  assert.equal(parseSendIntent("any mail from boss@x.com?"), null);
  assert.equal(parseSendIntent("what's in my inbox"), null);
  assert.equal(parseSendIntent("connect email"), null);
});

test("router: 'can u send mail to ... asking for referal' drafts a card, never touches the inbox, never auto-sends", async () => {
  const before = smtp.received.length;
  const { events, card, finish } = await runAndGrabApproval("can u send mail to mahesh.cs1201@gmail.com asking for referal");
  assert.ok(card, "a send_email approval card appears");
  assert.equal(card.action, "send_email");
  assert.equal((card.payload as any).to, "mahesh.cs1201@gmail.com");
  // model-drafted subject + body, in the user's voice
  assert.equal((card.payload as any).subject, "Referral request for a summer internship");
  assert.match((card.payload as any).body, /refer me/);
  assert.match((card.payload as any).body, /Mahesh/);
  // the draft is shown in chat too
  assert.match(visibleTexts(events), /Subject: Referral request/);
  // 68d3063 regression: the inbox catch-all must NOT have run
  assert.ok(!events.some((e) => e.kind === "tool_call" && e.tool === "mail.inbox"), "mail.inbox must not run for a send request");
  // the model was actually asked to draft
  assert.equal(model.bodies.length >= 1, true);
  const sys = model.bodies.at(-1).messages.find((m: any) => m.role === "system").content;
  assert.match(sys, /Never invent facts/);
  // nothing sent before approval
  assert.equal(smtp.received.length, before);
  resolveApproval(card.id, "approved");
  await finish();
  assert.equal(smtp.received.length, before + 1, "exactly one message leaves after Send");
  const msg = smtp.received.at(-1)!;
  assert.equal(msg.authUser, "one@gmail.com");
  assert.match(msg.rcptTo[0], /mahesh\.cs1201@gmail\.com/i);
  assert.match(msg.data, /Subject: Referral request for a summer internship/);
  assert.match(msg.data, /refer me/);
  assert.match(visibleTexts(events), /Email sent to mahesh\.cs1201@gmail\.com from one@gmail\.com/);
});

test("cancel sends nothing", async () => {
  const before = smtp.received.length;
  const { events, card, finish } = await runAndGrabApproval("send mail to pal@example.com saying hi");
  assert.ok(card);
  resolveApproval(card.id, "rejected");
  await finish();
  assert.equal(smtp.received.length, before);
  assert.match(visibleTexts(events), /Cancelled - nothing sent/);
});

test("edit before send delivers the edited subject and body", async () => {
  const { card, finish } = await runAndGrabApproval("can u send mail to mahesh.cs1201@gmail.com asking for referal");
  assert.ok(card);
  resolveApproval(card.id, "approved", { to: "mahesh.cs1201@gmail.com", from: "one@gmail.com", subject: "Edited subject", body: "Edited body text" });
  await finish();
  const msg = smtp.received.at(-1)!;
  assert.match(msg.data, /Subject: Edited subject/);
  assert.match(msg.data, /Edited body text/);
});

test("multi-account: both accounts named in chat, From switch routes SMTP auth to the other account", async () => {
  saveCredential("email", "two@gmail.com", "pw-two");
  assert.deepEqual(listMailAccounts().map((a) => a.user), ["one@gmail.com", "two@gmail.com"]);
  assert.ok(findMailAccount("two@gmail.com"));
  const { events, card, finish } = await runAndGrabApproval("send mail to recruiter@corp.com asking for a referral");
  assert.ok(card);
  assert.equal((card.payload as any).from, "one@gmail.com", "active account is the default sender");
  const chat = visibleTexts(events);
  assert.match(chat, /two@gmail\.com/, "the other connected account is named");
  assert.match(chat, /change From to switch/, "how to switch is explained");
  resolveApproval(card.id, "approved", { ...(card.payload as any), from: "two@gmail.com" });
  await finish();
  assert.equal(smtp.received.at(-1)!.authUser, "two@gmail.com");
  assert.match(visibleTexts(events), /from two@gmail\.com/);
});

test("unknown from-account in the request is refused with the connected list, no card", async () => {
  const { events, card, finish } = await runAndGrabApproval("send mail to x@y.com from ghost@gmail.com hello");
  await finish();
  assert.equal(card, undefined);
  assert.match(visibleTexts(events), /ghost@gmail\.com isn't a connected mail account/);
  assert.match(visibleTexts(events), /one@gmail\.com/);
});

test("edited From to an unknown account is refused at send time, nothing sent", async () => {
  const before = smtp.received.length;
  const { events, card, finish } = await runAndGrabApproval("send mail to pal@example.com saying hi");
  assert.ok(card);
  resolveApproval(card.id, "approved", { ...(card.payload as any), from: "ghost@gmail.com" });
  await finish();
  assert.equal(smtp.received.length, before);
  assert.match(visibleTexts(events), /Not sent: ghost@gmail\.com isn't a connected mail account/);
});

test("offline fallback: no model key still produces an editable plain draft", async () => {
  setSetting("model_api_key", "");
  try {
    const { events, card, finish } = await runAndGrabApproval("can u send mail to mahesh.cs1201@gmail.com asking for referal");
    assert.ok(card, "card still appears without a model");
    assert.equal((card.payload as any).subject, "Referral request");
    assert.match(visibleTexts(events), /No model is connected/);
    resolveApproval(card.id, "rejected");
    await finish();
  } finally {
    setSetting("model_api_key", "test-key");
  }
});

test("legacy 'send mail to <addr>: <body>' keeps the verbatim body (Inbox & Outreach composer)", async () => {
  const { card, finish } = await runAndGrabApproval("send mail to exact@example.com: line one\nline two");
  assert.ok(card);
  assert.equal((card.payload as any).body, "line one\nline two");
  resolveApproval(card.id, "rejected");
  await finish();
});

test("inbox read intents still route to mail.inbox, never to send", async () => {
  for (const text of ["check my email", "any new mails?"]) {
    const events: any[] = [];
    const off = onEvent((e) => events.push(e));
    await handleUserMessage(text).catch(() => {});
    off();
    assert.ok(events.some((e) => e.kind === "tool_call" && e.tool === "mail.inbox"), `"${text}" hits mail.inbox`);
    assert.ok(!events.some((e) => e.kind === "approval"), `"${text}" shows no send card`);
  }
});

test("fallbackDraft keeps the referral ask in the user's words", () => {
  const d = fallbackDraft("can u send mail to mahesh.cs1201@gmail.com asking for referal", "mahesh.cs1201@gmail.com", "Mahesh");
  assert.equal(d.subject, "Referral request");
  assert.match(d.body, /refer me/);
  assert.match(d.body, /Mahesh/);
});
