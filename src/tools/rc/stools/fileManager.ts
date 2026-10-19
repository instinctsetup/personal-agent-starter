import { realpath, mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
export class FileManager {
  constructor(readonly root: string) {}
  async path(name: string): Promise<string> {
    await mkdir(this.root,{recursive:true});
    const root=await realpath(this.root), path=resolve(root,name);
    const rel=relative(root,path);
    if (isAbsolute(rel)||rel==='..'||rel.startsWith('../')) throw new Error('Path outside workspace');
    if (rel.split(/[\\/]/).some(p=>p==='.git'||p==='.env'||p.startsWith('.env.')||p==='.browser_profiles'||p==='.auth')) throw new Error('Protected path');
    // Walk existing ancestors: symlinks cannot redirect a write outside the root.
    let current=path;
    while(current!==root) {
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlinks are not supported'); }
      catch(e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
      current=dirname(current);
    }
    return path;
  }
  async read(name:string,start=1,end=start+199) {
    if (!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end-start>499) throw new Error('Read 1-500 lines at a time');
    return (await readFile(await this.path(name),'utf8')).split('\n').slice(start-1,end).map((line,i)=>`${i+start}: ${line}`).join('\n');
  }
  async create(name:string,content:string) {
    const path=await this.path(name); await mkdir(dirname(path),{recursive:true}); await writeFile(path,content,{flag:'wx',mode:0o600}); return {created:name};
  }
  async patch(name:string,start:number,end:number,expected:string,replacement:string) {
    const path=await this.path(name), lines=(await readFile(path,'utf8')).split('\n');
    if (!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>lines.length||end-start>499) throw new Error('Invalid line range');
    if(lines.slice(start-1,end).join('\n')!==expected) throw new Error('File changed: expected text does not match');
    lines.splice(start-1,end-start+1,...replacement.split('\n'));
    const temporary=path+`.${process.pid}.tmp`; await writeFile(temporary,lines.join('\n'),{mode:0o600}); await rename(temporary,path); return {patched:name};
  }
}
