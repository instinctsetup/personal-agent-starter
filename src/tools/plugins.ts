// Plugins: drop an .mjs file into plugins/ to add a chat command.
//   export default {
//     name: 'hello',
//     commands: [{ match: /^hello(?: (.*))?$/i, run: async ({ args }) => `hi ${args[1] ?? 'there'}` }]
//   };
// run() receives { args, core, store } and returns the reply string.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { log } from '../util/log.js';

export interface PluginContext {
  args: RegExpMatchArray;
  store: unknown;
}

export interface PluginCommand {
  match: RegExp;
  run: (ctx: PluginContext) => Promise<string> | string;
  help?: string;
}

export interface Plugin {
  name: string;
  commands: PluginCommand[];
}

export class PluginRegistry {
  readonly dir: string;
  private plugins: Plugin[] = [];
  constructor(dir = join(process.cwd(), 'plugins')) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  async load(): Promise<void> {
    this.plugins = [];
    if (!existsSync(this.dir)) return;
    for (const file of readdirSync(this.dir).filter((f) => f.endsWith('.mjs') && !f.includes('.example.'))) {
      try {
        const mod = await import(pathToFileURL(join(this.dir, file)).href);
        const p = mod.default as Plugin;
        if (p?.name && Array.isArray(p.commands)) this.plugins.push(p);
      } catch (err) {
        log.warn(`plugin ${file} failed to load:`, err instanceof Error ? err.message : err);
      }
    }
  }

  list(): { name: string; help: string[] }[] {
    return this.plugins.map((p) => ({ name: p.name, help: p.commands.map((c) => c.help ?? String(c.match)) }));
  }

  /** First matching plugin command wins; undefined when nothing matches. */
  async run(text: string, store: unknown): Promise<string | undefined> {
    for (const p of this.plugins) {
      for (const c of p.commands) {
        const m = text.match(c.match);
        if (m) return await c.run({ args: m, store });
      }
    }
    return undefined;
  }
}
