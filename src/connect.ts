import {readFile,writeFile,chmod} from 'node:fs/promises';
import nodemailer from 'nodemailer';
import {spawnSync} from 'node:child_process';
// Conversational guided setup: "npm start -- connect email|telegram|slack".
// Secrets are typed with hidden input, written only to the local .env (mode 600), never logged or echoed.
export type IO={ask:(q:string)=>Promise<string>;askHidden:(q:string)=>Promise<string>;print:(s:string)=>void};
export type Deps={sendTest?:(cfg:SmtpCfg,to:string)=>Promise<unknown>;verifyTelegram?:(token:string)=>Promise<string>};
export type SmtpCfg={host:string;port:number;user:string;pass:string;from:string};

// Update KEY=VALUE lines in place (or append), never printing values. Returns the keys changed.
export async function updateEnv(path:string,pairs:Record<string,string>):Promise<string[]>{
  let text:string;
  try{text=await readFile(path,'utf8');}catch{
    try{text=await readFile('.env.example','utf8');}catch{text='';}
  }
  const changed:string[]=[];
  for(const [key,value] of Object.entries(pairs)){
    if(!/^[\w]+$/.test(key))throw new Error('Invalid env key');
    const line=`${key}=${value}`;
    const rx=new RegExp(`^#?\\s*${key}=.*$`,'m');
    if(rx.test(text))text=text.replace(rx,line);else text+=(text.endsWith('\n')||!text?'':'\n')+line+'\n';
    changed.push(key);
  }
  await writeFile(path,text,{mode:0o600});
  await chmod(path,0o600);
  return changed;
}

// Line reader with local echo control. On a TTY it uses the terminal's raw mode via
// process.stdin.setRawMode (the supported API: external tools like stty get reverted when
// the stream resumes) and echoes visible input itself or masks it with '*'. On piped stdin
// it reads one line plainly. Independent of any readline interface - close or pause those first.
async function readRaw(prompt:string,hidden:boolean):Promise<string>{
  const stdin=process.stdin,stdout=process.stdout;
  if(!stdin.isTTY){
    stdout.write(prompt);
    return await new Promise<string>(r=>{let s='';const on=(b:Buffer)=>{const t=b.toString('utf8');const i=t.indexOf('\n');if(i>=0){s+=t.slice(0,i);stdin.off('data',on);r(s.trim());}else s+=t;};stdin.on('data',on);stdin.resume();});
  }
  // Raw mode BEFORE writing the prompt, so kernel echo can never race the first typed characters.
  const wasRaw=(stdin as unknown as {isRaw?:boolean}).isRaw??false;
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(prompt);
  return await new Promise(resolve=>{
    let out='';
    const cleanup=()=>{stdin.off('data',onData);stdin.setRawMode(wasRaw);};
    const onData=(b:Buffer)=>{
      for(const ch of b.toString('utf8')){
        if(ch==='\r'||ch==='\n'){cleanup();stdout.write('\n');resolve(out);return;}
        if(ch==='\u0003'){cleanup();stdout.write('\n');process.exit(130);}
        if(ch==='\u007F'||ch==='\b'){if(out){out=out.slice(0,-1);if(!hidden)stdout.write('\b \b');}continue;}
        if(ch<' ')continue;
        out+=ch;stdout.write(hidden?'*':ch);
      }
    };
    stdin.on('data',onData);
  });
}
export const readVisible=(q:string)=>readRaw(q,false);
export const readHidden=(q:string)=>readRaw(q,true);

async function defaultSendTest(cfg:SmtpCfg,to:string){
  const transport=nodemailer.createTransport({host:cfg.host,port:cfg.port,secure:cfg.port===465,requireTLS:cfg.port!==465,auth:{user:cfg.user,pass:cfg.pass},connectionTimeout:15000,logger:false,debug:false});
  try{return await transport.sendMail({from:cfg.from,to,subject:'Personal agent: email connected',text:'Your personal-agent-starter email setup works. You can now say: send mail to someone@example.com saying ...',disableFileAccess:true,disableUrlAccess:true});}
  finally{transport.close();}
}
async function defaultVerifyTelegram(token:string):Promise<string>{
  const res=await fetch(`https://api.telegram.org/bot${token}/getMe`,{signal:AbortSignal.timeout(10000)});
  const data=await res.json() as any;
  if(!data?.ok)throw new Error('Telegram rejected the token');
  return String(data.result?.username??'');
}

export async function connectEmail(io:IO,envPath='.env',deps:Deps={}):Promise<void>{
  io.print('Email setup (SMTP send). Values are stored locally in .env (600). Nothing you type as a secret is shown or logged.');
  const user=(await io.ask('Gmail/SMTP address: ')).trim();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user))throw new Error('That does not look like an email address');
  const pass=await io.askHidden('App password (hidden; for Gmail: Google Account -> Security -> 2-Step Verification -> App passwords): ');
  if(!pass)throw new Error('Empty password; nothing changed');
  const host=(await io.ask('SMTP host (smtp.gmail.com): ')).trim()||'smtp.gmail.com';
  if(!/^[\w.-]+$/.test(host))throw new Error('Invalid host');
  const port=Number((await io.ask('SMTP port (465): ')).trim()||'465');
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid port');
  const changed=await updateEnv(envPath,{SMTP_HOST:host,SMTP_PORT:String(port),SMTP_USER:user,SMTP_PASSWORD:pass,MAIL_FROM:user});
  io.print(`Saved ${changed.join(', ')} to ${envPath} (mode 600). Password written to disk only, never displayed.`);
  const send=deps.sendTest??defaultSendTest;
  if((await io.ask('Send a test mail to yourself now? Type yes: '))==='yes'){
    io.print('Sending test mail...');
    await send({host,port,user,pass,from:user},user);
    io.print('Test mail sent. Check your inbox. Plain-English sending now works: run "Send mail to NAME saying ..." and approve the exact send.');
  }else io.print('Skipped test mail. Run "npm start -- connect email" again any time.');
}

export async function connectTelegram(io:IO,envPath='.env',deps:Deps={}):Promise<void>{
  io.print('Telegram bot setup. Create a bot with @BotFather first. The token is stored locally only.');
  const token=await io.askHidden('Bot token (hidden): ');
  if(!token)throw new Error('Empty token; nothing changed');
  const verify=deps.verifyTelegram??defaultVerifyTelegram;
  let username='';
  try{username=await verify(token);io.print(`Token works. Bot: @${username}`);}catch{io.print('Could not verify the token (network or invalid token); saving anyway - test with the daemon bot hooks.');}
  const chat=(await io.ask('Your chat ID to allow (from @userinfobot): ')).trim();
  if(!/^\d+$/.test(chat))throw new Error('Numeric chat ID required');
  const changed=await updateEnv(envPath,{TELEGRAM_BOT_TOKEN:token,TELEGRAM_ALLOWED_CHATS:chat,TELEGRAM_ALLOWED_USERS:chat});
  io.print(`Saved ${changed.join(', ')} to ${envPath} (mode 600). Enable inbound hooks with BOT_HOOKS=true plus TELEGRAM_WEBHOOK_SECRET and your own HTTPS proxy.`);
}

export async function connectSlack(io:IO,envPath='.env'):Promise<void>{
  io.print('Slack app setup. Signing secret is stored locally only. Live event delivery is not tested here.');
  const secret=await io.askHidden('Signing secret (hidden): ');
  if(!secret)throw new Error('Empty secret; nothing changed');
  const team=(await io.ask('Team ID (T...): ')).trim();
  const channel=(await io.ask('Channel ID to allow (C...): ')).trim();
  const userId=(await io.ask('Your user ID to allow (U...): ')).trim();
  if(!/^T\w+$/.test(team)||!/^C\w+$/.test(channel)||!/^U\w+$/.test(userId))throw new Error('IDs look like T..., C..., U...');
  const changed=await updateEnv(envPath,{SLACK_SIGNING_SECRET:secret,SLACK_TEAM_ID:team,SLACK_ALLOWED_CHANNELS:channel,SLACK_ALLOWED_USERS:userId});
  io.print(`Saved ${changed.join(', ')} to ${envPath} (mode 600). Enable with BOT_HOOKS=true and point your Slack app events at your own HTTPS proxy.`);
}
