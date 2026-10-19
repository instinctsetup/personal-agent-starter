import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesStore, looksSecret } from '../src/tools/notes.js';
import { ReminderStore, parseReminder } from '../src/tools/reminders.js';
import { FileTools } from '../src/tools/files.js';
import { PluginRegistry } from '../src/tools/plugins.js';
import { parseIntent } from '../src/agent/intents.js';
import { writeFileSync } from 'node:fs';

test('notes: add, search, remove; secrets refused by the guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-notes-'));
  const notes = new NotesStore(dir);
  const n = notes.add('Mahesh prefers Mumbai over Delhi for internships');
  assert.equal(notes.search('mumbai').length, 1);
  assert.equal(notes.search('nonexistent-xyz').length, 0);
  assert.ok(looksSecret('my password is hunter2'));
  assert.ok(!looksSecret('prefers Mumbai'));
  assert.equal(notes.remove(n.id)?.id, n.id);
  assert.equal(notes.all().length, 0);
});

test('reminder parsing: relative, absolute, tomorrow', () => {
  const now = new Date('2026-10-20T10:00:00');
  const rel = parseReminder('remind me in 30 minutes to stretch', now)!;
  assert.equal(rel.text, 'stretch');
  assert.equal(rel.dueAt.getTime() - now.getTime(), 30 * 60e3);
  const abs = parseReminder('remind me at 6pm to call home', now)!;
  assert.equal(abs.dueAt.getHours(), 18);
  assert.equal(abs.text, 'call home');
  const past = parseReminder('remind me at 9am to standup', now)!; // already past -> tomorrow
  assert.ok(past.dueAt.getDate() !== now.getDate());
  const tom = parseReminder('remind me tomorrow to submit the form', now)!;
  assert.equal(tom.dueAt.getHours(), 9);
  assert.equal(parseReminder('remind me whenever to x', now), undefined);
});

test('reminder store: pending, due, done', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-rem-'));
  const rs = new ReminderStore(dir);
  const soon = rs.add('past thing', new Date(Date.now() - 1000));
  rs.add('future thing', new Date(Date.now() + 3600e3));
  assert.equal(rs.pending().length, 2);
  const due = rs.due();
  assert.equal(due.length, 1);
  rs.markDone(soon.id);
  assert.equal(rs.pending().length, 1);
});

test('file tools stay inside the workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-files-'));
  const ft = new FileTools(dir);
  ft.write('a.txt', 'hello');
  ft.append('a.txt', ' world');
  assert.equal(ft.read('a.txt'), 'hello world');
  assert.deepEqual(ft.list().map((f) => f.name), ['a.txt']);
  assert.throws(() => ft.read('../secrets.json'));
  assert.throws(() => ft.write('../../etc/x', 'no'));
});

test('plugins load and answer commands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-plug-'));
  writeFileSync(join(dir, 'hi.mjs'), `export default { name: 'hi', commands: [{ match: /^hi (.*)$/i, run: async ({args}) => 'yo ' + args[1] }] };`);
  const reg = new PluginRegistry(dir);
  await reg.load();
  assert.equal(reg.list()[0].name, 'hi');
  assert.equal(await reg.run('hi there', {}), 'yo there');
  assert.equal(await reg.run('unrelated', {}), undefined);
});

test('new intents parse', () => {
  assert.deepEqual(parseIntent('remember that I like Mumbai'), { name: 'remember', text: 'I like Mumbai' });
  assert.deepEqual(parseIntent('recall mumbai'), { name: 'recall', query: 'mumbai' });
  assert.equal(parseIntent('notes').name, 'notes');
  assert.equal(parseIntent('forget abc123').name, 'forget');
  assert.equal(parseIntent('remind me in 5 minutes to check the oven').name, 'remind');
  assert.equal(parseIntent('reminders').name, 'reminders');
  assert.equal(parseIntent('list files').name, 'files.list');
  assert.deepEqual(parseIntent('write file todo.txt: buy milk'), { name: 'files.write', name2: 'todo.txt', content: 'buy milk' });
  assert.deepEqual(parseIntent('read file todo.txt'), { name: 'files.read', name2: 'todo.txt' });
  assert.equal(parseIntent('plugins').name, 'plugins');
});
