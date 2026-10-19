// HTTP server: serves the chat UI and a small JSON API on loopback.
// The Telegram bot is wired here so web chat and the bot share one agent.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { Store, type Secrets } from './config.js';
import { MailTools } from './tools/mail.js';
import { TelegramBot } from './tools/telegramBot.js';
import { TelegramChannels } from './tools/telegramChannels.js';
import { LinkedInTools, linkedinRiskNote } from './tools/linkedin.js';
import { AgentCore, type MessageSource } from './agent/core.js';
import { readApplicationLog } from './tools/apply.js';
import { PROFILE_LABELS } from './tools/profile.js';
import { log } from './util/log.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const WEB_DIR = join(process.cwd(), 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
};

export interface AppContext {
  store: Store;
  core: AgentCore;
  mail: MailTools;
  channels: TelegramChannels;
  linkedin: LinkedInTools;
  bot: TelegramBot | null;
}

export function buildApp(dataDir = join(process.cwd(), 'data')): AppContext {
  const store = new Store(dataDir);
  const mail = new MailTools(store);
  const channels = new TelegramChannels(store);
  const linkedin = new LinkedInTools(store, dataDir);
  const core = new AgentCore(store, mail, channels, linkedin, dataDir);

  const ctx: AppContext = { store, core, mail, channels, linkedin, bot: null };

  core.setNotifier((source: MessageSource, text: string) => {
    if (source.kind === 'telegram' && source.chatId && ctx.bot) {
      ctx.bot.sendMessage(source.chatId, text).catch((err) => log.warn('bot push failed:', err instanceof Error ? err.message : err));
    }
  });

  startBotIfConfigured(ctx);
  return ctx;
}

function startBotIfConfigured(ctx: AppContext): void {
  const s = ctx.store.getSettings();
  const token = ctx.store.getSecrets().telegramBotToken;
  if (!s.telegram.botEnabled || !token) {
    ctx.core.setBotState('off');
    return;
  }
  ctx.core.setBotState('starting');
  ctx.bot = new TelegramBot({
    token,
    onMessage: async (u) => {
      await ctx.core.handle(u.text, { kind: 'telegram', chatId: u.chatId });
      return ''; // follow-ups are pushed through the notifier
    },
  });
  ctx.bot.start();
  ctx.core.setBotState('on');
  log.info('Telegram bot polling started.');
}

async function readBody(req: IncomingMessage, cap = 256_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > cap) throw new Error('Request too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

const SECRET_FIELDS: (keyof Secrets)[] = ['modelApiKey', 'mailAppPassword', 'telegramBotToken', 'telegramSession'];

export function createHttpServer(ctx: AppContext) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    try {
      // ---- API ----
      if (path === '/api/status' && req.method === 'GET') {
        const s = ctx.store.getSettings();
        return json(res, 200, {
          setupComplete: s.setupComplete,
          model: { provider: s.model.provider, configured: ctx.store.hasModelAuth(), offline: s.model.provider === 'mock' },
          mail: { configured: ctx.store.hasMailAuth(), user: s.mail.user || null },
          telegram: {
            botConfigured: ctx.store.hasTelegramBot(),
            botEnabled: s.telegram.botEnabled,
            channelsConfigured: ctx.store.hasTelegramUser(),
            channels: s.telegram.channels,
          },
          linkedin: { enabled: s.linkedin.enabled, riskAccepted: s.linkedin.riskAccepted, riskNote: linkedinRiskNote() },
          pending: ctx.core.pending.listPending(),
          profileLabels: PROFILE_LABELS,
        });
      }

      if (path === '/api/settings' && req.method === 'GET') {
        const s = ctx.store.getSettings();
        const secrets = ctx.store.getSecrets();
        return json(res, 200, {
          settings: s,
          secretsSet: Object.fromEntries(SECRET_FIELDS.map((k) => [k, Boolean(secrets[k])])),
        });
      }

      if ((path === '/api/settings' || path === '/api/setup') && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { settings?: Parameters<Store['saveSettings']>[0]; secrets?: Partial<Secrets> };
        if (body.settings) ctx.store.saveSettings(body.settings);
        if (body.secrets) {
          const clean: Partial<Secrets> = {};
          for (const k of SECRET_FIELDS) {
            const v = body.secrets[k];
            if (typeof v === 'string' && v.trim()) (clean as Record<string, string>)[k] = v.trim();
          }
          if (Object.keys(clean).length) ctx.store.saveSecrets(clean);
        }
        if (path === '/api/setup') ctx.store.saveSettings({ setupComplete: true });
        startBotIfConfigured(ctx);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/profile' && req.method === 'GET') return json(res, 200, ctx.core.profiles.get());
      if (path === '/api/profile' && req.method === 'POST') {
        const patch = JSON.parse(await readBody(req));
        return json(res, 200, ctx.core.profiles.save(patch));
      }

      if (path === '/api/chat/history' && req.method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? 0);
        return json(res, 200, { entries: ctx.core.history.after(Number.isFinite(after) ? after : 0), pending: ctx.core.pending.listPending() });
      }

      if (path === '/api/chat' && req.method === 'POST') {
        const { text } = JSON.parse(await readBody(req)) as { text?: string };
        if (!text?.trim()) return json(res, 400, { error: 'text is required' });
        void ctx.core.handle(text.trim(), { kind: 'web' }).catch((err) => log.error('handle failed:', err));
        return json(res, 202, { accepted: true });
      }

      if (path === '/api/confirm' && req.method === 'POST') {
        const { id, approved } = JSON.parse(await readBody(req)) as { id?: string; approved?: boolean };
        const a = ctx.core.pending.decide(String(id ?? ''), Boolean(approved));
        if (!a) return json(res, 404, { error: 'No pending action with that id' });
        return json(res, 200, { ok: true, status: a.status });
      }

      if (path === '/api/applications' && req.method === 'GET') {
        return json(res, 200, { entries: readApplicationLog(ctx.store.dir, 100) });
      }

      if (path === '/api/test/mail' && req.method === 'POST') return json(res, 200, await ctx.mail.testConnection());
      if (path === '/api/test/telegram-bot' && req.method === 'POST') {
        const token = ctx.store.getSecrets().telegramBotToken;
        if (!token) return json(res, 200, { ok: false, detail: 'No bot token saved.' });
        return json(res, 200, await new TelegramBot({ token, onMessage: async () => '' }).test());
      }
      if (path === '/api/test/telegram-user' && req.method === 'POST') return json(res, 200, await ctx.channels.testConnection());
      if (path === '/api/test/linkedin' && req.method === 'POST') {
        return json(res, 200, { ok: await ctx.linkedin.isLoggedIn(), detail: '' });
      }

      if (path === '/api/telegram/login' && req.method === 'POST') {
        const s = ctx.store.getSettings().telegram;
        if (!s.apiId || !s.apiHash) return json(res, 400, { error: 'Save api_id and api_hash in Settings first.' });
        void (async () => {
          try {
            ctx.core.history.append({ role: 'system', source: 'system', text: 'Telegram login started - answer the prompts here in chat.' });
            const session = await TelegramChannels.interactiveLogin(s.apiId, s.apiHash, async (q) => {
              const ans = await new Promise<Record<string, string> | null>((resolve) => {
                const card = ctx.core.pending.askQuestions([q]);
                ctx.core.history.append({ role: 'assistant', source: 'web', text: `Telegram login needs: ${q}`, card: { type: 'questions', id: card.card.id, questions: [q] } });
                card.wait.then(resolve);
              });
              return ans?.[q] ?? '';
            });
            ctx.store.saveSecrets({ telegramSession: session });
            ctx.core.history.append({ role: 'system', source: 'system', text: 'Telegram login saved. Channel reading is ready.' });
          } catch (err) {
            ctx.core.history.append({ role: 'system', source: 'system', text: `Telegram login failed: ${err instanceof Error ? err.message : String(err)}` });
          }
        })();
        return json(res, 202, { accepted: true });
      }

      if (path === '/api/linkedin/enable' && req.method === 'POST') {
        const { enabled, riskAccepted } = JSON.parse(await readBody(req)) as { enabled?: boolean; riskAccepted?: boolean };
        ctx.store.saveSettings({ linkedin: { ...ctx.store.getSettings().linkedin, enabled: Boolean(enabled), riskAccepted: Boolean(riskAccepted) } });
        return json(res, 200, { ok: true });
      }

      if (path === '/api/linkedin/open-browser' && req.method === 'POST') {
        return json(res, 200, { detail: await ctx.linkedin.openForManualLogin() });
      }

      // ---- Static ----
      if (req.method === 'GET') {
        const rel = path === '/' ? 'index.html' : normalize(path).replace(/^([/\\])+/, '');
        const file = join(WEB_DIR, rel);
        if (!file.startsWith(WEB_DIR) || !existsSync(file)) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        return res.end(readFileSync(file));
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      log.error('request failed:', err instanceof Error ? err.message : err);
      json(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
    }
  });
}

export function startServer(port = PORT, host = HOST, dataDir?: string) {
  const ctx = buildApp(dataDir);
  const server = createHttpServer(ctx);
  server.listen(port, host, () => {
    log.info(`Personal Agent listening on http://${host}:${port}`);
    if (!ctx.store.getSettings().setupComplete) log.info('First run: open the URL above - the setup wizard will walk you through keys and mail.');
  });
  return { server, ctx };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? 'server.js');
if (isMain || process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  startServer();
}
