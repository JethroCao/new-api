import {createHash} from 'node:crypto';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,stat} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Bridge,validateConfig,createServer} from './bridge.mjs';import * as plugin from './plugin.js';
import {buildCreditPlugin} from './build-credit-plugin.mjs';
const id='11111111-1111-4111-8111-111111111111',token='retention-http-test-key-longer-than-32';const video=Buffer.from('000000186674797069736f6d0000020069736f6d','hex');
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'retention-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const cfg=validateConfig({token,dataDir:dir,cli:process.execPath,profile:'bridge',projectId:'c2679e06-fce3-4b3c-9038-3729d426c2b8',userId:'123',space:'personal',publicUrl:'http://127.0.0.1:8787',models:{'dreamina-video':{kind:'video',model:'test',ratio:'16:9',resolution:'720p',durations:[5],maxCredits:1}}});
 const bridge=await Bridge.open(cfg,async()=>{throw Error('no CLI or billing allowed')});t.after(()=>bridge.close());
 const j={id,context:bridge.contextKey,key:'a'.repeat(64),digest:'b'.repeat(64),status:'completed',created_at:10,completed_at:100000,request:{kind:'video',model:'dreamina-video',seconds:5,n:1},inputs:[],files:[{filename:id+'-0.bin',resourceId:'video',mime:'video/mp4',size:video.length}]};
 await writeFile(join(dir,j.files[0].filename),video);await bridge.save(j);
 const server=createServer(bridge);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 return {dir,bridge,j,url:'http://127.0.0.1:'+server.address().port};
}
test('expired bearer and valid signed downloads return 410 while completed metadata survives cleanup and restart',async t=>{
 const {bridge,j,dir,url}=await fixture(t);t.mock.timers.enable({apis:['Date'],now:(100000+28800)*1000});
 const content=url+'/v1/jobs/'+id+'/content/0';
 let r=await fetch(content,{headers:{Authorization:'Bearer '+token}});assert.equal(r.status,410);assert.equal((await r.json()).error.code,'artifact_expired');
 const signed=bridge.mediaURL(id,0).replace('http://127.0.0.1:8787',url);assert.equal((await fetch(signed)).status,410);
 assert.equal((await fetch(content)).status,401,'expiry is not exposed without auth');
 await bridge.cleanupMedia();await assert.rejects(stat(join(dir,j.files[0].filename)),{code:'ENOENT'});
 const meta=await (await fetch(url+'/v1/jobs/'+id,{headers:{Authorization:'Bearer '+token}})).json();assert.equal(meta.status,'completed');assert.equal(meta.content_expires_at,128800);assert.equal(meta.content_expired,true);
 assert.equal(JSON.parse(await readFile(join(dir,id+'.json'),'utf8')).status,'completed');
 await bridge.close();const reopened=await Bridge.open(bridge.config,async()=>{throw Error('must not regenerate')});t.after(()=>reopened.close());assert.equal((await reopened.loadJob(id)).status,'completed');
});
test('unexpired output remains downloadable and exposes the exact retention deadline',async t=>{
 const {bridge,j,url}=await fixture(t);t.mock.timers.enable({apis:['Date'],now:(100000+28800)*1000-1});
 const r=await fetch(url+'/v1/jobs/'+id+'/content/0',{headers:{Authorization:'Bearer '+token,Range:'bytes=0-7'}});assert.equal(r.status,206);assert.deepEqual(Buffer.from(await r.arrayBuffer()),video.subarray(0,8));
 assert.equal(bridge.get(id,j).content_expires_at,128800);assert.equal(bridge.get(id,j).content_expired,false);
});
test('historical completed jobs with submission IDs keep their files and seconds settlement without new billing proof',async t=>{
 const creditPlugin=await import('data:text/javascript;base64,'+Buffer.from(await buildCreditPlugin({models:['seedance_2.5']})).toString('base64'));
 for(const knownTerminal of [false,true])await t.test(knownTerminal?'known terminal without checksum':'old terminal without proof or checksum',async t=>{
  const {bridge,j,dir}=await fixture(t);t.mock.timers.enable({apis:['Date'],now:100001000});
  j.submitId='22222222-2222-4222-8222-222222222222';
  Object.assign(j.request,{mode:'t2v',ratio:'16:9',resolution:'720p'});
  if(knownTerminal)j.terminalOperationState='succeeded';
  await bridge.save(j);const saved=await readFile(join(dir,id+'.json'),'utf8');await bridge.close();
  const calls=[];
  const reopened=await Bridge.open(bridge.config,async args=>{calls.push(args);throw Error('historical completion must not call the CLI');});t.after(()=>reopened.close());
  const server=createServer(reopened);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const url='http://127.0.0.1:'+server.address().port+'/v1/jobs/'+id,headers={Authorization:'Bearer '+token};
  const response=await fetch(url,{headers});assert.equal(response.status,200);const receipt=await response.json();
  assert.equal(receipt.status,'completed');assert.equal(receipt.video_count,1);assert.equal(receipt.billing_mode,'legacy_seconds');
  assert.equal(receipt.terminal_proof,knownTerminal?true:undefined);assert.equal(receipt.delivery_verified,undefined);assert.equal(receipt.billing,undefined);
  const previous={id,object:'video',model:'dreamina-video',seconds:5,n:1,mode:'t2v',ratio:'16:9',resolution:'720p',status:'in_progress'};
  const poll={taskId:id,publicTaskId:'task_legacy',data:previous,state:null};
  const parsed=creditPlugin.parseTaskResult(poll,receipt,{status:200});assert.equal(parsed.status,'SUCCESS');
  assert.deepEqual(creditPlugin.extractUsageOnComplete(poll,parsed,receipt),{seconds:5});assert.equal(parsed.state?.settledCredits,undefined);
  const head=await fetch(url+'/content/0',{method:'HEAD',headers});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(video.length));
  const range=await fetch(url+'/content/0',{headers:{...headers,Range:'bytes=0-7'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),video.subarray(0,8));
  await reopened.processJob(await reopened.loadJob(id));await reopened.tick();
  assert.deepEqual(calls,[]);assert.deepEqual((await reopened.loadJob(id)).files,j.files);assert.equal(await readFile(join(dir,id+'.json'),'utf8'),saved);
 });
});
test('plugin renders expiry for new and historical completed snapshots and never changes task status',()=>{
 const d={object:'video',status:'completed',completed_at:100000,video_count:1,seconds:5};const task={status:'SUCCESS',data:d};
 const before=structuredClone(task);const rendered=plugin.protocols.openai_video.render({},task);assert.equal(rendered.content_expires_at,128800);assert.equal(rendered.content_expired,true);assert.deepEqual(task,before);
 const fresh=plugin.protocols.openai_video.render({},{status:'SUCCESS',data:{...d,timings:{download_completed_at_ms:Date.now()}}});assert.equal(fresh.content_expired,false);
});

test('an authorized stream opened before expiry finishes after cleanup unlinks the file',async t=>{
 const {j,bridge,dir,url}=await fixture(t);const data=Buffer.alloc(20*1024*1024,7);video.copy(data);j.files[0].size=data.length;await writeFile(join(dir,j.files[0].filename),data);await bridge.save(j);
 t.mock.timers.enable({apis:['Date'],now:(100000+28800)*1000-1});
 const {get}=await import('node:http');let removed=false,total=0;
 await new Promise((resolve,reject)=>{
  const request=get(url+'/v1/jobs/'+id+'/content/0',{headers:{Authorization:'Bearer '+token}},response=>{
   response.on('error',reject);response.on('end',resolve);
   response.on('data',chunk=>{
    total+=chunk.length;
    if(!removed){removed=true;response.pause();t.mock.timers.tick(1);bridge.cleanupMedia().then(async result=>{assert.equal(result.deleted_files,1);await assert.rejects(stat(join(dir,j.files[0].filename)),{code:'ENOENT'});response.resume();}).catch(reject);}
   });
  });request.on('error',reject);
 });
 assert.equal(total,data.length);assert.equal(removed,true);
});

test('unlink between metadata validation and streaming still serves the already-open file',async t=>{
 const {j,dir,url}=await fixture(t);t.mock.timers.enable({apis:['Date'],now:(100000+28800)*1000-1});
 const {unlinkSync}=await import('node:fs');let removed=false;
 Object.defineProperty(j.files[0],'size',{get(){if(!removed){removed=true;unlinkSync(join(dir,j.files[0].filename));}return video.length;},configurable:true});
 const r=await fetch(url+'/v1/jobs/'+id+'/content/0',{headers:{Authorization:'Bearer '+token}});
 assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),video);assert.equal(removed,true);
});

test('GET, HEAD and Range block equal-size corruption of a completed artifact after restart', async t=>{
  const {dir,bridge,j}=await fixture(t);
  t.mock.timers.enable({apis:['Date'],now:100001000});
  j.files[0].sha256=createHash('sha256').update(video).digest('hex');
  await bridge.save(j);await bridge.close();
  const reopened=await Bridge.open(bridge.config,async()=>{throw Error('a download cannot regenerate or change billing')});
  t.after(()=>reopened.close());
  const server=createServer(reopened);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const content='http://127.0.0.1:'+server.address().port+'/v1/jobs/'+id+'/content/0';
  const headers={Authorization:'Bearer '+token};
  const slice=await fetch(content,{headers:{...headers,Range:'bytes=0-9'}});
  assert.equal(slice.status,206);assert.deepEqual(Buffer.from(await slice.arrayBuffer()),video.subarray(0,10));
  await writeFile(join(dir,j.files[0].filename),Buffer.alloc(video.length));
  for(const req of [{method:'GET',headers},{method:'HEAD',headers},{headers:{...headers,Range:'bytes=0-9'}}]){
    const r=await fetch(content,req);
    assert.equal(r.status,503);
    if(req.method!=='HEAD')assert.equal((await r.json()).error.code,'artifact_integrity_failed');
  }
  assert.equal((await reopened.loadJob(id)).status,'completed');
  await writeFile(join(dir,j.files[0].filename),video);
  const restored=await fetch(content,{headers});
  assert.equal(restored.status,200);assert.deepEqual(Buffer.from(await restored.arrayBuffer()),video);
});
