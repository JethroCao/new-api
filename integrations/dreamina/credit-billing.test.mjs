import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildCreditPlugin} from './build-credit-plugin.mjs';
import {VIDEO_MODELS} from './plugin.js';
import {Bridge,validateConfig,createServer} from './bridge.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
globalThis.utils={base64URLDecode:value=>Buffer.from(value,'base64url').toString('utf8')};
const config={models:Object.keys(VIDEO_MODELS)};
const load=async c=>import('data:text/javascript;base64,'+Buffer.from(await buildCreditPlugin(c)).toString('base64'));
const ctx={publicTaskId:'task_test',model:'seedance_2.5',upstreamModel:'seedance_2.5',operation:'create',apiKey:'bridge-secret',baseUrl:'http://bridge',requestBody:{model:'seedance_2.5',prompt:'waves',seconds:5,n:2,resolution:'480p'}};
const ack={id:'job-123',object:'video',billing_mode:'credits',status:'queued',model:'seedance_2.5',seconds:5,n:2,mode:'t2v',ratio:'16:9',resolution:'480p',video_count:0,billing:{version:2,request_id:'task_test',reserved_credits:120}};
const done={...ack,terminal_proof:true,delivery_verified:true,status:'completed',video_count:2,billing:{...ack.billing,credits:73,basis:'accepted_quote'}};

test('Flash estimates surveyed credits without trusting reference duration hints', async () => {
 const p=await load({models:['seedance_2.5_flash']});
 const ref=type=>({type,url:'https://example.com/reference'});
 // Quote-only survey on 2026-11-13. Video reservations use the maximum
 // combined reference duration (30 rounded seconds), not a per-file bound.
 for(const [resolution,seconds,n,references,credits] of [
  ['480p',4,1,[],28],['480p',5,1,[],35],['480p',30,4,[],840],
  ['720p',4,1,[],76],['720p',5,1,[],95],['720p',30,4,[],2280],
  ['720p',10,2,[ref('image'),ref('audio')],380],
  ['480p',5,1,[ref('audio')],35],
  ['480p',5,1,[ref('image'),ref('image')],35],
  ['480p',5,1,[ref('video')],245],
  ['720p',5,4,[ref('video'),ref('video'),ref('audio')],980],
 ]) {
  const c={...ctx,model:'flash-alias',upstreamModel:'seedance_2.5_flash',
   requestBody:{prompt:'waves',resolution,seconds,n,references}};
  assert.deepEqual(p.extractUsage(c),{credits,resolution});
  const submit=p.buildSubmitRequest(c);
  assert.equal(submit.body.model,'seedance_2.5_flash');
  assert.equal(JSON.parse(submit.headers['X-Dreamina-Billing']).reserved_credits,credits);
 }
 const c={...ctx,model:'seedance_2.5_flash',upstreamModel:'seedance_2.5_flash',
  requestBody:{prompt:'waves',mode:'m2v',resolution:'720p',seconds:30,n:4}};
 const references=[...Array(10).fill(ref('image')),...Array(5).fill(ref('video')),...Array(5).fill(ref('audio'))];
 assert.deepEqual(p.extractUsage({...c,requestBody:{...c.requestBody,references}}),{credits:1680,resolution:'720p'});
 for(const type of ['image','video','audio']) {
  assert.throws(()=>p.extractUsage({...c,requestBody:{...c.requestBody,references:[...references,ref(type)]}}),/Too many/);
 }
 for(const change of [{resolution:'1080p'},{seconds:3},{seconds:31},{n:5},
  {references:[{...ref('video'),seconds:0}]},{mode:'promote'}]) {
  assert.throws(()=>p.extractUsage({...c,requestBody:{...c.requestBody,references:[ref('video')],...change}}));
 }
});

test('Flash settles accepted credits for delivered results, with refunds and upward adjustments',async()=>{
 const p=await load({models:['seedance_2.5_flash']});
 for(const [hasVideo,quoted,count,expected] of [[true,140,2,140],[true,140,1,70],[false,220,2,220],[false,0,2,0]]) {
  const c={...ctx,model:'seedance_2.5_flash',upstreamModel:'seedance_2.5_flash',
   requestBody:{...ctx.requestBody,model:'seedance_2.5_flash',resolution:'720p',
    references:hasVideo?[{type:'video',url:'https://example.com/video.mp4'}]:[]}};
  const reserved=hasVideo?490:190;
  assert.equal(p.extractUsage(c).credits,reserved);
  const receipt={...ack,model:'seedance_2.5_flash',resolution:'720p',mode:hasVideo?'m2v':'t2v',
   billing:{...ack.billing,reserved_credits:reserved}};
  const poll={taskId:receipt.id,publicTaskId:c.publicTaskId,state:p.parseSubmitResponse(c,{body:receipt}).state};
  const body={...receipt,status:'completed',terminal_proof:true,delivery_verified:true,video_count:count,
   billing:{...receipt.billing,basis:'accepted_quote',credits:quoted}};
  const result=p.parseTaskResult(poll,body,{status:200});
  assert.equal(result.status,'SUCCESS');
  assert.deepEqual(p.extractUsageOnComplete(poll,result,body),{credits:expected,resolution:'720p'});
  assert.equal(p.listArtifacts({status:result.status,data:body}).length,count);
  const waiting=p.parseTaskResult(poll,{...body,terminal_proof:false},{status:200});
  assert.equal(waiting.status,'UNKNOWN');
  const failed={...body,status:'failed',video_count:0,error:{message:'20100:本次输入文本敏感，安审拦截'}};
  const failure=p.parseTaskResult(poll,failed,{status:200});
  assert.equal(failure.status,'FAILURE');assert.equal(failure.reason,failed.error.message);
  assert.deepEqual(p.extractUsageOnComplete(poll,failure,failed),{});
 }
});

test('Flash traverses local HTTP admission, CLI quotation, partial delivery and download',async t=>{
 const model='seedance_2.5_flash',p=await load({models:[model]});
 const dir=await mkdtemp(join(tmpdir(),'flash-billing-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const token='flash-local-test-token-not-a-real-key';
 const cfg=validateConfig({cli:process.execPath,dataDir:dir,token,userId:'123',space:'personal',
  projectId:'11111111-1111-4111-8111-111111111111',publicUrl:'http://127.0.0.1:8787',
  models:{[model]:{kind:'video',model,maxCredits:0}},unlimitedCredits:true});
 cfg.pollIntervalMs=0;
 const bytes=Buffer.from('000000186674797069736f6d0000020069736f6d','hex');
 const flag=(args,key)=>args.find(a=>a.startsWith('--'+key+'='))?.slice(key.length+3);
 let saved,finished=false,runs=0;
 // Only the external CLI is simulated. All admission, receipt, persistence,
 // polling, delivery and HTTP download behavior below uses the real bridge.
 const bridge=await Bridge.open(cfg,async args=>{
  if(args[0]==='space')return {userId:'123',kind:'personal'};
  if(args[0]==='model')return {items:[{model,modes:[{name:'t2v',flags:[
   {flag:'--ratio',values:['16:9']},{flag:'--resolution',values:['480p','720p']},
   {flag:'--duration',min:4,max:30,step:1},{flag:'--count',min:1,max:4,step:1},
   {flag:'--prompt',minLength:1,maxLength:15000}]}]}]};
  if(args[0]==='node'&&args[1]==='create'){
   assert.equal(flag(args,'model'),model);assert.equal(flag(args,'count'),'2');
   assert.equal(flag(args,'resolution'),'720p');assert.equal(flag(args,'duration'),'5');
   assert.ok(!args.includes('--run'));
   saved={nodeId:flag(args,'node-id'),generation:{model,mode:'t2v',ratio:'16:9',
    resolution:'720p',durationSeconds:5,outputCount:2,prompt:'waves',references:[]}};
   return {node:saved,mutation:{savedDraftVersion:1}};
  }
  if(args[0]==='node'&&args[1]==='show')return {nodes:[saved],draftVersion:1};
  if(args[0]==='node'&&args[1]==='quote')return {consumptionSubject:{kind:'personal',userId:'123'},
   items:[{nodeId:saved.nodeId,maxCredits:190}],totalMaxCredits:190,draftVersion:1,confirmable:true,confirmationRequired:true};
  if(args[0]==='node'&&args[1]==='confirm')return {consumptionSubject:{kind:'personal',userId:'123'},
   creditConfirmationToken:'local-fixture',creditCeiling:190,expiresAt:'2099-01-01T00:00:00Z'};
  if(args[0]==='node'&&args[1]==='run'){
   runs++;return {items:[{nodeId:saved.nodeId,submitId:flag(args,'submit-id'),state:'accepted',resources:[]}]};
  }
  if(args[0]==='operation')return {operationRef:args[2],state:finished?'succeeded':'running',resources:finished?
   [{resourceId:'flash-output',state:'succeeded'},{state:'failed'}]:[]};
  if(args[0]==='resource'&&args[1]==='download'){
   const path=flag(args,'output');await writeFile(path,bytes);
   return {resourceId:args[2],path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  throw Error('Unexpected simulated CLI command: '+args.slice(0,2).join(' '));
 });
 t.after(()=>bridge.close());await bridge.preflight();
 const server=createServer(bridge);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 cfg.publicUrl='http://127.0.0.1:'+server.address().port;
 const c={...ctx,model,upstreamModel:model,baseUrl:cfg.publicUrl,apiKey:token,
  requestBody:{model,prompt:'waves',seconds:5,n:2,resolution:'720p'}};
 assert.deepEqual(p.extractUsage(c),{credits:190,resolution:'720p'});
 const submit=p.buildSubmitRequest(c);
 const response=await fetch(submit.url,{method:submit.method,headers:submit.headers,body:JSON.stringify(submit.body)});
 assert.equal(response.status,202);
 const admitted=p.parseSubmitResponse(c,{body:await response.json(),headers:Object.fromEntries(response.headers)});
 const poll={...c,taskId:admitted.taskId,state:admitted.state};
 // The gateway has durably recorded this task; observation releases dispatch.
 await bridge.observe(admitted.taskId);await bridge.tick();
 assert.equal(runs,1);assert.equal(bridge.get(admitted.taskId).billing.credits,190);
 finished=true;await bridge.tick();await bridge.tick();
 const query=p.buildQueryRequest(poll),reply=await fetch(query.url,{headers:query.headers});
 assert.equal(reply.status,200);
 const body=await reply.json();
 const parsed=p.parseTaskResult(poll,body,{status:reply.status,headers:Object.fromEntries(reply.headers)});
 assert.equal(parsed.status,'SUCCESS');
 assert.deepEqual(p.extractUsageOnComplete(poll,parsed,body),{credits:95,resolution:'720p'});
 assert.equal(p.listArtifacts({status:parsed.status,data:body}).length,1);
 const content=p.buildContentRequest({...c,upstreamTaskId:admitted.taskId,data:body,artifactKey:'video',clientRequest:{method:'GET'}});
 const download=await fetch(content.url,{headers:content.headers});
 assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
 assert.equal(runs,1);
});

test('credit artifact has stock metadata and derives reservation from validated batch count',async()=>{
 const p=await load(config);assert.equal(p.meta.key,'dreamina-cli');assert.equal(p.meta.requiredCapabilities,undefined);
 assert.equal(p.meta.usageSchema.credits.unit,'credit');assert.deepEqual(p.extractUsage(ctx),{credits:120,resolution:'480p'});
 assert.throws(()=>p.extractUsage({...ctx,usagePurpose:'billing_ratios'}),/credit.*expression/i);
 const req=p.buildSubmitRequest(ctx);assert.deepEqual(JSON.parse(req.headers['X-Dreamina-Billing']),ack.billing);
 assert.equal(req.body.billing,undefined);assert.equal(req.headers['Idempotency-Key'],'task_test');
 assert.throws(()=>p.extractUsage({...ctx,requestBody:{...ctx.requestBody,reserved_credits:0}}));
 assert.throws(()=>p.extractUsage({...ctx,requestBody:{...ctx.requestBody,n:5}}));
});

test('billing acknowledgement, state binding and exact accepted quote settlement including zero',async()=>{
 const p=await load(config);const submitted=p.parseSubmitResponse(ctx,{body:ack});
 const poll={taskId:ack.id,publicTaskId:ctx.publicTaskId,state:submitted.state};
 for(const credits of [0,73,120,180]){
  const body={...done,billing:{...done.billing,credits}};
  const parsed=p.parseTaskResult(poll,body,{status:200});assert.equal(parsed.status,'SUCCESS');
  assert.deepEqual(p.extractUsageOnComplete(poll,parsed,body),{credits,resolution:'480p'});
  assert.equal(p.protocols.openai_video.render({}, {status:'SUCCESS',data:body}).billing,undefined);
 }
 assert.throws(()=>p.parseSubmitResponse(ctx,{body:{...ack,billing:{...ack.billing,reserved_credits:100}}}));
 assert.throws(()=>p.parseSubmitResponse(ctx,{body:{...ack,billing:undefined}}));
});

test('missing or forged quote and invalid delivery counts cannot become successful estimate settlement',async()=>{
 const p=await load(config),poll={taskId:ack.id,publicTaskId:ctx.publicTaskId,state:p.parseSubmitResponse(ctx,{body:ack}).state};
 for(const change of [
  {billing:undefined},{billing:{...done.billing,credits:-1}},{billing:{...done.billing,credits:1000000001}},
  {billing:{...done.billing,credits:NaN}},{billing:{...done.billing,request_id:'other'}},
  {billing:{...done.billing,basis:'estimated'}},{n:1},{model:'wan_3.0'},
  ...[undefined,null,0,-1,1.5,3,NaN,Infinity,'1'].map(video_count=>({video_count})),
  {billing:{...done.billing,credits:undefined}},
 ]){
  const body={...done,...change},parsed=p.parseTaskResult(poll,body,{status:200});
  assert.equal(parsed.status,'UNKNOWN');assert.match(parsed.reason,/核查/);assert.equal(parsed.state,undefined);
  assert.deepEqual(p.extractUsageOnComplete(poll,parsed,body),{});
 }
 assert.equal(p.parseTaskResult(poll,{...done,status:'failed',video_count:0,error:{message:'20100:blocked'}},{status:200}).reason,'20100:blocked');
});

test('unbound receipts return UNKNOWN and the next original result can succeed', async () => {
 const p=await load(config);
 const poll={taskId:ack.id,publicTaskId:ctx.publicTaskId,state:p.parseSubmitResponse(ctx,{body:ack}).state,data:ack};
 const failed={...done,status:'failed',video_count:0,error:{message:'private-other-job-message'}};
 for(const reply of [null, {...failed,id:'other-job'}, {...failed,billing:{...done.billing,request_id:'other-public-task'}},
     {...ack,status:'in_progress',billing:undefined}, {...done,id:'other-job'}]) {
   const waiting=p.parseTaskResult(poll,reply,{status:200});
   assert.equal(waiting.status,'UNKNOWN');assert.match(waiting.reason,/核查/);
   assert.equal(waiting.state,undefined);assert.deepEqual(p.extractUsageOnComplete(poll,waiting,reply),{});
   assert.doesNotMatch(JSON.stringify(waiting),/private-other-job-message/);
 }
 const partial={...done,video_count:1};
 const success=p.parseTaskResult(poll,partial,{status:200});
 assert.equal(success.status,'SUCCESS');assert.equal(success.state.settledCredits,36.5);
 const real={...failed,billing:ack.billing,error:{message:'20100:输入文本敏感'}};
 const refused=p.parseTaskResult(poll,real,{status:200});
 assert.equal(refused.status,'FAILURE');assert.equal(refused.reason,real.error.message);
});

test('partial batches deliver successful artifacts and settle their share of the accepted quote',async()=>{
 const p=await load(config);
 for(const [n,count,quoted,credits] of [
  [4,2,240,120],[3,2,180,120],[2,1,73,36.5],[3,2,100,66.66666666666667],
  [4,1,1200,300],[4,3,0,0],
 ]){
  const c={...ctx,requestBody:{...ctx.requestBody,n}},reserved=p.extractUsage(c).credits;
  const receipt={...ack,n,billing:{...ack.billing,reserved_credits:reserved}};
  const poll={taskId:ack.id,publicTaskId:ctx.publicTaskId,state:p.parseSubmitResponse(c,{body:receipt}).state};
  const body={...receipt,terminal_proof:true,delivery_verified:true,status:'completed',video_count:count,billing:{...receipt.billing,credits:quoted,basis:'accepted_quote'}};
  const parsed=p.parseTaskResult(poll,body,{status:200});
  assert.equal(parsed.status,'SUCCESS');
  assert.deepEqual(p.extractUsageOnComplete(poll,parsed,body),{credits,resolution:'480p'});
  const task={status:parsed.status,data:body},artifacts=p.listArtifacts(task);
  assert.equal(artifacts.length,count);
  for(const [i,artifact] of artifacts.entries()){
   const download=p.buildContentRequest({...ctx,data:body,upstreamTaskId:ack.id,artifactKey:artifact.key,clientRequest:{method:'GET'}});
   assert.equal(download.url,'http://bridge/v1/jobs/job-123/content/'+i);
  }
  assert.throws(()=>p.buildContentRequest({...ctx,data:body,upstreamTaskId:ack.id,artifactKey:'video-'+(count+1),clientRequest:{method:'GET'}}));
  const rendered=p.protocols.openai_video.render({},task);
  assert.equal(rendered.n,n);assert.equal(rendered.video_count,count);assert.equal(rendered.billing,undefined);
  assert.equal(body.billing.credits,quoted);assert.equal(body.billing.basis,'accepted_quote');
  assert.equal(parsed.state.settledCredits,credits);assert.equal(parsed.state.deliveredCount,count);
 }
});

test('estimate uses the surveyed model/resolution rates and normalized output count',async()=>{
 const p=await load(config);
 for(const [model,resolution,expected] of [
  ['seedance_2.5','480p',60],['seedance_2.5','720p',100],['seedance_2.5','1080p',320],
  ['seedance_2.5_draft','480p',45],['seedance_2.0_vip','720p',70],['seedance_2.0_vip','1080p',165],['seedance_2.0_vip','4k',400],
  ['seedance_2.0_fast_vip','720p',30],['seedance_2.0_mini','720p',30],['seedance_pro_fast','720p',10],['seedance_pro_fast','1080p',20],
  ['happyhorse_1.1','720p',70],['happyhorse_1.1','1080p',90],['wan_3.0','720p',70],['wan_3.0','1080p',165],
 ])for(const n of [1,4])for(const references of [[],[{type:'image',url:'https://example.com/a.png'}]]){
  const c={...ctx,model:'alias',upstreamModel:model,requestBody:{prompt:'waves',seconds:5,n,resolution,references}};
  assert.deepEqual(p.extractUsage(c),{credits:expected*n,resolution:resolution.toLowerCase()},model+' '+resolution);
 }
 const audio={...ctx,requestBody:{...ctx.requestBody,n:1,references:[{type:'audio',url:'https://example.com/a.mp3'}]}};
 assert.deepEqual(p.extractUsage(audio),{credits:60,resolution:'480p'});
 assert.deepEqual(p.extractUsage({...ctx,upstreamModel:'dreamina-video'}),{credits:120,resolution:'480p'});
});

test('unverified reference durations use one total model bound, never a caller hint or a per-file surcharge',async()=>{
 const p=await load(config);
 for(const [model,resolution,expected] of [
  ['seedance_2.5','480p',315],['seedance_2.5','720p',455],['seedance_2.5','1080p',2240],
  ['seedance_2.5_draft','480p',315],['seedance_2.0_vip','720p',280],['seedance_2.0_vip','4k',1600],
  ['seedance_2.0_fast_vip','720p',120],['seedance_2.0_mini','720p',120],['wan_3.0','1080P',660],
 ])for(const count of [1,2]){
  const references=Array.from({length:count},()=>({type:'video',url:'https://example.com/a.mp4'}));
  const c={...ctx,upstreamModel:model,requestBody:{prompt:'waves',seconds:5,n:1,resolution,references}};
  assert.deepEqual(p.extractUsage(c),{credits:expected,resolution:resolution.toLowerCase()});
  assert.throws(()=>p.extractUsage({...c,requestBody:{...c.requestBody,references:[{...references[0],seconds:0}]}}));
 }
 for(const change of [{seconds:-1},{seconds:31},{n:0},{n:1e20},{seconds:NaN},{metadata:{seconds:1}},{resolution:'8k'}]){
  assert.throws(()=>p.extractUsage({...ctx,requestBody:{...ctx.requestBody,...change}}));
 }
});

test('legacy frozen ceilings remain strict while new estimates can settle upward',async()=>{
 const p=await load(config),poll={taskId:ack.id,publicTaskId:ctx.publicTaskId,state:p.parseSubmitResponse(ctx,{body:ack}).state};
 const legacy={...poll,state:{...poll.state,billing:{...poll.state.billing,version:1}}};
 assert.equal(p.parseTaskResult(legacy,{...done,billing:{...done.billing,version:1,credits:121}},{status:200}).status,'UNKNOWN');
 assert.equal(p.parseTaskResult(legacy,{...done,billing:{...done.billing,version:1,credits:120}},{status:200}).status,'SUCCESS');
 assert.equal(p.parseTaskResult(poll,{...done,billing:{...done.billing,version:1}},{status:200}).status,'UNKNOWN');
});

test('credit plugin rejects new promotion even with an owned completed origin task',async()=>{
 const p=await load(config),c={...ctx,requestBody:{mode:'promote',draft_task_id:'task_draft'},originTasks:[{taskId:'task_draft',upstreamTaskId:'draft-job',status:'SUCCESS',data:{model:'seedance_2.5_draft',seconds:5,n:1,video_count:1,ratio:'16:9'}}]};
 const message={message:'暂不支持样片转正，请直接创建普通视频任务'};
 assert.throws(()=>p.extractUsage(c),message);
 assert.throws(()=>p.buildSubmitRequest(c),message);
 await assert.rejects(buildCreditPlugin({...config,promotionReservationCreditsPerVideo:2000}),message);
 // Obsolete null settings are harmless but can never enable promotion.
 const legacyConfig=await load({...config,promotionReservationCreditsPerVideo:null});
 assert.throws(()=>legacyConfig.extractUsage(c),message);
});

test('build configuration explicitly selects supported models and rejects obsolete ceiling configuration',async()=>{
 for(const value of [undefined,{}, {models:[]},{models:['wrong']},{models:['seedance_2.5','seedance_2.5']},
 {reservationCreditsPerVideo:{'seedance_2.5':100}},{models:['seedance_2.5'],promotionReservationCreditsPerVideo:-1}])await assert.rejects(buildCreditPlugin(value));
 const p=await load({models:['seedance_2.5']});
 assert.throws(()=>p.extractUsage({...ctx,upstreamModel:'wan_3.0',requestBody:{model:'wan_3.0',prompt:'waves'}}));
 assert.deepEqual(p.meta.models,['seedance_2.5','dreamina-video']);
});


test('same-key upgrade lets a verified old seconds task finish and download partial results',async()=>{
 const p=await load(config);
 // Snapshot persisted by the old plugin, before the bridge introduced billing_mode.
 const old={...ack};delete old.billing;delete old.billing_mode;
 const poll={taskId:old.id,publicTaskId:ctx.publicTaskId,data:old,state:null};
 const body={...old,status:'completed',billing_mode:'legacy_seconds',video_count:1};
 const parsed=p.parseTaskResult(poll,body,{status:200});
 assert.equal(parsed.status,'SUCCESS');assert.deepEqual(p.extractUsageOnComplete(poll,parsed,body),{seconds:5});
 assert.equal(parsed.state?.settledCredits,undefined);
 assert.deepEqual(p.listArtifacts({status:parsed.status,data:body}),[{key:'video',type:'video'}]);
 const failed={...body,status:'failed',video_count:0,error:{message:'20110:输入图片版权校验未通过'}};
 const failure=p.parseTaskResult(poll,failed,{status:200});
 assert.equal(failure.status,'FAILURE');assert.equal(failure.reason,failed.error.message);
 assert.deepEqual(p.extractUsageOnComplete(poll,failure,failed),{});
 for(const foreign of [{...failed,id:'other-job'}, {...failed,n:4}, {...failed,billing_mode:'credits'}]) {
  const mismatch=p.parseTaskResult(poll,foreign,{status:200});
  assert.equal(mismatch.status,'UNKNOWN');assert.equal(mismatch.state,undefined);
  assert.doesNotMatch(mismatch.reason,/20110/);
 }
 const recovered=p.parseTaskResult(poll,body,{status:200});
 assert.equal(recovered.status,'SUCCESS');assert.deepEqual(p.extractUsageOnComplete(poll,recovered,body),{seconds:5});
});

test('missing credit state, quote or identity never authorizes a switch to seconds',async()=>{
 const p=await load(config),newState=p.parseSubmitResponse(ctx,{body:ack}).state;
 const old={...ack};delete old.billing;delete old.billing_mode;
 const poll={taskId:old.id,publicTaskId:ctx.publicTaskId,data:old,state:null};
 const body={...old,billing_mode:'legacy_seconds',status:'completed',video_count:1};
 const unidentified=p.parseTaskResult({...poll,data:null},body,{status:200});
 assert.equal(unidentified.status,'UNKNOWN');assert.deepEqual(p.extractUsageOnComplete(poll,unidentified,body),{});
 for(const [c,r] of [
  [poll,{...body,billing_mode:undefined}],
  [{...poll,data:ack},body],[{...poll,state:newState},body],[{...poll,state:{billing:null}},body],
  [{...poll,data:{...old,id:'wrong'}},body],[poll,{...body,n:1}],[poll,{...body,video_count:3}],
  [poll,{...body,billing:done.billing}],[poll,done],[{...poll,state:newState}, {...done,billing:undefined}],
  [{...poll,state:newState,publicTaskId:'task_other'},done],
  [{...poll,data:ack},{...body,status:'in_progress'}],
 ]){
  const parsed=p.parseTaskResult(c,r,{status:200});
  assert.equal(parsed.status,'UNKNOWN');assert.deepEqual(p.extractUsageOnComplete(c,parsed,r),{});
 }
});


test('an accepted batch amount is immutable across polls even without audit headers',async()=>{
 const p=await load(config);
 const accepted=(credits,status='in_progress')=>({...done,status,billing:{...done.billing,credits,quoted_credits:credits,quote_status:'accepted'}});
 const initial=()=>({taskId:ack.id,publicTaskId:ctx.publicTaskId,data:ack,state:p.parseSubmitResponse(ctx,{body:ack}).state});
 for(const quote of [73,0]) {
  const first=accepted(quote);
  const poll=initial();
  const observed=p.parseTaskResult(poll,first,{status:200});
  assert.equal(observed.status,'IN_PROGRESS');assert.equal(observed.state?.acceptedQuoteCredits,quote);
  const restored={...poll,data:first,state:JSON.parse(JSON.stringify(observed.state))};
  const repeat=p.parseTaskResult(restored,first,{status:200});
  assert.equal(repeat.status,'IN_PROGRESS');
  const staleSnapshot={...restored,data:ack};
  for(const body of [accepted(100),{...first,billing:ack.billing},accepted(100,'completed')]){
   const invalid=p.parseTaskResult(staleSnapshot,body,{status:200});assert.equal(invalid.status,'UNKNOWN');
   assert.equal(invalid.state,undefined);assert.deepEqual(p.extractUsageOnComplete(staleSnapshot,invalid,body),{});
  }
  const partial={...accepted(quote,'completed'),video_count:1};
  const result=p.parseTaskResult(staleSnapshot,partial,{status:200});
  assert.equal(result.status,'SUCCESS');assert.equal(result.state.settledCredits,quote/2);
 }
 const quotedAck={...ack,billing:{...done.billing,quoted_credits:73,quote_status:'accepted',credits:73}};
 const submitted=p.parseSubmitResponse(ctx,{body:quotedAck});
 assert.equal(submitted.state.acceptedQuoteCredits,73);
 const replay={taskId:ack.id,publicTaskId:ctx.publicTaskId,data:ack,state:submitted.state};
 assert.equal(p.parseTaskResult(replay,accepted(100),{status:200}).status,'UNKNOWN');
});

test('quotes, approvals and accepted submissions persist separately across failure, success and legacy receipts', async () => {
 const p = await load(config);
 const state = () => p.parseSubmitResponse(ctx, {body: ack}).state;
 const receipt = (status, phase) => ({
   ...ack, status, terminal_proof:true, delivery_verified:true, video_count: status === 'completed' ? 1 : 0,
   billing: {...ack.billing, quoted_credits: 73, quote_status: phase,
     ...(phase === 'accepted' ? {basis: 'accepted_quote', credits: 73} : {})},
   ...(status === 'failed' ? {error: {message: 'upstream rejected'}} : {}),
 });
 const poll = {taskId: ack.id, publicTaskId: ctx.publicTaskId, state: state()};
 const advance = (context, body) => {
   const parsed = p.parseTaskResult(context, body, {status: 200});
   context.state = parsed.state || context.state;
   context.data = body;
   return parsed;
 };
 for (const phase of ['quoted', 'confirmed']) {
   const job = {...poll};
   const inProgress = advance(job, receipt('in_progress', phase));
   assert.equal(inProgress.status, 'IN_PROGRESS');
   assert.equal(job.state.quoteStatus, phase);
   assert.equal(job.state.quotedCredits, 73);
   assert.equal(job.state.acceptedQuoteCredits, undefined);
   const rejected = advance(job, receipt('failed', phase));
   assert.equal(rejected.status, 'FAILURE');
   assert.deepEqual(p.extractUsageOnComplete(job, rejected, job.data), {});
   const fabricated = p.parseTaskResult(job, receipt('completed', phase), {status: 200});
   assert.equal(fabricated.status, 'UNKNOWN');
   assert.equal(fabricated.state?.settledCredits, undefined);
 }
 for (const phase of ['quoted', 'confirmed', 'accepted']) {
   advance(poll, receipt('in_progress', phase));
   assert.equal(poll.state.quoteStatus, phase);
 }
 const completed = advance(poll, receipt('completed', 'accepted'));
 assert.equal(completed.status, 'SUCCESS');
 assert.equal(poll.state.settledCredits, 36.5);
 const old = {...done, status: 'failed', video_count: 0, error: {message: 'limit exceeded'}};
 const historical = {taskId: ack.id, publicTaskId: ctx.publicTaskId, state: {...state(), acceptedQuoteCredits: 73}};
 assert.equal(advance(historical, old).status, 'FAILURE');
 assert.equal(historical.state.quoteStatus, 'quoted');
 assert.equal(historical.state.acceptedQuoteCredits, undefined);
 const oldSuccess = {...historical, state: state()};
 assert.equal(advance(oldSuccess, done).status, 'SUCCESS');
 assert.equal(oldSuccess.state.quoteStatus, 'accepted');
 assert.equal(oldSuccess.state.settledCredits, 73);
});

test('public video delivery follows official terminal task status', async () => {
 const p=await load(config);
 const completed={...done,phase:'completed',recovery:{action:'completed',message:'生成完成'},content_expires_at:4_000_000_000};
 const render=(status,progress,fail_reason)=>p.protocols.openai_video.render({}, {status,progress,fail_reason,data:completed});
 const pending=render('IN_PROGRESS','30%');
 assert.equal(pending.video_count,0);assert.equal(pending.phase,'needs_attention');assert.equal(pending.recovery.action,'manual_review');
 assert.equal(pending.content_expires_at,undefined);assert.equal(pending.error,undefined);
 assert.deepEqual(p.listArtifacts({status:'IN_PROGRESS',data:completed}),[]);
 const reason='无法完成结算，预扣已退回';
 const failed=render('FAILURE','100%',reason);
 assert.equal(failed.video_count,0);assert.equal(failed.phase,'failed');assert.equal(failed.error.message,reason);
 assert.equal(failed.recovery.message,reason);assert.equal(failed.recovery.action,'review_failure');
 assert.equal(failed.content_expires_at,undefined);
 const delivered=render('SUCCESS','100%');
 assert.equal(delivered.video_count,2);assert.equal(delivered.phase,'completed');assert.equal(delivered.content_expires_at,completed.content_expires_at);
});


test('failure cannot refund contradictory accepted quotes or known delivered videos', async () => {
 const p=await load(config);
 const first={...done,status:'in_progress',video_count:0,billing:{...done.billing,credits:300,quoted_credits:300,quote_status:'accepted'}};
 const original={taskId:ack.id,publicTaskId:ctx.publicTaskId,state:p.parseSubmitResponse(ctx,{body:ack}).state,data:ack};
 const parsed=p.parseTaskResult(original,first,{status:200});
 const poll={...original,state:JSON.parse(JSON.stringify(parsed.state)),data:first};
 const failed={...first,status:'failed',video_count:0,error:{message:'20115:本次生成的输出视频未通过版权审核'}};
 const missingCount={...failed,billing:ack.billing};delete missingCount.video_count;
 for(const body of [
  missingCount,
  {...failed,billing:{...failed.billing,credits:301,quoted_credits:301}},
  {...failed,billing:{...failed.billing,quote_status:'broken'}},
  {...failed,video_count:1},
 ]) {
  const result=p.parseTaskResult(poll,body,{status:200});
  assert.equal(result.status,'UNKNOWN');assert.equal(result.state,undefined);
  assert.deepEqual(p.extractUsageOnComplete(poll,result,body),{});
 }
 // Actual zero-delivery rejection may have no price; a quote contradiction may not.
 for(const billing of [failed.billing,ack.billing]) {
  const result=p.parseTaskResult(poll,{...failed,billing},{status:200});
  assert.equal(result.status,'FAILURE');assert.equal(result.reason,failed.error.message);
 }
 const repaired={...first,status:'completed',video_count:1};
 const result=p.parseTaskResult(poll,repaired,{status:200});
 assert.equal(result.status,'SUCCESS');assert.equal(result.state.settledCredits,150);
});

test('credit prices retain the normalized resolution through frozen submission and completion', async () => {
 const p=await load(config);
 assert.equal(p.meta.usageSchema.resolution.description.zh,'输出视频分辨率');
 for(const [resolution,seconds,credits] of [['480p',10,120],['720p',6,120]]) {
  const c={...ctx,requestBody:{...ctx.requestBody,n:1,seconds,resolution:resolution.toUpperCase()}};
  assert.deepEqual(p.extractUsage(c),{credits,resolution});
  const receipt={...ack,n:1,seconds,resolution,billing:{...ack.billing,reserved_credits:credits}};
  const poll={taskId:ack.id,publicTaskId:ctx.publicTaskId,state:p.parseSubmitResponse(c,{body:receipt}).state};
  const body={...receipt,terminal_proof:true,delivery_verified:true,status:'completed',video_count:1,billing:{...receipt.billing,credits,basis:'accepted_quote'}};
  const result=p.parseTaskResult(poll,body,{status:200});
  assert.equal(result.status,'SUCCESS');
  assert.deepEqual(p.extractUsageOnComplete(poll,result,body),{credits,resolution});
  const tampered=p.parseTaskResult(poll,{...body,resolution:resolution==='480p'?'720p':'480p'},{status:200});
  assert.equal(tampered.status,'UNKNOWN');
 }
});


test('unverified or expired content cannot become a new billable delivery', async () => {
 const p=await load(config);
 const poll={taskId:ack.id,publicTaskId:ctx.publicTaskId,state:p.parseSubmitResponse(ctx,{body:ack}).state,data:ack};
 for(const change of [
  {terminal_proof:false},{delivery_verified:false},
  {terminal_proof:undefined},{delivery_verified:undefined},
  {terminal_proof:'true'},{delivery_verified:1},
 ]) {
  const body={...done,...change};
  const result=p.parseTaskResult(poll,body,{status:200});
  assert.equal(result.status,'UNKNOWN');
  assert.deepEqual(p.extractUsageOnComplete(poll,result,body),{});
 }
 const expired={...done,content_expired:true,delivery_verified:false,content_expires_at:1};
 const result=p.parseTaskResult(poll,expired,{status:200});
 assert.equal(result.status,'FAILURE');assert.match(result.reason,/保留期限/);
 assert.deepEqual(p.extractUsageOnComplete(poll,result,expired),{});
 // Expiration does not make a contradictory quotation safe to refund.
 const accepted={...done,status:'in_progress',video_count:0};
 const observed=p.parseTaskResult(poll,accepted,{status:200});
 const frozen={...poll,state:observed.state,data:accepted};
 const disputed={...expired,billing:{...expired.billing,credits:99}};
 const blocked=p.parseTaskResult(frozen,disputed,{status:200});
 assert.equal(blocked.status,'UNKNOWN');assert.equal(blocked.state,undefined);
 assert.deepEqual(p.extractUsageOnComplete(frozen,blocked,disputed),{});
 const valid={...done,terminal_proof:true,delivery_verified:true};
 const recovered=p.parseTaskResult(poll,valid,{status:200});
 assert.equal(recovered.status,'SUCCESS');
 assert.equal(p.extractUsageOnComplete(poll,recovered,valid).credits,73);
});


test('private receipt headers bind the current poll and supply completion facts without public billing data', async () => {
 const p=await load(config);
 const response=body=>({status:200,headers:{'X-Dreamina-Billing-Receipt':Buffer.from(JSON.stringify({id:body.id,billing:body.billing})).toString('base64')}});
 const publicBody=body=>{const {billing,...data}=body;return data;};
 assert.equal(p.buildSubmitRequest(ctx).headers['X-Dreamina-Receipt'],'header-v1');
 assert.equal(p.buildQueryRequest({...ctx,taskId:ack.id}).headers['X-Dreamina-Receipt'],'header-v1');
 const submitted=p.parseSubmitResponse(ctx,{...response(ack),body:publicBody(ack)});
 assert.equal(submitted.taskData.billing,undefined);
 const poll={taskId:ack.id,publicTaskId:ctx.publicTaskId,state:submitted.state,data:submitted.taskData};
 for(const [credits,count,expected] of [[73,1,36.5],[0,2,0],[300,1,150]]) {
  const body={...done,video_count:count,billing:{...done.billing,credits}};
  const data=publicBody(body), parsed=p.parseTaskResult(poll,data,response(body));
  assert.equal(parsed.status,'SUCCESS');
  assert.deepEqual(p.extractUsageOnComplete(poll,{status:parsed.status,plugin_state:parsed.state},data),{credits:expected,resolution:'480p'});
  assert.equal(data.billing,undefined);
  assert.deepEqual(p.extractUsageOnComplete(poll,{status:'UNKNOWN'},data),{});
  assert.throws(()=>p.extractUsageOnComplete(poll,{status:'SUCCESS'},data),/evidence/);
 }
 for(const bad of [undefined,'not-base64',Buffer.from(JSON.stringify({id:'other-job',billing:done.billing})).toString('base64')]) {
  const headers=bad===undefined?{}:{'X-Dreamina-Billing-Receipt':bad};
  const parsed=p.parseTaskResult(poll,publicBody(done),{status:200,headers});
  assert.equal(parsed.status,'UNKNOWN');assert.equal(parsed.state,undefined);
 }
 const mismatch={...done,billing:{...done.billing,request_id:'another-task'}};
 assert.equal(p.parseTaskResult(poll,publicBody(done),response(mismatch)).status,'UNKNOWN');
});
