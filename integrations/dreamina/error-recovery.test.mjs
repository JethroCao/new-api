import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Bridge, validateConfig, runCLI} from './bridge.mjs';
import * as plugin from './plugin.js';
import {quotedCLI} from './fixtures/quote-cli.mjs';
import {buildCreditPlugin} from './build-credit-plugin.mjs';

async function setup(t, operation, submit, options = {}) {
  const dir=await mkdtemp(join(tmpdir(),'dreamina-recovery-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const cfg=validateConfig({token:'test-token-with-at-least-32-characters',dataDir:dir,cli:process.execPath,
    projectId:'c2679e06-fce3-4b3c-9038-3729d426c2b8',userId:'123',space:'personal',publicUrl:'http://127.0.0.1:8787',
    models:{'dreamina-video':{kind:'video',model:'test-video',ratio:'16:9',resolution:'720p',durations:[5],maxCredits:10},
      'seedance_2.5':{kind:'video',model:'seedance_2.5',maxCredits:10}}});
  cfg.pollIntervalMs=0;
  let runs=0;
  const cli=quotedCLI(async args=>{
    if(args[0]==='space')return {userId:'123',kind:'personal'};
    if(args[0]==='model')return JSON.parse(await readFile(new URL('./fixtures/video-models.json',import.meta.url),'utf8'));
    if(args[0]==='node'){runs++;return submit ? submit() : {submission:{state:'accepted'}};}
    if(args[0]==='operation')return operation();
    if(args[0]==='resource' && args[1]==='download' && options.download)return options.download(args);
    throw new Error('unexpected '+args[0]);
  });
  const bridge=await Bridge.open(cfg,cli);t.after(()=>bridge.close());
  if(options.request)await bridge.refreshCatalog('video');
  const job=await bridge.submit({kind:'video',model:'dreamina-video',prompt:'waves',seconds:5,...options.request},'job',false,options.billing);
  await bridge.tick();
  return {bridge,job,cfg,cli,runs:()=>runs};
}

test('terminal operation failure overrides pending resources and preserves safe reason',async t=>{
  for(const [code,action] of [
    [20005,'add_credits_then_resubmit'],
    [20100,'fix_input_then_resubmit'],
    ['20100','fix_input_then_resubmit'],
    [20110,'fix_input_then_resubmit'],
    [20115,'fix_input_then_resubmit'],
    ])await t.test(String(code),async t=>{
    const message=code+'：upstream rejection';
    const f=await setup(t,()=>({state:'failed',submission:{state:'completed'},submissionError:{serviceCode:code,message:'upstream rejection',retryable:false},resources:[{resourceId:'r',state:'pending'}]}));
    await f.bridge.tick();await f.bridge.tick();
    const b=f.bridge.get(f.job.id);
    assert.equal(b.status,'failed');assert.equal(b.error.upstream_code,code);assert.equal(b.error.message,message);
    assert.equal(b.recovery.action,action);assert.equal(b.recovery.automatic_resubmit,false);
    assert.equal(b.diagnostics.last_error.message,'upstream rejection');assert.ok(b.completed_at);
    assert.equal(f.runs(),1);
    const parsed=plugin.parseTaskResult({},b,{status:200});assert.equal(parsed.status,'FAILURE');assert.equal(parsed.reason,message);
    const rendered=plugin.protocols.openai_video.render({},{status:'FAILURE',fail_reason:parsed.reason,data:b});
    assert.equal(rendered.recovery.action,action);assert.equal(rendered.error.upstream_code,code);
  });
});

test('new terminal failures refund zero delivery and partial delivery charges only delivered credits',async t=>{
  const creditPlugin=await import('data:text/javascript;base64,'+Buffer.from(await buildCreditPlugin({models:['seedance_2.5']})).toString('base64'));
  for(const [name,delivered] of [['all rejected',0],['partial delivery',1]])await t.test(name,async t=>{
    const bytes=Buffer.from('000000186674797069736f6d0000020069736f6d','hex');
    const f=await setup(t,()=>({state:'failed',submissionOutcome:'rejected',submission:{state:'completed',resubmittable:false},
      submissionError:{code:20110,message:'Rejected'},resources:[
        {resourceId:'a',state:delivered?'succeeded':'pending'},{resourceId:'b',state:'pending'}]}),undefined,{
      request:{model:'seedance_2.5',n:2,resolution:'480p'},billing:{version:2,request_id:'job',reserved_credits:120},
      download:async args=>{
        assert.equal(args[2],'a');const path=args.find(a=>a.startsWith('--output=')).slice(9);
        await writeFile(path,bytes);return {resourceId:'a',path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
      },
    });
    const ctx={publicTaskId:'job',model:'seedance_2.5',upstreamModel:'seedance_2.5',requestBody:{prompt:'waves',seconds:5,n:2,resolution:'480p'}};
    const receipt=f.bridge.get(f.job.id);
    const poll={taskId:f.job.id,publicTaskId:'job',state:creditPlugin.parseSubmitResponse(ctx,{body:receipt}).state};
    await f.bridge.tick();await f.bridge.tick();
    const body=await f.bridge.observe(f.job.id),result=creditPlugin.parseTaskResult(poll,body,{status:200});
    assert.equal(body.video_count,delivered);assert.equal(result.status,delivered?'SUCCESS':'FAILURE');
    assert.deepEqual(creditPlugin.extractUsageOnComplete(poll,result,body),delivered?{credits:5,resolution:'480p'}:{});
    assert.equal(f.runs(),1);
  });
});

test('new identity errors do not spend the artifact download retry budget',async t=>{
  for(const code of [3,40003,40016])await t.test(String(code),async t=>{
    const f=await setup(t,()=>({state:'succeeded',resources:[{resourceId:'r',state:'succeeded'}]}),undefined,{
      download:async()=>{throw Object.assign(new Error('identity'),{cliError:{code,message:'Identity unavailable'}});},
    });
    await f.bridge.tick();await f.bridge.tick();
    const stored=f.bridge.jobs.get(f.job.id),body=f.bridge.get(f.job.id);
    assert.equal(body.status,'in_progress');assert.equal(body.recovery.action,'manual_review');
    assert.deepEqual(stored.downloadAttempts,[0]);assert.equal(body.diagnostics.download_failures||0,0);
    assert.equal(f.runs(),1);
  });
});

test('missing submission fails with a public reason and stays terminal through restart without resubmission',async t=>{
  const f=await setup(t,()=>{throw Object.assign(new Error('CLI command failed'),{cliError:{code:'cli.operation_submission_absent',message:'Submission absent',request_id:'request-123'}});},()=>{throw new Error('timeout');});
  await f.bridge.tick();
  const b=f.bridge.get(f.job.id);
  assert.equal(b.status,'failed');assert.equal(b.attention,undefined);
  assert.equal(b.error.upstream_code,'cli.operation_submission_absent');
  assert.equal(b.error.message,'cli.operation_submission_absent：Submission absent');
  assert.equal(b.diagnostics.last_error.code,'cli.operation_submission_absent');
  assert.equal(b.diagnostics.last_error.message,'Submission absent');
  assert.equal(b.diagnostics.last_error.request_id,'request-123');
  assert.equal(b.diagnostics.next_poll_at_ms,0);
  assert.equal(b.recovery.automatic_resubmit,false);
  const parsed=plugin.parseTaskResult({},b,{status:200});
  assert.equal(parsed.status,'FAILURE');assert.equal(parsed.reason,b.error.message);
  const rendered=plugin.protocols.openai_video.render({},{status:'FAILURE',fail_reason:parsed.reason,data:b});
  assert.equal(rendered.error.upstream_code,'cli.operation_submission_absent');
  assert.equal(rendered.error.message,b.error.message);
  await f.bridge.close();const reopened=await Bridge.open(f.cfg,f.cli);t.after(()=>reopened.close());
  await reopened.tick();assert.equal(reopened.get(f.job.id).status,'failed');assert.equal(f.runs(),1);
});

test('accepted jobs with missing records survive restart and recover only the original operation',async t=>{
  const creditPlugin=await import('data:text/javascript;base64,'+Buffer.from(await buildCreditPlugin({models:['seedance_2.5']})).toString('base64'));
  for(const evidence of ['run receipt','poll receipt','legacy resource'])for(const ending of ['succeeded','failed'])await t.test(evidence+' / '+ending,async t=>{
    let phase=evidence==='poll receipt'?'accepted':'missing';
    const bytes=Buffer.from('000000186674797069736f6d0000020069736f6d','hex');
    const f=await setup(t,()=>{
      if(phase==='missing')throw Object.assign(Error('missing'),{cliError:{code:'cli.operation_submission_absent',message:'Submission absent',request_id:'req-absent'}});
      if(phase==='accepted')return {state:'running',submission:{state:'accepted'},resources:[{resourceId:'original',state:'pending'}]};
      return {state:ending,submission:{state:'completed'},resources:[{resourceId:'original',state:ending,
        ...(ending==='failed'?{serviceCode:20110,message:'Rejected'}:{})}]};
    },()=>{
      if(evidence==='poll receipt')throw Error('run reply lost');
      return {submission:{state:'accepted',resources:[{resourceId:'original',state:'pending'}]}};
    },{request:{model:'seedance_2.5',resolution:'480p'},billing:{version:2,request_id:'job',reserved_credits:60},
      download:async args=>{
        assert.equal(args[2],'original');const path=args.find(a=>a.startsWith('--output=')).slice(9);
        await writeFile(path,bytes);return {resourceId:'original',path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
      }});
    const ctx={publicTaskId:'job',model:'seedance_2.5',upstreamModel:'seedance_2.5',requestBody:{prompt:'waves',seconds:5,resolution:'480p'}};
    const poll={taskId:f.job.id,publicTaskId:'job',state:creditPlugin.parseSubmitResponse(ctx,{body:f.bridge.get(f.job.id)}).state};
    if(evidence==='poll receipt'){await f.bridge.tick();phase='missing';}
    const job=f.bridge.jobs.get(f.job.id),submitId=job.submitId;
    // Older records may retain resource identities without acceptance timing.
    if(evidence==='legacy resource'){delete job.timings.accepted_at_ms;await f.bridge.save(job);}
    await f.bridge.tick();
    let body=f.bridge.get(job.id);
    assert.equal(body.status,'in_progress');assert.equal(body.error,undefined);
    assert.equal(body.recovery.action,'manual_review');assert.equal(body.recovery.automatic_resubmit,false);
    assert.match(body.recovery.message,/记录.*核查/);
    assert.equal(body.diagnostics.last_error.code,'cli.operation_submission_absent');
    assert.equal(creditPlugin.parseTaskResult(poll,body,{status:200}).status,'IN_PROGRESS');
    assert.ok(body.diagnostics.next_poll_at_ms>Date.now()+50000);
    await f.bridge.close();const restored=await Bridge.open(f.cfg,f.cli);t.after(()=>restored.close());
    const saved=restored.jobs.get(job.id);saved.diagnostics.next_poll_at_ms=0;
    await Promise.all([restored.tick(),restored.tick()]);
    assert.equal(restored.get(job.id).status,'in_progress');assert.equal(saved.submitId,submitId);assert.equal(f.runs(),1);
    phase='resolved';saved.diagnostics.next_poll_at_ms=0;restored.nextPoll.clear();
    await restored.tick();await restored.tick();
    body=await restored.observe(job.id);
    const result=creditPlugin.parseTaskResult(poll,body,{status:200});
    assert.equal(result.status,ending==='succeeded'?'SUCCESS':'FAILURE');
    assert.deepEqual(creditPlugin.extractUsageOnComplete(poll,result,body),ending==='succeeded'?{credits:10,resolution:'480p'}:{});
    assert.equal(body.attention,undefined);assert.equal(saved.submitId,submitId);assert.equal(f.runs(),1);
  });
});

test('identity and context query errors still require review instead of failing the task',async t=>{
  for(const code of ['cli.operation_identity_unknown','cli.operation_context_mismatch',3,40003,40016,40012])await t.test(String(code),async t=>{
    const f=await setup(t,()=>{throw Object.assign(new Error('CLI command failed'),{cliError:{code,message:'Cannot identify submission'}});});
    await f.bridge.tick();const b=f.bridge.get(f.job.id);
    assert.equal(b.status,'in_progress');assert.equal(b.recovery.action,'manual_review');
    assert.equal(b.error,undefined);assert.ok(b.diagnostics.next_poll_at_ms>Date.now()+50000);
  });
});

test('1.3 rejection receipts release pending placeholders but never running or uncertain outputs',async t=>{
  for(const [name,operation,want] of [
    ['copyright',{state:'failed',submission:{state:'completed'},submissionError:{code:20110,message:'Rejected'},resources:[{resourceId:'r',state:'pending'}]},'failed'],
    ['explicit refusal',{state:'failed',submissionOutcome:'rejected',submissionError:{code:20999,message:'Rejected'},resources:[{resourceId:'r',state:'pending'}]},'failed'],
    ['still running',{state:'failed',submission:{state:'completed'},submissionError:{code:20110,message:'Rejected'},resources:[{resourceId:'r',state:'running'}]},'in_progress'],
    ['unknown error',{state:'failed',submission:{state:'completed'},submissionError:{code:49999,message:'Unclassified'},resources:[{resourceId:'r',state:'pending'}]},'in_progress'],
    ['authentication',{state:'failed',submissionError:{code:3,message:'Authentication required'},resources:[{resourceId:'r',state:'pending'}]},'in_progress'],
    ['identity error is not terminal proof',{state:'failed',submissionError:{code:40016,message:'Context mismatch'},resources:[{resourceId:'r',state:'failed'}]},'in_progress'],
    ['ambiguous outcome',{state:'failed',submissionOutcome:'unknown',submissionError:{code:20110,message:'Rejected'},resources:[{resourceId:'r',state:'failed'}]},'in_progress'],
    ['not terminal',{state:'running',submissionOutcome:'rejected',submissionError:{code:20110,message:'Rejected'},resources:[{resourceId:'r',state:'pending'}]},'in_progress'],
  ])await t.test(name,async t=>{
    const f=await setup(t,()=>operation);
    await f.bridge.tick();
    const b=f.bridge.get(f.job.id);
    assert.equal(b.status,want);assert.equal(b.video_count,0);assert.equal(f.runs(),1);
    assert.equal(plugin.parseTaskResult({},b,{status:200}).status,want==='failed'?'FAILURE':'IN_PROGRESS');
    await f.bridge.close();const restored=await Bridge.open(f.cfg,f.cli);t.after(()=>restored.close());
    assert.equal(restored.get(f.job.id).status,want);
  });
});

test('1.3 error details survive parsing, persistence and presentation with credentials removed',async t=>{
  const payload={schemaVersion:'2',ok:false,error:{code:2,message:'The request parameters are invalid.',reason:'invalid_reference',
    diagnostics:[{detail:'Unsupported reference Bearer hidden-bearer https://media.test/a?sig=hidden-url',suggestion:'Check type token=hidden-token',private:'hidden-private'}],
    localStorage:{directory:'/private/hidden-path'},private:'hidden-private'},meta:{requestId:'req-v2',token:'hidden-private'}};
  let cliError;
  await assert.rejects(runCLI(process.execPath,['-e',`process.stderr.write(${JSON.stringify(JSON.stringify(payload))});process.exit(2)`]),e=>{
    cliError=e.cliError;assert.equal(e.cliError.code,2);assert.equal(e.cliError.reason,'invalid_reference');
    assert.equal(e.cliError.diagnostics[0].suggestion,'Check type token=hidden-token');return true;
  });
  const f=await setup(t,()=>{throw Object.assign(new Error('failed'),{cliError});});
  await f.bridge.tick();await f.bridge.close();
  const restored=await Bridge.open(f.cfg,f.cli);t.after(()=>restored.close());
  const receipt=restored.get(f.job.id);
  assert.equal(receipt.diagnostics.last_error.reason,'invalid_reference');
  const output=plugin.protocols.openai_video.render({},{status:'IN_PROGRESS',data:receipt});
  assert.equal(output.diagnostics.last_error.message,'The request parameters are invalid.');
  assert.match(output.diagnostics.last_error.diagnostics[0].detail,/Unsupported reference/);
  assert.match(output.diagnostics.last_error.diagnostics[0].suggestion,/Check type/);
  for(const secret of ['hidden-bearer','hidden-url','hidden-token','hidden-private','hidden-path'])assert.equal(JSON.stringify(receipt).includes(secret),false);
});

test('rejected run diagnostics cannot persist the credit confirmation token',async t=>{
  for(const padding of ['', 'x'.repeat(1006)])await t.test(padding?'token at detail boundary':'ordinary detail',async t=>{
    const f=await setup(t,()=>{throw Error('must not query a rejected run');},()=>({submission:{state:'rejected',error:{code:20110,message:'Rejected',
      diagnostics:[{detail:padding+'Rejected fixture-approval',suggestion:'Do not retry fixture-approval'}]}}}));
    const b=f.bridge.get(f.job.id);
    assert.equal(b.status,'failed');assert.equal(b.error.message,'20110：Rejected');
    assert.match(b.diagnostics.last_error.diagnostics[0].suggestion,/Do not retry \[redacted\]/);
    assert.equal(JSON.stringify(b).includes('fixture-'),false);
  });
});

test('transient query error clears on healthy running response; no generation retry',async t=>{
  let healthy=false;
  const f=await setup(t,()=>{if(!healthy)throw new Error('network timeout');return {state:'running',resources:[{state:'pending'}]};});
  await f.bridge.tick();assert.equal(f.bridge.get(f.job.id).recovery.action,'retry_query');
  healthy=true;f.bridge.jobs.get(f.job.id).diagnostics.next_poll_at_ms=0;f.bridge.nextPoll.clear();
  await f.bridge.tick();const b=f.bridge.get(f.job.id);
  assert.equal(b.recovery.action,'wait');assert.equal(b.attention,undefined);assert.equal(b.diagnostics.consecutive_query_errors,0);assert.equal(f.runs(),1);
});

test('CLI structured errors on stderr are retained without private envelope fields',async()=>{
  const payload={ok:false,error:{code:'cli.operation_submission_absent',message:'Submission absent',class:'operation_incomplete',private:'secret'},meta:{requestId:'req-123',token:'secret'}};
  await assert.rejects(runCLI(process.execPath,['-e',`process.stderr.write(${JSON.stringify(JSON.stringify(payload))});process.exit(20)`]),e=>{
    assert.equal(e.exitCode,20);assert.equal(e.cliError.code,payload.error.code);assert.equal(e.cliError.request_id,'req-123');assert.equal(JSON.stringify(e.cliError).includes('secret'),false);return true;
  });
});

test('input review rejection is terminal even across overlapping ticks and restart',async t=>{
  for(const code of [20100,'20110'])await t.test(String(code),async t=>{
    const f=await setup(t,()=>{throw new Error('must not poll rejected submission');},()=>{
      throw Object.assign(new Error('CLI command failed'),{exitCode:21,cliError:{code,message:'input blocked'}});
    });
    await Promise.all([f.bridge.tick(),f.bridge.tick()]);
    assert.equal(f.bridge.get(f.job.id).status,'failed');
    assert.equal(f.bridge.get(f.job.id).recovery.automatic_resubmit,false);
    await f.bridge.close();const reopened=await Bridge.open(f.cfg,f.cli);t.after(()=>reopened.close());
    await reopened.tick();assert.equal(f.runs(),1);assert.equal(reopened.get(f.job.id).error.upstream_code,code);
  });
});

test('unrecognized submission and missing outputs remain nonterminal with review advice',async t=>{
  for(const op of [{state:'unknown',submission:{state:'absent'},resources:[]},{state:'succeeded',resources:[]}])await t.test(op.state,async t=>{
    const f=await setup(t,()=>op);await f.bridge.tick();
    const b=f.bridge.get(f.job.id);assert.equal(b.status,'in_progress');assert.equal(b.recovery.action,'manual_review');assert.equal(b.error,undefined);
    assert.ok(b.diagnostics.next_poll_at_ms>Date.now()+50000);
  });
});

test('diagnostics redact credentials and signed media URLs before persistence and API delivery',async t=>{
  const f=await setup(t,()=>{throw Object.assign(new Error('failed'),{cliError:{code:'cli.network_error',request_id:'req-123',message:'Bearer secret-bearer token=secret-query https://media.test/x?sig=secret-url test-token-with-at-least-32-characters'}});});
  await f.bridge.tick();const b=f.bridge.get(f.job.id);
  const output=plugin.protocols.openai_video.render({},{status:'IN_PROGRESS',data:b});
  for(const secret of ['secret-bearer','secret-query','secret-url',f.cfg.token])assert.equal(JSON.stringify(output).includes(secret),false);
  assert.equal(output.diagnostics.last_error.request_id,'req-123');
  assert.equal(output.recovery.action,'retry_query');
});


test('original upstream errors have one code prefix in the bridge and both plugin variants',async t=>{
  const creditPlugin=await import('data:text/javascript;base64,'+Buffer.from(await buildCreditPlugin({models:['seedance_2.5']})).toString('base64'));
  for(const [error,expected] of [
    [{serviceCode:20117,message:'Input audio copyright verification failed.'},'20117：Input audio copyright verification failed.'],
    [{errorCode:'20117',errorMessage:'Input audio copyright verification failed.'},'20117：Input audio copyright verification failed.'],
    [{code:20117,message:'20117: Input audio copyright verification failed.'},'20117: Input audio copyright verification failed.'],
    [{code:20117,message:'20117：Input audio copyright verification failed.'},'20117：Input audio copyright verification failed.'],
    [{code:20999},'20999：Dreamina did not provide an error message'],
    [{message:'Uncoded rejection'},'Uncoded rejection'],
    [{code:'cli.rejected',message:'Original rejection'},'cli.rejected：Original rejection'],
    [{code:20110,message:'原始中文说明'},'20110：原始中文说明'],
    [{code:20110,message:'Rejected Bearer secret-value https://private.test/file',diagnostics:[{detail:'Private diagnostic',suggestion:'Do not retry'}]},'20110：Rejected Bearer [redacted] [redacted URL]'],
  ])await t.test(expected,async t=>{
    const f=await setup(t,()=>({state:'failed',resources:[{resourceId:'r',state:'failed',...error}]}),undefined,{
      request:{model:'seedance_2.5',resolution:'480p'},billing:{version:2,request_id:'job',reserved_credits:60}});
    const ctx={publicTaskId:'job',model:'seedance_2.5',upstreamModel:'seedance_2.5',requestBody:{prompt:'waves',seconds:5,resolution:'480p'}};
    const poll={taskId:f.job.id,publicTaskId:'job',state:creditPlugin.parseSubmitResponse(ctx,{body:f.bridge.get(f.job.id)}).state};
    await f.bridge.tick();const body=f.bridge.get(f.job.id);
    assert.equal(body.error.message,expected);assert.equal(f.runs(),1);
    for(const p of [plugin,creditPlugin]){
      const parsed=p.parseTaskResult(poll,body,{status:200});
      assert.equal(parsed.status,'FAILURE');assert.equal(parsed.reason,expected);
      const rendered=p.protocols.openai_video.render({},{status:'FAILURE',fail_reason:parsed.reason,data:body});
      assert.equal(rendered.error.message,expected);
      assert.deepEqual(p.extractUsageOnComplete({},parsed,body),{});
    }
    await f.bridge.close();const restored=await Bridge.open(f.cfg,f.cli);t.after(()=>restored.close());
    await restored.tick();assert.equal(restored.get(f.job.id).error.message,expected);assert.equal(f.runs(),1);
  });
  const oldBody={id:'legacy-job',object:'video',model:'seedance_2.5',seconds:5,n:1,mode:'t2v',resolution:'480p',ratio:'16:9',billing_mode:'legacy_seconds',status:'failed',error:{upstream_code:20117,message:'Input audio copyright verification failed.'},recovery:{message:'请勿重新生成'}};
  for(const p of [plugin,creditPlugin])assert.equal(p.parseTaskResult({taskId:'legacy-job',data:oldBody},oldBody,{status:200}).reason,'20117：Input audio copyright verification failed.');
});
