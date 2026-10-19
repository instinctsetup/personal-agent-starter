import type {Memory} from './db.js';
export interface Embedder {id:string;embed(text:string):Promise<number[]>}
function valid(v:unknown):v is number[]{return Array.isArray(v)&&v.length>0&&v.length<=65536&&v.every(x=>typeof x==='number'&&Number.isFinite(x))&&v.some(x=>x!==0);}
export function cosine(a:number[],b:number[]){if(!valid(a)||!valid(b)||a.length!==b.length)throw new Error('Invalid or incompatible vectors');let dot=0,aa=0,bb=0;for(let i=0;i<a.length;i++){dot+=a[i]!*b[i]!;aa+=a[i]!**2;bb+=b[i]!**2;}return dot/Math.sqrt(aa*bb);}
export class OllamaEmbeddings implements Embedder {
  readonly id:string;
  constructor(private model=process.env.EMBEDDING_MODEL??'nomic-embed-text',private base=process.env.EMBEDDING_BASE_URL??'http://127.0.0.1:11434'){this.id=`ollama:${base}:${model}`;}
  async embed(text:string){const response=await fetch(this.base.replace(/\/$/,'')+'/api/embed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:this.model,input:text}),signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error('Embedding request failed');const data=await response.json() as any;const vector=data.embeddings?.[0];if(!valid(vector))throw new Error('Invalid embedding');return vector;}
}
export class VectorMemory {
  constructor(private memory:Memory,private provider:Embedder){memory.db.exec('CREATE TABLE IF NOT EXISTS vectors(note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,provider TEXT NOT NULL,vector TEXT NOT NULL)');}
  async remember(text:string){if(!text.trim()||text.length>10000)throw new Error('Invalid note');const vector=await this.provider.embed(text);if(!valid(vector))throw new Error('Invalid embedding');const id=this.memory.remember(text);try{this.memory.db.prepare('INSERT INTO vectors VALUES(?,?,?)').run(id,this.provider.id,JSON.stringify(vector));return id;}catch(e){this.memory.forget(id);throw e;}}
  async recall(query:string,limit=8){if(!query.trim()||query.length>500||!Number.isInteger(limit)||limit<1||limit>20)throw new Error('Invalid search');const vector=await this.provider.embed(query);if(!valid(vector))throw new Error('Invalid embedding');return this.memory.db.prepare('SELECT notes.id,notes.text,vectors.vector FROM vectors JOIN notes ON notes.id=vectors.note_id WHERE provider=?').all(this.provider.id).map(row=>({id:String(row.id),text:String(row.text),score:cosine(vector,JSON.parse(String(row.vector)))})).sort((a,b)=>b.score-a.score).slice(0,limit);}
}
