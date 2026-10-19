import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
const exec=promisify(execFile);
const ignore=['.env','.env.*','!.env.example','.browser_profiles/','playwright/.auth/','*.db','*.db-*','*.sqlite*','state.json','.auth/','node_modules/','artifacts/'];
export class GitTools {
  constructor(readonly root:string) {}
  private async git(args:string[]) { return (await exec('git',['-C',await realpath(this.root),...args],{timeout:60000,maxBuffer:1024*1024})).stdout; }
  async safeIgnore() { const path=join(this.root,'.gitignore'); const text=await readFile(path,'utf8').catch(()=> ''); const missing=ignore.filter(p=>!text.split('\n').includes(p)); if(missing.length) await appendFile(path,'\n'+missing.join('\n')+'\n'); }
  async init() { const result=await this.git(['init']); await this.safeIgnore(); return result; }
  async status() { return this.git(['status','--short']); }
  async branch(name:string) { if(!/^[a-zA-Z0-9][a-zA-Z0-9_/-]*$/.test(name)||name.includes('..')) throw new Error('Invalid branch'); return this.git(['switch','-c',name]); }
  async commit(message:string,files:string[]) {
    if (!/^(feat|fix|docs|test|chore|refactor)(\([\w-]+\))?: .{1,100}$/.test(message)) throw new Error('Use a conventional commit message');
    await this.safeIgnore();
    // Never silently include previously staged changes or ignored/tracked secrets.
    if ((await this.git(['diff','--cached','--name-only'])).trim()) throw new Error('Index must be clean before staging');
    if(!files.length||files.some(f=>!f||f==='.'||f.startsWith('/')||f.split('/').some(p=>p==='..'||p.startsWith('.env')||p==='.git'||p==='.browser_profiles'||p==='.auth')||/\.(db|sqlite|pem|key)(-|$)/.test(f))) throw new Error('Explicit non-secret files only');
    await this.git(['add','--',...files]); return this.git(['commit','-m',message]);
  }
  async push() { const remote=(await this.git(['remote','get-url','origin'])).trim(); if(!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(remote)&&!/^git@github\.com:[\w.-]+\/[\w.-]+(?:\.git)?$/.test(remote)) throw new Error('Only credential-free GitHub remotes allowed'); return this.git(['push','--set-upstream','origin','HEAD']); }
  async lfs(pattern:string) { if(!pattern||pattern.startsWith('-')||pattern.includes('\n')) throw new Error('Invalid LFS pattern'); await this.git(['lfs','install','--local']); return this.git(['lfs','track',pattern]); }
}
