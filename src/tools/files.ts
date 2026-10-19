// A small workspace file manager: list/read/write/append inside
// data/workspace only. Paths can never escape that folder.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

export class FileTools {
  readonly dir: string;
  constructor(base = join(process.cwd(), 'data')) {
    this.dir = join(base, 'workspace');
    mkdirSync(this.dir, { recursive: true });
  }

  private safe(rel: string): string {
    const p = normalize(join(this.dir, rel));
    if (!p.startsWith(this.dir)) throw new Error('Paths stay inside the workspace folder.');
    return p;
  }

  list(): { name: string; size: number }[] {
    return readdirSync(this.dir).map((name) => ({ name, size: statSync(join(this.dir, name)).size }));
  }

  read(rel: string, maxChars = 8000): string {
    const p = this.safe(rel);
    if (!existsSync(p)) throw new Error(`No file named ${rel} in the workspace.`);
    const text = readFileSync(p, 'utf8');
    return text.length > maxChars ? text.slice(0, maxChars) + `\n... (truncated, ${text.length} chars total)` : text;
  }

  write(rel: string, content: string): string {
    const p = this.safe(rel);
    writeFileSync(p, content);
    return rel;
  }

  append(rel: string, content: string): string {
    const p = this.safe(rel);
    appendFileSync(p, content);
    return rel;
  }
}
