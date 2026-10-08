import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { THAI_RAG_CANCEL_CAPABILITY, THAI_RAG_CANCEL_CONTRACT_FINGERPRINT } from '@unified-mpc/thai-rag';
import { NativeThaiRagProviderDriver } from './native-thai-rag-provider.js';

const WS='14fc20d1-5836-4faf-aed6-0df6a9633a38';
const OTHER='ee83c457-0b79-49d7-937e-5c35aa91975d';
const fixture=fileURLToPath(new URL('./fixtures/native-thai-rag-private-worker.mjs',import.meta.url));
const scratch:string[]=[];
async function tmp(){const p=await mkdtemp(path.join(os.tmpdir(),'native-thai-rag-strict-'));scratch.push(p);return p;}
afterEach(async()=>{await Promise.all(scratch.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
function handshake():Record<string,unknown>{
 return {
  provider_id:'thai-rag',provider_version:'0.1.0',contract_version:'1.0',
  compatibility_range:{min:'1.0',max:'1.x'},contract_fingerprint:THAI_RAG_CANCEL_CONTRACT_FINGERPRINT,
  index_job_contract_version:'1.1',
  capabilities:['remember','recall','record_event','forget','pre_edit_context','code_search','code_context',
   'code_blast_radius','code_index','index_status','health','version',THAI_RAG_CANCEL_CAPABILITY],
  workspace_scope_model:'explicit_workspace_id',state:'ready',workspace_ready:true,embedding_index_generation:1,
  components:{worker_reachable:true,sqlite_available:true,fts_available:true,vector_store_available:true,
   embedder_available:true,lexical_retrieval_available:true,semantic_retrieval_available:true,active_jobs:[]},
  embedding:{profile:'nomic-embed-text-v2-moe',
   model:'nomic-embed-text-v2-moe@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
   dimension:768,preprocessing_version:'1'},
  generation:{contract:THAI_RAG_CANCEL_CONTRACT_FINGERPRINT,embedding:'nomic-embed-text-v2-moe',index:'1',storage:'sqlite'},
 };
}
function lines(contents:string):Array<{pid:number;name:string;workspaceId:string|null;valid:boolean}>{
 return contents.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as {pid:number;name:string;workspaceId:string|null;valid:boolean});
}
function startOptions(dataRoot:string){
 return {providerRoot:path.join(dataRoot,'thai-rag'),ownerId:'unified-private-worker',
  providerVersion:'4.61.0',embeddingIndexGeneration:1};
}
describe('NativeThaiRagProviderDriver strict worker authority opt-in',()=>{
 it('rejects conflicting legacy client factory and strict authority without spawning',async()=>{
  const dataRoot=await tmp(),root=await tmp();
  expect(()=>new NativeThaiRagProviderDriver({
   dataRoot,launchConfig:{command:process.execPath},workspacesProvider:async()=>[{id:WS,realRootPath:root}],
   strictWorkerAuthority:true,clientFactory:{connect:async()=>{throw Error('unsafe');}},
  })).toThrow('native_thai_rag_strict_factory_conflict');
 });

 it('starts a real FD3 worker, attests recall, and refuses unknown/unregistered workspace before IPC',async()=>{
  const dataRoot=await tmp(),root=await tmp(),trace=path.join(dataRoot,'trace.jsonl');
  await writeFile(trace,'');
  let active=true;
  const driver=new NativeThaiRagProviderDriver({
   dataRoot,strictWorkerAuthority:true,launchConfig:{
    command:process.execPath,args:[fixture],
    env:{NATIVE_RAG_FIXTURE_HANDSHAKE_B64:Buffer.from(JSON.stringify(handshake())).toString('base64url'),
     NATIVE_RAG_FIXTURE_TRACE:trace}},
   workspacesProvider:async()=>active?[{id:WS,realRootPath:root}]:[],
  });
  try{
   const started=await driver.start(startOptions(dataRoot));
   expect(started.ok).toBe(true);
   if(!started.ok)throw Error('strict worker failed to start: '+started.error.message);
   await expect(driver.call('recall',{workspace_id:WS,query:'verified'})).resolves.toMatchObject({ok:true});
   await expect(driver.call('recall',{workspace_id:OTHER,query:'forged'})).resolves.toMatchObject({ok:false});
   active=false;
   await expect(driver.call('recall',{workspace_id:WS,query:'revoked'})).resolves.toMatchObject({ok:false});
  } finally {await driver.stop();}
  const events=lines(await readFile(trace,'utf8'));
  expect(events.filter(x=>x.name==='recall')).toHaveLength(1);
  expect(events.filter(x=>x.name==='recall')).toEqual([expect.objectContaining({workspaceId:WS,valid:true})]);
  expect(events.filter(x=>x.name==='version'||x.name==='health').every(x=>x.valid)).toBe(true);
 },25_000);

 it('protects background admission index via a SECOND private FD3 worker session',async()=>{
  const dataRoot=await tmp(),root=await tmp(),trace=path.join(dataRoot,'trace.jsonl');
  await writeFile(trace,'');
  const driver=new NativeThaiRagProviderDriver({
   dataRoot,strictWorkerAuthority:true,indexJobPollMs:10,
   launchConfig:{command:process.execPath,args:[fixture],
    env:{NATIVE_RAG_FIXTURE_HANDSHAKE_B64:Buffer.from(JSON.stringify(handshake())).toString('base64url'),
     NATIVE_RAG_FIXTURE_TRACE:trace}},
   workspacesProvider:async()=>[{id:WS,realRootPath:root}],
  });
  try{
   const started=await driver.start(startOptions(dataRoot));
   expect(started.ok).toBe(true);
   if(!started.ok)throw Error(started.error.message);
   await driver.call('pre_edit_context',{workspace_id:WS,file_path:'src/a.ts'});
   await expect.poll(async()=>lines(await readFile(trace,'utf8'))
    .filter(e=>e.name==='code_index'||e.name==='index_status').length,{timeout:8_000}).toBeGreaterThan(0);
   await expect(driver.call('recall',{workspace_id:WS,query:'other'})).resolves.toMatchObject({ok:true});
  } finally {await driver.stop();}
  const events=lines(await readFile(trace,'utf8'));
  expect(events.find(e=>e.name==='code_index')).toMatchObject({workspaceId:WS,valid:true});
  const codeWorker=events.find(e=>e.name==='code_index')?.pid;
  const callWorker=events.find(e=>e.name==='recall')?.pid;
  expect(codeWorker).toBeGreaterThan(0);
  expect(callWorker).toBeGreaterThan(0);
  expect(codeWorker).not.toBe(callWorker);
  expect(events.filter(e=>e.name==='index_status'||e.name==='cancel_index').every(e=>e.valid)).toBe(true);
 },35_000);
});
