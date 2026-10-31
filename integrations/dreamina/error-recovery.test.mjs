import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Bridge, validateConfig, runCLI} from './bridge.mjs';
import * as plugin from './plugin.js';

async function setup(t, operation, submit) {
  const dir=await mkdtemp(join(tmpdir(),'dreamina-recovery-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const cfg=validateConfig({token:'test-token-with-at-least-32-characters',dataDir:dir,cli:process.execPath,
    projectId:'c2679e06-fce3-4b3c-9038-3729d426c2b8',userId:'123',space:'personal',publicUrl:'http://127.0.0.1:8787',
    models:{'dreamina-video':{kind:'video',model:'test-video',ratio:'16:9',resolution:'720p',durations:[5],maxCredits:10}}});
  cfg.pollIntervalMs=0;
  let runs=0;
  const cli=async args=>{
    if(args[0]==='space')return {userId:'123',kind:'personal'};
    if(args[0]==='node'){runs++;return submit ? submit() : {submission:{state:'accepted'}};}
    if(args[0]==='operation')return operation();
    throw new Error('unexpected '+args[0]);
  };
  const bridge=await Bridge.open(cfg,cli);t.after(()=>bridge.close());
  const job=await bridge.submit({kind:'video',model:'dreamina-video',prompt:'waves',seconds:5},'job');
  await bridge.tick();
  return {bridge,job,cfg,cli,runs:()=>runs};
}

test('terminal operation failure overrides pending resources and preserves safe reason',async t=>{
  for(const [code,message,action] of [
    [20005,'20005:即梦当前成员可用积分不足','add_credits_then_resubmit'],
    [20100,'20100:本次输入文本敏感，已被安全审核拦截','fix_input_then_resubmit'],
    ['20100','20100:本次输入文本敏感，已被安全审核拦截','fix_input_then_resubmit'],
    [20115,'20115:本次生成的输出视频未通过版权审核','fix_input_then_resubmit'],
  ])await t.test(String(code),async t=>{
    const f=await setup(t,()=>({state:'failed',submission:{state:'completed'},submissionError:{serviceCode:code,message:'upstream rejection',retryable:false},resources:[{resourceId:'r',state:'pending'}]}));
    await f.bridge.tick();await f.bridge.tick();
    const b=f.bridge.get(f.job.id);
    assert.equal(b.status,'failed');assert.equal(b.error.upstream_code,code);assert.equal(b.error.message,message);
    assert.equal(b.recovery.action,action);assert.equal(b.recovery.automatic_resubmit,false);
    assert.equal(b.diagnostics.last_error.message,'upstream rejection');assert.ok(b.completed_at);
    assert.equal(f.runs(),1);
    const parsed=plugin.parseTaskResult({},b,{status:200});assert.equal(parsed.status,'FAILURE');assert.equal(parsed.reason,message+'；'+b.recovery.message);
    const rendered=plugin.protocols.openai_video.render({},{status:'FAILURE',fail_reason:parsed.reason,data:b});
    assert.equal(rendered.recovery.action,action);assert.equal(rendered.error.upstream_code,code);
  });
});

test('missing submission stays nonterminal and backs off through restart without resubmission',async t=>{
  const f=await setup(t,()=>{throw Object.assign(new Error('CLI command failed'),{cliError:{code:'cli.operation_submission_absent',message:'Submission absent',request_id:'request-123'}});},()=>{throw new Error('timeout');});
  await f.bridge.tick();
  const b=f.bridge.get(f.job.id);
  assert.equal(b.status,'in_progress');assert.equal(b.phase,'needs_attention');
  assert.equal(b.recovery.action,'manual_review');assert.equal(b.diagnostics.last_error.code,'cli.operation_submission_absent');
  assert.ok(b.diagnostics.next_poll_at_ms>Date.now()+50000);
  assert.match(plugin.parseTaskResult({},b,{status:200}).progress,/待核查/);
  await f.bridge.close();const reopened=await Bridge.open(f.cfg,f.cli);t.after(()=>reopened.close());
  await reopened.tick();assert.equal(reopened.get(f.job.id).diagnostics.consecutive_query_errors,1);assert.equal(f.runs(),1);
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

test('20100 submit rejection is terminal even across overlapping ticks and restart',async t=>{
  const f=await setup(t,()=>{throw new Error('must not poll rejected submission');},()=>{
    throw Object.assign(new Error('CLI command failed'),{exitCode:21,cliError:{code:20100,message:'input blocked'}});
  });
  await Promise.all([f.bridge.tick(),f.bridge.tick()]);
  assert.equal(f.bridge.get(f.job.id).status,'failed');
  assert.equal(f.bridge.get(f.job.id).recovery.automatic_resubmit,false);
  await f.bridge.close();const reopened=await Bridge.open(f.cfg,f.cli);t.after(()=>reopened.close());
  await reopened.tick();assert.equal(f.runs(),1);assert.equal(reopened.get(f.job.id).error.upstream_code,20100);
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
