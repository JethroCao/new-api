import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Bridge,validateConfig} from './bridge.mjs';

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
  const cli=async a=>{
    calls.push(a);
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
      return {path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
    }
    throw Error('unexpected command');
  };
  const bridge=await Bridge.open(cfg,cli);t.after(()=>bridge.close());await bridge.preflight();
  return {bridge,cfg,cli,calls};
}


test('slow download does not occupy polling workers or block other canvases', async t=>{
  let unblock; const held=new Promise(r=>unblock=r); let downloading=false,polls=0;
  const {bridge}=await fixture(t,{pollWorkers:1,downloadWorkers:1},async a=>{
    if(a[0]==='canvas')return {project:{projectId:flag(a,'project-id')}};
    if(a[0]==='node')return {submission:{state:'accepted'}};
    if(a[0]==='operation'){polls++;return {state:'succeeded',resources:[{state:'succeeded',resourceId:'output'}]};}
    if(a[0]==='resource'){downloading=true;await Promise.race([held,new Promise(r=>setTimeout(r,1000))]);const path=flag(a,'output');await writeFile(path,mp4);return {path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};}
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
  t.mock.timers.tick(5000);await bridge.tick();assert.equal(polls,2);
  const d=bridge.get(j.id);assert.equal(d.timings.poll_count,2);assert.equal(d.timings.poll_error_count,1);assert.equal(d.timings.max_poll_gap_ms,5000);
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
  let broken=true;
  const {bridge,cfg,cli,calls}=await fixture(t,{},async a=>{
    if(a[0]==='canvas')return {project:{projectId:flag(a,'project-id')}};
    if(a[0]==='node')return {submission:{state:'accepted'}};
    if(a[0]==='operation')return {state:'succeeded',resources:[{state:'succeeded',resourceId:'first'},{state:'succeeded',resourceId:'second'}]};
    if(a[0]==='resource'){
      if(a[2]==='second' && broken)throw Error('temporary download failure');
      const path=flag(a,'output');await writeFile(path,mp4);return {path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
    }
  });
  const j=bridge.jobs.get((await bridge.submit({...request,n:2},'partial-restart')).id);
  await bridge.processJob(j);await bridge.processJob(j);await bridge.processJob(j);
  assert.equal(j.attention,'download_failed');assert.equal(j.files.length,1);assert.equal(j.status,'in_progress');
  await bridge.close();calls.length=0;broken=false;
  const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());await restored.tick();
  assert.equal(restored.get(j.id).video_count,2);assert.equal(restored.get(j.id).status,'completed');
  assert.deepEqual(calls.filter(a=>a[0]!=='space').map(a=>a.slice(0,3)),[['resource','download','second']]);
  assert.equal(restored.jobs.get(j.id).submitId,j.submitId);assert.equal(restored.jobs.get(j.id).projectId,j.projectId);
});
