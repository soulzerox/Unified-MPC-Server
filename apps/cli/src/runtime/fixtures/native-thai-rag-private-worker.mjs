import { appendFileSync, readFileSync } from 'node:fs';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';

const envelope = JSON.parse(readFileSync(3, 'utf8'));
const key = Buffer.from(envelope.secret_b64url, 'base64url');
const handshake = JSON.parse(Buffer.from(process.env.NATIVE_RAG_FIXTURE_HANDSHAKE_B64, 'base64url').toString('utf8'));
const tracePath = process.env.NATIVE_RAG_FIXTURE_TRACE;
if (process.env.THAI_RAG_EXTERNAL_AUTH_MODE !== 'strict'
 || process.env.THAI_RAG_EXTERNAL_AUTH_FD !== '3'
 || !tracePath || process.argv.some(x => x.includes(envelope.secret_b64url))
 || Object.values(process.env).some(x => x?.includes(envelope.secret_b64url))) process.exit(73);
const nonceSet = new Set();
const tools = ['remember', 'remember_turn', 'recall', 'record_event', 'forget', 'pre_edit_context',
 'code_search', 'code_context', 'code_blast_radius', 'code_index', 'adopt_legacy_index',
 'index_status', 'cancel_index', 'health', 'version', 'memory_reconcile', 'code_reconcile', 'worker_authority_probe'];
function verify(name, args) {
 const proof = args.authority_proof;
 if (typeof proof !== 'string' || !args.workspace_id) return false;
 const parts = proof.split('.');
 if (parts.length !== 2) return false;
 const bytes = Buffer.from(parts[0], 'base64url');
 const sig = Buffer.from(parts[1], 'base64url');
 const expected = createHmac('sha256', key).update('thai-rag-external-workspace-authority-v1\0')
  .update(bytes).digest();
 if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return false;
 let claims;
 try { claims = JSON.parse(bytes.toString('utf8')); } catch { return false; }
 const registeredRoot = envelope.workspace_roots[args.workspace_id];
 const now = Math.floor(Date.now()/1000);
 if (!registeredRoot || claims.workspace_id !== args.workspace_id || claims.operation !== name
  || claims.owner_id !== envelope.owner_id || claims.authority_generation !== envelope.authority_generation
  || claims.root_fingerprint !== 'sha256:'+createHash('sha256').update(registeredRoot).digest('hex')
  || typeof claims.nonce !== 'string' || nonceSet.has(claims.nonce)
  || claims.issued_at > now || claims.expires_at < now || claims.expires_at - claims.issued_at > 60) return false;
 nonceSet.add(claims.nonce);
 return true;
}
function respond(id, result) {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');}
for await (const line of createInterface({input:process.stdin})) {
 const msg=JSON.parse(line);
 if(msg.id===undefined)continue;
 if(msg.method==='initialize') {
  respond(msg.id,{protocolVersion:msg.params?.protocolVersion??'2025-06-18',
   capabilities:{tools:{}},serverInfo:{name:'strict-native-rag-test',version:'1.0.0'}});continue;
 }
 if(msg.method==='tools/list') {respond(msg.id,{tools:tools.map(name=>({name,inputSchema:{type:'object',additionalProperties:true}}))});continue;}
 if(msg.method==='resources/list') {respond(msg.id,{resources:[]});continue;}
 if(msg.method==='tools/call') {
  const name=msg.params.name,args=msg.params.arguments??{};
  if (name === 'worker_authority_probe') {
    const challenge = args.challenge;
    const raw = Buffer.from(challenge, 'base64url');
    const material = Buffer.concat([
      Buffer.from('thai-rag-worker-fd3-challenge-v1'), Buffer.from([0]), raw,
      Buffer.from([0]), Buffer.from(envelope.owner_id), Buffer.from([0]),
      Buffer.from(String(envelope.authority_generation)),
    ]);
    const reply = { status: 'ok', strict_mode: true, challenge,
      owner_id: envelope.owner_id, authority_generation: envelope.authority_generation,
      proof: createHmac('sha256', key).update(material).digest('base64url') };
    respond(msg.id, {content:[{type:'text',text:JSON.stringify(reply)}], structuredContent:reply});
    continue;
  }
  const valid=(name==='health'||name==='version')
   ? !Object.hasOwn(args,'authority_proof') : verify(name,args);
  appendFileSync(tracePath,JSON.stringify({pid:process.pid,name,workspaceId:args.workspace_id??null,valid})+'\n');
  let data;
  if(name==='health'||name==='version') data=handshake;
  else if(name==='code_index') data={status:'running',job_id:'idx_private_worker_1',workspace_id:args.workspace_id};
  else if(name==='index_status') data={status:'done',job_id:'idx_private_worker_1',workspace_id:args.workspace_id,result:{status:'complete',indexed:1}};
  else if(name==='cancel_index') data={status:'cancelled',job_id:args.job_id};
  else data={status:'ok',value:name};
  respond(msg.id,{content:[{type:'text',text:valid?'ok':'denied'}],structuredContent:{result:name,data:valid?data:{error:'invalid-proof'}},isError:!valid});
  continue;
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'not found'}})+'\n');
}
