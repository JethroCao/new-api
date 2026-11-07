import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Bridge, validateConfig, runCLI, createServer } from './bridge.mjs';
import { quotedCLI } from './fixtures/quote-cli.mjs';

const token = 'test-only-bridge-key-32-characters-long';
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
function config(dir) {
  return validateConfig({ token, dataDir: dir, cli: process.execPath, profile: 'bridge',
    projectId: 'c2679e06-fce3-4b3c-9038-3729d426c2b8', userId: '123', space: 'personal',
    publicUrl: 'http://127.0.0.1:8787',
    models: { 'dreamina-image': { kind: 'image', model: 'seedream_4.0', ratio: '1:1', resolution: '2k', counts: [1, 2], maxCredits: 5 },
      'dreamina-video': { kind: 'video', model: 'video-test', ratio: '16:9', resolution: '720p', durations: [5, 10], maxCredits: 10 } } });
}
async function fixture(t, cli) {
  const dir = await mkdtemp(join(tmpdir(), 'dreamina-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfg = config(dir);
  cfg.pollIntervalMs = 0; // Lifecycle tests advance manually; pacing is covered separately.
  const invoke = quotedCLI(async (args, saved) => {
    if (args[0] === 'node' && args[1] === 'find') {
      assert.ok(args.includes('--project-id=' + cfg.projectId));
      return {projectId: cfg.projectId, nodes: []};
    }
    return cli(args, saved);
  });
  const bridge = await Bridge.open(cfg, invoke);
  t.after(() => bridge.close());
  return { bridge, cfg, dir, invoke };
}
const context = { userId: '123', kind: 'personal' };
const request = { kind: 'image', model: 'dreamina-image', prompt: 'a paper boat', n: 1 };

test('reject invalid/unbounded requests before any CLI mutation', async t => {
  const { bridge } = await fixture(t, async () => { throw new Error('CLI must not be called'); });
  for (const [index, change] of [{ n: 0 }, { n: 100 }, { n: 1.1 }, { n: '1' }, { prompt: '' }, { prompt: 'x'.repeat(10001) },
    { n: null }, { prompt: '{{res :private}}' }, { model: 'unknown' }, { kind: 'video' }, { image: 'https://example.com/a.png' }, { maxCredits: 999 }].entries()) {
    await assert.rejects(bridge.submit({ ...request, ...change }, 'invalid-' + index), /invalid|unsupported/);
  }
  await assert.rejects(bridge.submit(request, ''), /idempotency/i);
});

test('HTTP rejects every new promotion form before task lookup, persistence or CLI work', async t => {
  let calls = 0;
  const { bridge, cfg } = await fixture(t, async () => { calls++; throw new Error('CLI must not be called'); });
  bridge.loadJob = async () => { throw new Error('promotion source must not be loaded'); };
  bridge.save = async () => { throw new Error('promotion task must not be saved'); };
  bridge.canvases.reserve = async () => { throw new Error('promotion canvas must not be reserved'); };
  const server = createServer(bridge);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  cfg.publicUrl = 'http://127.0.0.1:' + server.address().port;
  const variants = [{mode:'promote'}, {source_job_id:'missing'}, {draft_task_id:'task_old'}, {source_job_id:null}, {draft_task_id:''}];
  for (const [index, fields] of variants.entries()) {
    const response = await fetch(cfg.publicUrl + '/v1/jobs', {
      method:'POST', headers:{Authorization:'Bearer ' + token, 'Content-Type':'application/json', 'Idempotency-Key':'promotion-' + index},
      body:JSON.stringify({kind:'video',model:'seedance_2.5',...fields}),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {error:{code:'promotion_not_supported',message:'暂不支持样片转正，请直接创建普通视频任务'}});
  }
  assert.equal(bridge.jobs.size, 0);
  assert.equal(bridge.storedJobs, 0);
  assert.equal(calls, 0);
});

test('simultaneous duplicate submissions survive restart and conflicting payload is rejected', async t => {
  const { bridge, cfg } = await fixture(t, async () => context);
  const [a, b] = await Promise.all([bridge.submit(request, 'same'), bridge.submit(request, 'same')]);
  assert.equal(a.id, b.id);
  await assert.rejects(bridge.submit({ ...request, prompt: 'different' }, 'same'), /conflict/);
  await bridge.close();
  const reopened = await Bridge.open(cfg, async () => context);
  t.after(() => reopened.close());
  assert.equal((await reopened.submit(request, 'same')).id, a.id);
});

test('submission timeout is recovered by original submit ID and never generates twice', async t => {
  let submitted = 0; let original; let ready = false; let submittedArgs; let queriedID;
  const cli = async args => {
    if (args[0] === 'space') return context;
    if (args[0] === 'node') {
      submitted++; original = args.find(a => a.startsWith('--submit-id=')).split('=')[1];
      submittedArgs = args;
      throw new Error('timeout');
    }
    if (args[0] === 'operation') {
      queriedID = args[2];
      return { operationRef: original, state: ready ? 'succeeded' : 'running', resources: ready ? [{ resourceId: 'res-test', state: 'succeeded' }] : [] };
    }
    if (args[0] === 'resource') {
      const path = args.find(a => a.startsWith('--output=')).slice(9);
      await writeFile(path, png);
      return { resourceId: 'res-test', path, size: png.length, sha256: createHash('sha256').update(png).digest('hex') };
    }
    throw new Error('unexpected command');
  };
  const { bridge, cfg, invoke } = await fixture(t, cli);
  const job = await bridge.submit({ ...request, prompt: '--yes; $(touch /tmp/never-created-by-bridge)' }, 'resume');
  await bridge.tick();
  assert.match(submittedArgs.find(a => a.startsWith('--node-id=')), /^--node-id=node_[0-9a-hjkmnp-tv-z]{10}$/);
  assert.ok(submittedArgs.includes('--prompt=--yes; $(touch /tmp/never-created-by-bridge)'));
  assert.ok(submittedArgs.includes('--credit-ceiling=5'));
  assert.ok(!submittedArgs.includes('--yes'));
  assert.equal(bridge.get(job.id).status, 'in_progress');
  await bridge.close();
  const recovered = await Bridge.open(cfg, invoke);
  t.after(() => recovered.close());
  ready = true;
  await recovered.tick();
  assert.equal(queriedID, original);
  await recovered.tick(); // Independent download dispatch.
  assert.equal(recovered.get(job.id).status, 'completed');
  assert.equal(submitted, 1);
  assert.equal(recovered.get(job.id).data.length, 1);
  assert.equal((await readFile(join(cfg.dataDir, job.id + '.json'), 'utf8')).includes('?sig='), false);
});

test('wrong identity fails a queued task before it can spend', async t => {
  let calls = 0;
  const { bridge } = await fixture(t, async args => {
    calls++;
    assert.equal(args[0], 'space');
    return { ...context, kind: 'team', team: { teamId: 'wrong-team' } };
  });
  const job = await bridge.submit(request, 'space');
  await bridge.tick();
  assert.equal(bridge.get(job.id).status, 'failed');
  assert.equal(bridge.get(job.id).error.code, 'credit_subject_mismatch');
  assert.equal(calls, 1);
});

test('empty resource collection and unsupported video download never produce success', async t => {
  let empty = true;
  const { bridge } = await fixture(t, async args => {
    if (args[0] === 'space') return context;
    if (args[0] === 'node') return { submission: { state: 'accepted' } };
    if (args[0] === 'operation') return { state: 'succeeded', resources: empty ? [] : [{ resourceId: 'video', state: 'succeeded' }] };
    throw new Error('video download unsupported');
  });
  const job = await bridge.submit({ kind: 'video', model: 'dreamina-video', prompt: 'waves', seconds: 5 }, 'video');
  await bridge.tick(); await bridge.tick();
  assert.notEqual(bridge.get(job.id).status, 'completed');
  empty = false; bridge.jobs.get(job.id).diagnostics.next_poll_at_ms=0; await bridge.tick(); await bridge.tick();
  assert.notEqual(bridge.get(job.id).status, 'completed');
  await bridge.tick();
  assert.equal(bridge.get(job.id).attention, 'download_failed');
});

test('HTTP auth, signed download expiry/tampering and content ranges', async t => {
  const { bridge, cfg } = await fixture(t, async args => {
    if (args[0] === 'space') return context;
    if (args[0] === 'node') return { submission: { state: 'accepted' } };
    if (args[0] === 'operation') return { state: 'succeeded', resources: [{ resourceId: 'res-test', state: 'succeeded' }] };
    const path = args.find(a => a.startsWith('--output=')).slice(9);
    await writeFile(path, png);
    return { resourceId:args[2], path, size: png.length, sha256: createHash('sha256').update(png).digest('hex') };
  });
  const server = createServer(bridge);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  cfg.publicUrl = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': 'http' };
  assert.equal((await fetch(cfg.publicUrl + '/v1/jobs')).status, 401);
  assert.equal((await fetch(cfg.publicUrl + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ ...request, n: 99 }) })).status, 400);
  const created = await fetch(cfg.publicUrl + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify(request) });
  assert.equal(created.status, 202);
  const job = await created.json(); await bridge.tick();
  assert.equal(bridge.get(job.id).status, 'queued');
  await fetch(cfg.publicUrl + '/v1/jobs/' + job.id, { headers });
  await bridge.tick(); await bridge.tick(); await bridge.tick();
  const done = await (await fetch(cfg.publicUrl + '/v1/jobs/' + job.id, { headers })).json();
  assert.equal(done.status, 'completed');
  const url = done.data[0].url;
  assert.ok(!url.includes(token));
  assert.equal((await fetch(url + 'x')).status, 401);
  const expired = new URL(url); expired.searchParams.set('expires', '1');
  assert.equal((await fetch(expired)).status, 401);
  const media = await fetch(url, { headers: { Range: 'bytes=0-7' } });
  assert.equal(media.status, 206);
  assert.equal(media.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), png.subarray(0, 8));
});

test('CLI runner rejects invalid output and kills hung processes', async () => {
  await assert.rejects(runCLI(process.execPath, ['-e', 'console.log("not-json")'], 1000), /CLI/);
  await assert.rejects(runCLI(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 40), /timeout/);
  await assert.rejects(runCLI(process.execPath, ['-e', 'console.error(JSON.stringify({ok:false,error:{code:"cli.generation_confirmation_required"}})); process.exit(10)'], 1000), { exitCode: 10 });
});

test('partial image failure delivers and bills only successful artifacts', async t => {
  const { bridge } = await fixture(t, async args => {
    if (args[0] === 'space') return context;
    if (args[0] === 'node') return { submission: { state: 'accepted' } };
    if (args[0] === 'operation') return { state: 'failed', resources: [{ resourceId: 'good', state: 'succeeded' }, { resourceId: 'bad', state: 'failed' }] };
    const path = args.find(a => a.startsWith('--output=')).slice(9);
    await writeFile(path, png);
    return { resourceId:args[2], path, size: png.length, sha256: createHash('sha256').update(png).digest('hex') };
  });
  const job = await bridge.submit({ ...request, n: 2 }, 'partial');
  await bridge.tick(); await bridge.tick(); await bridge.tick();
  assert.equal(bridge.get(job.id).status, 'completed');
  assert.equal(bridge.get(job.id).image_count, 1);
  assert.equal(bridge.get(job.id).data.length, 1);
});

test('preflight rejects incorrect resolution case and model capabilities before submission', async t => {
  const { bridge, cfg } = await fixture(t, async args => {
    if (args[0] === 'space') return context;
    return { items: [{ model: 'seedream_4.0', modes: [{ name: 't2i', flags: [
      { flag: '--ratio', values: ['1:1'] }, { flag: '--resolution', values: ['2K'] },
      { flag: '--count', min: 1, max: 8 }, { flag: '--prompt', maxLength: 2000 },
    ] }] }] };
  });
  delete cfg.models['dreamina-video'];
  await assert.rejects(bridge.preflight(), /resolution/);
  cfg.models['dreamina-image'].resolution = '2K';
  await bridge.preflight();
  await assert.rejects(bridge.submit({ ...request, prompt: 'x'.repeat(2001) }, 'too-long'), /invalid prompt/);
});

test('queue limits, exclusive lock and configuration pinning prevent unsafe admission', async t => {
  const { bridge, cfg } = await fixture(t, async () => context);
  cfg.maxQueue = 1;
  await bridge.submit(request, 'first');
  await assert.rejects(bridge.submit(request, 'second'), { status: 429 });
  await assert.rejects(Bridge.open(cfg), { code: 'EEXIST' });
  await bridge.close();
  await assert.rejects(Bridge.open({ ...cfg, userId: '456' }), /context mismatch/);
});

test('HTML masquerading as generated media is never exposed as a completed artifact', async t => {
  const { bridge } = await fixture(t, async args => {
    if (args[0] === 'space') return context;
    if (args[0] === 'node') return { submission: { state: 'accepted' } };
    if (args[0] === 'operation') return { state: 'succeeded', resources: [{ resourceId: 'res-test', state: 'succeeded' }] };
    const path = args.find(a => a.startsWith('--output=')).slice(9), bytes = Buffer.from('<html>login required</html>');
    await writeFile(path, bytes);
    return { resourceId:args[2], path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const job = await bridge.submit(request, 'invalid-media');
  await bridge.tick(); await bridge.tick();
  assert.equal(bridge.get(job.id).status, 'in_progress');
  await bridge.tick();
  assert.equal(bridge.get(job.id).attention, 'download_failed');
  assert.deepEqual(bridge.get(job.id).data, []);
});


test('restart does not start queued work until gateway polling renews its lease', async t => {
  let generations = 0;
  const cli = async args => { if (args[0] === 'space') return context; generations++; return { submission: { state: 'accepted' } }; };
  const { bridge, cfg, invoke } = await fixture(t, cli);
  const job = await bridge.submit(request, 'lease');
  await bridge.close();
  const restored = await Bridge.open(cfg, invoke);
  t.after(() => restored.close());
  await restored.tick();
  assert.equal(generations, 0);
  restored.observe(job.id);
  await restored.tick();
  assert.equal(generations, 1);
});

test('video uses the approved duration and only completes after verified MP4 download', async t => {
  let savedArgs,runArgs;
  const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d', 'hex');
  const { bridge } = await fixture(t, async (args, saved) => {
    if (args[0] === 'space') return context;
    if (args[0] === 'node') { savedArgs = saved; runArgs = args; return { submission: { state: 'accepted' } }; }
    if (args[0] === 'operation') return { state: 'succeeded', resources: [{ resourceId: 'video-test', state: 'succeeded' }] };
    const path = args.find(a => a.startsWith('--output=')).slice(9);
    await writeFile(path, mp4);
    return { resourceId:args[2], path, size: mp4.length, sha256: createHash('sha256').update(mp4).digest('hex') };
  });
  const job = await bridge.submit({ kind: 'video', model: 'dreamina-video', prompt: 'waves', seconds: 10 }, 'video-success');
  await bridge.tick();
  assert.ok(savedArgs.includes('--duration=10'));
  assert.ok(savedArgs.includes('--model=video-test'));
  assert.ok(runArgs.includes('--credit-token=fixture-approval'));
  assert.ok(savedArgs.includes('--mode=t2v'));
  await bridge.tick(); await bridge.tick();
  assert.equal(bridge.get(job.id).status, 'completed');
  assert.equal(bridge.get(job.id).seconds, 10);
  assert.equal(bridge.jobs.get(job.id).files[0].mime, 'video/mp4');
});

const liveCatalog = JSON.parse(await readFile(new URL('./fixtures/video-models.json', import.meta.url), 'utf8'));
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d', 'hex');
async function videoFixture(t, handler, overrides = {}) {
  const dir=await mkdtemp(join(tmpdir(),'dreamina-video-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const cfg=validateConfig({...config(dir),maxConcurrent:100,models:Object.fromEntries(liveCatalog.items.map(m=>[m.model,{kind:'video',model:m.model,maxCredits:100}])),...overrides});
  cfg.pollIntervalMs = 0; // Lifecycle tests advance manually.
  const cli=quotedCLI(async (args,saved)=>{
    if(args[0]==='space') return context;
    if(args[0]==='model' && args[1]==='list') return liveCatalog;
    if(args[0]==='model') return {matches:[{generation:{generationKind:'sample',mode:'t2v',draftPromotion:{params:[{name:'resolution',rule:{stringValues:['1080p']}}]}}}]};
    return handler(args,saved);
  });
  const bridge=await Bridge.open(cfg,cli);t.after(()=>bridge.close());await bridge.preflight();
  return {bridge,cfg,cli,dir};
}

// Snapshots admitted by a previous bridge version remain valid after new
// promotion submission is disabled. Do not create them through today's API.
async function persistLegacyPromotion(bridge, seconds = 5, billing) {
  const sourceId = randomUUID(), jobId = randomUUID();
  const source = {
    id:sourceId,key:createHash('sha256').update(sourceId).digest('hex'),context:bridge.contextKey,
    request:{kind:'video',model:'seedance_2.5_draft',mode:'t2v',prompt:'waves',ratio:'16:9',resolution:'480P',seconds,n:1,references:[]},
    nodeId:'node_0000000001',projectId:bridge.config.projectId,status:'completed',created_at:Math.floor(Date.now()/1000),
    files:[{resourceId:'draft-result'}],inputs:[],
  };
  const job = {
    id:jobId,key:createHash('sha256').update(jobId).digest('hex'),context:bridge.contextKey,
    request:{kind:'video',model:'seedance_2.5',mode:'promote',source_job_id:source.id,resolution:'1080p',ratio:'16:9',seconds,n:1,references:[]},
    nodeId:'node_0000000002',projectId:source.projectId,updateId:randomUUID(),submitId:randomUUID(),
    status:'queued',created_at:Math.floor(Date.now()/1000),timings:{admitted_at_ms:Date.now()},files:[],inputs:[],
    ...(billing ? {billing,billingMode:'credits'} : {billingMode:'legacy_seconds'}),
  };
  for (const record of [source,job]) {
    record.digest=createHash('sha256').update(JSON.stringify(record.billing?{request:record.request,billing:record.billing}:record.request)).digest('hex');
    await bridge.save(record);
    await bridge.indexJob(record);
    bridge.storedJobs++;
  }
  await bridge.observe(job.id);
  return {source,job};
}

test('30-minute queue window allows late starts, expires waiting work, and preserves running jobs', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T00:00:00Z') });
  let generations = 0;
  const {bridge} = await videoFixture(t, async args => {
    if (args[0] === 'node') { generations++; return {submission:{state:'accepted'}}; }
    return {state:'running',resources:[]};
  }, {maxQueueWaitSeconds:1800});
  const running = await bridge.submit({kind:'video',model:'seedance_2.5',prompt:'waves'}, 'late-start');
  const waiting = await bridge.submit({kind:'video',model:'seedance_2.5',prompt:'waves'}, 'expires');
  t.mock.timers.tick(1799000);
  bridge.observe(running.id);
  await bridge.tick();
  assert.equal(generations, 1);
  assert.equal(bridge.get(running.id).status, 'in_progress');
  t.mock.timers.tick(1000);
  bridge.observe(waiting.id);
  await bridge.tick();
  assert.equal(generations, 1);
  assert.equal(bridge.get(waiting.id).error.code, 'queue_expired');
  assert.equal(bridge.get(running.id).status, 'in_progress');
});

test('unlimited credit approval must be an explicit server boolean', () => {
  for (const value of ['true', 'false', 1, null]) {
    assert.throws(() => validateConfig({...config('/tmp/dreamina-config-test'), unlimitedCredits: value}), /unlimitedCredits/);
  }
});

test('persisted historical promotion preserves the operator credit cap and unlimited policy', async t => {
  for (const unlimitedCredits of [false, true]) {
      await t.test(unlimitedCredits ? 'unlimited' : 'capped', async t => {
        const {bridge} = await videoFixture(t, async args => {
          assert.equal(args[0], 'node');
          // Simulate the documented CLI response to a quote above 100 credits.
          if (!args.includes('--yes')) {
            assert.ok(args.includes('--credit-ceiling=100'));
            throw Object.assign(new Error('quote exceeds ceiling'), {exitCode: 10});
          }
          assert.equal(args.some(a => a.startsWith('--credit-ceiling=')), false);
          return {submitId: args.find(a => a.startsWith('--submit-id=')).slice(12), state: 'accepted'};
        }, {unlimitedCredits});
        const {job} = await persistLegacyPromotion(bridge, 10);
        await bridge.tick();
        assert.equal(bridge.get(job.id).status, unlimitedCredits ? 'in_progress' : 'failed');
        assert.equal(bridge.get(job.id).error?.code, unlimitedCredits ? undefined : 'credit_approval_required');
      });
  }
});

test('live catalogue validates all eight models and requested spec reaches CLI unchanged',async t=>{
  const calls=[];
  const {bridge}=await videoFixture(t,async (a,saved)=>{calls.push(saved||a);return {submission:{state:'accepted'}};});
  const job=await bridge.submit({kind:'video',model:'wan_3.0',prompt:'海浪',resolution:'1080p',ratio:'9:16',seconds:12,n:3},'all-video');
  await bridge.tick();
  const args=calls.find(a=>a[0]==='node');
  for(const flag of ['--model=wan_3.0','--resolution=1080P','--ratio=9:16','--duration=12','--count=3']) assert.ok(args.includes(flag),flag);
  assert.equal(bridge.get(job.id).resolution,'1080P');
  await assert.rejects(bridge.submit({kind:'video',model:'seedance_2.5',prompt:'x',resolution:'4k'},'bad'),/resolution/);
});

test('reference upload IDs survive restart and paid dispatch waits for a live gateway lease',async t=>{
  const uploaded=[];let nodes=0;let fail=true;
  const {bridge,cfg,cli,dir}=await videoFixture(t,async a=>{
    if(a[0]==='resource' && a[1]==='upload') {
      const id=a.find(x=>x.startsWith('--resource-id=')).slice(14);uploaded.push(id);
      if(fail) throw new Error('upload transport lost');
      return {resourceId:id,mediaType:'image'};
    }
    if(a[0]==='node'){nodes++;return {submission:{state:'accepted'}};}
    throw new Error('unexpected command');
  });
  const job=await bridge.submit({kind:'video',model:'seedance_2.5',prompt:'x',mode:'first_last_frame',references:[{type:'image',url:'data:image/png;base64,'+png.toString('base64')}]},'ref');
  await bridge.tick();assert.equal(nodes,0);
  assert.equal((await readFile(join(dir,job.id+'.json'),'utf8')).includes('base64'),false);
  await bridge.close();fail=false;
  const recovered=await Bridge.open(cfg,cli);t.after(()=>recovered.close());await recovered.preflight();
  await recovered.tick();assert.equal(nodes,0);
  recovered.observe(job.id);await recovered.tick();
  assert.equal(nodes,1);assert.equal(uploaded.length,2);assert.equal(uploaded[0],uploaded[1]);
});

test('unleased queue entries do not starve another live request and active tasks are polled',async t=>{
  const {bridge,cfg}=await videoFixture(t,async a=>a[0]==='node'?{submission:{state:'accepted'}}:{state:'running',resources:[]});
  cfg.maxConcurrent=2;
  const a=await bridge.submit({kind:'video',model:'seedance_2.5',prompt:'a'},'a');
  bridge.leases.delete(a.id);
  const b=await bridge.submit({kind:'video',model:'seedance_2.5',prompt:'b'},'b');
  await bridge.tick();assert.equal(bridge.get(b.id).status,'in_progress');
  bridge.observe(a.id);await bridge.tick();assert.equal(bridge.get(a.id).status,'in_progress');
});

test('configured 200-slot scheduler admits and starts 200 jobs, then rejects overflow', async t => {
  const {bridge} = await videoFixture(t, async args => args[0] === 'node'
    ? {submission:{state:'accepted'}} : {state:'running',resources:[]},
  {maxConcurrent:200,maxQueue:200});
  const jobs = [];
  for (let i = 0; i < 200; i++) {
    jobs.push(await bridge.submit({kind:'video',model:'seedance_2.5',prompt:'waves'}, 'concurrency-' + i));
  }
  await assert.rejects(bridge.submit({kind:'video',model:'seedance_2.5',prompt:'waves'}, 'overflow'),
    error => error.status === 429);
  for (let i = 0; i < 200; i++) {
    for (const job of jobs) bridge.observe(job.id);
    await bridge.tick();
  }
  assert.equal(jobs.filter(job => bridge.get(job.id).status === 'in_progress').length, 200);
});

test('multi-video partial completion counts only verified downloads and exposes every output',async t=>{
  const {bridge}=await videoFixture(t,async a=>{
    if(a[0]==='node') return {submission:{state:'accepted'}};
    if(a[0]==='operation')return {state:'failed',resources:[{resourceId:'good1',state:'succeeded'},{resourceId:'bad',state:'failed'},{resourceId:'good2',state:'succeeded'}]};
    const path=a.find(x=>x.startsWith('--output=')).slice(9);await writeFile(path,mp4);
    return {resourceId:a[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
  });
  const j=await bridge.submit({kind:'video',model:'seedance_2.5',prompt:'x',seconds:10,n:3},'partial-video');
  await bridge.tick();await bridge.tick();await bridge.tick();
  assert.equal(bridge.get(j.id).status,'completed');assert.equal(bridge.get(j.id).video_count,2);assert.equal(bridge.get(j.id).n,3);
});

test('reference URLs cannot fetch local services and invalid media fails before paid CLI calls',async t=>{
  let paid=0;
  const {bridge}=await videoFixture(t,async a=>{if(a[0]==='node')paid++;throw new Error('unexpected');});
  for(const url of ['https://127.0.0.1/a','https://169.254.169.254/meta','https://[::1]/a','https://localhost/a','data:image/png;base64,'+Buffer.from('<html>bad</html>').toString('base64')]) {
    await assert.rejects(bridge.submit({kind:'video',model:'seedance_2.5',references:[{type:'image',url}]},'unsafe-'+url));
  }
  assert.equal(paid,0);
});

test('persisted historical promotion resumes on its original draft after restart',async t=>{
  let args;
  const {bridge,cfg,cli}=await videoFixture(t,async a=>{args=a;return {submitId:a.find(value=>value.startsWith('--submit-id=')).slice(12),state:'accepted'};});
  const {source,job}=await persistLegacyPromotion(bridge,12);
  await bridge.close();
  const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());await restored.preflight();
  await restored.observe(job.id);await restored.tick();
  assert.deepEqual(args.slice(0,3),['node','promote','video-sample']);
  assert.ok(args.includes('--node-id='+source.nodeId));assert.ok(args.includes('--submit-id='+job.submitId));
  assert.equal(restored.get(job.id).status,'in_progress');
  assert.match(restored.get(source.id).warning,/样片最长存储 7 天.*暂不支持样片转正/);
});

test('reference DNS checks every answer including mixed public/private addresses', async()=>{
  const {publicAddress}=await import('./media-input.mjs');
  assert.equal(await publicAddress(new URL('https://example.com/a'),async()=>[{address:'8.8.8.8',family:4}]),'8.8.8.8');
  for(const address of ['10.0.0.1','100.64.0.1','127.1.2.3','172.16.1.1','192.168.1.1','0.250.250.254','224.1.1.1']) {
    await assert.rejects(publicAddress(new URL('https://example.com/a'),async()=>[{address:'8.8.8.8',family:4},{address,family:4}]));
  }
  await assert.rejects(publicAddress(new URL('https://user:pass@example.com/a')));
  await assert.rejects(publicAddress(new URL('https://example.com:8787/a')));
});

test('long reference upload cannot bypass gateway lease or cause a paid submission',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-01-01T00:00:00Z')});
  let paid=0;
  const {bridge}=await videoFixture(t,async a=>{
    if(a[0]==='node')paid++;
    t.mock.timers.tick(301000);
    return {resourceId:a.find(x=>x.startsWith('--resource-id=')).slice(14),mediaType:'image'};
  });
  const j=await bridge.submit({kind:'video',model:'seedance_2.5',references:[{type:'image',url:'data:image/png;base64,'+png.toString('base64')}]},'slow-upload');
  await bridge.tick();assert.equal(paid,0);assert.equal(bridge.get(j.id).status,'queued');
});

test('historical promotion validates its accepted result and remains downloadable after restart',async t=>{
  let resource='foreign';
  const {bridge,cfg,cli}=await videoFixture(t,async a=>{
    if(a[0]==='node')return {submitId:a.find(x=>x.startsWith('--submit-id=')).slice(12),state:'accepted',errorCode:0,resourceIds:['promoted']};
    if(a[0]==='operation')return {operationRef:a[2],state:'completed',resources:[{resourceId:resource,state:'succeeded'}]};
    if(a[0]==='resource'){
      const path=a.find(x=>x.startsWith('--output=')).slice(9);await writeFile(path,mp4);
      return {resourceId:a[2],path,size:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')};
    }
    throw new Error('unexpected');
  });
  const {job:j}=await persistLegacyPromotion(bridge);
  await bridge.tick();assert.equal(bridge.get(j.id).attention,undefined);
  const promoted=bridge.jobs.get(j.id);
  await bridge.processJob(promoted);
  assert.equal(bridge.get(j.id).attention,'resource_count_mismatch');
  resource='promoted';await bridge.processJob(promoted);await bridge.processJob(promoted);
  assert.equal(bridge.get(j.id).status,'completed');
  assert.deepEqual(promoted.files.map(f=>f.resourceId),['promoted']);
  await bridge.close();
  const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());
  const server=createServer(restored);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  cfg.publicUrl='http://127.0.0.1:'+server.address().port;
  const response=await fetch(cfg.publicUrl+'/v1/jobs/'+j.id,{headers:{Authorization:'Bearer '+token}});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.status,'completed');
  assert.equal(result.billing_mode,'legacy_seconds');
  assert.equal(result.video_count,1);
  assert.equal(result.seconds,5);
  const media=await fetch(restored.mediaURL(j.id,0));
  assert.equal(media.status,200);
  assert.equal(media.headers.get('content-type'),'video/mp4');
  assert.deepEqual(Buffer.from(await media.arrayBuffer()),mp4);
});

test('historical accepted promotion failure preserves the upstream error without resubmitting',async t=>{
  let polls=0;
  const {bridge,cfg,cli}=await videoFixture(t,async args=>{
    assert.equal(args[0],'operation');polls++;
    return {operationRef:args[2],state:'failed',errorCode:20115,resources:[]};
  });
  const {job}=await persistLegacyPromotion(bridge);
  job.status='in_progress';
  job.timings.accepted_at_ms=Date.now();
  await bridge.save(job);await bridge.close();
  const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());
  await restored.tick();
  const result=restored.get(job.id);
  assert.equal(result.status,'failed');
  assert.equal(result.error.upstream_code,20115);
  assert.match(result.error.message,/本次生成的输出视频未通过版权审核/);
  assert.equal(result.billing_mode,'legacy_seconds');
  assert.equal(polls,1);
});

for (const limit of [2, 200]) test('HTTP admission limit '+limit+' bounds submissions while queries remain available',async t=>{
  const {bridge}=await videoFixture(t,async()=>{throw new Error('no CLI mutation');},limit===2?{}:{maxAdmissions:limit});
  let unblock, entered, count=0;
  const held=new Promise(r=>{unblock=r;});
  bridge.submit=async()=>{count++;entered?.();if(count<=limit)await held;return {id:'accepted'};};
  bridge.loadJob=async id=>({id});
  const server=createServer(bridge);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{unblock();server.closeAllConnections();return new Promise(r=>server.close(r));});
  const url='http://127.0.0.1:'+server.address().port;
  // Dedicated sockets exercise the server limit rather than fetch's connection pool.
  const send=()=>new Promise((resolve,reject)=>{
    const req=httpRequest(url+'/v1/jobs',{method:'POST',agent:false,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}},res=>{
      res.resume();res.once('end',()=>resolve({status:res.statusCode}));
    });
    req.once('error',reject);req.end('{}');
  });
  const pending=[];
  try {
    // Admit one connection at a time, keeping every accepted request pending.
    // Bursting 200 TCP connects tests the OS accept backlog instead of our cap.
    for(let i=0;i<limit;i++) {
      let rejected;
      const admitted=new Promise((resolve,reject)=>{entered=resolve;rejected=reject;});
      const request=send();request.catch(rejected);pending.push(request);
      await admitted;
    }
    assert.equal(count,limit);
    assert.equal((await fetch(url+'/healthz',{headers:{Authorization:'Bearer '+token}})).status,200);
    assert.equal((await send()).status,429);
    unblock();
    assert.ok((await Promise.all(pending)).every(r=>r.status===202));
  } finally {unblock();await Promise.allSettled(pending);}
});

test('reference admission aborts during DNS without holding the queue indefinitely',async()=>{
  const {publicAddress}=await import('./media-input.mjs');
  const controller=new AbortController();
  let release;
  const dns=new Promise(r=>{release=r;});
  const pending=publicAddress(new URL('https://example.com/a'),()=>dns,controller.signal);
  controller.abort(new Error('Reference deadline exceeded'));
  release([{address:'8.8.8.8',family:4}]);
  await assert.rejects(pending,/deadline/);
});

test('an upload-rejected queued job cannot starve a healthy leased request',async t=>{
  let uploads=0,paid=0;
  const {bridge}=await videoFixture(t,async a=>{
    if(a[0]==='resource'){uploads++;throw new Error('upload rejected');}
    if(a[0]==='node'){paid++;return {submission:{state:'accepted'}};}
    return {state:'running',resources:[]};
  });
  const blocked=await bridge.submit({kind:'video',model:'seedance_2.5',references:[{type:'image',url:'data:image/png;base64,'+png.toString('base64')}]},'upload-blocked');
  const healthy=await bridge.submit({kind:'video',model:'seedance_2.5',prompt:'healthy'},'healthy');
  await bridge.tick();await bridge.tick();await bridge.tick();
  assert.equal(bridge.get(healthy.id).status,'in_progress');
  assert.equal(bridge.get(blocked.id).status,'queued');assert.equal(paid,1);assert.ok(uploads>=1);
});

test('terminal upstream failures preserve original codes and messages without private payloads', async t => {
  for (const upstream of [
    {state:'failed',resources:[{state:'failed',resourceId:'r',serviceCode:20999}]},
    {state:'failed',resources:[{state:'failed',resourceId:'r',serviceCode:20999}],error:{message:'Original upstream rejection'}},
    {state:'failed',resources:[{state:'failed',resourceId:'r',serviceCode:20999,errorMessage:'内容不符合平台规则，请修改后重试',privateUrl:'https://secret'}]},
    {state:'failed',error:{code:'ContentRejected',message:'Reference image was rejected',details:{token:'secret'}}},
  ]) await t.test(JSON.stringify(upstream.error?.code || upstream.resources[0].serviceCode)+' '+Boolean(upstream.resources?.[0].errorMessage), async t => {
    const {bridge}=await videoFixture(t,async a=>a[0]==='node'?{submission:{state:'accepted'}}:upstream);
    const j=await bridge.submit({kind:'video',model:'seedance_2.5',prompt:'waves'},'error');
    await bridge.tick();await bridge.tick();
    const err=bridge.get(j.id).error;
    assert.equal(err.code,'generation_failed');
    assert.equal(err.upstream_code,upstream.error?.code || 20999);
    assert.equal(err.message,upstream.error?.message || upstream.resources[0].errorMessage || 'Dreamina service error: 20999');
    assert.equal(JSON.stringify(err).includes('secret'),false);
  });
});

test('explicit submission rejection keeps the upstream reason', async t => {
  const {bridge}=await videoFixture(t,async()=>({submission:{state:'rejected',error:{code:'INPUT_REJECTED',message:'Unsupported reference image'}}}));
  const j=await bridge.submit({kind:'video',model:'seedance_2.5',prompt:'waves'},'reject');
  await bridge.tick();
  assert.deepEqual(bridge.get(j.id).error,{code:'submission_rejected',message:'Unsupported reference image',upstream_code:'INPUT_REJECTED'});
});

test('copyright rejection 20115 has Chinese text in task logs and public video errors', async t => {
  const plugin = await import('./plugin.js');
  for (const code of [20115, '20115']) {
    const {bridge}=await videoFixture(t,async a=>a[0]==='node'
      ? {submission:{state:'accepted'}}
      : {state:'failed',resources:[{state:'failed',resourceId:'r',serviceCode:code,errorMessage:'Dreamina service error: 20115'}]});
    const job=await bridge.submit({kind:'video',model:'seedance_2.5',prompt:'waves'},'copyright-'+code);
    await bridge.tick();await bridge.tick();
    const body=bridge.get(job.id);
    const parsed=plugin.parseTaskResult({},body,{status:200});
    assert.equal(parsed.reason,'20115:本次生成的输出视频未通过版权审核；请修改输入内容后重新提交，不自动重试');
    const output=plugin.protocols.openai_video.render({},{status:'FAILURE',fail_reason:parsed.reason,data:body});
    assert.deepEqual(output.error,{code:'video_generation_failed',message:parsed.reason,upstream_code:code});
  }
});
