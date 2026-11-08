import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm,readFile,writeFile} from 'node:fs/promises';
import {setImmediate} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Bridge,validateConfig,createServer} from './bridge.mjs';
import {readReference} from './media-input.mjs';
import {quotedCLI} from './fixtures/quote-cli.mjs';
import * as plugin from './plugin.js';
import {buildCreditPlugin} from './build-credit-plugin.mjs';

const catalog=JSON.parse(await readFile(new URL('./fixtures/video-models.json',import.meta.url),'utf8'));
const legacy='c2679e06-fce3-4b3c-9038-3729d426c2b8';
const mp4=Buffer.from('000000186674797069736f6d0000020069736f6d','hex');
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const request={kind:'video',model:'seedance_2.5',prompt:'a paper boat',seconds:5};
const flag=(a,name)=>a.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3);
async function fixture(t,overrides={},handler) {
  const dir=await mkdtemp(join(tmpdir(),'bridge-rotation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const cfg=validateConfig({token:'test-only-rotation-key-32-characters',dataDir:dir,cli:process.execPath,profile:'bridge',projectId:legacy,userId:'123',space:'personal',publicUrl:'http://127.0.0.1:8787',canvasTaskLimit:5,maxConcurrent:100,
    models:Object.fromEntries(catalog.items.map(m=>[m.model,{kind:'video',model:m.model,maxCredits:100}])),...overrides});
  const calls=[];
  const invoke=quotedCLI(async a=>{
    if(a[0]==='space')return {userId:'123',kind:'personal'};
    if(a[0]==='model' && a[1]==='list')return catalog;
    if(a[0]==='model')return {matches:[{generation:{generationKind:'sample',mode:'t2v',draftPromotion:{params:[{name:'resolution',rule:{stringValues:['1080p']}}]}}}]};
    if(handler)return handler(a);
    if(a[0]==='canvas')return {project:{projectId:flag(a,'project-id')}};
    if(a[0]==='node')return {submission:{state:'accepted'}};
    if(a[0]==='operation')return {state:'succeeded',resources:[{state:'succeeded',resourceId:'output'}]};
    if(a[0]==='resource' && a[1]==='upload')return {resourceId:flag(a,'resource-id'),mediaType:'image'};
    if(a[0]==='resource' && a[1]==='download'){
      const path=flag(a,'output');await writeFile(path,mp4);
      return {resourceId:a[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
    }
    throw Error('unexpected command');
  });
  const cli=async a=>{calls.push(a);return invoke(a);};
  const bridge=await Bridge.open(cfg,cli);t.after(()=>bridge.close());await bridge.preflight();
  return {bridge,cfg,cli,calls};
}


test('slow download does not occupy polling workers or block other canvases', async t=>{
  let unblock; const held=new Promise(r=>unblock=r); let downloading=false,polls=0;
  const {bridge}=await fixture(t,{pollWorkers:1,downloadWorkers:1},async a=>{
    if(a[0]==='canvas')return {project:{projectId:flag(a,'project-id')}};
    if(a[0]==='node')return {submission:{state:'accepted'}};
    if(a[0]==='operation'){polls++;return {state:'succeeded',resources:[{state:'succeeded',resourceId:'output'}]};}
    if(a[0]==='resource'){downloading=true;await Promise.race([held,new Promise(r=>setTimeout(r,1000))]);const path=flag(a,'output');await writeFile(path,mp4);return {resourceId:a[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};}
  });
  const a=bridge.jobs.get((await bridge.submit(request,'a')).id);
  const b=bridge.jobs.get((await bridge.submit(request,'b')).id);
  await bridge.processJob(a);await bridge.processJob(b);
  await bridge.tick(); // only observe completion; downloads have their own lane
  assert.equal(downloading,false);assert.equal(a.status,'in_progress');
  let pending;
  try {
    pending=bridge.tick();
    for(let i=0;i<100 && (!downloading || polls<2 || [...bridge.inFlight.values()].some(w=>w.lane==='poll'));i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(downloading,true);assert.equal(polls,2,'polling continues during held download');
    assert.equal([...bridge.inFlight.values()].filter(w=>w.lane==='poll').length,0);
    assert.equal([...bridge.inFlight.values()].filter(w=>w.lane==='download').length,1);
  } finally {unblock();await pending;}
  assert.equal(a.status,'completed');assert.equal(b.status,'in_progress');
  await bridge.tick();assert.equal(b.status,'completed');
});

test('observed success survives restart and downloads without re-querying or resubmitting',async t=>{
  const {bridge,cfg,cli,calls}=await fixture(t);
  const j=bridge.jobs.get((await bridge.submit(request,'restart')).id);
  await bridge.processJob(j);await bridge.processJob(j);
  assert.deepEqual(j.downloadResources,['output']);assert.equal(j.status,'in_progress');
  const timings=bridge.get(j.id).timings;
  assert.ok(timings.accepted_at_ms>=timings.submit_started_at_ms);
  assert.ok(timings.upstream_completed_observed_at_ms>=timings.accepted_at_ms);
  await bridge.close();calls.length=0;
  const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());
  await restored.tick();assert.equal(restored.get(j.id).status,'completed');
  assert.equal(calls.some(a=>['node','operation'].includes(a[0])),false);
  assert.ok(restored.get(j.id).timings.download_completed_at_ms>=timings.upstream_completed_observed_at_ms);
  assert.equal(restored.get(j.id).timings.accepted_at_ms,timings.accepted_at_ms);
});

test('poll spacing prevents repeated calls and records gaps and failures without exposing payloads',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});let polls=0;
  const {bridge}=await fixture(t,{},async a=>{
    if(a[0]==='canvas')return {project:{projectId:flag(a,'project-id')}};
    if(a[0]==='node')return {submission:{state:'accepted'}};
    if(a[0]==='operation'){polls++;if(polls===2)throw Error('secret upstream token');return {state:'running',resources:[]};}
  });
  const j=bridge.jobs.get((await bridge.submit(request,'paced')).id);
  await bridge.tick();await bridge.tick();await bridge.tick();assert.equal(polls,1);
  t.mock.timers.tick(2999);await bridge.tick();assert.equal(polls,1);
  t.mock.timers.tick(1);await bridge.tick();assert.equal(polls,2);
  const d=bridge.get(j.id);assert.equal(d.timings.poll_count,2);assert.equal(d.timings.poll_error_count,1);assert.equal(d.timings.max_poll_gap_ms,3000);
  assert.ok(d.timings.last_poll_finished_at_ms>=d.timings.last_poll_started_at_ms,'failed query also records its finish');
  assert.equal(JSON.stringify(d).includes('secret'),false);
});

test('catalogue refresh is shared, expires and never uses stale data after refresh failure',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const {bridge,cli}=await fixture(t);let reads=0,broken=false;
  bridge.cli=async a=>{if(a[0]==='model' && a[1]==='list'){reads++;if(broken)throw Error('unavailable');}return cli(a);};
  await Promise.all([bridge.refreshVideoCatalog(),bridge.refreshVideoCatalog()]);assert.equal(reads,0);
  t.mock.timers.tick(60001);
  await Promise.all([bridge.refreshVideoCatalog(),bridge.refreshVideoCatalog()]);assert.equal(reads,1);
  t.mock.timers.tick(60001);broken=true;
  await assert.rejects(bridge.refreshVideoCatalog(),/unavailable/);
  await assert.rejects(bridge.refreshVideoCatalog(),/unavailable/);assert.equal(reads,3);
});

test('context checks coalesce concurrent calls but recheck every subsequent workflow',async t=>{
  const {bridge}=await fixture(t);let checks=0,wrong=false;
  bridge.cli=async()=>{checks++;await Promise.resolve();return {userId:wrong?'other':'123',kind:'personal'};};
  await Promise.all([bridge.checkContext(),bridge.checkContext(),bridge.checkContext()]);assert.equal(checks,1);
  wrong=true;await assert.rejects(bridge.checkContext(),/context_mismatch/);assert.equal(checks,2);
});

test('100-task backlog is visited fairly with a bounded polling cadence',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const elapsed=[];
  for(const limits of [{pollMs:5000,pollWorkers:2},{pollMs:1000,pollWorkers:4}]) {
    const visited=new Set();
    const {bridge}=await fixture(t,{...limits,maxQueue:100},async a=>{
      if(a[0]==='operation'){visited.add(a[2]);return {state:'running',resources:[]};}
      throw Error('unexpected mutation');
    });
    for(let i=0;i<100;i++)bridge.jobs.get((await bridge.submit(request,'backlog-'+i)).id).status='in_progress';
    const start=Date.now();
    for(let i=0;i<110 && visited.size<100;i++) {await bridge.tick();if(visited.size<100)t.mock.timers.tick(limits.pollMs);}
    assert.equal(visited.size,100);elapsed.push(Date.now()-start);
  }
  assert.deepEqual(elapsed,[245000,24000]);
});

test('restart after a partial download resumes only missing resources',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  let broken=true;
  const {bridge,cfg,cli,calls}=await fixture(t,{},async a=>{
    if(a[0]==='canvas')return {project:{projectId:flag(a,'project-id')}};
    if(a[0]==='node')return {submission:{state:'accepted'}};
    if(a[0]==='operation')return {state:'succeeded',resources:[{state:'succeeded',resourceId:'first'},{state:'succeeded',resourceId:'second'}]};
    if(a[0]==='resource'){
      if(a[2]==='second' && broken)throw Error('temporary download failure');
      const path=flag(a,'output');await writeFile(path,mp4);return {resourceId:a[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
    }
  });
  const j=bridge.jobs.get((await bridge.submit({...request,n:2},'partial-restart')).id);
  await bridge.processJob(j);await bridge.processJob(j);await bridge.processJob(j);
  assert.equal(j.attention,'download_failed');assert.equal(j.files.length,1);assert.equal(j.status,'in_progress');
  await bridge.close();calls.length=0;broken=false;
  const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());
  t.mock.timers.setTime(j.diagnostics.next_download_at_ms+1);await restored.tick();
  assert.equal(restored.get(j.id).video_count,2);assert.equal(restored.get(j.id).status,'completed');
  assert.deepEqual(calls.filter(a=>a[0]!=='space').map(a=>a.slice(0,3)),[['resource','download','second']]);
  assert.equal(restored.jobs.get(j.id).submitId,j.submitId);assert.equal(restored.jobs.get(j.id).projectId,j.projectId);
});

test('oversized download fails visibly without resubmission and remains terminal after restart',async t=>{
  const {bridge,cfg,cli,calls}=await fixture(t,{},async a=>{
    if(a[0]==='resource')throw Object.assign(new Error('CLI failed'),{cliError:{code:'cli.download_too_large',message:'The media response exceeds the permitted download size.',request_id:'download-123'}});
  });
  const j=bridge.jobs.get((await bridge.submit(request,'oversized')).id);
  j.status='in_progress';j.terminalOperationState='succeeded';j.downloadResources=['output'];await bridge.save(j);
  await bridge.tick();const result=bridge.get(j.id);
  assert.equal(result.status,'failed');assert.equal(result.error.upstream_code,'cli.download_too_large');
  assert.match(result.error.message,/视频已生成.*下载.*大小限制/);
  assert.equal(result.diagnostics.last_error.request_id,'download-123');
  assert.equal(result.diagnostics.last_error.message,'The media response exceeds the permitted download size.');
  assert.equal(result.recovery.automatic_resubmit,false);assert.match(result.recovery.message,/请勿重新生成/);
  const parsed=plugin.parseTaskResult({},result,{status:200});
  assert.equal(parsed.status,'FAILURE');assert.match(parsed.reason,/cli.download_too_large.*下载大小限制/);
  const rendered=plugin.protocols.openai_video.render({},{status:'FAILURE',fail_reason:parsed.reason,data:result});
  assert.equal(rendered.error.upstream_code,'cli.download_too_large');
  await bridge.close();calls.length=0;
  const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());await restored.tick();
  assert.equal(restored.get(j.id).status,'failed');assert.deepEqual(restored.jobs.get(j.id).downloadResources,['output']);
  assert.equal(calls.some(a=>['resource','node','operation'].includes(a[0])),false);
});

test('bridge size limit rejects and removes oversized local media without exposing an artifact',async t=>{
  const {bridge}=await fixture(t,{maxMediaBytes:1});
  const j=bridge.jobs.get((await bridge.submit(request,'local-size')).id);
  j.status='in_progress';j.terminalOperationState='succeeded';j.downloadResources=['output'];await bridge.save(j);await bridge.tick();
  const result=bridge.get(j.id);assert.equal(result.status,'failed');
  assert.equal(result.error.upstream_code,'media_download_too_large');assert.equal(result.video_count,0);
  await assert.rejects(readFile(join(bridge.config.dataDir,j.id+'-0.bin.part')),{code:'ENOENT'});
});

test('download retries back off durably and exhaust without a new generation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const {bridge,cfg,cli,calls}=await fixture(t,{},async a=>{
    if(a[0]==='resource')throw Object.assign(new Error('CLI failed'),{cliError:{code:'cli.transport_failed',message:'Temporary transport error',request_id:'download-456'}});
  });
  const j=bridge.jobs.get((await bridge.submit(request,'retry-limit')).id);
  j.status='in_progress';j.terminalOperationState='succeeded';j.downloadResources=['output'];await bridge.save(j);
  await bridge.tick();const first=bridge.get(j.id);
  assert.equal(first.status,'in_progress');assert.equal(first.diagnostics.download_failures,1);
  assert.equal(first.diagnostics.last_error.code,'cli.transport_failed');
  assert.ok(first.diagnostics.next_download_at_ms>Date.now());
  await bridge.close();calls.length=0;
  const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());
  await restored.tick();assert.equal(calls.length,0,'restart must respect persisted retry deadline');
  for(let i=2;i<=5;i++){
    t.mock.timers.setTime(restored.get(j.id).diagnostics.next_download_at_ms+1);
    await restored.tick();assert.equal(restored.get(j.id).diagnostics.download_failures,i);
  }
  const result=restored.get(j.id);assert.equal(result.status,'failed');assert.equal(result.error.upstream_code,'cli.transport_failed');
  assert.match(result.error.message,/下载失败.*重试/);assert.equal(result.diagnostics.next_download_at_ms,0);
  await restored.tick();assert.equal(calls.filter(a=>a[0]==='resource').length,4);
  assert.equal(calls.some(a=>['node','operation'].includes(a[0])),false);
});


test('context failure during delivery preserves the original download budget across restart',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const {bridge,cfg,cli,calls}=await fixture(t);
  const j=bridge.jobs.get((await bridge.submit(request,'context-download')).id);
  j.status='in_progress';j.terminalOperationState='succeeded';j.downloadResources=['output'];j.downloadAttempts=[3];await bridge.save(j);
  bridge.cli=async()=>{throw Object.assign(new Error('CLI failed'),{cliError:{code:'cli.auth_required',message:'Login required'}});};
  await bridge.tick();
  assert.equal(bridge.get(j.id).recovery.action,'manual_review');
  assert.equal(j.diagnostics.last_error.code,'cli.auth_required');
  assert.equal(j.diagnostics.download_failures,undefined);
  assert.deepEqual(j.downloadAttempts,[3]);
  const retryAt=j.diagnostics.next_context_check_at_ms;
  assert.ok(retryAt>Date.now());
  await bridge.close();calls.length=0;
  const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());
  await restored.tick();assert.deepEqual(calls,[]);
  t.mock.timers.setTime(retryAt);
  await restored.tick();
  assert.equal(restored.get(j.id).status,'completed');
  assert.equal(restored.get(j.id).video_count,1);
  assert.equal(calls.filter(a=>a[0]==='node'||a[0]==='operation').length,0);
  assert.equal(calls.filter(a=>a[0]==='resource').length,1);
});


test('a resource-level space error does not spend a download attempt',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  let denied=true;
  const {bridge,calls}=await fixture(t,{},async args=>{
    if(args[0]==='resource'){
      if(denied)throw Object.assign(Error('wrong space'),{cliError:{code:'cli.canvas_space_mismatch'}});
      const path=flag(args,'output');await writeFile(path,mp4);
      return {resourceId:args[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
    }
    throw Error('unexpected '+args[0]);
  });
  const job=bridge.jobs.get((await bridge.submit(request,'space-download')).id);
  job.status='in_progress';job.terminalOperationState='succeeded';job.downloadResources=['original'];await bridge.save(job);
  await bridge.tick();const result=bridge.get(job.id);
  assert.equal(result.recovery.action,'manual_review');
  assert.deepEqual(job.downloadAttempts,[0]);
  assert.equal(job.diagnostics.download_failures,undefined);
  assert.equal(job.diagnostics.last_error.code,'cli.canvas_space_mismatch');
  await bridge.tick();assert.equal(calls.filter(a=>a[0]==='resource').length,1);
  denied=false;t.mock.timers.setTime(job.diagnostics.next_context_check_at_ms+1);await bridge.tick();
  assert.equal(bridge.get(job.id).video_count,1);
  assert.equal(calls.filter(a=>a[0]==='node'||a[0]==='operation').length,0);
});

test('queued identity lookup backs off, survives restart, and reports the reason at its deadline',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const {bridge,cfg}=await fixture(t,{maxQueueWaitSeconds:70});
  const j=bridge.jobs.get((await bridge.submit(request,'identity-before-submit')).id);
  let checks=0;
  const missing = async a=>{
    if(a[0]==='space'){checks++;throw Object.assign(Error('lookup unavailable'),{cliError:{code:'cli.transport_failed'}});}
    throw Error('unexpected '+a[0]);
  };
  bridge.cli=missing;await bridge.tick();await bridge.tick();assert.equal(checks,1);
  assert.equal(j.status,'queued');assert.ok(j.diagnostics.next_context_check_at_ms>Date.now());
  await bridge.close();
  const restored=await Bridge.open(cfg,missing);t.after(()=>restored.close());
  restored.observe(j.id);await restored.tick();assert.equal(checks,1);
  t.mock.timers.setTime(160001);await restored.tick();assert.equal(checks,2);
  t.mock.timers.setTime(170001);await restored.tick();
  const result=restored.get(j.id);
  assert.equal(checks,2);assert.equal(result.status,'failed');assert.equal(result.error.code,'credit_subject_unverified');
  assert.equal(result.error.upstream_code,'cli.transport_failed');
});

test('reference uploads share a global bound and preserve reference order across jobs', async t=>{
  let release;const held=new Promise(r=>release=r);t.after(()=>release());let active=0,peak=0;
  const {bridge,calls}=await fixture(t,{uploadWorkers:4},async a=>{
    if(a[0]==='canvas')return {project:{projectId:flag(a,'project-id')}};
    if(a[0]==='node')return {submission:{state:'accepted'}};
    if(a[0]==='resource'&&a[1]==='upload'){
      active++;peak=Math.max(peak,active);await held;active--;
      return {resourceId:flag(a,'resource-id'),mediaType:'image'};
    }
    throw Error('unexpected command');
  });
  const body={...request,mode:'m2v',references:Array.from({length:6},()=>({type:'image',url:png}))};
  const jobs=[];for(const key of ['parallel-a','parallel-b'])jobs.push(bridge.jobs.get((await bridge.submit(body,key)).id));
  const runs=jobs.map(j=>bridge.processJob(j));
  try{for(let i=0;i<100&&active<4;i++)await new Promise(r=>setTimeout(r,5));assert.equal(active,4,'independent reference uploads should start together');}
  finally{release();await Promise.all(runs)}
  assert.equal(peak,4,'all jobs share one upload capacity');
  for(const job of jobs){assert(job.inputs.every(i=>i.uploaded));const call=calls.find(a=>a[0]==='node'&&flag(a,'node-id')===job.nodeId);assert.deepEqual(call.filter(a=>a.startsWith('--ref=')),job.inputs.map(i=>'--ref=res:'+i.resourceId));assert.equal(job.status,'in_progress')}
});

test('failed parallel upload drains outstanding work and retries only missing inputs', async t=>{
  let release;const held=new Promise(r=>release=r);t.after(()=>release());let first=true,active=0,attempts=new Map(),failedId;
  const {bridge,calls}=await fixture(t,{uploadWorkers:2},async a=>{
    if(a[0]==='canvas')return {project:{projectId:flag(a,'project-id')}};
    if(a[0]==='node')return {submission:{state:'accepted'}};
    if(a[0]==='resource'){
      const id=flag(a,'resource-id');attempts.set(id,(attempts.get(id)||0)+1);
      if(id===failedId&&first){first=false;throw Error('temporary upload failure')}
      active++;await held;active--;return {resourceId:id,mediaType:'image'};
    }
    throw Error('unexpected command');
  });
  const job=bridge.jobs.get((await bridge.submit({...request,mode:'m2v',references:[{type:'image',url:png},{type:'image',url:png}]},'partial-upload')).id);
  failedId=job.inputs[0].resourceId;
  let settled=false;const run=bridge.processJob(job).finally(()=>settled=true);
  try{for(let i=0;i<100&&!active;i++)await new Promise(r=>setTimeout(r,5));assert.equal(active,1);assert.equal(settled,false,'do not release submit slot while uploads remain');assert.equal(calls.filter(a=>a[0]==='node').length,0)}finally{release();await run}
  assert.equal(job.status,'queued');assert.equal(job.attention,'reference_upload_pending');
  assert.equal(job.inputs[1].uploaded,true);
  await bridge.processJob(job);assert.equal(job.status,'in_progress');
  assert.equal(attempts.get(job.inputs[0].resourceId),2);assert.equal(attempts.get(job.inputs[1].resourceId),1);
  assert.equal(calls.filter(a=>a[0]==='node'&&a[1]==='run').length,1);
});

test('short terminal batches deliver the verified subset; a running batch waits for other results', async t => {
  for (const finalState of ['failed', 'succeeded']) {
    let done = false;
    const {bridge, calls} = await fixture(t, {}, async a => {
      if (a[0] === 'canvas') return {project:{projectId:flag(a,'project-id')}};
      if (a[0] === 'node') return {submission:{state:'accepted'}};
      if (a[0] === 'operation') return {operationRef:a[2], state:done ? finalState : 'running', resources:done && finalState === 'succeeded' ? [{state:'succeeded',resourceId:'survivor'},{state:'succeeded',resourceId:'survivor'}] : [{state:'succeeded',resourceId:'survivor'}]};
      if (a[0] === 'resource') {
        const path = flag(a,'output'); await writeFile(path,mp4);
        return {resourceId:a[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
      }
      throw Error('unexpected command');
    });
    const job = bridge.jobs.get((await bridge.submit({...request,n:2}, finalState)).id);
    await bridge.processJob(job);
    await bridge.processJob(job);
    assert.equal(job.downloadResources, undefined);
    done = true;
    await bridge.processJob(job);
    await bridge.processJob(job);
    const reply = bridge.get(job.id);
    assert.equal(reply.status, 'completed');
    assert.equal(reply.n, 2); assert.equal(reply.video_count, 1);
    assert.deepEqual(calls.filter(a => a[0] === 'resource').map(a => a[2]), ['survivor']);
  }
});

test('restart after mixed download outcomes preserves files and charges only verified deliveries', async t => {
  t.mock.timers.enable({apis:['Date'],now:100000});
  const payloads = {second:Buffer.concat([mp4,Buffer.from('second')]), fourth:Buffer.concat([mp4,Buffer.from('fourth')])};
  const {bridge,cfg,cli,calls} = await fixture(t, {}, async a => {
    if (a[0] === 'canvas') return {project:{projectId:flag(a,'project-id')}};
    if (a[0] === 'node') return {submission:{state:'accepted'}};
    if (a[0] === 'operation') return {operationRef:a[2],state:'succeeded',resources:['oversize','second','transport','fourth'].map(resourceId => ({state:'succeeded',resourceId}))};
    if (a[0] === 'resource') {
      if (a[2] === 'oversize') throw Object.assign(Error(), {cliError:{code:'cli.download_too_large'}});
      if (a[2] === 'transport') throw Object.assign(Error(), {cliError:{code:'cli.transport_failed'}});
      const bytes = payloads[a[2]];
      const path = flag(a,'output'); await writeFile(path,bytes);
      return {resourceId:a[2],path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    }
    throw Error('unexpected command');
  });
  const job = bridge.jobs.get((await bridge.submit({...request,n:4}, 'mixed-downloads')).id);
  await bridge.processJob(job); await bridge.processJob(job); await bridge.processJob(job);
  assert.equal(job.status, 'in_progress');
  assert.deepEqual(job.files.map(f => f.resourceId), ['second', 'fourth']);
  await bridge.close(); calls.length=0;
  const restored=await Bridge.open(cfg,cli); t.after(()=>restored.close());
  for (let i=0; i<4; i++) {
    t.mock.timers.setTime(restored.get(job.id).diagnostics.next_download_at_ms+1);
    await restored.tick();
  }
  const reply = restored.get(job.id);
  assert.equal(reply.status, 'completed'); assert.equal(reply.n, 4); assert.equal(reply.video_count, 2);
  const saved = await restored.loadJob(job.id);
  assert.deepEqual(saved.files.map(f=>f.resourceId), ['second','fourth']);
  const server = createServer(restored);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = 'http://127.0.0.1:' + server.address().port + '/v1/jobs/' + job.id + '/content/';
  const headers = {Authorization:'Bearer ' + cfg.token};
  for (const [i,key] of ['second','fourth'].entries()) {
    const media = await fetch(url + i, {headers});
    assert.equal(media.status, 200); assert.equal(media.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), payloads[key]);
  }
  assert.equal((await fetch(url + '2', {headers})).status, 404);
  assert.deepEqual(calls.filter(a=>a[0]!=='space').map(a=>a.slice(0,3)), Array(4).fill(['resource','download','transport']));
  assert.deepEqual(plugin.listArtifacts({status:'SUCCESS',data:reply}, {}).map(a=>a.key), ['video','video-2']);
});

test('restart reacquires a missing, equal-size corrupted or legacy checkpoint before publishing', async t => {
  for (const scenario of ['missing','corrupt','legacy']) await t.test(scenario, async t => {
    t.mock.timers.enable({apis:['Date'],now:100000});
    let earlyFails = true;
    const {bridge,cfg,cli,calls} = await fixture(t,{},async a => {
      if (a[0]==='resource') {
        if (earlyFails && a[2] === 'first') throw Error('transport');
        const path = flag(a,'output'); await writeFile(path,mp4);
        return {resourceId:a[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
      }
      throw Error('unexpected command');
    });
    const job = bridge.jobs.get((await bridge.submit({...request,n:2},'restore-missing-file')).id);
    job.status='in_progress'; job.terminalOperationState='succeeded'; job.downloadResources=['first','second']; await bridge.save(job);
    await bridge.processJob(job);
    assert.deepEqual(job.files.map(f=>f.resourceId),['second']);
    if (scenario==='legacy') {
      delete job.files[0].sha256;
      await bridge.save(job);
    }
    await bridge.close(); calls.length=0;
    const checkpoint=join(cfg.dataDir,job.files[0].filename);
    if (scenario==='missing') await rm(checkpoint);
    if (scenario==='corrupt') await writeFile(checkpoint, Buffer.alloc(mp4.length));
    earlyFails=false;
    const restored=await Bridge.open(cfg,cli); t.after(()=>restored.close());
    t.mock.timers.setTime(restored.get(job.id).diagnostics.next_download_at_ms+1);
    await restored.tick();
    assert.equal(restored.get(job.id).video_count,2);
    const saved=await restored.loadJob(job.id);
    assert.deepEqual(saved.files.map(f=>f.resourceId), ['first','second']);
    assert.deepEqual(await readFile(checkpoint), mp4);
    assert.equal(saved.files[1].sha256, createHash('sha256').update(mp4).digest('hex'));
    assert.deepEqual(calls.filter(a=>a[0]!=='space').map(a=>a.slice(0,3)),[['resource','download','first'],['resource','download','second']]);
  });
});

test('mixed aggregate failure waits for the explicitly running resource before publishing any count', async t => {
  let reads = 0;
  const {bridge} = await fixture(t, {}, async args => {
    if (args[0] === 'canvas') return {project:{projectId:flag(args,'project-id')}};
    if (args[0] === 'node') return {submission:{state:'accepted'}};
    if (args[0] === 'operation') {
      reads++;
      return {operationRef:args[2], state:'failed', resources:[
        {resourceId:'first',state:'succeeded'}, {resourceId:'bad',state:'failed'},
        {resourceId:'last',state:reads === 1 ? 'running' : 'succeeded'}]};
    }
    if (args[0] === 'resource') {
      const path = flag(args,'output'); await writeFile(path,mp4);
      return {resourceId:args[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
    }
    throw Error('unexpected command');
  });
  const job=bridge.jobs.get((await bridge.submit({...request,n:3},'mixed-states')).id);
  await bridge.processJob(job); await bridge.processJob(job);
  assert.equal(job.status,'in_progress'); assert.equal(job.downloadResources,undefined);
  await bridge.processJob(job); await bridge.processJob(job);
  assert.equal(reads,2); assert.equal(bridge.get(job.id).video_count,2);
  assert.deepEqual(job.files.map(f=>f.resourceId),['first','last']);
});

test('mismatched and missing download receipt IDs cannot publish a different verified MP4', async t => {
  const {bridge} = await fixture(t, {}, async args => {
    const path=flag(args,'output'); await writeFile(path,mp4);
    const receipt={path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
    if(args[2] !== 'missing') receipt.resourceId=args[2]==='wrong'?'other':args[2];
    return receipt;
  });
  const job=bridge.jobs.get((await bridge.submit({...request,n:3},'download-identity')).id);
  job.status='in_progress'; job.terminalOperationState='succeeded'; job.downloadResources=['wrong','right','missing'];
  for(let i=0;i<5;i++)await bridge.processJob(job);
  assert.equal(bridge.get(job.id).video_count,1);
  assert.deepEqual(job.files.map(f=>f.resourceId),['right']);
});

test('a short terminal response after restart retains successes from an earlier poll of the same operation', async t => {
  let stage = 0;
  const {bridge,cfg,cli}=await fixture(t, {}, async args=>{
    if(args[0]==='canvas')return {project:{projectId:flag(args,'project-id')}};
    if(args[0]==='node')return {submission:{state:'accepted'}};
    if(args[0]==='operation'){
      stage++;
      return {operationRef:args[2],state:stage===1?'running':'failed',
        resources:stage===1?[{resourceId:'earlier',state:'succeeded'},{resourceId:'later',state:'running'}]:
          [{resourceId:'later',state:'succeeded'}]};
    }
    const path=flag(args,'output');await writeFile(path,mp4);
    return {resourceId:args[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
  });
  const job=bridge.jobs.get((await bridge.submit({...request,n:3},'shrinking-list')).id);
  await bridge.processJob(job);await bridge.processJob(job);await bridge.close();
  const recovered=await Bridge.open(cfg,cli);t.after(()=>recovered.close());
  const restored=recovered.jobs.get(job.id);
  await recovered.processJob(restored);await recovered.processJob(restored);
  assert.equal(recovered.get(job.id).video_count,2);
  assert.deepEqual(restored.files.map(f=>f.resourceId),['earlier','later']);
});

test('unknown submission facts cannot turn unrelated cached resources into a paid delivery', async t => {
  let recovered=false;
  const {bridge}=await fixture(t,{}, async args=>{
    if(args[0]==='operation')return recovered
      ? {operationRef:args[2],state:'completed',submission:{state:'completed'},resources:[{state:'succeeded',resourceId:'right'}]}
      : {operationRef:args[2],state:'unknown',submission:{state:'absent'},resources:[{state:'succeeded',resourceId:'wrong'}]};
    if(args[0]==='resource'){
      assert.equal(args[2],'right');const path=flag(args,'output');await writeFile(path,mp4);
      return {resourceId:args[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
    }
    throw Error('unexpected command');
  });
  const job=bridge.jobs.get((await bridge.submit(request,'ambiguous-cached-results')).id);
  // Fault after dispatch but before the acknowledgement is persisted.
  job.status='in_progress';await bridge.save(job);
  await bridge.processJob(job);
  assert.equal(job.attention,'manual_recovery_required');
  assert.equal(job.timings.accepted_observed_at_ms,undefined);
  assert.equal(job.observedSuccessIds,undefined);assert.equal(job.downloadResources,undefined);
  recovered=true;await bridge.processJob(job);await bridge.processJob(job);
  assert.equal(bridge.get(job.id).video_count,1);
  assert.deepEqual(job.files.map(f=>f.resourceId),['right']);
});

test('only a definitive refusal releases a pending placeholder beside a successful video', async t => {
  for (const [state,refused] of [['pending',true],['pending',false],['running',true],['in_progress',true],['processing',true]]) {
    await t.test(state + (refused ? ' with refusal' : ' without refusal'), async t=>{
      let final=false;
      const {bridge}=await fixture(t,{},async args=>{
        if(args[0]==='canvas')return {project:{projectId:flag(args,'project-id')}};
        if(args[0]==='node')return {submission:{state:'accepted'}};
        if(args[0]==='operation')return {operationRef:args[2],state:'failed',submission:{state:refused?'rejected':'completed'},
          ...(refused?{submissionError:{serviceCode:20110,retryable:false}}:{}),
          resources:[{resourceId:'survivor',state:'succeeded'},{resourceId:'other',state:final?'succeeded':state}]};
        const path=flag(args,'output');await writeFile(path,mp4);
        return {resourceId:args[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
      });
      const job=bridge.jobs.get((await bridge.submit({...request,n:2},'refusal-'+state+'-'+refused)).id);
      await bridge.processJob(job);await bridge.processJob(job);
      const placeholder = state === 'pending' && refused;
      if(!placeholder) {
        assert.equal(job.downloadResources,undefined);
        assert.equal(job.status,'in_progress');
        final=true;
        await bridge.processJob(job);
      }
      await bridge.processJob(job);
      const reply=bridge.get(job.id);
      assert.equal(reply.status,'completed');assert.equal(reply.n,2);
      assert.equal(reply.video_count,placeholder?1:2);
      assert.deepEqual(job.files.map(f=>f.resourceId),placeholder?['survivor']:['survivor','other']);
    });
  }
});

test('conflicting states for the same output are rechecked without blocking independent refused placeholders', async t=>{
  let consistent=false;
  const {bridge}=await fixture(t,{},async args=>{
    if(args[0]==='canvas')return {project:{projectId:flag(args,'project-id')}};
    if(args[0]==='node')return {submission:{state:'accepted'}};
    if(args[0]==='operation')return {operationRef:args[2],state:'failed',submission:{state:'rejected'},
      resources:[{resourceId:'winner',state:'succeeded'},{resourceId:consistent?'unused':'winner',state:'pending'}]};
    const path=flag(args,'output');await writeFile(path,mp4);
    return {resourceId:args[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
  });
  const job=bridge.jobs.get((await bridge.submit({...request,n:2},'contradictory-outcomes')).id);
  await bridge.processJob(job);await bridge.processJob(job);
  assert.equal(job.attention,'resource_count_mismatch');assert.equal(job.downloadResources,undefined);
  consistent=true;await bridge.processJob(job);await bridge.processJob(job);
  assert.equal(bridge.get(job.id).video_count,1);
});


test('a provisional success cannot authorize delivery before the original operation is terminal', async t => {
  let reads = 0;
  const {bridge,calls} = await fixture(t, {canvasTaskLimit:0}, async args => {
    if (args[0] === 'node') return {submission:{state:'accepted',resources:[{resourceId:'a',state:'pending'}]}};
    if (args[0] === 'operation') {
      reads++;
      return reads === 1 ? {operationRef:args[2],state:'running',resources:[{resourceId:'a',state:'succeeded'}]} :
        {operationRef:args[2],state:'failed',resources:[{resourceId:'a',state:'failed',serviceCode:20115}]};
    }
    throw Error('a rejected output must not be downloaded');
  });
  const j=bridge.jobs.get((await bridge.submit(request,'provisional-running')).id);
  await bridge.processJob(j); await bridge.processJob(j);
  assert.equal(j.downloadResources,undefined);
  await bridge.processJob(j);
  assert.equal(j.status,'failed');assert.equal(j.error.upstream_code,20115);
  assert.equal(bridge.get(j.id).video_count,0);
  assert.equal(calls.some(a=>a[0]==='resource'),false);
});

test('acceptance binds output identities and survives restart and a short terminal receipt', async t => {
  for (const replace of [false,true]) await t.test(replace?'different output':'original partial delivery', async t=>{
    const {bridge,cfg,cli,calls}=await fixture(t,{canvasTaskLimit:0},async args=>{
      if (args[0]==='node') return {submission:{state:'accepted',resources:[
        {resourceId:'a',state:'succeeded'},{resourceId:'b',state:'running'}]}};
      if (args[0]==='operation') return {operationRef:args[2],state:'failed',resources:[
        replace?{resourceId:'foreign',state:'succeeded'}:{resourceId:'b',state:'failed',serviceCode:20115}]};
      const path=flag(args,'output');await writeFile(path,mp4);
      return {resourceId:args[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
    });
    const id=(await bridge.submit({...request,n:2}, 'accepted-members-'+replace)).id;
    await bridge.processJob(bridge.jobs.get(id));await bridge.close();
    const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());
    const j=restored.jobs.get(id);await restored.processJob(j);await restored.processJob(j);
    const reply=restored.get(id);
    if (replace) {
      assert.equal(reply.video_count,0);assert.equal(reply.recovery.action,'manual_review');
      assert.equal(calls.some(a=>a[0]==='resource'),false);
    } else {
      assert.equal(reply.status,'completed');assert.equal(reply.video_count,1);
      assert.deepEqual(j.files.map(f=>f.resourceId),['a']);
    }
    assert.equal(calls.filter(a=>a[1]==='run').length,1);
  });
});

test('a pending pre-upgrade download checkpoint rechecks its original operation before delivery', async t=>{
  const {bridge,cfg,cli,calls}=await fixture(t,{canvasTaskLimit:0}, async args=>{
    if (args[0]==='operation') return {operationRef:args[2],state:'failed',resources:[{resourceId:'stale',state:'failed',serviceCode:20115}]};
    if (args[0]==='resource') {const path=flag(args,'output');await writeFile(path,mp4);return {resourceId:args[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};}
    throw Error('unexpected mutation');
  });
  const j=bridge.jobs.get((await bridge.submit(request,'old-download-checkpoint')).id);
  j.status='in_progress';j.downloadResources=['stale'];j.observedSuccessIds=['stale'];await bridge.save(j);await bridge.close();
  const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());await restored.tick();
  assert.equal(restored.get(j.id).error?.upstream_code,20115);assert.equal(restored.get(j.id).video_count,0);
  assert.equal(calls.some(args=>args[0]==='resource'||args[1]==='run'),false);
});

test('an active legacy task still polls, downloads and settles seconds after restart',async t=>{
  const {bridge,cfg,cli,calls}=await fixture(t,{canvasTaskLimit:0});
  const job=bridge.jobs.get((await bridge.submit(request,'active-legacy')).id);
  job.status='in_progress';delete job.billingMode;
  const previous=bridge.get(job.id);delete previous.billing_mode;delete previous.terminal_proof;
  await bridge.save(job);await bridge.close();calls.length=0;
  const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());
  await restored.tick();await restored.tick();
  const receipt=await restored.observe(job.id);
  assert.equal(receipt.status,'completed');assert.equal(receipt.billing_mode,'legacy_seconds');assert.equal(receipt.video_count,1);
  const creditPlugin=await import('data:text/javascript;base64,'+Buffer.from(await buildCreditPlugin({models:['seedance_2.5']})).toString('base64'));
  const poll={taskId:job.id,publicTaskId:'active-legacy',data:previous,state:null};
  const parsed=creditPlugin.parseTaskResult(poll,receipt,{status:200});
  assert.equal(parsed.status,'SUCCESS');assert.deepEqual(creditPlugin.extractUsageOnComplete(poll,parsed,receipt),{seconds:5});
  assert.equal(calls.filter(args=>args[0]==='operation').length,1);assert.equal(calls.filter(args=>args[1]==='download').length,1);
  assert.equal(calls.some(args=>args[1]==='run'),false);
});

test('a failed terminal receipt without child outcomes cannot publish a provisional success', async t=>{
  let phase=0;
  const {bridge,calls}=await fixture(t,{canvasTaskLimit:0}, async args=>{
    if (args[0]==='node') return {submission:{state:'accepted',resources:[{resourceId:'a',state:'succeeded'}]}};
    if (args[0]==='operation') {
      phase++;
      return {operationRef:args[2],state:'failed',resources:phase===1?[]:[{resourceId:'a',state:'failed',serviceCode:20115}]};
    }
    throw Error('unexpected download');
  });
  const j=bridge.jobs.get((await bridge.submit(request,'ambiguous-terminal-denial')).id);
  await bridge.processJob(j);await bridge.processJob(j);
  assert.equal(j.attention,'resources_missing');assert.equal(j.downloadResources,undefined);
  await bridge.processJob(j);
  assert.equal(j.status,'failed');assert.equal(j.error.upstream_code,20115);
  assert.equal(calls.some(a=>a[0]==='resource'),false);
});

test('an unrelated run receipt cannot poison recovery of the original accepted operation', async t => {
  const {bridge,calls}=await fixture(t,{canvasTaskLimit:0},async args=>{
    if(args[0]==='node')return {consumptionSubject:{kind:'personal',userId:'456'},items:[{nodeId:'node_foreign',submitId:'foreign',state:'accepted',resources:[{resourceId:'foreign',state:'succeeded'}]}]};
    if(args[0]==='operation')return {operationRef:args[2],state:'succeeded',submission:{state:'completed'},resources:[{resourceId:'original',state:'succeeded'}]};
    const path=flag(args,'output');await writeFile(path,mp4);return {resourceId:args[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
  });
  const job=bridge.jobs.get((await bridge.submit(request,'foreign-run',false,{version:2,request_id:'foreign-run',reserved_credits:60})).id);
  await bridge.processJob(job);await bridge.processJob(job);await bridge.processJob(job);
  assert.equal(job.status,'completed');assert.deepEqual(job.files.map(f=>f.resourceId),['original']);
  assert.equal(bridge.get(job.id).billing.credits,10);assert.equal(calls.filter(a=>a[1]==='run').length,1);
});

test('a shortened terminal receipt retains every previously running output across restart', async t=>{
  let reads=0;
  const {bridge,cfg,cli,calls}=await fixture(t,{canvasTaskLimit:0},async args=>{
    if(args[0]==='node')return {submission:{state:'accepted',resources:[{resourceId:'A',state:'running'},{resourceId:'B',state:'running'}]}};
    if(args[0]==='operation')return {operationRef:args[2],state:++reads===1?'running':'failed',resources:reads===1?
      [{resourceId:'A',state:'succeeded'},{resourceId:'B',state:'running'}]:reads===2?
      [{resourceId:'A',state:'succeeded'}]:[{resourceId:'A',state:'succeeded'},{resourceId:'B',state:'succeeded'}]};
    const path=flag(args,'output');await writeFile(path,mp4);return {resourceId:args[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
  });
  const job=bridge.jobs.get((await bridge.submit({...request,n:2},'known-pending')).id);
  await bridge.processJob(job);await bridge.processJob(job);await bridge.close();
  const recovered=await Bridge.open(cfg,cli);t.after(()=>recovered.close());const restored=recovered.jobs.get(job.id);
  await recovered.processJob(restored);
  assert.equal(restored.downloadResources,undefined);assert.equal(recovered.get(job.id).video_count,0);
  await recovered.processJob(restored);await recovered.processJob(restored);
  assert.equal(reads,3);assert.deepEqual(restored.files.map(f=>f.resourceId),['A','B']);
  assert.equal(calls.filter(a=>a[1]==='run').length,1);
});

test('the final resource order replaces the order in which provisional outputs became visible',async t=>{
  let reads=0;
  const {bridge}=await fixture(t,{canvasTaskLimit:0},async args=>{
    if(args[0]==='node')return {submission:{state:'accepted'}};
    if(args[0]==='operation')return {operationRef:args[2],state:++reads===1?'running':'succeeded',resources:reads===1?
      [{resourceId:'second',state:'succeeded'}]:[{resourceId:'first',state:'succeeded'},{resourceId:'second',state:'succeeded'}]};
    const path=flag(args,'output');await writeFile(path,mp4);return {resourceId:args[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
  });
  const job=bridge.jobs.get((await bridge.submit({...request,n:2},'final-order')).id);
  for(let i=0;i<4;i++)await bridge.processJob(job);
  assert.equal(job.status,'completed');assert.deepEqual(job.files.map(f=>f.resourceId),['first','second']);
});

test('a completed credit job must revalidate its original terminal outcome before a new receipt',async t=>{
  const {bridge,cfg,cli,calls}=await fixture(t,{canvasTaskLimit:0},async args=>{
    if(args[0]==='operation')return {operationRef:args[2],state:'failed',resources:[{resourceId:'provisional',state:'failed',serviceCode:20115}]};
    throw Error('must not generate or download a revoked provisional output');
  });
  const job=bridge.jobs.get((await bridge.submit(request,'upgrade-completed',false,{version:2,request_id:'upgrade-completed',reserved_credits:100})).id);
  job.status='completed';job.completed_at=Math.floor(Date.now()/1000);job.downloadResources=['provisional'];
  job.files=[{resourceId:'provisional',filename:job.id+'-0.bin',size:mp4.length,mime:'video/mp4',sha256:createHash('sha256').update(mp4).digest('hex')}];
  await writeFile(join(cfg.dataDir,job.files[0].filename),mp4);await bridge.save(job);await bridge.close();
  const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());
  assert.equal((await restored.observe(job.id)).status,'in_progress');
  await restored.tick();const receipt=await restored.observe(job.id);
  assert.equal(receipt.status,'failed');assert.equal(receipt.error.upstream_code,20115);assert.equal(receipt.video_count,0);
  assert.equal(calls.filter(a=>a[0]==='operation').length,1);assert.equal(calls.some(a=>a[1]==='run'),false);
});

test('saved draft recovery accepts the documented node show wrapper without creating another draft',async t=>{
  const {bridge,cli,calls}=await fixture(t,{canvasTaskLimit:0},async args=>{
    if(args[0]==='node')return {submission:{state:'accepted'}};
    throw Error('unexpected command');
  });
  const job=bridge.jobs.get((await bridge.submit(request,'nested-node')).id);let expire=true;
  bridge.cli=async args=>{
    if(args[1]==='show')return {nodes:[{nodeId:job.nodeId,result:'FOUND',node:{nodeId:job.nodeId,generation:{...job.request,durationSeconds:job.request.seconds,outputCount:job.request.n,references:[]}}}],draftVersion:1};
    const result=await cli(args);if(args[1]==='confirm'&&expire){expire=false;bridge.leases.clear();}return result;
  };
  await bridge.processJob(job);assert.equal(job.status,'queued');bridge.observe(job.id);
  await bridge.processJob(job);
  assert.equal(job.status,'in_progress');assert.equal(calls.filter(a=>a[1]==='run').length,1);
  assert.equal(calls.filter(a=>a[1]==='create').length,1);
});

test('missing promotion quotes recover only from the original operation or expire without another promotion',async t=>{
  const previousUtils=globalThis.utils;
  globalThis.utils={base64URLDecode:value=>Buffer.from(value,'base64url').toString('utf8')};
  t.after(()=>{globalThis.utils=previousUtils;});
  const creditPlugin=await import('data:text/javascript;base64,'+Buffer.from(await buildCreditPlugin({models:['seedance_2.5','seedance_2.5_draft']})).toString('base64'));
  for(const recover of [false,true])await t.test(recover?'original quote recovered':'quote unavailable until deadline',async t=>{
    t.mock.timers.enable({apis:['Date'],now:100000000});let reads=0;
    const {bridge,calls}=await fixture(t,{canvasTaskLimit:0},async args=>{
      if(args[1]==='promote')throw Error('response lost');
      if(args[0]==='operation')return {operationRef:args[2],state:'succeeded',submission:{state:'completed'},
        ...(recover&&++reads>1?{totalMaxCredits:75}:{}),resources:[{resourceId:'promoted',state:'succeeded'}]};
      const path=flag(args,'output');await writeFile(path,mp4);return {resourceId:args[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
    });
    const source=bridge.jobs.get((await bridge.submit({...request,model:'seedance_2.5_draft'},'promotion-draft')).id);
    source.status='completed';source.files=[{resourceId:'draft'}];await bridge.save(source);
    const key='quote-recovery',id=randomUUID(),billing={version:1,request_id:key,reserved_credits:100};
    const job={...source,id,key:createHash('sha256').update(key).digest('hex'),
      request:{kind:'video',model:'seedance_2.5',mode:'promote',source_job_id:source.id,resolution:'1080p',ratio:source.request.ratio,seconds:5,n:1,references:[]},
      billing,billingMode:'credits',nodeId:'node_0000000002',updateId:randomUUID(),submitId:randomUUID(),status:'queued',files:[],inputs:[]};
    job.digest=createHash('sha256').update(JSON.stringify({request:job.request,billing})).digest('hex');
    await bridge.save(job);await bridge.indexJob(job);bridge.storedJobs++;await bridge.observe(job.id);
    // This frozen plugin state was created by the old release. New submission
    // rejects promotion, but must still settle this durable version-1 contract.
    const poll={taskId:job.id,publicTaskId:key,data:bridge.get(job.id),state:{billingReceipt:billing,
      billing:{...billing,job_id:job.id,model:'seedance_2.5',seconds:5,n:1,mode:'promote',resolution:'1080p',ratio:'16:9'}}};
    await bridge.processJob(job);await bridge.processJob(job);await bridge.processJob(job);
    if(recover){
      await bridge.processJob(job);
      assert.equal(job.status,'completed');assert.equal(bridge.get(job.id).billing.credits,75);
      const receipt=await bridge.observe(job.id);
      const parsed=creditPlugin.parseTaskResult(poll,receipt,{status:200,headers:{'X-Upstream-Credit-Quote':bridge.creditQuoteHeader(job)}});
      assert.equal(parsed.status,'SUCCESS');assert.equal(parsed.state.creditQuote.quote_stage,'operation_response');
      assert.deepEqual(creditPlugin.extractUsageOnComplete(poll,parsed,receipt),{credits:75,resolution:'1080p'});
    }else{
      const pending=await bridge.observe(job.id);assert.equal(pending.status,'in_progress');assert.equal(pending.billing_unresolved,true);
      t.mock.timers.setTime(pending.billing_resolution_expires_at*1000);
      await bridge.processJob(job);const result=await bridge.observe(job.id);
      assert.equal(result.status,'failed');assert.equal(result.error.code,'billing_quote_unavailable');assert.equal(result.video_count,0);
      assert.equal(creditPlugin.parseTaskResult(poll,result,{status:200}).status,'FAILURE');
    }
    assert.equal(calls.filter(a=>a[1]==='promote').length,1);
  });
});

test('completed credit receipts detect missing, corrupt or unverified media and repair the original download',async t=>{
  for(const damage of ['missing','same size corruption','missing checksum'])await t.test(damage,async t=>{
    const {bridge,cfg,calls}=await fixture(t,{canvasTaskLimit:0});
    const job=bridge.jobs.get((await bridge.submit(request,'delivery-repair',false,{version:2,request_id:'delivery-repair',reserved_credits:100})).id);
    for(let i=0;i<3;i++)await bridge.processJob(job);
    assert.equal(job.status,'completed');const path=join(cfg.dataDir,job.files[0].filename);
    if(damage==='missing')await rm(path);
    else if(damage==='missing checksum')delete job.files[0].sha256;
    else await writeFile(path,Buffer.alloc(mp4.length));
    const pending=await bridge.observe(job.id);
    assert.equal(pending.status,'in_progress');assert.equal(pending.video_count,0);
    await bridge.processJob(job);const repaired=await bridge.observe(job.id);
    assert.equal(repaired.status,'completed');assert.equal(repaired.delivery_verified,true);assert.deepEqual(await readFile(path),mp4);
    assert.equal(calls.filter(a=>a[1]==='run').length,1);assert.equal(calls.filter(a=>a[1]==='download').length,2);
  });
});

test('a receipt cannot certify delivery when retention expires during file verification',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000000});
  const {bridge}=await fixture(t,{canvasTaskLimit:0});
  const job=bridge.jobs.get((await bridge.submit(request,'expires-during-proof',false,{version:2,request_id:'expires-during-proof',reserved_credits:100})).id);
  for(let i=0;i<3;i++)await bridge.processJob(job);
  const expires=bridge.get(job.id).content_expires_at;
  t.mock.timers.setTime(expires*1000-1);
  const cached=bridge.verifiedMedia.get.bind(bridge.verifiedMedia);
  bridge.verifiedMedia.get=record=>{t.mock.timers.setTime(expires*1000);return cached(record);};
  const receipt=await bridge.observe(job.id);
  assert.equal(receipt.content_expired,true);assert.equal(receipt.delivery_verified,false);
});


test('held input preparation does not block unrelated submissions and coalesces duplicate keys',async t=>{
  const {bridge,cfg}=await fixture(t,{inputPreparationWorkers:1});
  const entered=Promise.withResolvers(),release=Promise.withResolvers();let reads=0;
  bridge.readInput=async(...args)=>{reads++;entered.resolve();await release.promise;return readReference(...args);};
  const body={...request,mode:'m2v',references:[{type:'image',url:png}]};
  const slow=bridge.submit(body,'parallel-input',true);
  let duplicate;
  try {
    await Promise.race([entered.promise,slow.then(()=>assert.fail('reference preparation was not dispatched through its bounded input worker'))]);
    duplicate=bridge.submit(body,'parallel-input',true);
    await assert.rejects(bridge.submit({...body,prompt:'different'},'parallel-input',true),e=>e.status===409);
    const fast=await bridge.submit(request,'independent-input',true);
    assert.equal(fast.status,'queued');
    assert.equal(reads,1,'duplicate POST must share preparation');
    assert.equal(bridge.leases.has(fast.id),false);
    release.resolve();
    const [a,b]=await Promise.all([slow,duplicate]);
    assert.equal(a.id,b.id);
    assert.equal(bridge.jobs.size,2);
    assert.equal(bridge.leases.has(a.id),false);
    await bridge.submit(body,'parallel-input',true);
    assert.equal(bridge.leases.has(a.id),false,'duplicate POST is not a host persistence acknowledgement');
    const saved=await readFile(join(cfg.dataDir,a.id+'.json'),'utf8');
    assert.equal(saved.includes('base64'),false);
    assert.equal(bridge.jobs.get(a.id).inputs.length,1);
  } finally {release.resolve();await Promise.allSettled([slow,duplicate]);}
});

test('pending input preparations reserve queue capacity and bound active downloads',async t=>{
  const {bridge}=await fixture(t,{inputPreparationWorkers:1,maxQueue:2});
  const entered=Promise.withResolvers(),release=Promise.withResolvers();let reads=0;
  bridge.readInput=async(...args)=>{reads++;entered.resolve();await release.promise;return readReference(...args);};
  const body={...request,mode:'m2v',references:[{type:'image',url:png}]};
  const first=bridge.submit(body,'capacity-one',true);let second;
  try {
    await Promise.race([entered.promise,first.then(()=>assert.fail('input worker did not hold reference preparation'))]);
    second=bridge.submit(body,'capacity-two',true);
    await bridge.admissions;
    await assert.rejects(bridge.submit(request,'capacity-overflow',true),e=>e.code==='active_queue_full');
    assert.equal(reads,1,'second preparation must wait for its worker');
    release.resolve();
    await Promise.all([first,second]);
    assert.equal(reads,2);assert.equal(bridge.jobs.size,2);
    assert.equal(bridge.preparingUnits,0);
  } finally {release.resolve();await Promise.allSettled([first,second]);}
});

test('one request downloads at most three references at a time and keeps input order',async t=>{
  const {bridge,cfg}=await fixture(t);
  const images=Array.from({length:4},(_,index)=>Buffer.concat([
    Buffer.from(png.split(',')[1],'base64'),Buffer.from([index]),
  ]));
  const references=images.map(bytes=>({type:'image',url:'data:image/png;base64,'+bytes.toString('base64')}));
  const releases=images.map(()=>Promise.withResolvers());
  const entered=images.map(()=>Promise.withResolvers());
  const started=[];
  bridge.readInput=async(ref,...args)=>{
    const index=references.findIndex(item=>item.url===ref.url);
    started.push(index);
    entered[index].resolve();
    await releases[index].promise;
    return readReference(ref,...args);
  };
  const pending=bridge.submit({...request,mode:'m2v',references},'ordered-inputs',true);
  try {
    await entered[0].promise;
    assert.deepEqual(started,[0,1,2]);
    releases[2].resolve();
    await entered[3].promise;
    assert.deepEqual(started,[0,1,2,3]);
    releases[3].resolve();
    releases[1].resolve();
    releases[0].resolve();
    const job=bridge.jobs.get((await pending).id);
    const files=await Promise.all(job.inputs.map(input=>readFile(join(cfg.dataDir,input.filename))));
    assert.deepEqual(files,images);
  } finally {
    for(const release of releases) release.resolve();
    await Promise.allSettled([pending]);
  }
});

test('failed input preparation cancels sibling downloads, cleans files and releases reservations',{timeout:5000},async t=>{
  const {bridge,cfg}=await fixture(t,{inputPreparationWorkers:1,maxQueue:1});
  const failDownload=Promise.withResolvers(), releaseSibling=Promise.withResolvers();
  let reads=0, siblingAborted=false;
  bridge.readInput=async(ref,limit,signal,...rest)=>{
    switch(++reads) {
      case 2:
        await releaseSibling.promise;
        siblingAborted=signal.aborted;
        return readReference(ref,limit,signal,...rest);
      case 3:
        await failDownload.promise;
        throw Error('source signed URL secret');
      default:
        return readReference(ref,limit,signal,...rest);
    }
  };
  const body={...request,mode:'m2v',references:Array.from({length:3},()=>({type:'image',url:png}))};
  const pending=bridge.submit(body,'failed-preparation',true);
  try {
    // Wait until the first successful input has reached disk.
    while (!(await readdir(cfg.dataDir)).some(name=>name.includes('-input-'))) await setImmediate();
    assert.equal(reads,3);
    failDownload.resolve();
    await setImmediate();
    releaseSibling.resolve();
    await assert.rejects(pending,{message:'invalid or unavailable reference media'});
    assert.equal(siblingAborted,true);
  } finally {
    failDownload.resolve();
    releaseSibling.resolve();
    await Promise.allSettled([pending]);
  }
  assert.equal(bridge.preparingUnits,0);assert.equal(bridge.pendingAdmissions.size,0);
  assert.equal((await readdir(cfg.dataDir)).some(name=>name.includes('-input-')),false);
  const replacement=await bridge.submit(request,'replacement',true);
  assert.equal(replacement.status,'queued');
});

test('parallel inputs still share the per-request byte limit',async t=>{
  const bytes=Buffer.from(png.split(',')[1],'base64').length;
  const {bridge,cfg}=await fixture(t,{maxInputBytes:2*bytes});
  const references=Array.from({length:3},()=>({type:'image',url:png}));
  await assert.rejects(bridge.submit({...request,mode:'m2v',references},'oversized-inputs',true),
    {message:'invalid or unavailable reference media'});
  assert.equal((await readdir(cfg.dataDir)).some(name=>name.includes('-input-')),false);
});

test('the 60-second deadline aborts all downloads in one request',async t=>{
  const {bridge,cfg}=await fixture(t);
  const deadline=new AbortController(), entered=Promise.withResolvers();
  let timeoutMs;
  const signals=[];
  t.mock.method(AbortSignal,'timeout',ms=>{
    timeoutMs=ms;
    return deadline.signal;
  });
  bridge.readInput=async(_ref,_limit,signal)=>{
    signals.push(signal);
    entered.resolve();
    await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  };
  const references=Array.from({length:3},()=>({type:'image',url:png}));
  const pending=bridge.submit({...request,mode:'m2v',references},'input-deadline',true);
  await entered.promise;
  deadline.abort();
  await assert.rejects(pending,{message:'invalid or unavailable reference media'});
  assert.equal(timeoutMs,60000);
  assert.equal(signals.length,3);
  assert.ok(signals.every(signal=>signal.aborted));
  assert.equal((await readdir(cfg.dataDir)).some(name=>name.includes('-input-')),false);
});

test('shutdown drains active preparation and rejects queued preparation before reading it',async t=>{
  const {bridge,cfg}=await fixture(t,{inputPreparationWorkers:1,maxQueue:2});
  const entered=Promise.withResolvers(),release=Promise.withResolvers();let reads=0;
  bridge.readInput=async(...args)=>{reads++;entered.resolve();await release.promise;return readReference(...args);};
  const body={...request,mode:'m2v',references:[{type:'image',url:png}]};
  const first=bridge.submit(body,'shutdown-one',true);let second,closing;
  try {
    await Promise.race([entered.promise,first.then(()=>assert.fail('input preparation did not enter worker'))]);
    second=bridge.submit(body,'shutdown-two',true);
    const settled=Promise.allSettled([first,second]);
    await bridge.admissions;
    closing=bridge.close();release.resolve();
    const results=await settled;await closing;
    assert.deepEqual(results.map(result=>result.status),['rejected','rejected']);
    assert.equal(reads,1);assert.equal(bridge.jobs.size,0);assert.equal(bridge.preparingUnits,0);
    const {readdir}=await import('node:fs/promises');
    assert.equal((await readdir(cfg.dataDir)).some(name=>name.includes('-input-')),false);
  } finally {release.resolve();await Promise.allSettled([first,second,closing]);}
});
