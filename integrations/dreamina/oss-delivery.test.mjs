import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Bridge,validateConfig,createServer} from './bridge.mjs';
import * as plugin from './plugin.js';
import {OSSStorage} from './oss-storage.mjs';
const id='11111111-1111-4111-8111-111111111111';
const token='oss-delivery-local-only-token-32-characters';
const video=Buffer.from('000000186674797069736f6d0000020069736f6d','hex');
const digest=createHash('sha256').update(video).digest('hex');
const oss={bucket:'test-media',region:'oss-cn-hangzhou',prefix:'prod/videos',signedUrlSeconds:86400};
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'oss-delivery-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const cfg=validateConfig({token,dataDir:dir,cli:process.execPath,projectId:'c2679e06-fce3-4b3c-9038-3729d426c2b8',userId:'123',space:'personal',publicUrl:'http://127.0.0.1:8787',oss,
 models:{'seedance_2.5':{kind:'video',model:'seedance_2.5',maxCredits:100}}});
 const bridge=await Bridge.open(cfg,async()=>{throw Error('OSS must never generate or download from CLI again');});t.after(()=>bridge.close());
 const j={id,context:bridge.contextKey,key:'a'.repeat(64),digest:'b'.repeat(64),gatewayTaskId:'task_oss_test',status:'in_progress',created_at:1794370000,submitId:'22222222-2222-4222-8222-222222222222',terminalOperationState:'succeeded',
 request:{kind:'video',model:'seedance_2.5',seconds:5,n:1},inputs:[],files:[{filename:id+'-0.bin',resourceId:'video',mime:'video/mp4',size:video.length,sha256:digest}],
 outputStorage:{...oss,type:'oss',status:'pending'},timings:{download_completed_at_ms:Date.now()},diagnostics:{},downloadResources:['video']};
 await writeFile(join(dir,j.files[0].filename),video);await bridge.save(j);
 return {dir,bridge,j};
}
test('OSS delivery waits for upload, retries without generation, checkpoints and exposes fixed signed URLs',async t=>{
 const {bridge,j,dir}=await fixture(t);let attempts=0;
 bridge.oss={upload:async(file,path,dest,key)=>{attempts++;assert.deepEqual(await readFile(path),video);assert.match(key,/prod\/videos\/2026\/11\/11\/task_oss_test\/outputs\/001.mp4$/);if(attempts===1)throw Error('secret=https://leak.invalid/?token=secret');return {bucket:dest.bucket,region:dest.region,key,size:file.size,sha256:file.sha256,uploaded_at:Math.floor(Date.now()/1000)};},sign:async()=> 'https://test-media.oss-cn-hangzhou.aliyuncs.com/video?signature=test'};
 await bridge.uploadOutputs(j);assert.equal(j.status,'in_progress');assert.equal(j.attention,'oss_upload_failed');assert.equal(bridge.get(id,j).recovery.action,'retry_upload');assert.equal(bridge.get(id,j).phase,'uploading');assert.doesNotMatch(JSON.stringify(j),/leak.invalid/);
 await bridge.cleanupMedia();assert.equal((await stat(join(dir,j.files[0].filename))).size,video.length);
 await bridge.uploadOutputs(j);assert.equal(j.status,'completed');assert.equal(attempts,2);
 const receipt=bridge.get(id,j);assert.equal(receipt.storage,'oss');assert.equal(receipt.content_expires_at,undefined);
 assert.equal(receipt.video_url,receipt.video_urls[0]);assert.ok(receipt.download_url_expires_at>Math.floor(Date.now()/1000));
 const rendered=plugin.protocols.openai_video.render({},{status:'SUCCESS',data:receipt});assert.equal(rendered.video_url,receipt.video_url);assert.equal(rendered.content_expires_at,undefined);
 const persisted=JSON.parse(await readFile(join(dir,id+'.json'),'utf8'));assert.equal(persisted.files[0].oss.sha256,digest);
 assert.equal(plugin.protocols.openai_video.render({},{status:'IN_PROGRESS',data:receipt}).video_url,undefined);
});
test('OSS client checks remote metadata, uses private streamed PUT and signs public V4 URL',async t=>{
 const {dir,j}=await fixture(t);const requests=[];
 const client={head:async()=>{throw Object.assign(Error('missing'),{status:404});},putStream:async(key,stream,opts)=>{const chunks=[];for await(const c of stream)chunks.push(c);assert.deepEqual(Buffer.concat(chunks),video);requests.push(opts);return {res:{status:200}};}};
 const store=new OSSStorage(oss,client,{signatureUrlV4:async(method,seconds,options,key)=>{assert.equal(method,'GET');assert.equal(seconds,86400);return 'https://test-media.oss-cn-hangzhou.aliyuncs.com/'+key+'?signed=yes';}});
 client.head=async()=>requests.length?{res:{headers:{'content-length':String(video.length),'x-oss-meta-sha256':digest}}}:Promise.reject(Object.assign(Error('missing'),{status:404}));
 const saved=await store.upload(j.files[0],join(dir,j.files[0].filename),j.outputStorage,'prod/videos/test.mp4');assert.equal(saved.sha256,digest);assert.equal(requests[0].headers['x-oss-object-acl'],'private');assert.equal(requests[0].contentLength,video.length);
 await store.upload(j.files[0],join(dir,j.files[0].filename),j.outputStorage,'prod/videos/test.mp4');assert.equal(requests.length,1,'lost receipt recovers via HEAD');
 assert.match(await store.sign(saved,86400),/^https:/);
});

test('partial batch upload checkpoints survive restart and settle only delivered videos',async t=>{
 const {bridge,j,dir}=await fixture(t);
 const {buildCreditPlugin}=await import('./build-credit-plugin.mjs');
 const p=await import('data:text/javascript;base64,'+Buffer.from(await buildCreditPlugin({models:['seedance_2.5']})).toString('base64'));
 j.request={...j.request,n:3,mode:'t2v',ratio:'16:9',resolution:'480p'};
 j.billingMode='credits';j.billing={version:2,request_id:j.gatewayTaskId,reserved_credits:180};
 const ack=bridge.get(id,{...j,status:'queued'});
 const ctx={publicTaskId:j.gatewayTaskId,model:'seedance_2.5',upstreamModel:'seedance_2.5',requestBody:{...j.request,prompt:'waves'}};
 const submitted=p.parseSubmitResponse(ctx,{body:ack});
 j.upstreamCreditQuote={credits:300};j.timings.accepted_at_ms=Date.now();
 j.files.push({...j.files[0],filename:id+'-1.bin',resourceId:'video2'});j.downloadResources.push('video2');
 await writeFile(join(dir,j.files[1].filename),video);
 const uploads=[];let failSecond=true;
 const remote={upload:async(file,path,dest,key)=>{uploads.push(key);if(key.endsWith('002.mp4')&&failSecond)throw Error('transient');return {bucket:dest.bucket,region:dest.region,key,size:file.size,sha256:file.sha256};},sign:async o=>'https://test-media.oss-cn-hangzhou.aliyuncs.com/'+o.key+'?signed=yes'};
 bridge.oss=remote;await bridge.uploadOutputs(j);
 assert.equal(j.status,'in_progress');assert.ok(j.files[0].oss);assert.equal(j.files[1].oss,undefined);
 const poll={taskId:id,publicTaskId:j.gatewayTaskId,state:submitted.state};
 const waiting=await bridge.observe(id,j),pending=p.parseTaskResult(poll,waiting,{status:200});
 assert.equal(pending.status,'IN_PROGRESS');assert.deepEqual(p.extractUsageOnComplete(poll,pending,waiting),{});
 await bridge.close();const reopened=await Bridge.open(bridge.config,async()=>{throw Error('must not regenerate');});t.after(()=>reopened.close());
 reopened.oss=remote;failSecond=false;const restored=await reopened.loadJob(id);await reopened.uploadOutputs(restored);
 assert.equal(uploads.filter(k=>k.endsWith('001.mp4')).length,1);
 const receipt=await reopened.observe(id,restored),result=p.parseTaskResult(poll,receipt,{status:200});
 assert.equal(result.status,'SUCCESS');assert.deepEqual(p.extractUsageOnComplete(poll,result,receipt),{credits:200,resolution:'480p'});
 assert.equal(p.listArtifacts({status:'SUCCESS',data:receipt}).length,2);assert.equal(p.protocols.openai_video.render({}, {status:'SUCCESS',data:receipt}).video_urls.length,2);
 assert.equal(receipt.billing.credits,300,'preserve full accepted quote, bill 2/3 of it');
});

test('OSS cleanup leaves durable links and legacy GET HEAD Range downloads work without local videos',async t=>{
 const {bridge,j,dir}=await fixture(t);const {createServer: httpServer}=await import('node:http');
 const requests=[];const remote=httpServer((req,res)=>{
  requests.push({method:req.method,authorization:req.headers.authorization,range:req.headers.range});
  if(req.headers.range==='bytes=999-') {res.writeHead(416,{'Content-Range':'bytes */'+video.length,'Content-Length':0});res.end();return;}
  const slice=req.headers.range?video.subarray(0,8):video;
  res.writeHead(req.headers.range?206:200,{'Content-Type':'video/mp4','Content-Length':slice.length,'Accept-Ranges':'bytes',...(req.headers.range?{'Content-Range':'bytes 0-7/'+video.length}:{})});
  res.end(req.method==='HEAD'?undefined:slice);
 });
 await new Promise(r=>remote.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>remote.close(r)));
 const remoteURL='http://127.0.0.1:'+remote.address().port+'/video?signature=local-only';
 bridge.oss={upload:async(f,path,d,k)=>({bucket:d.bucket,region:d.region,key:k,size:f.size,sha256:f.sha256}),sign:async()=>remoteURL};
 await bridge.uploadOutputs(j);const originalURL=j.outputStorage.urls[0],expiration=j.outputStorage.urlExpiresAt;
 t.mock.timers.enable({apis:['Date'],now:Date.now()+28801000});
 await bridge.cleanupMedia();await assert.rejects(stat(join(dir,j.files[0].filename)),{code:'ENOENT'});
 const server=createServer(bridge);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port+'/v1/jobs/'+id,headers={Authorization:'Bearer '+token};
 assert.equal((await fetch(base)).status,401);assert.equal((await fetch(base+'/content/0')).status,401);
 const receipt=await (await fetch(base,{headers})).json();assert.equal(receipt.video_url,originalURL);assert.equal(receipt.content_expired,undefined);
 for(const [method,range,status,length] of [['GET',null,200,video.length],['HEAD',null,200,0],['GET','bytes=0-7',206,8],['GET','bytes=999-',416,0]]) {
  const r=await fetch(base+'/content/0',{method,headers:{...headers,...(range?{Range:range}:{})}});assert.equal(r.status,status);assert.equal((await r.arrayBuffer()).byteLength,length);
 }
 assert.ok(requests.every(r=>r.authorization===undefined),'gateway bearer never reaches object storage');
 t.mock.timers.tick(86400000);
 const expired=await (await fetch(base,{headers})).json();assert.equal(expired.video_url,originalURL);assert.equal(expired.download_url_expires_at,expiration,'GET never extends the signed snapshot');
 assert.equal((await fetch(base+'/content/0',{headers})).status,200,'proxy obtains a fresh server-side signature');
});

test('OSS upload concurrency is bounded independently of polling and never dispatches the same job twice',async t=>{
 const {bridge,j}=await fixture(t);bridge.config.ossWorkers=1;
 j.outputStorage.status='uploading';j.diagnostics.next_context_check_at_ms=Date.now()+60000;
 const second=structuredClone(j);second.id='33333333-3333-4333-8333-333333333333';second.key='c'.repeat(64);await bridge.save(second);
 const poll=structuredClone(j);poll.id='44444444-4444-4444-8444-444444444444';poll.key='d'.repeat(64);delete poll.downloadResources;delete poll.outputStorage;delete poll.diagnostics.next_context_check_at_ms;await bridge.save(poll);
 let release;const gate=new Promise(r=>release=r),ran=[];
 bridge.processJob=async job=>{ran.push(job.id);if(job.outputStorage)await gate;else job.status='completed';};
 const first=bridge.dispatchReadyJobs();await Promise.resolve();const overlap=bridge.dispatchReadyJobs();await Promise.resolve();
 assert.deepEqual(ran,[id,poll.id]);assert.equal(bridge.inFlight.get(id).lane,'oss');release();await Promise.all([first,overlap]);
});

test('OSS SDK rejects remote checksum conflict and local corruption and generates public V4 signatures offline',async t=>{
 const {j,dir}=await fixture(t);let puts=0;
 const client={head:async()=>({res:{headers:{'content-length':video.length,'x-oss-meta-sha256':'wrong'}}}),putStream:async()=>puts++};
 const store=new OSSStorage(oss,client,{});
 await assert.rejects(store.upload(j.files[0],join(dir,j.files[0].filename),j.outputStorage,'x'),/integrity mismatch/);
 client.head=async()=>{throw Object.assign(Error('missing'),{status:404});};await writeFile(join(dir,j.files[0].filename),Buffer.alloc(video.length));
 await assert.rejects(store.upload(j.files[0],join(dir,j.files[0].filename),j.outputStorage,'x'),/digest mismatch/);assert.equal(puts,0);
 assert.throws(()=>OSSStorage.fromEnvironment(oss,{}),/Set DREAMINA_OSS/);
 const real=OSSStorage.fromEnvironment({...oss,internal:true},{DREAMINA_OSS_ACCESS_KEY_ID:'local-only-ak',DREAMINA_OSS_ACCESS_KEY_SECRET:'local-only-sk'});
 const signed=new URL(await real.sign({bucket:oss.bucket,region:oss.region,key:'prod/videos/test.mp4'},86400));
 assert.equal(signed.protocol,'https:');assert.equal(signed.hostname,'test-media.oss-cn-hangzhou.aliyuncs.com');assert.equal(signed.searchParams.get('x-oss-expires'),'86400');assert.ok(signed.searchParams.get('x-oss-signature'));
 await assert.rejects(real.sign({bucket:'different',region:oss.region,key:'x'},86400),/destination/);
});

test('OSS metadata round trips the existing database payload without schema changes',async t=>{
 const {DatabaseStore}=await import('./database-store.mjs');const {randomUUID}=await import('node:crypto');
 const {bridge,j,dir}=await fixture(t);const context=createHash('sha256').update(randomUUID()).digest('hex');
 const url=process.env.DREAMINA_TEST_DATABASE_URL || 'sqlite://'+join(dir,'oss.sqlite');
 let store=await DatabaseStore.open({url,context});t.after(()=>store.close());await store.initialize([],null);
 j.context=context;j.status='completed';j.outputStorage={...j.outputStorage,status:'ready',urls:['https://test-media.example/video?signed=local'],urlExpiresAt:1794456400};
 j.files[0].oss={bucket:oss.bucket,region:oss.region,key:'prod/videos/task_test/outputs/001.mp4',size:video.length,sha256:digest};
 await store.save(j);await store.close();store=await DatabaseStore.open({url,context});
 assert.deepEqual(await store.get(id),j);assert.equal(await store.findKey(j.key),id);
 await bridge.close();
});

test('POST admission freezes destination, downloads once, then uploads before publishing completion',async t=>{
 const {bridge,j}=await fixture(t);j.status='failed';await bridge.save(j);bridge.config.pollIntervalMs=0;
 const {quotedCLI}=await import('./fixtures/quote-cli.mjs');
 const catalog=JSON.parse(await readFile(new URL('./fixtures/video-models.json',import.meta.url),'utf8'));
 let runs=0,downloads=0,uploads=0;
 bridge.cli=quotedCLI(async args=>{
  if(args[0]==='space')return {kind:'personal',userId:'123'};
  if(args[0]==='model')return catalog;
  if(args[0]==='node'&&args[1]==='run'){runs++;return {submission:{state:'accepted'}};}
  if(args[0]==='operation')return {state:'succeeded',resources:[{resourceId:'video-post',state:'succeeded'}]};
  if(args[0]==='resource'&&args[1]==='download'){
   downloads++;const path=args.find(v=>v.startsWith('--output=')).slice(9);await writeFile(path,video);return {resourceId:args[2],path,size:video.length,sha256:digest};
  }
  throw Error('unexpected mock CLI command '+args.slice(0,2).join(' '));
 });
 await bridge.preflight();
 bridge.oss={upload:async(f,path,d,k)=>{uploads++;assert.equal(d.prefix,'prod/videos');return {bucket:d.bucket,region:d.region,key:k,size:f.size,sha256:f.sha256};},sign:async()=> 'https://test-media.example/post.mp4?signed=test'};
 const server=createServer(bridge);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port+'/v1/jobs',headers={Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':'task_post_oss'};
 const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({kind:'video',model:'seedance_2.5',prompt:'waves',seconds:5,resolution:'480p'})});
 assert.equal(response.status,202);const ack=await response.json();
 bridge.config.oss.prefix='changed-for-future-jobs';
 await fetch(url+'/'+ack.id,{headers});
 await bridge.tick();await bridge.tick();await bridge.tick();
 const downloaded=bridge.jobs.get(ack.id);assert.equal(downloaded.status,'in_progress');assert.equal(downloaded.outputStorage.status,'uploading');assert.equal(uploads,0);
 await bridge.tick();const completed=await(await fetch(url+'/'+ack.id,{headers})).json();
 assert.equal(completed.status,'completed');assert.equal(completed.video_urls.length,1);assert.equal(runs,1);assert.equal(downloads,1);assert.equal(uploads,1);
});
