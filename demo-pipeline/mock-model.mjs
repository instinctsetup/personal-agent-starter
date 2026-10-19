// Demo-only mock model. Ollama-compatible /api/chat on 127.0.0.1:8090.
// Returns scripted JSON decisions per goal so the video shows real CLI runs
// without spending real tokens. Clearly disclosed on title cards.
import http from 'node:http';
const counts = new Map(); // goal-key -> assistant decisions so far
function key(goal){ return Object.keys(scripts).find(k=>goal.includes(k)); }
const R=(observation,next)=>({type:'reflect',observation,next});
const scripts = {
 'hello.txt': [
   {type:'plan',steps:['Draft a friendly greeting','Write hello.txt in the workspace']},
   {type:'tool',tool:'file_create',args:{path:'hello.txt',content:'Hello! Hope your day is going well.\n'},reason:'Write the greeting file the user asked for'},
   {type:'done',message:'Created hello.txt with a friendly greeting in the workspace.'}],
 'example.com and summarize': [
   {type:'tool',tool:'web_fetch',args:{url:'https://example.com'},reason:'Fetch the exact page the user named'},
   {type:'done',message:'Summary: example.com is the IANA example domain - one short page stating it is reserved for illustrative examples in documentation.'}],
 'concise weekly': [
   {type:'tool',tool:'memory_remember',args:{text:'User prefers concise weekly summaries.'},reason:'Save the explicit, non-secret preference the user stated'},
   {type:'done',message:'Saved. I will keep weekly summaries concise.'}],
 'writing style': [
   {type:'tool',tool:'memory_recall',args:{query:'writing style preference'},reason:'Check explicit saved notes before answering'},
   {type:'done',message:'From your saved notes: you prefer concise weekly summaries.'}],
 'greeting file': [
   {type:'tool',tool:'git_init',args:{},reason:'Initialize the workspace repository'},
   {type:'tool',tool:'git_commit',args:{files:['hello.txt'],message:'feat: add friendly greeting file'},reason:'Commit the greeting file the user named'},
   {type:'done',message:'Initialized git in the workspace and committed hello.txt.'}],
 'workspace files': [
   {type:'tool',tool:'run_command',args:{command:'ls',args:['-la']},reason:'List the workspace files exactly as asked'},
   {type:'done',message:'Listed the workspace files with the approved command.'}],
 'hello plugin': [
   {type:'tool',tool:'plugin_hello',args:{name:'the team'},reason:'The user explicitly asked for the hello plugin'},
   {type:'done',message:'The hello plugin greeted the team.'}],
 'in the browser': [
   {type:'tool',tool:'browser_start',args:{},reason:'Start the local browser'},
   {type:'tool',tool:'navigate_url',args:{url:'https://example.com'},reason:'Open the allowed page the user named'},
   {type:'tool',tool:'extract_markdown',args:{},reason:'Read the page text'},
   {type:'done',message:'Opened https://example.com in the browser and read it: the IANA example domain page.'}],
 'focus note': [
   {type:'tool',tool:'file_create',args:{path:'focus.txt',content:"Today's focus: finish and review the demo video.\n"},reason:'Write the focus note file'},
   {type:'done',message:"Wrote today's focus note to focus.txt."}],
 'Send mail to': [
   {type:'tool',tool:'mail_send',args:{to:'sam@example.com',subject:'Report ships Friday',text:'Hi Sam,\n\nThe report ships Friday.\n\nBest,\nMahesh'},reason:'Send the exact message the user dictated'},
   {type:'reflect',observation:'The SMTP send failed: the demo credentials are placeholders and no real server answered.',next:'Report the honest outcome and how to make live sending work'},
   {type:'done',message:'The draft was approved exactly as shown, but sending failed: demo SMTP settings are placeholders. Run "npm start -- connect email" with a real Gmail app password to send for real.'}],
 'Long research': 'LONG',
};
const srv = http.createServer((req,res)=>{
  if(req.method==='POST' && req.url==='/api/chat'){
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      const {messages=[]}=JSON.parse(b||'{}');
      const sys=messages.find(m=>m.role==='system')?.content||'';
      let out;
      if(sys.includes('Summarize the conversation excerpt')){
        out='Goal: review all queued source batches.\nFacts learned: batches 1-38 contained routine status text.\nActions done: each batch reviewed and logged.\nOpen items: none.';
      } else {
        const gm=sys.match(/Original user goal \(data\): ([\s\S]*?)$/);
        const goal=(gm?gm[1]:'').slice(0,500);
        const k=key(goal);
        if(!k){ out=JSON.stringify({type:'done',message:'Nothing to do.'}); }
        else if(scripts[k]==='LONG'){
          const n=(counts.get(k)||0);
          counts.set(k,n+1);
          if(n===20) out=JSON.stringify({type:'pause',message:'Pausing after 20 review steps for a checkpoint. Resume when ready.'});
          else if(n>=39) out=JSON.stringify({type:'done',message:'Reviewed all queued sources; nothing required action.'});
          else out=JSON.stringify(R(`Batch ${n+1}: routine status text, nothing actionable.`,`Continue with batch ${n+2}`));
        }
        else {
          const n=(counts.get(k)||0);
          counts.set(k,n+1);
          out=JSON.stringify(scripts[k][Math.min(n,scripts[k].length-1)]);
        }
      }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({message:{role:'assistant',content:out},done:true}));
    });
  } else {res.writeHead(404);res.end();}
});
srv.listen(8090,'127.0.0.1',()=>console.log('mock model on 127.0.0.1:8090'));
