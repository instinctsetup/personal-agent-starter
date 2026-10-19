import {createInterface} from 'node:readline/promises';
import {readFile,writeFile,access} from 'node:fs/promises';
const rl=createInterface({input:process.stdin,output:process.stdout});
try{
 try{await access('.env');console.log('.env already exists. Not overwriting your settings.');process.exitCode=0;}
 catch{
  console.log('Personal Agent setup. No secrets are collected by this wizard.');
  const provider=(await rl.question('Provider [ollama/openai/openrouter/anthropic] (ollama): ')).trim()||'ollama';
  if(!['ollama','openai','openrouter','anthropic'].includes(provider))throw new Error('Unknown provider');
  const model=(await rl.question('Model name (llama3.2 for local demo): ')).trim()||'llama3.2';
  if(!/^[\w.:/-]+$/.test(model))throw new Error('Model name contains unsupported characters');
  const template=await readFile('.env.example','utf8');
  await writeFile('.env',template.replace('MODEL_PROVIDER=ollama',`MODEL_PROVIDER=${provider}`).replace('MODEL_NAME=llama3.2',`MODEL_NAME=${model}`),{flag:'wx',mode:0o600});
  console.log('Created private .env. Add any API or email credentials with your local editor, never in chat.');
  console.log('Next: npm run build; npm test; npx playwright install chromium; npm start -- run "Create a hello.txt file with a greeting"');
 }
} catch(error){console.error(error.message);process.exitCode=1;}finally{rl.close();}
