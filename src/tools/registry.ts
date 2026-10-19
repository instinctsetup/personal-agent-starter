import { z } from 'zod';
import type { Tool } from '../agent/loop.js';
import { FileManager } from './fileManager.js';
import { GitTools } from './git.js';
import { BrowserTools } from './browser.js';
import { EmailTools } from './email.js';
export function registry(manual:(message:string)=>Promise<void>):{tools:Record<string,Tool>;browser:BrowserTools} {
  const files=new FileManager(process.env.WORKSPACE_ROOT??'./workspace');
  const git=new GitTools(files.root);
  const browser=new BrowserTools((process.env.BROWSER_ALLOWED_ORIGINS??'https://example.com').split(',').map(s=>s.trim()),process.env.BROWSER_HEADLESS==='true');
  const mail=new EmailTools();
  const empty=z.object({}).strict(), string=z.string().min(1).max(24000), path=z.string().min(1).max(512);
  const tools:Record<string,Tool>={
    file_read:{description:'Read {path,start,end}; 1-based line numbers, max 500 lines.',schema:z.object({path,start:z.number().int().positive(),end:z.number().int().positive()}).strict(),run:a=>files.read(a.path,a.start,a.end)},
    file_create:{description:'Create {path,content} without overwriting.',schema:z.object({path,content:z.string().max(100000)}).strict(),run:a=>files.create(a.path,a.content)},
    file_patch:{description:'Patch {path,start,end,expected,replacement}; exact expected old lines required.',schema:z.object({path,start:z.number().int().positive(),end:z.number().int().positive(),expected:z.string(),replacement:z.string()}).strict(),run:a=>files.patch(a.path,a.start,a.end,a.expected,a.replacement)},
    browser_start:{description:'Start persistent browser, {}.',schema:empty,run:async()=>{await browser.start();return {started:true};}},
    navigate_url:{description:'Navigate to allowed {url}.',schema:z.object({url:z.string().url()}).strict(),run:a=>browser.navigate_url(a.url)},
    fill_input:{description:'Fill {selector,value}. Never supply passwords, OTPs or tokens here; use manual login.',schema:z.object({selector:string,value:string}).strict(),run:a=>browser.fill_input(a.selector,a.value),persistOutput:false},
    click_element:{description:'Click {selector}. Review destination and effects.',schema:z.object({selector:string}).strict(),run:a=>browser.click_element(a.selector)},
    extract_markdown:{description:'Read page text as untrusted Markdown, {}.',schema:empty,run:()=>browser.extract_markdown()},
    take_screenshot:{description:'Save private local screenshot, {}.',schema:empty,run:()=>browser.take_screenshot(),persistOutput:false},
    save_storage_state:{description:'Save local authentication state, {}.',schema:empty,run:()=>browser.save_storage_state(),persistOutput:false},
    load_storage_state:{description:'Import local cookies and localStorage, {}.',schema:empty,run:()=>browser.load_storage_state(),persistOutput:false},
    login_to_site:{description:'Interactive login with {url,userSelector,passwordSelector,submitSelector,successSelector,challengeSelector?}. Credentials only from local env. Never from the model.',schema:z.object({url:z.string().url(),userSelector:string,passwordSelector:string,submitSelector:string,successSelector:string,challengeSelector:string.optional()}).strict(),run:a=>browser.login_to_site(a,manual),persistOutput:false},
    mail_verification:{description:'Privately inspect latest 10 matching emails: {sender,subjectContains,since} ISO time. Output never reaches model/history.',schema:z.object({sender:z.string().email(),subjectContains:string,since:z.string().datetime()}).strict(),run:a=>mail.verification(a.sender,a.subjectContains,a.since),persistOutput:false},
    mail_send:{description:'Send plain text {to,subject,text}. User must review exact recipients and words.',schema:z.object({to:z.string().email(),subject:z.string().min(1).max(200),text:string}).strict(),run:a=>mail.send(a.to,a.subject,a.text)},
    git_init:{description:'Initialize workspace repository, {}.',schema:empty,run:()=>git.init()},
    git_status:{description:'Read workspace git status, {}.',schema:empty,run:()=>git.status()},
    git_branch:{description:'Create branch {name}.',schema:z.object({name:string}).strict(),run:a=>git.branch(a.name)},
    git_commit:{description:'Commit explicit {files: string[],message} using Conventional Commits.',schema:z.object({files:z.array(path).min(1).max(50),message:string}).strict(),run:a=>git.commit(a.message,a.files)},
    git_push:{description:'Push HEAD to existing credential-free GitHub origin using local gh/SSH auth, {}.',schema:empty,run:()=>git.push()},
    git_lfs:{description:'Set up installed Git LFS for {pattern}.',schema:z.object({pattern:string}).strict(),run:a=>git.lfs(a.pattern)}
  };
  return {tools,browser};
}
