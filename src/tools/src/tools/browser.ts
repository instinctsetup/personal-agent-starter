import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir, chmod, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Turndown from 'turndown';
export class BrowserTools {
  private context?:BrowserContext; private page?:Page; private lastAction=0;
  constructor(private readonly allowedOrigins:string[], private readonly headless=false) {}
  private check(url:string) { const parsed=new URL(url); if(!['https:','http:'].includes(parsed.protocol)||!this.allowedOrigins.includes(parsed.origin)) throw new Error(`Origin not allowed: ${parsed.origin}`); }
  private async pace() { const delay=Math.max(0,1500-(Date.now()-this.lastAction)); if(delay) await new Promise(r=>setTimeout(r,delay)); this.lastAction=Date.now(); }
  async start() {
    const directory=resolve('.browser_profiles/default'); await mkdir(directory,{recursive:true,mode:0o700}); await chmod(directory,0o700);
    this.context=await chromium.launchPersistentContext(directory,{headless:this.headless,acceptDownloads:false});
    await this.context.route('**/*',async route=>{const request=route.request(); if(request.isNavigationRequest()&&request.frame()===request.frame().page().mainFrame()) {try{this.check(request.url());}catch{await route.abort();return;}} await route.continue();});
    this.page=this.context.pages()[0]??await this.context.newPage(); this.page.setDefaultTimeout(15000);
  }
  private active() { if(!this.page) throw new Error('Start browser first'); this.check(this.page.url()); return this.page; }
  async navigate_url(url:string) { this.check(url); await this.pace(); if(!this.page) throw new Error('Start browser first'); await this.page.goto(url,{waitUntil:'domcontentloaded'}); this.check(this.page.url()); return {url:this.page.url(),title:await this.page.title()}; }
  async fill_input(selector:string,value:string) { await this.pace(); await this.active().locator(selector).fill(value); return {filled:true}; }
  async click_element(selector:string) { await this.pace(); await this.active().locator(selector).click(); return {clicked:true,url:this.page!.url()}; }
  async extract_markdown() { const html=await this.active().locator('body').innerHTML(); return new Turndown().turndown(html).slice(0,24000); }
  async take_screenshot() { await mkdir('artifacts',{recursive:true,mode:0o700}); const path=`artifacts/screenshot-${Date.now()}.png`; await this.active().screenshot({path,fullPage:true}); await chmod(path,0o600); return {path}; }
  async save_storage_state() { if(!this.context) throw new Error('Start browser first'); await mkdir('playwright/.auth',{recursive:true,mode:0o700}); await this.context.storageState({path:'playwright/.auth/state.json',indexedDB:true}); await chmod('playwright/.auth/state.json',0o600); return {saved:true}; }
  async load_storage_state() {
    // Restore at launch into a fresh context. localStorage is restored by Playwright,
    // not injected globally with an init script that might leak to another origin.
    const state=JSON.parse(await readFile('playwright/.auth/state.json','utf8'));
    for(const origin of state.origins??[]) this.check(origin.origin);
    await this.close(); const directory=resolve('.browser_profiles/default'); await mkdir(directory,{recursive:true,mode:0o700});
    // Persistent contexts do not accept storageState. Import only same-origin data.
    await this.start(); await this.context!.addCookies(state.cookies??[]);
    for(const origin of state.origins??[]) {await this.navigate_url(origin.origin); await this.page!.evaluate((items:Array<{name:string;value:string}>)=>{for(const item of items) localStorage.setItem(item.name,item.value);},origin.localStorage??[]);}
    return {restored:true,indexedDB:'Not restored by this import; use the persistent profile for IndexedDB sessions'};
  }
  async login_to_site(options:{url:string;userSelector:string;passwordSelector:string;submitSelector:string;successSelector:string;challengeSelector?:string}, manual:(message:string)=>Promise<void>) {
    if(this.headless) throw new Error('Interactive login requires BROWSER_HEADLESS=false; restart headful');
    await this.navigate_url(options.url);
    const user=process.env.SITE_USER,password=process.env.SITE_PASSWORD;
    if(user&&password) {await this.fill_input(options.userSelector,user);await this.fill_input(options.passwordSelector,password);await this.click_element(options.submitSelector);}
    // Always require manual inspection. Detection alone is unreliable for MFA.
    const challenge=options.challengeSelector&&await this.active().locator(options.challengeSelector).isVisible().catch(()=>false);
    await manual(challenge?'Complete the visible challenge in the browser. No CAPTCHA bypass is attempted.':'Review the login in the browser and complete any login, OTP or CAPTCHA step.');
    await this.active().locator(options.successSelector).waitFor({state:'visible',timeout:120000}); return this.save_storage_state();
  }
  async close() {await this.context?.close();this.context=undefined;this.page=undefined;}
}
