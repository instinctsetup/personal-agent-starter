// Local-first settings and secrets. Both files live under data/ with mode 600.
// Secrets are kept in a separate file so settings can be shown in the UI
// without ever serializing a secret value.
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { registerSecret } from './util/log.js';

export interface ModelSettings {
  provider: 'mock' | 'openai-compatible';
  baseUrl: string; // e.g. https://api.openai.com/v1 or http://localhost:11434/v1
  model: string;
}

export interface MailSettings {
  user: string; // Gmail address
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  fromName: string;
}

export interface TelegramSettings {
  botEnabled: boolean;
  apiId: string; // user-client credentials for channel reading
  apiHash: string;
  channels: string[]; // @handles or t.me links the user configured
}

export interface LinkedinCaps {
  feedChecksPerDay: number;
  actionsPerDay: number; // applies/messages/invites combined
  minFeedCheckMinutes: number;
  minActionMinutes: number;
}

export interface LinkedinSettings {
  enabled: boolean;
  riskAccepted: boolean; // one-time UI note about LinkedIn ToS
  caps: LinkedinCaps;
}

export interface Settings {
  setupComplete: boolean;
  model: ModelSettings;
  mail: MailSettings;
  telegram: TelegramSettings;
  linkedin: LinkedinSettings;
}

export interface Secrets {
  modelApiKey?: string;
  mailAppPassword?: string;
  telegramBotToken?: string;
  telegramSession?: string; // GramJS StringSession for channel reading
}

export const DEFAULT_SETTINGS: Settings = {
  setupComplete: false,
  model: { provider: 'mock', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  mail: {
    user: '',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    fromName: '',
  },
  telegram: { botEnabled: false, apiId: '', apiHash: '', channels: [] },
  linkedin: {
    enabled: false,
    riskAccepted: false,
    caps: { feedChecksPerDay: 4, actionsPerDay: 10, minFeedCheckMinutes: 60, minActionMinutes: 10 },
  },
};

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return { ...fallback, ...JSON.parse(readFileSync(path, 'utf8')) } as T;
  } catch {
    return fallback;
  }
}

function writeJson600(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export class Store {
  readonly dir: string;
  readonly settingsPath: string;
  readonly secretsPath: string;
  private settings: Settings;
  private secrets: Secrets;

  constructor(dir = join(process.cwd(), 'data')) {
    this.dir = dir;
    this.settingsPath = join(dir, 'settings.json');
    this.secretsPath = join(dir, 'secrets.json');
    this.settings = readJson(this.settingsPath, structuredClone(DEFAULT_SETTINGS));
    this.settings.linkedin.caps = { ...DEFAULT_SETTINGS.linkedin.caps, ...this.settings.linkedin?.caps };
    this.secrets = readJson(this.secretsPath, {} as Secrets);
    for (const v of Object.values(this.secrets)) registerSecret(v);
    if (existsSync(this.settingsPath)) chmodSync(this.settingsPath, 0o600);
    if (existsSync(this.secretsPath)) chmodSync(this.secretsPath, 0o600);
  }

  getSettings(): Settings {
    return structuredClone(this.settings);
  }

  saveSettings(patch: Partial<Settings>): Settings {
    this.settings = {
      ...this.settings,
      ...patch,
      model: { ...this.settings.model, ...(patch.model ?? {}) },
      mail: { ...this.settings.mail, ...(patch.mail ?? {}) },
      telegram: { ...this.settings.telegram, ...(patch.telegram ?? {}) },
      linkedin: {
        ...this.settings.linkedin,
        ...(patch.linkedin ?? {}),
        caps: { ...this.settings.linkedin.caps, ...(patch.linkedin?.caps ?? {}) },
      },
    };
    writeJson600(this.settingsPath, this.settings);
    return this.getSettings();
  }

  /** Returns a copy of secrets in memory. Never persist or log the result. */
  getSecrets(): Secrets {
    return { ...this.secrets };
  }

  saveSecrets(patch: Partial<Secrets>): void {
    this.secrets = { ...this.secrets, ...patch };
    for (const v of Object.values(this.secrets)) registerSecret(v);
    writeJson600(this.secretsPath, this.secrets);
  }

  hasMailAuth(): boolean {
    return Boolean(this.settings.mail.user && this.secrets.mailAppPassword);
  }

  hasModelAuth(): boolean {
    return this.settings.model.provider === 'mock' || Boolean(this.secrets.modelApiKey);
  }

  hasTelegramBot(): boolean {
    return Boolean(this.secrets.telegramBotToken);
  }

  hasTelegramUser(): boolean {
    return Boolean(this.settings.telegram.apiId && this.settings.telegram.apiHash && this.secrets.telegramSession);
  }
}
