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
  const cfg=validateConfig({token:'test-only-rotation-key-32-characters',dataDir:dir,cli:process.execPath,profile:'bridge',projectId:legacy,userId:'123',space:'personal',publicUrl:'http://127.0.0.1:8787',canvasTaskLimit:5,
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

test('rotation binds batches to five-request canvases without remote work at admission',async t=>{
  const {bridge,calls}=await fixture(t);
  const jobs=await Promise.all(Array.from({length:6},(_,i)=>bridge.submit({...request,n:i===0?2:1},'job-'+i)));
  const ids=jobs.map(j=>bridge.jobs.get(j.id).projectId);
  assert.equal(new Set(ids.slice(0,5)).size,1);assert.notEqual(ids[0],ids[5]);assert.notEqual(ids[0],legacy);
  assert.ok(ids[0]);assert.equal(calls.filter(a=>a[0]==='canvas').length,0);
  assert.equal((await bridge.submit({...request,n:2},'job-0')).id,jobs[0].id);
  bridge.failed(bridge.jobs.get(jobs[0].id),'generation_failed');
  const next=await bridge.submit(request,'job-6');assert.equal(bridge.jobs.get(next.id).projectId,ids[5]);
  await assert.rejects(bridge.submit({...request,projectId:legacy},'injected'),/unsupported|invalid/i);
});

test('uploads generation status and downloads use the bound canvas after restart',async t=>{
  const {bridge,cfg,cli,calls}=await fixture(t);
  for(let i=0;i<5;i++)await bridge.submit(request,'fill-'+i,true);
  const result=await bridge.submit({...request,mode:'m2v',references:[{type:'image',url:png}]},'reference',true);
  const projectId=bridge.jobs.get(result.id).projectId;
  assert.ok(projectId);assert.notEqual(projectId,legacy);
  await bridge.close();
  const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());await restored.preflight();
  restored.observe(result.id);await restored.processJob(restored.jobs.get(result.id));
  restored.observe(result.id);await restored.processJob(restored.jobs.get(result.id));
  assert.equal(restored.get(result.id).status,'completed');
  const work=calls.filter(a=>['canvas','resource','node','operation'].includes(a[0]));
  assert.deepEqual(work.map(a=>a.slice(0,2).join(' ')),['canvas create','resource upload','node create','operation status','resource download']);
  assert.ok(work.every(a=>flag(a,'project-id')===projectId));
  assert.ok(work[0][2].startsWith('Nexora-'));assert.equal(work[0].includes('--use'),false);
});

test('legacy in-progress jobs keep their original canvas when rotation is enabled',async t=>{
  const {bridge,cfg,cli,calls}=await fixture(t,{canvasTaskLimit:0});
  const result=await bridge.submit(request,'legacy');await bridge.processJob(bridge.jobs.get(result.id));
  await bridge.close();calls.length=0;
  const restored=await Bridge.open({...cfg,canvasTaskLimit:5},cli);t.after(()=>restored.close());await restored.preflight();
  await restored.processJob(restored.jobs.get(result.id));
  assert.equal(restored.get(result.id).status,'completed');
  assert.ok(calls.filter(a=>['operation','resource'].includes(a[0])).every(a=>flag(a,'project-id')===legacy));
  assert.equal(calls.some(a=>a[0]==='canvas'),false);
});

test('promotion is pinned to the source and full canvases reject before remote mutation',async t=>{
  const {bridge,calls}=await fixture(t);
  const first=await bridge.submit({...request,model:'seedance_2.5_draft'},'draft');
  const source=bridge.jobs.get(first.id);source.status='completed';source.files=[{resourceId:'draft'}];await bridge.save(source);
  const promote={kind:'video',model:'seedance_2.5',mode:'promote',source_job_id:first.id,resolution:'1080p',ratio:source.request.ratio,seconds:5,n:1,references:[]};
  for(let i=0;i<3;i++)await bridge.submit(request,'fill-'+i);
  const fifth=await bridge.submit(promote,'promote-1');
  assert.equal(bridge.jobs.get(fifth.id).projectId,source.projectId);
  const count=calls.length;
  await assert.rejects(bridge.submit(promote,'promote-2'),/source canvas capacity reached/);
  assert.equal(calls.length,count);assert.equal((await bridge.submit(promote,'promote-1')).id,fifth.id);
});

test('canvas create failure cannot dispatch or fall back and resumes the same project ID',async t=>{
  let creates=0,paid=0,ids=[];
  const {bridge}=await fixture(t,{},async a=>{
    if(a[0]==='canvas'){creates++;ids.push(flag(a,'project-id'));if(creates===1)throw Error('timeout');return {project:{projectId:ids[0]}};}
    if(a[0]==='node'){paid++;return {submission:{state:'accepted'}};}
    throw Error('unexpected');
  });
  const r=await bridge.submit(request,'retry'),j=bridge.jobs.get(r.id);
  await bridge.processJob(j);assert.equal(j.status,'queued');assert.equal(j.attention,'canvas_creation_pending');assert.equal(paid,0);
  bridge.observe(r.id);await bridge.processJob(j);
  assert.equal(j.status,'in_progress');assert.equal(paid,1);assert.deepEqual(ids,[j.projectId,j.projectId]);
});

test('disabling rotation after a partial admission preserves the durable reservation',async t=>{
  const {bridge,cfg,cli}=await fixture(t);
  bridge.save=async()=>{throw Error('disk interrupted');};
  await assert.rejects(bridge.submit(request,'partial'),/disk interrupted/);
  const state=JSON.parse(await readFile(join(cfg.dataDir,'canvases.json'),'utf8'));
  const reserved=state.canvases.find(c=>!c.legacy).projectId;
  await bridge.close();
  const restored=await Bridge.open({...cfg,canvasTaskLimit:0},cli);t.after(()=>restored.close());await restored.preflight();
  const result=await restored.submit(request,'partial');
  assert.equal(restored.jobs.get(result.id).projectId,reserved);
  await restored.close();
  const again=await Bridge.open({...cfg,canvasTaskLimit:0},cli);t.after(()=>again.close());
  assert.equal(again.jobs.get(result.id).projectId,reserved);
});
