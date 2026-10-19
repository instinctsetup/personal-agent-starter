export type Message = {role:'user'|'assistant'|'system';content:string};
export interface Model { complete(messages:Message[]):Promise<string>; }
export class Router implements Model {
  async complete(messages: Message[]): Promise<string> {
    const provider = process.env.MODEL_PROVIDER ?? 'ollama';
    const defaults: Record<string,string> = {openai:'https://api.openai.com/v1',openrouter:'https://openrouter.ai/api/v1',anthropic:'https://api.anthropic.com/v1',ollama:'http://127.0.0.1:11434'};
    if (!defaults[provider]) throw new Error('Unsupported model provider');
    const base = (process.env.MODEL_BASE_URL || defaults[provider]!).replace(/\/$/,'');
    const model = process.env.MODEL_NAME; if (!model) throw new Error('MODEL_NAME is required');
    const key = process.env.MODEL_API_KEY ?? '';
    if (provider !== 'ollama' && !key) throw new Error('MODEL_API_KEY is required');
    const headers: Record<string,string> = {'Content-Type':'application/json'};
    let url: string, body: unknown;
    if (provider === 'anthropic') {
      headers['x-api-key']=key; headers['anthropic-version']='2023-06-01';
      url=base+'/messages'; body={model,max_tokens:2048,system:messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),messages:messages.filter(m=>m.role!=='system')};
    } else if (provider === 'ollama') { url=base+'/api/chat'; body={model,messages,stream:false,format:'json'}; }
    else { headers.Authorization=`Bearer ${key}`; url=base+'/chat/completions'; body={model,messages,temperature:0.2}; }
    const response = await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
    if (!response.ok) throw new Error(`Model request failed (${response.status}); response body omitted to protect secrets`);
    const data = await response.json() as any;
    const text = provider === 'anthropic' ? data.content?.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('') : provider === 'ollama' ? data.message?.content : data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('Model returned no text'); return text;
  }
}
