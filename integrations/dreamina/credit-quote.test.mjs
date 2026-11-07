import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, validateConfig, createServer } from './bridge.mjs';
import * as plugin from './plugin.js';
import {buildCreditPlugin} from './build-credit-plugin.mjs';

const catalog=JSON.parse(await readFile(new URL('./fixtures/video-models.json',import.meta.url),'utf8'));
const token='test-only-bridge-key-32-characters-long';
globalThis.utils={base64URLDecode:value=>Buffer.from(value,'base64url').toString('utf8')};
const request={kind:'video',model:'seedance_2.5',prompt:'waves',seconds:5,resolution:'480p'};
const personalSubject = {kind:'personal', userId:'123'};
const value=(args,key)=>args.find(a=>a.startsWith('--'+key+'='))?.slice(key.length+3);
async function fixture(t, handler, overrides={}) {
  const dir=await mkdtemp(join(tmpdir(),'dreamina-quote-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const config=validateConfig({token,dataDir:dir,cli:process.execPath,profile:'bridge',userId:'123',space:'personal',
    projectId:'c2679e06-fce3-4b3c-9038-3729d426c2b8',publicUrl:'http://127.0.0.1:8787',
    models:{'seedance_2.5':{kind:'video',model:'seedance_2.5',maxCredits:100}},...overrides});
  config.pollIntervalMs=0;
  let saved;const calls=[];
  const cli=async args=>{
    calls.push(args);
    if(args[0]==='space') {
      const custom = await handler?.(args, {dir, config, saved});
      if (custom !== undefined) return custom;
      return {userId:config.userId, kind:config.space==='personal'?'personal':'team',
        ...(config.space==='personal'?{}:{team:{teamId:config.space.slice(5)}})};
    }
    if(args[0]==='model'&&args[1]==='list')return catalog;
    if(args[0]==='model')return {matches:[{generation:{generationKind:'sample',mode:'t2v',draftPromotion:{params:[{name:'resolution',rule:{stringValues:['1080p']}}]}}}]};
    const custom=await handler?.(args,{dir,config,saved});
    if(custom!==undefined)return custom;
    if(args[0]==='node'&&args[1]==='create'){
      assert.ok(!args.includes('--run'),'save must not generate');
      assert.ok(!args.includes('--yes'),'save must not auto-approve');
      saved={nodeId:value(args,'node-id'),generation:{mode:'t2v',model:'seedance_2.5',ratio:'16:9',resolution:'480p',durationSeconds:5,outputCount:1,prompt:'waves',references:[]}};
      return {node:saved,mutation:{savedDraftVersion:1}};
    }
    if(args[0]==='node'&&args[1]==='show')return {nodes:saved?[saved]:[],draftVersion:1};
    const subject = config.space==='personal' ? {kind:'personal',userId:config.userId} :
      {kind:'team',userId:config.userId,teamId:config.space.slice(5)};
    if(args[0]==='node'&&args[1]==='quote')return {consumptionSubject:subject,items:[{nodeId:value(args,'node-id'),maxCredits:42}],totalMaxCredits:42,draftVersion:1,confirmable:true,confirmationRequired:true};
    if(args[0]==='node'&&args[1]==='confirm')return {consumptionSubject:subject,creditConfirmationToken:'PRIVATE-CREDIT-TOKEN',creditCeiling:Number(value(args,'credit-ceiling')),expiresAt:'2099-01-01T00:00:00Z'};
    if(args[0]==='node'&&args[1]==='run')return {items:[{nodeId:value(args,'node-id'),submitId:value(args,'submit-id'),state:'accepted',resources:[]}]};
    if(args[0]==='operation')return {operationRef:args[2],state:'running',resources:[]};
    throw Error('unexpected CLI call');
  };
  const bridge=await Bridge.open(config,cli);t.after(()=>bridge.close());await bridge.preflight();
  return {bridge,config,dir,calls,cli};
}

test('each CLI verifies its own member, team and canvas before spending', async t => {
  const teamId = '9999999999999999123';
  const anotherTeam = '9999999999999999124';
  const memberA = '7000000000000000001';
  const memberB = '7000000000000000002';
  const cases = [
    ['A correct', 'A', memberA, null, null],
    ['B correct', 'B', memberB, null, null],
    ['B quoted for member A of same team', 'B', memberB, 'quote', {kind:'team', userId:memberA, teamId}],
    ['A confirmed for member B of same team', 'A', memberA, 'confirm', {kind:'team', userId:memberB, teamId}],
    ['A personal quote', 'A', memberA, 'quote', {kind:'personal', userId:memberA}],
    ['B confirmed for another team', 'B', memberB, 'confirm', {kind:'team', userId:memberB, teamId:anotherTeam}],
    ['A quote with missing subject', 'A', memberA, 'quote', undefined],
    ['B confirmation with missing subject', 'B', memberB, 'confirm', undefined],
    ['B confirmation has unsafe numeric team ID', 'B', memberB, 'confirm', {kind:'team', userId:memberB, teamId:Number(teamId)}],
  ];
  for (const [name,channel,userId,stage,returned] of cases) await t.test(name, async t => {
    const f = await fixture(t, args => {
      if (!stage || args[0] !== 'node' || args[1] !== stage) return;
      const result = stage === 'quote'
        ? {items:[{nodeId:value(args,'node-id'), maxCredits:42}], totalMaxCredits:42, draftVersion:1}
        : {creditConfirmationToken:'private-test-token', creditCeiling:42};
      return {...result, consumptionSubject:returned};
    }, {canvasChannel:channel, userId, space:'team:' + teamId});
    const created = await f.bridge.submit(request, 'bound-subject');
    await f.bridge.tick();
    const commands = f.calls.filter(a => a[0] === 'node');
    const runCount = commands.filter(a => a[1] === 'run').length;
    assert.equal(runCount, stage ? 0 : 1);
    if (stage === 'quote') assert.equal(commands.filter(a => a[1] === 'confirm').length, 0);
    assert.ok(commands.every(a => value(a,'project-id') === f.config.projectId));
    const result = f.bridge.get(created.id);
    if (stage) {
      assert.equal(result.status,'failed');
      assert.match(result.error.code,/^credit_subject_(mismatch|unverified)$/);
    } else assert.equal(result.status,'in_progress');
  });
});

test('a login change after confirm stops execution without reusing the approved token', async t => {
  let approved = false;
  const f = await fixture(t, args => {
    if (args[1] === 'confirm') approved = true;
    if (args[0] === 'space' && approved) return {kind:'personal',userId:'456'};
  });
  const created = await f.bridge.submit(request,'login-changed');
  await f.bridge.tick();
  assert.equal(f.bridge.get(created.id).error.code, 'credit_subject_mismatch');
  assert.equal(f.calls.some(a => a[1] === 'run'), false);
});

test('promotion checks its original node on the original canvas before a paid call', async t => {
  for (const kind of ['wrong-member','missing-subject','wrong-source-node']) await t.test(kind, async t => {
    const f = await fixture(t, args => {
      if (args[1] === 'quote') return {
        consumptionSubject:kind === 'missing-subject' ? undefined :
          {kind:'personal',userId:kind === 'wrong-member' ? '456' : '123'},
        items:[{nodeId:kind === 'wrong-source-node' ? 'node_other' : value(args,'node-id')}],
      };
    }, {models:{'seedance_2.5':{kind:'video',model:'seedance_2.5',maxCredits:100},
      'seedance_2.5_draft':{kind:'video',model:'seedance_2.5_draft',maxCredits:100}}});
    const draft = await f.bridge.submit({...request,model:'seedance_2.5_draft'},'promotion-source');
    const source = f.bridge.jobs.get(draft.id);
    source.status = 'completed'; source.files = [{resourceId:'original'}];
    const promoted = await f.bridge.submit({kind:'video',model:'seedance_2.5',mode:'promote',
      source_job_id:source.id,resolution:'1080p',ratio:'16:9',seconds:5,n:1,references:[]}, 'promotion-identity');
    await f.bridge.tick();
    const quote = f.calls.find(a => a[1] === 'quote');
    assert.equal(value(quote,'node-id'),source.nodeId);
    assert.equal(value(quote,'project-id'),f.bridge.projectId(source));
    assert.match(f.bridge.get(promoted.id).error.code, /^credit_subject_/);
    assert.equal(f.calls.some(a => a[1] === 'promote'), false);
    assert.equal(f.bridge.jobs.get(promoted.id).upstreamCreditQuote, undefined);
  });
});


test('promotion rechecks the current member after the durable submission barrier', async t => {
  let switched = false;
  const f=await fixture(t,args=>{
    if (args[0]==='space' && switched) return {kind:'personal',userId:'456'};
    if (args[1]==='promote') return {state:'accepted',submitId:value(args,'submit-id')};
  },{models:{'seedance_2.5':{kind:'video',model:'seedance_2.5',maxCredits:100},'seedance_2.5_draft':{kind:'video',model:'seedance_2.5_draft',maxCredits:100}}});
  const draft=await f.bridge.submit({...request,model:'seedance_2.5_draft'},'switch-source');
  const source=f.bridge.jobs.get(draft.id);source.status='completed';source.files=[{resourceId:'original'}];
  const job=await f.bridge.submit({kind:'video',model:'seedance_2.5',mode:'promote',source_job_id:source.id,resolution:'1080p',ratio:source.request.ratio,seconds:5,n:1,references:[]},'switch-promote');
  const persist=f.bridge.save.bind(f.bridge);
  f.bridge.save=async j=>{
    await persist(j);
    if (j.id===job.id && j.status==='in_progress') switched=true;
  };
  await f.bridge.tick();
  assert.equal(f.bridge.get(job.id).error?.code,'credit_subject_mismatch');
  assert.equal(f.calls.some(a=>a[1]==='promote'),false);
});

test('quote is durable before approval/run, private in transport, and not actual consumption',async t=>{
  const f=await fixture(t,async(args,{dir})=>{
    if(args[0]==='node'&&['confirm','run'].includes(args[1])){
      const job=[...f.bridge.jobs.values()][0];
      const disk=JSON.parse(await readFile(join(dir,job.id+'.json'),'utf8'));
      assert.equal(disk.upstreamCreditQuote.credits,42);
      assert.equal(disk.upstreamCreditQuote.cost_cny_per_credit,'0.123456');
      assert.equal(disk.status,args[1]==='run'?'in_progress':'queued');
    }
  },{creditCostCnyPerCredit:'0.123456'});
  const accepted=await f.bridge.submit(request,'quote-primary');await f.bridge.tick();
  const job=f.bridge.jobs.get(accepted.id),quote=job.upstreamCreditQuote;
  assert.equal(quote.quote_stage,'before_generation');assert.equal(quote.source,'dreamina_canvas_cli');
  assert.equal(quote.submit_id,job.submitId);assert.equal(quote.node_id,job.nodeId);assert.equal(quote.draft_version,1);
  assert.equal(quote.actual_credits,undefined);assert.equal(f.bridge.get(job.id).upstreamCreditQuote,undefined);
  assert.equal(JSON.stringify(job).includes('PRIVATE-CREDIT-TOKEN'),false);
  assert.deepEqual(f.calls.filter(a=>a[0]==='node').map(a=>a[1]),['create','quote','confirm','run']);
  const server=createServer(f.bridge);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/jobs/'+job.id,{headers:{Authorization:'Bearer '+token}});
  const body=await response.json(),header=response.headers.get('x-upstream-credit-quote');
  assert.ok(header.length<=4096);assert.deepEqual(JSON.parse(Buffer.from(header,'base64').toString()),quote);
  assert.equal(JSON.stringify(body).includes('cost_cny_per_credit'),false);
});

test('missing, partial, mismatched, and excessive quotes stop before any approval or generation',async t=>{
  for(const kind of ['missing','partial','mismatch','negative','overflow','operator-cap'])await t.test(kind,async t=>{
    const f=await fixture(t,args=>{
      if(args[0]==='node'&&args[1]==='quote'){
        const credits=kind==='negative'?-1:kind==='overflow'?1e20:kind==='operator-cap'?101:42;
        return {consumptionSubject:personalSubject,items:[{nodeId:kind==='mismatch'?'node_wrong':value(args,'node-id'),...(kind==='missing'?{}:{maxCredits:credits}),...(kind==='partial'?{error:{serviceCode:123}}:{})}],totalMaxCredits:credits,draftVersion:1};
      }
    });
    const accepted=await f.bridge.submit(request,'bad-quote');await f.bridge.tick();
    assert.equal(f.calls.some(a=>a[0]==='node'&&['confirm','run'].includes(a[1])),false);
    assert.equal(f.bridge.get(accepted.id).status,'failed');
  });
});

test('malformed quotation and confirmation envelopes fail explicitly before generation',async t=>{
  for(const bad of ['null-quote','null-item','null-confirmation'])await t.test(bad,async t=>{
    const f=await fixture(t,args=>{
      if(args[1]==='quote'&&bad==='null-quote')return null;
      if(args[1]==='quote'&&bad==='null-item')return {items:[null],totalMaxCredits:42,draftVersion:1};
      if(args[1]==='confirm'&&bad==='null-confirmation')return null;
    });
    const j=await f.bridge.submit(request,bad);await f.bridge.tick();
    assert.equal(f.bridge.get(j.id).error.code,bad==='null-confirmation'?'credit_confirmation_unavailable':'credit_quote_unavailable');
    assert.equal(f.calls.some(a=>a[1]==='run'),false);
  });
});

test('oversized persisted audit metadata is omitted without breaking task status',async t=>{
  const f=await fixture(t);const j=await f.bridge.submit(request,'oversized');
  const job=f.bridge.jobs.get(j.id);job.status='failed';job.error={code:'20100',message:'input rejected'};
  job.upstreamCreditQuote={source:'dreamina_canvas_cli',credits:42,extra:'x'.repeat(4096)};
  assert.equal(f.bridge.creditQuoteHeader(job),undefined);
  assert.equal(f.bridge.get(j.id).status,'failed');
});

test('storage failure after quotation cannot authorize a paid call',async t=>{
  const f=await fixture(t);const original=f.bridge.save.bind(f.bridge);
  f.bridge.save=async job=>{if(job.upstreamCreditQuote)throw Error('database unavailable');return original(job);};
  await f.bridge.submit(request,'disk-failure');await assert.rejects(f.bridge.tick(),/database unavailable/);
  assert.equal(f.calls.some(a=>a[0]==='node'&&['confirm','run'].includes(a[1])),false);
});

test('uncertain run recovers original submission without re-quote, approval, or generation',async t=>{
  const f=await fixture(t,args=>{if(args[0]==='node'&&args[1]==='run')throw Error('transport lost');});
  const accepted=await f.bridge.submit(request,'uncertain');await f.bridge.tick();
  const quote=structuredClone(f.bridge.jobs.get(accepted.id).upstreamCreditQuote);
  await f.bridge.close();const restored=await Bridge.open(f.config,f.cli);t.after(()=>restored.close());
  await restored.tick();
  assert.deepEqual(restored.jobs.get(accepted.id).upstreamCreditQuote,quote);
  assert.equal(f.calls.filter(a=>a[0]==='node'&&a[1]==='run').length,1);
  assert.equal(f.calls.filter(a=>a[0]==='node'&&a[1]==='quote').length,1);
});

test('quotation parser uses only the private response header and drops malformed audit metadata without changing task status',()=>{
  const quote={source:'dreamina_canvas_cli',credits:42,quoted_at_ms:1,node_id:'node_test',submit_id:'01234567-89ab-cdef-0123-456789abcdef',model:'seedance_2.5',mode:'t2v',resolution:'480p',ratio:'16:9',seconds:5,count:1,quote_stage:'before_generation'};
  const encoded=Buffer.from(JSON.stringify(quote)).toString('base64');
  const headers={'x-UPSTREAM-CREDIT-quote':encoded};
  const body={id:'job',object:'video',status:'in_progress',model:quote.model,mode:quote.mode,resolution:quote.resolution,ratio:quote.ratio,seconds:quote.seconds,n:quote.count};
  const poll={taskId:body.id};
  for(const value of [encoded,[encoded]]) {
    const hostHeaders={'x-UPSTREAM-CREDIT-quote':value};
    assert.deepEqual(plugin.parseSubmitResponse({}, {body,headers:hostHeaders}).state.creditQuote,quote);
    assert.deepEqual(plugin.parseTaskResult(poll,body,{status:200,headers:hostHeaders}).state.creditQuote,quote);
  }
  assert.equal(plugin.parseTaskResult({taskId:'other'},body,{status:200,headers}).state,undefined);
  assert.equal(plugin.parseTaskResult(poll,{...body,upstreamCreditQuote:quote},{status:200}).upstreamCreditQuote,undefined);
  for(const bad of ['not-base64',[],[null],Buffer.from('{}').toString('base64'),'x'.repeat(4097)])for(const status of ['completed','failed']) {
    const parsed=plugin.parseTaskResult(poll,{...body,status},{status:200,headers:{'X-Upstream-Credit-Quote':bad}});
    assert.equal(parsed.upstreamCreditQuote,undefined);assert.equal(parsed.status,status==='completed'?'SUCCESS':'FAILURE');
  }
  assert.equal(plugin.meta.requiredCapabilities,undefined);
});

test('zero credits and large official draft versions are preserved without inventing actual consumption',async t=>{
  const f=await fixture(t,args=>args[1]==='quote'?{consumptionSubject:personalSubject,items:[{nodeId:value(args,'node-id'),maxCredits:0}],totalMaxCredits:0,draftVersion:2147483648}:undefined);
  const j=await f.bridge.submit(request,'free-quote');await f.bridge.tick();
  assert.equal(f.bridge.get(j.id).status,'in_progress');
  assert.equal(f.bridge.jobs.get(j.id).upstreamCreditQuote.credits,0);
  assert.equal(f.bridge.jobs.get(j.id).upstreamCreditQuote.draft_version,2147483648);
});

test('ephemeral confirmation tokens echoed in run errors never persist',async t=>{
  for(const code of ['20100','cli.transport_failed','rejected'])await t.test(code,async t=>{
    const f=await fixture(t,args=>{if(args[1]==='run'){
      if(code==='rejected')return {items:[{nodeId:value(args,'node-id'),submitId:value(args,'submit-id'),state:'rejected',error:{message:'rejected PRIVATE-CREDIT-TOKEN',serviceCode:500}}]};
      throw Object.assign(Error('failed'),{cliError:{code,message:'rejected PRIVATE-CREDIT-TOKEN',request_id:'PRIVATE-CREDIT-TOKEN'}});
    }});
    const j=await f.bridge.submit(request,'no-token');await f.bridge.tick();
    assert.equal((await readFile(join(f.dir,j.id+'.json'),'utf8')).includes('PRIVATE-CREDIT-TOKEN'),false);
    assert.equal(JSON.stringify(f.bridge.get(j.id)).includes('PRIVATE-CREDIT-TOKEN'),false);
  });
});

test('lease expiry during approval never starts generation; re-quote cannot overwrite frozen price',async t=>{
  let changed=false;
  const f=await fixture(t,args=>{
    if(args[1]==='confirm')f.bridge.leases.clear();
    if(args[1]==='quote'&&changed)return {consumptionSubject:personalSubject,items:[{nodeId:value(args,'node-id'),maxCredits:43}],totalMaxCredits:43,draftVersion:2};
  },{creditCostCnyPerCredit:'0.123456'});
  const j=await f.bridge.submit(request,'expired');await f.bridge.tick();
  const original=structuredClone(f.bridge.jobs.get(j.id).upstreamCreditQuote);
  assert.equal(f.calls.some(a=>a[1]==='run'),false);assert.equal(f.bridge.get(j.id).status,'queued');
  changed=true;f.bridge.config.creditCostCnyPerCredit='0.234567';f.bridge.observe(j.id);await f.bridge.tick();
  assert.equal(f.bridge.get(j.id).error.code,'credit_quote_changed');
  assert.deepEqual(f.bridge.jobs.get(j.id).upstreamCreditQuote,original);
  assert.equal(f.calls.filter(a=>a[1]==='create').length,1);assert.equal(f.calls.some(a=>a[1]==='run'),false);
});

test('resuming an approved draft checks owned parameters and ignores unrelated canvas version changes',async t=>{
  for(const change of ['canvas-version','draft-model','malformed-references'])await t.test(change,async t=>{
    let expired=false, resumed=false;
    const f=await fixture(t,(args,{saved})=>{
      if(args[1]==='confirm'&&!expired){f.bridge.leases.clear();expired=true;}
      if(args[1]==='show'&&resumed)return {nodes:[{...saved,generation:{...saved.generation,
        ...(change==='draft-model'?{model:'seedance_2.0_vip'}:{}),...(change==='malformed-references'?{references:{}}:{})}}],draftVersion:2};
      if(args[1]==='quote'&&resumed)return {consumptionSubject:personalSubject,items:[{nodeId:value(args,'node-id'),maxCredits:42}],totalMaxCredits:42,draftVersion:2};
    });
    const j=await f.bridge.submit(request,change);await f.bridge.tick();
    const quote=structuredClone(f.bridge.jobs.get(j.id).upstreamCreditQuote);
    resumed=true;f.bridge.observe(j.id);await f.bridge.tick();
    assert.deepEqual(f.bridge.jobs.get(j.id).upstreamCreditQuote,quote);
    assert.equal(f.calls.filter(a=>a[1]==='create').length,1);
    assert.equal(f.calls.filter(a=>a[1]==='run').length,change==='canvas-version'?1:0);
    assert.equal(f.bridge.get(j.id).status,change==='canvas-version'?'in_progress':'failed');
    if(change!=='canvas-version')assert.equal(f.bridge.get(j.id).error.code,'draft_changed');
  });
});

test('restart after saved draft but before quotation checks request alignment before quoting',async t=>{
  const f=await fixture(t,args=>{
    if(args[1]==='show')return {nodes:[{nodeId:value(args,'node-id'),generation:{mode:'t2v',model:'seedance_2.0_vip',ratio:'16:9',resolution:'480p',durationSeconds:5,outputCount:1,prompt:'waves',references:[]}}],draftVersion:2};
  });
  const j=await f.bridge.submit(request,'saved-before-quote');
  const job=f.bridge.jobs.get(j.id);job.draftSaved=true;await f.bridge.save(job);
  await f.bridge.close();
  const restored=await Bridge.open(f.config,f.cli);t.after(()=>restored.close());
  restored.observe(j.id);await restored.tick();
  assert.equal(restored.get(j.id).error.code,'draft_changed');
  assert.equal(f.calls.some(a=>['create','quote','confirm','run'].includes(a[1])),false);
});

test('unlimited policy still confirms exactly the frozen quote and checks leases',async t=>{
  const f=await fixture(t,args=>args[1]==='quote'?{consumptionSubject:personalSubject,items:[{nodeId:value(args,'node-id'),maxCredits:101}],totalMaxCredits:101,draftVersion:1}:undefined,{unlimitedCredits:true});
  const j=await f.bridge.submit(request,'unlimited');await f.bridge.tick();
  assert.equal(f.bridge.get(j.id).status,'in_progress');
  assert.ok(f.calls.find(a=>a[1]==='confirm').includes('--credit-ceiling=101'));
  assert.equal(f.calls.some(a=>a.includes('--yes')),false);
});

test('promotion stores only an actual returned quote with explicit post-submission timing',async t=>{
  for(const quoted of [true,false,'without-node'])await t.test(String(quoted),async t=>{
    const f=await fixture(t,args=>args[1]==='promote'?{submitId:value(args,'submit-id'),...(quoted==='without-node'?{}:{nodeId:'node_promoted'}),state:'accepted',authorizedCredits:300,...(quoted?{totalMaxCredits:75}:{})}:undefined,
      {models:{'seedance_2.5':{kind:'video',model:'seedance_2.5',maxCredits:100},'seedance_2.5_draft':{kind:'video',model:'seedance_2.5_draft',maxCredits:100}}});
    const draft=await f.bridge.submit({...request,model:'seedance_2.5_draft'},'sample');
    const source=f.bridge.jobs.get(draft.id);source.status='completed';source.files=[{resourceId:'original'}];
    const j=await f.bridge.submit({kind:'video',model:'seedance_2.5',mode:'promote',source_job_id:draft.id,resolution:'1080p',ratio:'16:9',seconds:5,n:1,references:[]},'promote');
    await f.bridge.tick();const quote=f.bridge.jobs.get(j.id).upstreamCreditQuote;
    assert.equal(f.bridge.get(j.id).status,'in_progress');
    if(quoted){assert.equal(quote.credits,75);assert.equal(quote.quote_stage,'submission_response');assert.equal(quote.node_id,quoted==='without-node'?undefined:'node_promoted');}
    else assert.equal(quote,undefined,'authorization ceiling is not a quote');
  });
});

test('bridge identifies the billing protocol from the saved job on every query',async t=>{
  const f=await fixture(t);
  const legacy=await f.bridge.submit(request,'old-video',true);
  const credit=await f.bridge.submit(request,'new-video',true,{version:2,request_id:'new-video',reserved_credits:42});
  assert.equal(legacy.billing_mode,'legacy_seconds');
  assert.equal(credit.billing_mode,'credits');
  await f.bridge.close();
  const restored=await Bridge.open(f.config,f.cli);
  t.after(()=>restored.close());
  assert.equal(restored.get(legacy.id).billing_mode,'legacy_seconds');
  assert.equal(restored.get(credit.id).billing_mode,'credits');
  // Historical jobs predate the durable protocol label.
  const historical={...restored.jobs.get(legacy.id)};
  delete historical.billingMode;
  assert.equal(restored.get(legacy.id,historical).billing_mode,'legacy_seconds');
  const damaged={...restored.jobs.get(credit.id)};
  delete damaged.billing;
  assert.equal(restored.get(credit.id,damaged).billing_mode,'credits');
});

test('gateway reservation is durable, frozen by idempotency and caps uncapped operator policy',async t=>{
 for(const cap of [41,42])await t.test(String(cap),async t=>{
  const f=await fixture(t,undefined,{unlimitedCredits:true});
  const billing={version:1,request_id:'credit-job',reserved_credits:cap};
  const admitted=await f.bridge.submit(request,'credit-job',false,billing);
  assert.deepEqual(admitted.billing,billing);
  const disk=JSON.parse(await readFile(join(f.dir,admitted.id+'.json'),'utf8'));
  assert.deepEqual(disk.billing,billing);
  await assert.rejects(f.bridge.submit(request,'credit-job',false,{...billing,reserved_credits:cap+1}),/idempotency/);
  await f.bridge.tick();const job=f.bridge.get(admitted.id);
  assert.equal(job.status,cap<42?'failed':'in_progress');
  assert.equal(f.calls.some(a=>a[1]==='run'),cap===42);
  assert.equal(f.calls.some(a=>a[1]==='confirm'),cap===42);
  assert.equal(job.billing.quoted_credits,42);
  assert.equal(job.billing.quote_status,cap===42?'accepted':'quoted');
  assert.equal(job.billing.credits,cap===42?42:undefined);
  assert.equal(job.billing.basis,cap===42?'accepted_quote':undefined);
  assert.equal(job.billing.cost_cny_per_credit,undefined);
 });
});

test('invalid gateway billing contracts are rejected without admitting a job',async t=>{
 const f=await fixture(t);
 for(const billing of [null,{}, {version:1,request_id:'bad',reserved_credits:10},
  {version:1,request_id:'key',reserved_credits:0},{version:1,request_id:'key',reserved_credits:1e10}]) {
  await assert.rejects(f.bridge.submit(request,'key',false,billing),/billing/);
 }
 assert.equal(f.bridge.jobs.size,0);assert.equal(f.calls.some(a=>a[0]==='node'),false);
});

test('promotion enforces gateway ceiling even with unlimited operator credits',async t=>{
 const f=await fixture(t,args=>args[1]==='promote'?{submitId:value(args,'submit-id'),state:'accepted',totalMaxCredits:75}:undefined,
  {unlimitedCredits:true,models:{'seedance_2.5':{kind:'video',model:'seedance_2.5',maxCredits:0},'seedance_2.5_draft':{kind:'video',model:'seedance_2.5_draft',maxCredits:0}}});
 const draft=await f.bridge.submit({...request,model:'seedance_2.5_draft'},'sample-credit');
 const source=f.bridge.jobs.get(draft.id);source.status='completed';source.files=[{resourceId:'original'}];
 const j=await f.bridge.submit({kind:'video',model:'seedance_2.5',mode:'promote',source_job_id:draft.id,resolution:'1080p',ratio:'16:9',seconds:5,n:1,references:[]},'promote-credit',false,{version:1,request_id:'promote-credit',reserved_credits:100});
 await f.bridge.tick();const args=f.calls.find(a=>a[1]==='promote');
 assert.ok(args.includes('--credit-ceiling=100'));assert.equal(args.includes('--yes'),false);
 assert.equal(f.bridge.get(j.id).billing.credits,75);
});

test('HTTP submission carries the internal billing reservation and rejects malformed headers',async t=>{
 const f=await fixture(t);const server=createServer(f.bridge);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port+'/v1/jobs';
 const billing={version:1,request_id:'http-credit',reserved_credits:50};
 for(const [value,status] of [['not-json',400],[JSON.stringify(billing),202]]){
  const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':'http-credit','X-Dreamina-Billing':value},body:JSON.stringify(request)});
  assert.equal(response.status,status);const body=await response.json();if(status===202)assert.deepEqual(body.billing,billing);
 }
});

test('promotion never settles a quote from an unacknowledged or different submission',async t=>{
 for(const kind of ['wrong-id','unknown-state','rejected','wrong-node','wrong-resource'])await t.test(kind,async t=>{
  const f=await fixture(t,args=>args[1]==='promote'?{submitId:kind==='wrong-id'?'different-operation':value(args,'submit-id'),state:kind==='unknown-state'?'unknown':kind==='rejected'?'rejected':'accepted',totalMaxCredits:99,
    ...(kind==='wrong-node'?{sourceNodeId:'node_other'}:{}), ...(kind==='wrong-resource'?{sourceResourceId:'other'}:{})}:undefined,
   {unlimitedCredits:true,models:{'seedance_2.5':{kind:'video',model:'seedance_2.5',maxCredits:0},'seedance_2.5_draft':{kind:'video',model:'seedance_2.5_draft',maxCredits:0}}});
  const draft=await f.bridge.submit({...request,model:'seedance_2.5_draft'},'binding-source');
  const source=f.bridge.jobs.get(draft.id);source.status='completed';source.files=[{resourceId:'original'}];
  const j=await f.bridge.submit({kind:'video',model:'seedance_2.5',mode:'promote',source_job_id:draft.id,resolution:'1080p',ratio:'16:9',seconds:5,n:1,references:[]},'binding-promotion',false,{version:1,request_id:'binding-promotion',reserved_credits:100});
  await f.bridge.tick();const job=f.bridge.jobs.get(j.id);
  assert.equal(job.upstreamCreditQuote,undefined,'an unrelated or unacknowledged quote is not billing evidence');
  const stored=JSON.parse(await readFile(join(f.dir,j.id+'.json'),'utf8'));
  assert.equal(stored.upstreamCreditQuote,undefined);
  assert.equal(f.bridge.get(j.id).billing.credits,undefined);
  assert.equal(job.status,kind==='rejected'?'failed':'in_progress');
  if (kind==='wrong-node' || kind==='wrong-resource') {
    assert.equal(job.runConflict,'promotion_source_mismatch');
    assert.equal(f.bridge.get(j.id).recovery.action,'manual_review');
    assert.ok(job.timings.accepted_at_ms>0);
  }
  assert.equal(f.calls.filter(a=>a[1]==='promote').length,1);
 });
});


test('estimated reservations permit a higher accepted quote but retain operator ceilings and restart identity',async t=>{
 for(const unlimitedCredits of [true,false])await t.test(String(unlimitedCredits),async t=>{
  const f=await fixture(t,undefined,{unlimitedCredits,models:{'seedance_2.5':{kind:'video',model:'seedance_2.5',maxCredits:40}}});
  const billing={version:2,request_id:'estimated-job',reserved_credits:30};
  const j=await f.bridge.submit(request,'estimated-job',false,billing);
  await f.bridge.close();const restored=await Bridge.open(f.config,f.cli);t.after(()=>restored.close());
  restored.observe(j.id);await restored.tick();
  assert.equal(restored.get(j.id).billing.version,2);
  assert.equal(restored.get(j.id).billing.reserved_credits,30);
  assert.equal(restored.get(j.id).billing.quoted_credits,42);
  assert.equal(restored.get(j.id).billing.credits,unlimitedCredits?42:undefined);
  assert.equal(restored.get(j.id).status,unlimitedCredits?'in_progress':'failed');
  assert.equal(f.calls.some(a=>a[1]==='run'),unlimitedCredits);
  if(unlimitedCredits)assert.ok(f.calls.find(a=>a[1]==='confirm').includes('--credit-ceiling=42'));
 });
});

test('only matching upstream acceptance promotes a durable quote after a lost run reply', async t => {
  let responseID;
  const f = await fixture(t, async args => {
    if (args[1] === 'confirm' || args[1] === 'run') {
      const job = [...f.bridge.jobs.values()][0];
      const stored = JSON.parse(await readFile(join(f.dir, job.id + '.json'), 'utf8'));
      const receipt = f.bridge.get(job.id, stored).billing;
      assert.equal(receipt.quoted_credits, 42);
      assert.equal(receipt.credits, undefined);
      assert.equal(receipt.basis, undefined);
      assert.equal(receipt.quote_status, args[1] === 'confirm' ? 'quoted' : 'confirmed');
      if (args[1] === 'run') throw Error('response lost');
    }
    if (args[0] === 'operation') return {
      operationRef: args[2], submission: {submitId: responseID, state: 'accepted'}, state: 'running', resources: [],
    };
  });
  const key = 'recover-accepted-quote';
  const j = await f.bridge.submit(request, key, false, {version: 2, request_id: key, reserved_credits: 42});
  await f.bridge.tick();
  assert.equal(f.bridge.get(j.id).billing.quote_status, 'confirmed');
  await f.bridge.close();
  const restored = await Bridge.open(f.config, f.cli);
  t.after(() => restored.close());
  restored.observe(j.id);
  responseID = 'different-submit';
  await restored.tick();
  assert.equal(restored.get(j.id).attention, 'operation_mismatch');
  assert.equal(restored.get(j.id).billing.quote_status, 'confirmed');
  const job = restored.jobs.get(j.id);
  job.diagnostics.next_poll_at_ms = 0;
  responseID = job.submitId;
  await restored.tick();
  const disk = JSON.parse(await readFile(join(f.dir, j.id + '.json'), 'utf8'));
  const receipt = restored.get(j.id, disk).billing;
  assert.equal(receipt.quote_status, 'accepted');
  assert.equal(receipt.credits, 42);
  assert.equal(receipt.basis, 'accepted_quote');
  assert.equal(f.calls.filter(args => args[1] === 'run').length, 1);
});

test('a run with explicit conflicting terms is reconciled only against the original operation', async t => {
  const source = await buildCreditPlugin({models:['seedance_2.5']});
  const billingPlugin = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  for (const reason of ['run_subject_mismatch','run_generation_changed']) await t.test(reason, async t => {
    let operationState = 'running';
    const f = await fixture(t, args => {
      if (args[1] === 'run') {
        const item = {nodeId:value(args,'node-id'), submitId:value(args,'submit-id'), state:reason === 'run_generation_changed' ? 'unknown' : 'accepted'};
        if (reason === 'run_generation_changed') item.generationDiff = [{fieldPath:'durationSeconds',from:'5',to:'4'}];
        return {consumptionSubject: reason === 'run_subject_mismatch' ? {kind:'personal',userId:'456'} : personalSubject, items:[item]};
      }
      if (args[0] === 'operation') return {operationRef:args[2], state:operationState, resources:operationState === 'running' ? [] : [{resourceId:'unverified-output',state:'succeeded'}]};
    });
    const key = 'conflict-' + reason;
    const j = await f.bridge.submit(request,key,false,{version:2,request_id:key,reserved_credits:60});
    const submitCtx = {model:request.model, publicTaskId:key, requestBody:{model:request.model,prompt:request.prompt,seconds:5,resolution:'480p'}};
    const receipt = billingPlugin.parseSubmitResponse(submitCtx, {body:j});
    const gatewayTask = {publicTaskId:key, taskId:j.id, state:receipt.state, data:receipt.taskData};
    const assertDisputedPrice = reply => {
      assert.equal(reply.billing.quote_status, 'confirmed');
      assert.equal(reply.billing.quoted_credits, 42);
      assert.equal(reply.billing.credits, undefined);
      assert.equal(reply.billing.basis, undefined);
    };
    await f.bridge.tick();
    assertDisputedPrice(f.bridge.get(j.id));
    assert.equal(f.bridge.get(j.id).recovery.action, 'manual_review');
    assert.match(f.bridge.get(j.id).recovery.message, /核查/);
    assert.equal(f.bridge.get(j.id).diagnostics.last_error.code, reason);
    await f.bridge.close();
    const restored = await Bridge.open(f.config,f.cli);
    t.after(()=>restored.close());
    const job = restored.jobs.get(j.id);
    job.diagnostics.next_poll_at_ms = 0;
    await restored.tick();
    const running = restored.get(j.id);
    assertDisputedPrice(running);
    const inProgress = billingPlugin.parseTaskResult(gatewayTask,running,{status:200});
    assert.equal(inProgress.status,'IN_PROGRESS');assert.match(inProgress.progress,/核查/);
    gatewayTask.state = inProgress.state || gatewayTask.state;gatewayTask.data=running;
    assert.equal(running.status,'in_progress'); assert.equal(running.recovery.action,'manual_review');
    assert.ok(running.diagnostics.next_poll_at_ms > Date.now() + 50000);
    operationState = 'succeeded'; job.diagnostics.next_poll_at_ms = 0; await restored.tick();
    const failed = restored.get(j.id);
    assertDisputedPrice(failed);
    assert.ok(failed.timings.accepted_at_ms || failed.timings.accepted_observed_at_ms);
    assert.deepEqual(job.runConflictResourceIds,['unverified-output']);
    assert.equal(failed.status,'failed'); assert.equal(failed.error.code,reason);
    assert.match(failed.error.message,/核查/); assert.equal(failed.video_count,0);
    assert.equal(failed.recovery.automatic_resubmit,false);
    const final = billingPlugin.parseTaskResult(gatewayTask,failed,{status:200});
    assert.equal(final.status,'FAILURE');assert.match(final.reason,/核查/);
    assert.deepEqual(billingPlugin.extractUsageOnComplete(gatewayTask,final,failed),{});
    assert.equal((final.state || gatewayTask.state).acceptedQuoteCredits,undefined);
    assert.equal(f.calls.some(args=>args[0]==='resource' && args[1]==='download'),false);
    assert.equal(f.calls.filter(args=>args[1]==='run').length,1);
  });
});

test('a status response without the required operationRef cannot recover an uncertain run', async t => {
  let reference;
  const f = await fixture(t, args => {
    if (args[1] === 'run') throw new Error('response lost');
    if (args[0] === 'operation') return {operationRef:reference, submission:{state:'accepted'},state:'succeeded',resources:[{resourceId:'output',state:'succeeded'}]};
  });
  const key = 'no-operation-ref';
  const j = await f.bridge.submit(request,key,false,{version:2,request_id:key,reserved_credits:60});
  await f.bridge.tick(); await f.bridge.tick();
  let job = f.bridge.jobs.get(j.id);
  assert.equal(f.bridge.get(j.id).billing.quote_status,'confirmed');
  assert.equal(f.bridge.get(j.id).recovery.action,'manual_review');
  assert.ok(job.diagnostics.next_poll_at_ms > Date.now()+50000);
  assert.equal(job.downloadResources,undefined);
  reference = job.submitId; job.diagnostics.next_poll_at_ms = 0; await f.bridge.tick();
  assert.equal(f.bridge.get(j.id).billing.quote_status,'accepted');
  assert.deepEqual(job.downloadResources,['output']);
  assert.equal(f.calls.filter(args=>args[1]==='run').length,1);
});

test('omitted run subject and unchanged generation terms keep the verified approval', async t => {
  const f = await fixture(t, args => args[1] === 'run' ? {
    consumptionSubject:null,items:[{nodeId:value(args,'node-id'),submitId:value(args,'submit-id'),state:'accepted',
      generationDiff:[{fieldPath:'durationSeconds',from:'5',to:'5'}]}],
  } : undefined);
  const key = 'unchanged-run-terms';
  const j = await f.bridge.submit(request,key,false,{version:2,request_id:key,reserved_credits:60});
  await f.bridge.tick();
  const reply = f.bridge.get(j.id);
  assert.equal(reply.recovery.action,'wait');
  assert.equal(reply.billing.quote_status,'accepted');
});

test('official absence for the original disputed run ends it without resubmitting or billing', async t => {
  let unavailable = false;
  const f = await fixture(t, args => {
    if (args[1] === 'run') return {items:[{
      nodeId:value(args,'node-id'),submitId:value(args,'submit-id'),state:'accepted',
      generationDiff:[{fieldPath:'durationSeconds',from:'5',to:'4'}],
    }]};
    if (args[0] === 'operation') {
      if (unavailable) throw Object.assign(Error('CLI command failed'),{
        cliError:{code:'cli.operation_submission_absent',message:'Submission absent',request_id:'absence-test'},
      });
      return {state:'failed',resources:[]}; // Missing operationRef is inconclusive.
    }
  });
  const key = 'disputed-then-absent';
  const created = await f.bridge.submit(request,key,false,{version:2,request_id:key,reserved_credits:60});
  await f.bridge.tick();
  const job = f.bridge.jobs.get(created.id);
  job.diagnostics.next_poll_at_ms = 0; await f.bridge.tick();
  assert.equal(f.bridge.get(created.id).status,'in_progress');
  assert.equal(f.bridge.get(created.id).recovery.action,'manual_review');
  unavailable = true; job.diagnostics.next_poll_at_ms = 0; await f.bridge.tick();
  const final = f.bridge.get(created.id);
  assert.equal(final.status,'failed');
  assert.equal(job.runConflict,'run_generation_changed');
  assert.equal(final.error.upstream_code,'cli.operation_submission_absent');
  assert.match(final.error.message,/提交记录不存在或已过期/);
  assert.match(final.recovery.message,/生成参数已变化/);
  assert.equal(final.recovery.automatic_resubmit,false);
  assert.equal(final.billing.credits,undefined);
  assert.equal(final.video_count,0);
  await f.bridge.tick();
  assert.deepEqual(f.calls.filter(a=>a[0]==='operation').map(a=>a[2]),[job.submitId,job.submitId]);
  assert.equal(f.calls.filter(a=>a[1]==='run').length,1);
});


test('HTTP private receipt opt-in keeps billing out of task snapshots and preserves legacy callers',async t=>{
 const f=await fixture(t),server=createServer(f.bridge);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port+'/v1/jobs';
 const billing={version:2,request_id:'private-receipt',reserved_credits:60};
 const headers={Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':billing.request_id,
  'X-Dreamina-Billing':JSON.stringify(billing),'X-Dreamina-Receipt':'header-v1'};
 const submitted=await fetch(url,{method:'POST',headers,body:JSON.stringify(request)});
 assert.equal(submitted.status,202);const created=await submitted.json();assert.equal(created.billing,undefined);
 assert.deepEqual(JSON.parse(Buffer.from(submitted.headers.get('X-Dreamina-Billing-Receipt'),'base64')),{id:created.id,billing});
 const queried=await fetch(url+'/'+created.id,{headers});const body=await queried.json();
 assert.equal(body.billing,undefined);
 assert.deepEqual(JSON.parse(Buffer.from(queried.headers.get('X-Dreamina-Billing-Receipt'),'base64')),{id:created.id,billing});
 const legacy=await fetch(url+'/'+created.id,{headers:{Authorization:'Bearer '+token}});
 assert.deepEqual((await legacy.json()).billing,billing);assert.equal(legacy.headers.get('X-Dreamina-Billing-Receipt'),null);
 assert.equal(f.calls.some(args=>args[0]==='node'&&args[1]==='run'),false);
});
