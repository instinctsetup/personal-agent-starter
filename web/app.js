/* Personal Agent web UI - no framework, polls the local API. */
const $ = (sel) => document.querySelector(sel);
const api = async (path, opts = {}) => {
  const res = await fetch(path, opts.method
    ? { method: opts.method, headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined }
    : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

let lastN = 0;
let statusCache = null;

// ---------- navigation ----------
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`));
    if (btn.dataset.view === 'applications') loadApplications();
    if (btn.dataset.view === 'settings') loadSettings();
  });
});

// ---------- chat ----------
function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

function renderEntry(e) {
  const div = document.createElement('div');
  div.className = `msg ${e.role}`;
  div.dataset.n = e.n;
  const body = document.createElement('span');
  body.textContent = e.text;
  div.appendChild(body);
  if (e.card && e.card.type === 'confirm') {
    const pending = (statusCache?.pending || []).find((p) => p.id === e.card.id);
    const card = document.createElement('div');
    card.className = 'card' + (pending ? '' : ' done');
    const label = document.createElement('div');
    label.textContent = pending ? 'Needs your confirmation' : 'Confirmation handled';
    label.style.fontWeight = '600';
    card.appendChild(label);
    if (pending) {
      const actions = document.createElement('div');
      actions.className = 'actions';
      const yes = document.createElement('button');
      yes.className = 'primary'; yes.textContent = 'Confirm';
      const no = document.createElement('button');
      no.className = 'danger'; no.textContent = 'Cancel';
      yes.onclick = () => decide(e.card.id, true);
      no.onclick = () => decide(e.card.id, false);
      actions.append(yes, no);
      card.appendChild(actions);
    }
    div.appendChild(card);
  }
  if (e.card && e.card.type === 'questions') {
    const card = document.createElement('div');
    card.className = 'card';
    const ul = document.createElement('ol');
    ul.style.margin = '6px 0';
    e.card.questions.forEach((q) => {
      const li = document.createElement('li');
      li.textContent = q;
      ul.appendChild(li);
    });
    card.appendChild(ul);
    div.appendChild(card);
  }
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = fmtTime(e.ts);
  div.appendChild(ts);
  return div;
}

async function decide(id, approved) {
  await api('/api/confirm', { method: 'POST', body: { id, approved } });
  await refreshStatus();
  await poll(true);
}

async function poll(force) {
  try {
    const data = await api(`/api/chat/history?after=${lastN}`);
    if (data.pending) statusCache = { ...(statusCache || {}), pending: data.pending };
    const box = $('#messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    for (const e of data.entries) {
      lastN = Math.max(lastN, e.n);
      box.appendChild(renderEntry(e));
    }
    if (data.entries.length && (atBottom || force)) box.scrollTop = box.scrollHeight;
  } catch { /* server may be restarting */ }
}

$('#composer').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('#composer-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await api('/api/chat', { method: 'POST', body: { text } });
  await poll(true);
});

// ---------- status ----------
function pill(label, state, badge) {
  return `<div class="status-pill"><span class="dot ${state}"></span><span>${label}</span>${badge ? `<span class="badge">${badge}</span>` : ''}</div>`;
}

async function refreshStatus() {
  try {
    const prev = statusCache;
    statusCache = { ...(await api('/api/status')), pending: prev?.pending || [] };
    const s = statusCache;
    $('#status-list').innerHTML = [
      pill('Model', s.model.configured ? (s.model.offline ? 'warn' : 'ok') : 'off', s.model.offline ? 'mock/offline' : null),
      pill('Mail', s.mail.configured ? 'ok' : 'off', s.mail.configured ? null : 'not set up'),
      pill('Telegram bot', s.telegram.botEnabled && s.telegram.botConfigured ? 'ok' : 'off', null),
      pill('TG channels', s.telegram.channelsConfigured ? 'ok' : 'off', s.telegram.channelsConfigured ? null : 'not set up'),
      pill('LinkedIn', s.linkedin.enabled ? 'warn' : 'off', s.linkedin.enabled ? 'at your risk' : null),
    ].join('');
    if (!s.setupComplete) showWizard();
  } catch { /* ignore */ }
}

// ---------- applications ----------
async function loadApplications() {
  const { entries } = await api('/api/applications');
  const box = $('#applications-list');
  if (!entries.length) {
    box.innerHTML = '<p class="muted">Nothing yet. Paste a job link in chat with the word "apply".</p>';
    return;
  }
  box.innerHTML = '';
  for (const r of entries) {
    const div = document.createElement('div');
    div.className = 'app-row';
    div.innerHTML = `<span class="status ${String(r.status).includes('submitted') ? 'submitted' : r.status === 'failed' ? 'failed' : 'cancelled'}">${r.status}</span> · ${r.ts ? new Date(r.ts).toLocaleString() : ''}<br><a href="${r.url}" style="color:var(--accent)">${r.url || ''}</a>${r.error ? `<br><span class="muted">${r.error}</span>` : ''}`;
    box.appendChild(div);
  }
}

// ---------- settings ----------
const SECRET_INPUT = (key, label, placeholder) =>
  `<div class="field"><label>${label}</label><input type="password" data-secret="${key}" placeholder="${placeholder}"><span class="muted" data-secret-state="${key}"></span></div>`;

function settingsHtml(s, secretsSet) {
  const m = s.settings.model, mail = s.settings.mail, tg = s.settings.telegram, li = s.settings.linkedin;
  return `
  <div class="settings-section"><h3>Model provider</h3>
    <div class="field"><label>Provider</label><select id="set-model-provider">
      <option value="mock" ${m.provider === 'mock' ? 'selected' : ''}>Offline mock (testing, no key needed)</option>
      <option value="openai-compatible" ${m.provider === 'openai-compatible' ? 'selected' : ''}>OpenAI-compatible endpoint</option>
    </select></div>
    <div class="row">
      <div class="field"><label>Base URL</label><input id="set-model-base" value="${m.baseUrl}" placeholder="https://api.openai.com/v1"></div>
      <div class="field"><label>Model</label><input id="set-model-name" value="${m.model}" placeholder="gpt-4o-mini"></div>
    </div>
    ${SECRET_INPUT('modelApiKey', 'API key', secretsSet.modelApiKey ? 'saved - type to replace' : 'sk-...')}
    <p class="muted">Works with OpenAI, OpenRouter, Ollama (http://localhost:11434/v1), LM Studio, etc.</p>
  </div>

  <div class="settings-section"><h3>Mail (Gmail)</h3>
    <div class="row">
      <div class="field"><label>Gmail address</label><input id="set-mail-user" value="${mail.user}" placeholder="you@gmail.com"></div>
      <div class="field"><label>From name (optional)</label><input id="set-mail-fromname" value="${mail.fromName}"></div>
    </div>
    ${SECRET_INPUT('mailAppPassword', 'Gmail app password', secretsSet.mailAppPassword ? 'saved - type to replace' : '16-letter app password')}
    <div class="row">
      <div class="field"><label>IMAP host</label><input id="set-mail-imap" value="${mail.imapHost}"></div>
      <div class="field"><label>SMTP host</label><input id="set-mail-smtp" value="${mail.smtpHost}"></div>
    </div>
    <button class="ghost" id="test-mail">Test connection</button> <span class="test-result" id="test-mail-result"></span>
    <p class="muted">Gmail needs an app password: Google Account &gt; Security &gt; 2-Step Verification &gt; App passwords. Your normal password will not work.</p>
  </div>

  <div class="settings-section"><h3>Telegram</h3>
    ${SECRET_INPUT('telegramBotToken', 'Bot token (from @BotFather)', secretsSet.telegramBotToken ? 'saved - type to replace' : '123456:ABC...')}
    <div class="row">
      <div class="field"><label>api_id (my.telegram.org)</label><input id="set-tg-apiid" value="${tg.apiId}"></div>
      <div class="field"><label>api_hash</label><input id="set-tg-apihash" value="${tg.apiHash}"></div>
    </div>
    <div class="field"><label>Channels to read (comma-separated, @handle or t.me link)</label><input id="set-tg-channels" value="${tg.channels.join(', ')}"></div>
    <div class="row">
      <button class="ghost" id="test-tg-bot">Test bot token</button>
      <button class="ghost" id="tg-login">Log in for channel reading</button>
      <button class="ghost" id="test-tg-user">Test channel login</button>
    </div>
    <span class="test-result" id="test-tg-result"></span>
    <p class="muted">The bot answers your messages in Telegram. Channel reading uses your own account (one-time login here in chat). Channel reading is <b>not yet live-verified</b> on this install.</p>
  </div>

  <div class="settings-section"><h3>LinkedIn assist <span class="badge">opt-in</span></h3>
    <div class="notice" id="li-risk">${''}</div>
    <div class="row">
      <button class="${li.enabled ? 'danger' : 'primary'}" id="li-toggle">${li.enabled ? 'Disable LinkedIn assist' : 'Enable LinkedIn assist'}</button>
      <button class="ghost" id="li-open">Open LinkedIn browser (log in once)</button>
    </div>
    <p class="muted">Uses your own logged-in browser session on this machine. Slow pacing with daily caps; stops immediately on any checkpoint or captcha and tells you. Never auto-applies without your confirmation.</p>
  </div>

  <div class="settings-section"><h3>Your profile (form answers)</h3>
    <p class="muted">Applications are answered only from here - never invented. Anything missing gets asked in chat.</p>
    <div id="profile-fields"></div>
    <button class="primary" id="save-profile">Save profile</button> <span class="test-result" id="save-profile-result"></span>
  </div>

  <div class="settings-section">
    <button class="primary" id="save-settings">Save settings</button> <span class="test-result" id="save-settings-result"></span>
  </div>`;
}

async function loadSettings() {
  const data = await api('/api/settings');
  const box = $('#settings-form');
  box.innerHTML = settingsHtml(data, data.secretsSet);
  $('#li-risk').innerHTML = statusCache?.linkedin?.riskNote || '';
  $('#li-risk').style.display = data.settings.linkedin.riskAccepted ? 'none' : 'block';

  // profile fields
  const prof = await api('/api/profile');
  const pf = $('#profile-fields');
  pf.innerHTML = '';
  for (const [key, label] of Object.entries(statusCache.profileLabels || {})) {
    const div = document.createElement('div');
    div.className = 'field';
    div.innerHTML = `<label>${label}</label><input data-profile="${key}" value="${(prof[key] || '').replace(/"/g, '&quot;')}">`;
    pf.appendChild(div);
  }

  $('#save-settings').onclick = saveSettings;
  $('#save-profile').onclick = async () => {
    const patch = {};
    document.querySelectorAll('[data-profile]').forEach((el) => (patch[el.dataset.profile] = el.value.trim()));
    await api('/api/profile', { method: 'POST', body: patch });
    $('#save-profile-result').textContent = 'Saved.';
    $('#save-profile-result').className = 'test-result ok';
  };
  $('#test-mail').onclick = async () => {
    await saveSettings();
    const r = await api('/api/test/mail', { method: 'POST' });
    $('#test-mail-result').textContent = `${r.ok ? 'OK' : 'Failed'} - ${r.detail}`;
    $('#test-mail-result').className = `test-result ${r.ok ? 'ok' : 'bad'}`;
  };
  $('#test-tg-bot').onclick = async () => {
    await saveSettings();
    const r = await api('/api/test/telegram-bot', { method: 'POST' });
    $('#test-tg-result').textContent = `${r.ok ? 'OK' : 'Failed'} - ${r.detail}`;
    $('#test-tg-result').className = `test-result ${r.ok ? 'ok' : 'bad'}`;
  };
  $('#test-tg-user').onclick = async () => {
    const r = await api('/api/test/telegram-user', { method: 'POST' });
    $('#test-tg-result').textContent = `${r.ok ? 'OK' : 'Failed'} - ${r.detail}`;
    $('#test-tg-result').className = `test-result ${r.ok ? 'ok' : 'bad'}`;
  };
  $('#tg-login').onclick = async () => {
    await saveSettings();
    await api('/api/telegram/login', { method: 'POST' });
    document.querySelector('[data-view="chat"]').click();
  };
  $('#li-toggle').onclick = async () => {
    const enabling = !data.settings.linkedin.enabled;
    if (enabling && !data.settings.linkedin.riskAccepted) {
      if (!confirm($('#li-risk').textContent + '\n\nEnable anyway?')) return;
      await api('/api/linkedin/enable', { method: 'POST', body: { enabled: true, riskAccepted: true } });
    } else {
      await api('/api/linkedin/enable', { method: 'POST', body: { enabled: !data.settings.linkedin.enabled, riskAccepted: data.settings.linkedin.riskAccepted } });
    }
    await refreshStatus();
    loadSettings();
  };
  $('#li-open').onclick = async () => {
    const r = await api('/api/linkedin/open-browser', { method: 'POST' });
    alert(r.detail);
  };
}

async function saveSettings() {
  const g = (id) => ($(id)?.value ?? '').trim();
  const settings = {
    model: { provider: g('#set-model-provider'), baseUrl: g('#set-model-base'), model: g('#set-model-name') },
    mail: { user: g('#set-mail-user'), fromName: g('#set-mail-fromname'), imapHost: g('#set-mail-imap') || 'imap.gmail.com', smtpHost: g('#set-mail-smtp') || 'smtp.gmail.com' },
    telegram: {
      botEnabled: Boolean(g('#set-tg-bottoken-enabled') || document.querySelector('[data-secret="telegramBotToken"]')?.value || statusCache?.telegram?.botConfigured),
      apiId: g('#set-tg-apiid'), apiHash: g('#set-tg-apihash'),
      channels: g('#set-tg-channels').split(',').map((s) => s.trim()).filter(Boolean),
    },
  };
  const secrets = {};
  document.querySelectorAll('[data-secret]').forEach((el) => { if (el.value.trim()) secrets[el.dataset.secret] = el.value.trim(); });
  await api('/api/settings', { method: 'POST', body: { settings, secrets } });
  const r = $('#save-settings-result');
  if (r) { r.textContent = 'Saved.'; r.className = 'test-result ok'; }
  await refreshStatus();
}

// ---------- wizard ----------
const WIZARD_STEPS = [
  { title: 'Model provider', html: `
    <p class="muted">Pick "Offline mock" to try everything now, or connect any OpenAI-compatible endpoint.</p>
    <div class="field"><label>Provider</label><select id="wiz-model-provider"><option value="mock">Offline mock (no key)</option><option value="openai-compatible">OpenAI-compatible</option></select></div>
    <div class="field"><label>Base URL</label><input id="wiz-model-base" value="https://api.openai.com/v1"></div>
    <div class="field"><label>Model</label><input id="wiz-model-name" value="gpt-4o-mini"></div>
    <div class="field"><label>API key (if needed)</label><input type="password" id="wiz-model-key"></div>` },
  { title: 'Mail (Gmail)', html: `
    <p class="muted">Uses IMAP + an app password. Google Account &gt; Security &gt; 2-Step Verification &gt; App passwords.</p>
    <div class="field"><label>Gmail address</label><input id="wiz-mail-user" placeholder="you@gmail.com"></div>
    <div class="field"><label>App password</label><input type="password" id="wiz-mail-pass"></div>` },
  { title: 'Telegram (optional)', html: `
    <p class="muted">Bot token from @BotFather lets you chat from Telegram. Channel reading needs api_id/api_hash from my.telegram.org - finish that later in Settings.</p>
    <div class="field"><label>Bot token</label><input type="password" id="wiz-tg-token"></div>
    <div class="field"><label>Channels to read (comma-separated)</label><input id="wiz-tg-channels" placeholder="@jobs, @remoteok"></div>` },
  { title: 'Your profile', html: `
    <p class="muted">Forms are answered only from this profile. Add the basics now; refine later in Settings.</p>
    <div class="row"><div class="field"><label>First name</label><input id="wiz-first"></div><div class="field"><label>Last name</label><input id="wiz-last"></div></div>
    <div class="field"><label>Email for applications</label><input id="wiz-email"></div>
    <div class="field"><label>Phone</label><input id="wiz-phone"></div>
    <div class="field"><label>Full path to your resume PDF on this computer</label><input id="wiz-resume" placeholder="/home/you/resume.pdf"></div>` },
];
let wizardIdx = 0;

function showWizard() {
  $('#wizard').classList.remove('hidden');
  renderWizard();
}

function renderWizard() {
  const wrap = $('#wizard-steps');
  wrap.innerHTML = WIZARD_STEPS.map((s, i) => `<div class="step ${i === wizardIdx ? 'active' : ''}" data-step="${i}"><h3>${s.title}</h3>${s.html}</div>`).join('');
  $('#wizard-next').textContent = wizardIdx === WIZARD_STEPS.length - 1 ? 'Finish' : 'Next';
  $('#wizard-skip').textContent = wizardIdx === 0 ? 'Skip for now' : 'Skip step';
}

$('#wizard-skip').onclick = async () => {
  if (wizardIdx === 0) { await api('/api/setup', { method: 'POST', body: {} }); $('#wizard').classList.add('hidden'); return; }
  wizardIdx++;
  if (wizardIdx >= WIZARD_STEPS.length) { await api('/api/setup', { method: 'POST', body: {} }); $('#wizard').classList.add('hidden'); return; }
  renderWizard();
};

$('#wizard-next').onclick = async () => {
  const g = (id) => ($(id)?.value ?? '').trim();
  if (wizardIdx === 0) {
    await api('/api/settings', { method: 'POST', body: { settings: { model: { provider: g('#wiz-model-provider'), baseUrl: g('#wiz-model-base'), model: g('#wiz-model-name') } }, secrets: { modelApiKey: g('#wiz-model-key') } } });
  } else if (wizardIdx === 1) {
    await api('/api/settings', { method: 'POST', body: { settings: { mail: { user: g('#wiz-mail-user') } }, secrets: { mailAppPassword: g('#wiz-mail-pass') } } });
  } else if (wizardIdx === 2) {
    await api('/api/settings', { method: 'POST', body: { settings: { telegram: { botEnabled: Boolean(g('#wiz-tg-token')), channels: g('#wiz-tg-channels').split(',').map((s) => s.trim()).filter(Boolean) } }, secrets: { telegramBotToken: g('#wiz-tg-token') } } });
  } else if (wizardIdx === 3) {
    await api('/api/profile', { method: 'POST', body: { firstName: g('#wiz-first'), lastName: g('#wiz-last'), email: g('#wiz-email'), phone: g('#wiz-phone'), resumePath: g('#wiz-resume') } });
    await api('/api/setup', { method: 'POST', body: {} });
    $('#wizard').classList.add('hidden');
    await refreshStatus();
    return;
  }
  wizardIdx++;
  renderWizard();
};

// ---------- boot ----------
(async () => {
  await refreshStatus();
  await poll(true);
  setInterval(poll, 2000);
  setInterval(refreshStatus, 15000);
})();
