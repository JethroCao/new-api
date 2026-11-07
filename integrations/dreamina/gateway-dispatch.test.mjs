import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Bridge, validateConfig} from './bridge.mjs';
import {quotedCLI} from './fixtures/quote-cli.mjs';

const request={model:'seedance_2.5',prompt:'a paper boat',seconds:5};
const catalog=JSON.parse(await readFile(new URL('./fixtures/video-models.json',import.meta.url),'utf8'));
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'dreamina-dispatch-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const config=validateConfig({token:'test-only-gateway-key-32-characters',dataDir:dir,cli:process.execPath,
    projectId:'c2679e06-fce3-4b3c-9038-3729d426c2b8',userId:'123',space:'personal',publicUrl:'http://localhost:8787',
    maxConcurrent:10,maxQueue:20,models:{'seedance_2.5':{kind:'video',model:'seedance_2.5',maxCredits:100}}});
  const calls=[];
  const invoke=quotedCLI(async args=>{
    if(args[0]==='space')return {userId:'123',kind:'personal'};
    if(args[0]==='model')return catalog;
    if(args[0]==='node')return {submission:{state:'accepted'}};
    if(args[0]==='operation')return {state:'running',resources:[]};
    throw Error('unexpected test CLI command');
  });
  const cli=args=>{calls.push(args);return invoke(args);};
  const bridge=await Bridge.open(config,cli);t.after(()=>bridge.close());
  await bridge.preflight();calls.length=0;
  const submit=async name=>{
    const key='task_'+name;
    return bridge.jobs.get((await bridge.submit(request,key,true,{version:2,request_id:key,reserved_credits:70})).id);
  };
  return {bridge,config,cli,calls,submit};
}

test('batch confirmation starts a persisted job without a gateway status GET',async t=>{
  const {bridge,submit}=await fixture(t);
  const a=await submit('confirmed'),b=await submit('not_persisted');let queries=0;
  bridge.gatewayTaskReader={inspect:async tasks=>{
    queries++;assert.equal(tasks.length,2);
    return new Map([[a.id,'active'],[b.id,'missing']]);
  }};
  await bridge.tick();
  assert.equal(queries,1);
  assert.equal(a.status,'in_progress');assert.equal(b.status,'queued');
  assert.ok(a.timings.gateway_confirmed_at_ms);
});

test('host terminal or mismatched identities cannot be started by a stale poll',async t=>{
  const {bridge,submit,calls}=await fixture(t);
  const a=await submit('terminal'),b=await submit('mismatch');
  bridge.gatewayTaskReader={inspect:async()=>new Map([[a.id,'terminal'],[b.id,'mismatch']])};
  await bridge.confirmGatewayTasks();
  await bridge.observe(a.id);await bridge.observe(b.id);
  await bridge.tick();
  assert.equal(a.status,'queued');assert.equal(b.status,'queued');
  assert.equal(calls.length,0);
});

test('database outages back off and ordinary gateway polling still starts its task',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const {bridge,submit}=await fixture(t);const a=await submit('fallback');let queries=0;
  bridge.gatewayTaskReader={inspect:async()=>{queries++;throw Error('secret connection string');}};
  await bridge.tick();await bridge.tick();assert.equal(queries,1);assert.equal(a.status,'queued');
  t.mock.timers.tick(1000);await bridge.tick();assert.equal(queries,2);
  t.mock.timers.tick(1000);await bridge.tick();assert.equal(queries,2,'second failure backs off for 2 seconds');
  await bridge.observe(a.id);await bridge.tick();assert.equal(a.status,'in_progress');
  assert.equal(JSON.stringify(bridge.get(a.id)).includes('secret'),false);
});

test('overlapping confirmation batches coalesce and cannot revive a task changed during query',async t=>{
  const {bridge,submit}=await fixture(t);const a=await submit('race');let finish,queries=0;
  bridge.gatewayTaskReader={inspect:()=>{queries++;return new Promise(resolve=>finish=resolve);}};
  const first=bridge.confirmGatewayTasks(),second=bridge.confirmGatewayTasks();
  assert.equal(queries,1);
  a.status='failed';finish(new Map([[a.id,'active']]));await Promise.all([first,second]);
  assert.equal(bridge.dispatchAllowed(a),false);
});

test('database confirmation expires and restart requires fresh confirmation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const {bridge,submit,config,cli}=await fixture(t);const a=await submit('restart');
  bridge.gatewayTaskReader={inspect:async()=>new Map([[a.id,'active']])};
  await bridge.confirmGatewayTasks();assert.equal(bridge.dispatchAllowed(a),true);
  t.mock.timers.tick(5000);assert.equal(bridge.dispatchAllowed(a),false);
  await bridge.close();
  const restored=await Bridge.open(config,cli);t.after(()=>restored.close());
  assert.equal(restored.dispatchAllowed(restored.jobs.get(a.id)),false);
  restored.gatewayTaskReader={inspect:async()=>new Map([[a.id,'active']])};
  await restored.tick();assert.equal(restored.jobs.get(a.id).status,'in_progress');
});

test('slow host confirmation does not block polling an already accepted operation',async t=>{
  const {bridge,submit,calls}=await fixture(t);
  const running=await submit('running');await bridge.observe(running.id);await bridge.tick();
  await submit('waiting');let release;
  const queryStarted=Promise.withResolvers();const operationPolled=Promise.withResolvers();
  const invoke=bridge.cli;
  bridge.cli=args=>{if(args[0]==='operation')operationPolled.resolve();return invoke(args);};
  bridge.gatewayTaskReader={inspect:()=>{queryStarted.resolve();return new Promise(resolve=>release=resolve);}};
  const cycle=bridge.tick();await queryStarted.promise;
  await operationPolled.promise;
  release(new Map());await cycle;
  assert.ok(calls.some(args=>args[0]==='operation'));
});

test('a definitely undispatched job returned to queued can be reconfirmed',async t=>{
  const {bridge,submit}=await fixture(t);const a=await submit('redispatch');
  // prepareDispatch returns to queued when its final identity check or
  // lease fails, even though the pre-dispatch timestamp was already persisted.
  a.timings.submit_started_at_ms=Date.now()-1000;
  bridge.gatewayTaskReader={inspect:async()=>new Map([[a.id,'active']])};
  await bridge.tick();assert.equal(a.status,'in_progress');
});

test('HTTP admission plus a real host database row starts only the matching task without GET',async t=>{
  const {createServer}=await import('./bridge.mjs');
  const {GatewayTaskReader}=await import('./gateway-task-reader.mjs');
  const {DatabaseSync}=await import('node:sqlite');
  const {bridge,config}=await fixture(t);
  const dbPath=join(config.dataDir,'host.sqlite');const host=new DatabaseSync(dbPath);t.after(()=>host.close());
  host.exec('CREATE TABLE tasks(task_id TEXT,platform TEXT,channel_id INTEGER,status TEXT,private_data TEXT); CREATE INDEX task_id_index ON tasks(task_id)');
  bridge.gatewayTaskReader=await GatewayTaskReader.open({url:'sqlite://'+dbPath,channelId:3});
  const server=createServer(bridge);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port;
  const key='task_http_admission';
  const response=await fetch(base+'/v1/jobs',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.token,'Idempotency-Key':key,'X-Dreamina-Billing':JSON.stringify({version:2,request_id:key,reserved_credits:70})},body:JSON.stringify(request)});
  assert.equal(response.status,202);const submitted=await response.json();
  await bridge.tick();assert.equal(bridge.get(submitted.id).status,'queued');
  host.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(key,'dreamina-cli',3,'SUBMITTED',JSON.stringify({upstream_task_id:submitted.id}));
  // Advance the configured batch deadline without a wall-clock sleep.
  bridge.nextGatewayConfirmation=0;
  await bridge.tick();assert.equal(bridge.get(submitted.id).status,'in_progress');
  const health=await(await fetch(base+'/healthz',{headers:{Authorization:'Bearer '+config.token}})).json();
  assert.equal(health.gateway_confirmation_enabled,true);assert.equal(health.gateway_confirmation_failures,0);
  assert.equal(health.preparing_requests,0);assert.equal(health.preparing_units,0);assert.equal(health.active_input_preparations,0);
});

test('slow pre-dispatch persistence and identity checks renew the lease and run exactly once',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const {bridge,submit,calls}=await fixture(t);const a=await submit('slow_identity');
  bridge.gatewayTaskReader={inspect:async()=>new Map([[a.id,'active']])};
  const saveGate=Promise.withResolvers(),saveStarted=Promise.withResolvers();
  const identityGate=Promise.withResolvers(),identityStarted=Promise.withResolvers();
  const save=bridge.save.bind(bridge);let held=false;
  bridge.save=async job=>{
    await save(job);
    if(job.status==='in_progress' && !held){held=true;saveStarted.resolve();await saveGate.promise;}
  };
  bridge.verifyCurrentSpace=async()=>{
    if(a.status==='in_progress'){identityStarted.resolve();await identityGate.promise;}
  };
  const cycle=bridge.tick();t.after(()=>{saveGate.resolve();identityGate.resolve();});await saveStarted.promise;
  t.mock.timers.tick(6000);await bridge.confirmGatewayTasks();
  const confirmedDuringSave=bridge.dispatchAllowed(a);
  saveGate.resolve();await identityStarted.promise;
  t.mock.timers.tick(6000);await bridge.confirmGatewayTasks();
  identityGate.resolve();await cycle;
  assert.equal(confirmedDuringSave,true,'the durable pre-dispatch write remains eligible');
  assert.equal(calls.filter(args=>args[0]==='node' && args[1]==='run').length,1);
  assert.equal(bridge.dispatchChecks.size,0);
});
