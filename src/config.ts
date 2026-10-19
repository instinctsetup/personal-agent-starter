export function checkConfig(env:Record<string,string|undefined>):{level:'error'|'warn'|'ok';message:string}[]{
  const r:{level:'error'|'warn'|'ok';message:string}[]=[];
  const p=env.MODEL_PROVIDER??'ollama';
  if(!['openai','openrouter','anthropic','ollama'].includes(p))r.push({level:'error',message:`MODEL_PROVIDER "${p}" is not supported`});
  if(!env.MODEL_NAME)r.push({level:'error',message:'MODEL_NAME is not set'});
  if(p!=='ollama'&&!env.MODEL_API_KEY)r.push({level:'error',message:`MODEL_API_KEY is required for ${p}`});
  if(env.BOT_HOOKS==='true'&&!(env.TELEGRAM_WEBHOOK_SECRET||env.SLACK_SIGNING_SECRET))r.push({level:'error',message:'BOT_HOOKS=true needs a Telegram secret or Slack signing secret'});
  if(env.ENABLE_COMMAND_RUNNER==='true')r.push({level:'warn',message:'Command runner is ON: approved commands run with your user permissions (not a sandbox)'});
  if(env.ENABLE_PLUGINS==='true'){if(!env.PLUGIN_DIR)r.push({level:'error',message:'ENABLE_PLUGINS=true needs PLUGIN_DIR'});else r.push({level:'warn',message:'Plugins are ON: plugin code runs with your user permissions'});}
  if(env.WEB_SEARCH_URL&&!/^https:\/\//.test(env.WEB_SEARCH_URL))r.push({level:'warn',message:'WEB_SEARCH_URL should be https'});
  if(!r.some(x=>x.level==='error'))r.push({level:'ok',message:'No configuration errors found (nothing was sent over the network)'});
  return r;
}
