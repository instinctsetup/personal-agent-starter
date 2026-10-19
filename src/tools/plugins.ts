import {readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import type {Tool} from '../agent/loop.js';
// Plugins are local JavaScript that runs with your permissions. Load only code you wrote or reviewed.
// A plugin is an .mjs file whose default export is (z) => ({ toolName: {description, schema, run} }).
export async function loadPlugins(dir:string,existing:Record<string,Tool>):Promise<Record<string,Tool>>{
  const out:Record<string,Tool>={};
  if(!existsSync(dir))throw new Error('Plugin directory not found');
  for(const f of readdirSync(dir).filter(f=>f.endsWith('.mjs')).sort()){
    const mod=await import(pathToFileURL(resolve(dir,f)).href);
    if(typeof mod.default!=='function')throw new Error(`Plugin ${f} must default-export a function`);
    const tools=await mod.default(z);
    for(const [name,t] of Object.entries<any>(tools??{})){
      if(!/^[a-z][a-z0-9_]{1,40}$/.test(name))throw new Error(`Bad plugin tool name in ${f}`);
      const key='plugin_'+name;
      if(existing[key]||out[key])throw new Error(`Duplicate tool ${key}`);
      if(typeof t?.description!=='string'||typeof t?.run!=='function'||typeof t?.schema?.parse!=='function')throw new Error(`Plugin tool ${key} needs description, schema and run`);
      out[key]={description:'[plugin] '+t.description,schema:t.schema,run:t.run};
    }
  }
  return out;
}
