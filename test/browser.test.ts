import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserTools} from '../src/tools/browser.js';
test('real Chromium navigation, forms, extraction, screenshot and cookie/localStorage restore',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agent-browser-')),cwd=process.cwd();
 const server=createServer((_,response)=>response.end('<h1>Browser fixture</h1><input id="name"><button onclick="document.querySelector(\'h1\').textContent=document.querySelector(\'input\').value;localStorage.setItem(\'demo\',\'saved\');document.cookie=\'session=demo;path=/\'">Save</button>'));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;process.chdir(dir);const browser=new BrowserTools([origin],true);
 try{await browser.start();await browser.navigate_url(origin);await browser.fill_input('#name','Hello test');await browser.click_element('button');assert.match(await browser.extract_markdown(),/Hello test/);assert.ok((await browser.take_screenshot()).path);await browser.save_storage_state();await browser.load_storage_state();await browser.navigate_url(origin);assert.match(await browser.extract_markdown(),/Browser fixture/);await assert.rejects(browser.navigate_url('https://not-allowed.example'));await assert.rejects(browser.login_to_site({url:origin,userSelector:'input',passwordSelector:'input',submitSelector:'button',successSelector:'h1'},async()=>{}),/headful/);}finally{await browser.close();process.chdir(cwd);server.close();await rm(dir,{recursive:true,force:true});}
});
