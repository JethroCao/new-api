import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as p from './plugin.js';
const models = ['happyhorse_1.1', 'seedance_2.0_fast_vip', 'seedance_2.0_mini', 'seedance_2.0_vip', 'seedance_2.5', 'seedance_2.5_draft', 'seedance_pro_fast', 'wan_3.0'];
const decode = (value, extra = {}) => p.protocols.openai_video.decodeRequest({ model: value.model || 'seedance_2.5', operation: 'create', body: { kind: 'json', value }, ...extra });
const driver = intent => ({ ...intent, publicTaskId: 'task-public', baseUrl: 'http://localhost:8787/', apiKey: 'secret' });

test('all eight models support user specs and only advertise video generation', () => {
  assert.deepEqual(p.meta.protocols, ['openai_video']);
  assert.equal(p.meta.models.includes('dreamina-image'), false);
  for (const model of models) {
    assert.ok(p.meta.models.includes(model));
    const r = p.buildSubmitRequest(driver(decode({ model, prompt: 'waves', seconds: 5, n: 2, ratio: '9:16' })));
    assert.equal(r.body.model, model); assert.equal(r.body.ratio, '9:16'); assert.equal(r.body.n, 2);
    assert.equal(r.headers['Idempotency-Key'], 'task-public');
  }
  const r = p.buildSubmitRequest(driver(decode({ prompt: 'waves', size: '1920x1080', seconds: '12' })));
  assert.equal(r.body.resolution, '1080p'); assert.equal(r.body.ratio, '16:9'); assert.equal(r.body.seconds, 12);
  assert.equal(p.buildSubmitRequest(driver(decode({model:'wan_3.0',prompt:'x',resolution:'1080p'}))).body.resolution, '1080P');
});

test('invalid model/spec/reference combinations are rejected before billing', () => {
  for (const change of [{seconds:0},{seconds:31},{seconds:1.5},{seconds:null},{n:0},{n:5},{n:1.5},{resolution:'4k'},{ratio:'5:7'},{maxCredits:999},{source_job_id:'private'},{prompt:'{{res:private}}'},{prompt:'{{node:node_private}}'},{model:'seedance_pro_fast',mode:'m2v',references:[{type:'image',url:'https://example.com/a.png'}]}]) {
    assert.throws(() => decode({prompt:'x',...change}));
  }
  assert.throws(()=>decode({model:'seedance_2.0_mini',prompt:'x',seconds:20}));
  assert.throws(()=>decode({prompt:'x',size:'1280x720',resolution:'1080p'}));
  assert.throws(()=>decode({prompt:'x',mode:'first_last_frame',references:[{type:'audio',url:'https://example.com/a.mp3'}]}));
  assert.throws(()=>decode({prompt:'x',references:[{type:'image',url:'file:///etc/passwd'}]}));
  assert.throws(()=>decode({prompt:'x',references:[{type:'image',resource_id:'secret'}]}));
});

test('multipart files keep ordering and host refs while all quantities are validated', () => {
  const intent = decode({}, {body:{kind:'multipart',fields:{model:['seedance_2.5'],prompt:['waves'],seconds:['10'],mode:['first_last_frame']},files:[
    {ref:'request_file:input_reference',field:'input_reference',mimeType:'image/png',size:10},
    {ref:'request_file:input_reference#1',field:'input_reference',mimeType:'image/jpeg',size:11},
  ]}});
  const r=p.buildSubmitRequest(driver(intent));
  assert.deepEqual(r.body.references.map(x=>x.url.__fileRef),['request_file:input_reference','request_file:input_reference#1']);
  assert.equal(r.body.seconds,10);
  assert.throws(()=>decode({}, {body:{kind:'multipart',fields:{prompt:['x'],seconds:['5','30']},files:[]}}));
  assert.throws(()=>decode({prompt:'x',references:[{type:'image',url:{__fileRef:'request_file:secret',encoding:'dataUrl'}}]}));
});

test('usage reserves all requested seconds and settles only delivered videos with frozen spec facts', () => {
  const ctx=driver(decode({prompt:'x',resolution:'1080p',seconds:10,n:3}));
  assert.deepEqual(p.extractUsage(ctx),{seconds:30,resolution:'1080p',mode:'t2v',reference_video:false});
  assert.deepEqual(p.extractUsageOnComplete({}, {}, {object:'video',status:'completed',seconds:10,video_count:2,resolution:'1080p',mode:'t2v',reference_video:false}),{seconds:20});
  assert.throws(()=>p.extractUsageOnComplete({}, {}, {object:'video',status:'completed',seconds:1e100,video_count:2}));
});

test('multiple results have authenticated host artifacts without exposing bridge URLs', () => {
  const task={task_id:'task-public',status:'SUCCESS',data:{object:'video',video_count:3,seconds:5,resolution:'480p',ratio:'16:9',mode:'t2v',data:[{url:'http://private?sig=secret'}]}};
  assert.deepEqual(p.listArtifacts(task).map(x=>x.key),['video','video-2','video-3']);
  const r=p.buildContentRequest({upstreamTaskId:'private',artifactKey:'video-3',data:task.data,baseUrl:'http://localhost:8787',apiKey:'secret',clientRequest:{method:'GET'}});
  assert.equal(r.url,'http://localhost:8787/v1/jobs/private/content/2');
  assert.equal(r.headers.Authorization,'Bearer secret');
  assert.throws(()=>p.buildContentRequest({artifactKey:'video-4',data:task.data}));
  const rendered=p.protocols.openai_video.render({},task);
  assert.equal(rendered.video_count,3); assert.equal(JSON.stringify(rendered).includes('private'),false);
});

test('draft promotion uses only an owner-verified origin task and inherits its immutable parameters', () => {
  const intent=decode({model:'seedance_2.5',mode:'promote',draft_task_id:'task_draft',resolution:'1080p'});
  assert.deepEqual(intent.originTaskIds,['task_draft']);
  assert.throws(()=>p.buildSubmitRequest(driver(intent)));
  const ctx={...driver(intent),originTasks:[{taskId:'task_draft',upstreamTaskId:'bridge-draft',status:'SUCCESS',data:{model:'seedance_2.5_draft',object:'video',video_count:1,n:1,seconds:12,ratio:'9:16'}}]};
  const r=p.buildSubmitRequest(ctx);
  assert.equal(r.body.source_job_id,'bridge-draft'); assert.equal(r.body.seconds,12); assert.equal(r.body.ratio,'9:16');
  assert.equal(p.extractUsage(ctx).seconds,12);
  assert.throws(()=>decode({mode:'promote',draft_task_id:'task_draft',seconds:30}));
});

test('query errors remain unknown and old image tasks cannot be created', () => {
  assert.throws(()=>p.parseTaskResult({}, {}, {status:503}));
  assert.equal(p.parseTaskResult({}, {status:'surprise'}, {status:200}).status,'UNKNOWN');
  assert.throws(()=>decode({model:'dreamina-image',prompt:'x'}));
});

test('prompt placeholders cannot inject private canvas references using whitespace or alternate spelling',()=>{
  for(const prompt of ['{{res :11111111-1111-4111-8111-111111111111}}','{{ node : node_0123456789}}','{{uri : private}}','{{vid : private}}','{{RES:private}}','{{\tres\n:private}}']) {
    assert.throws(()=>decode({prompt,mode:'m2v',references:[{type:'image',url:'https://example.com/public.png'}]}),/prompt/);
  }
});
