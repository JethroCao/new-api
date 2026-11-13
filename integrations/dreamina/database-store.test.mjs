import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseStore} from './database-store.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const projectId='c2679e06-fce3-4b3c-9038-3729d426c2b8';
function job(context,key,status='queued') {return {context,id:randomUUID(),key:hash(key),digest:hash('request'),projectId,nodeId:'node_123',submitId:randomUUID(),updateId:randomUUID(),status,request:{n:1,kind:'video'},files:[]};}
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'dreamina-db-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const context=hash(randomUUID()),url=process.env.DREAMINA_TEST_DATABASE_URL || 'sqlite://'+join(dir,'jobs.sqlite');
 const store=await DatabaseStore.open({url,context});t.after(()=>store.close());
 return {store,dir,context,url};
}
test('database jobs and idempotency survive restart without terminal history consuming capacity',async t=>{
 const {store,context,url}=await fixture(t);await store.initialize([],null);
 const a={...job(context,'a','completed'),billing:{version:1,request_id:'task-credit',reserved_credits:100},upstreamCreditQuote:{source:'dreamina_canvas_cli',credits:42,quote_stage:'before_generation',cost_cny_per_credit:'0.025'}};await store.save(a);
 const b=job(context,'b','failed');await store.save(b);
 const c=job(context,'c');await store.save(c);
 assert.equal(await store.findKey(a.key),a.id);
 assert.deepEqual(await store.get(a.id),a);
 assert.deepEqual((await store.active()).map(j=>j.id),[c.id]);
 await assert.rejects(DatabaseStore.open({url,context}),/writer|storage/);
 await store.close();const restored=await DatabaseStore.open({url,context});t.after(()=>restored.close());
 assert.deepEqual(await restored.get(a.id),a);assert.equal(await restored.count(),3);
 const duplicate={...a,id:randomUUID()};await assert.rejects(restored.save(duplicate),/storage/);
});
test('legacy migration is atomic and never overwrites database state on rerun',async t=>{
 const {store,context}=await fixture(t);const a=job(context,'legacy','completed');
 const registry={version:2,context,canvases:[]};
 await store.initialize([a],registry);
 const updated={...a,error:'preserved newer database state'};await store.save(updated);
 await store.initialize([a],registry);
 assert.deepEqual(await store.get(a.id),updated);assert.deepEqual(await store.readCanvas(),registry);
 await store.writeCanvas({...registry,canvases:[{projectId}]});
 assert.deepEqual((await store.readCanvas()).canvases,[{projectId}]);
});
test('a conflicting legacy batch leaves no partially imported jobs',async t=>{
 const {store,context,url}=await fixture(t);const a=job(context,'same');
 await assert.rejects(store.initialize([a,{...a,id:randomUUID()}],null),/storage/);
 await store.close();const retry=await DatabaseStore.open({url,context});t.after(()=>retry.close());
 assert.equal(await retry.initialized(),false);assert.equal(await retry.count(),0);
 await retry.initialize([a],null);assert.equal(await retry.count(),1);
});


test('losing the database session fails closed and never silently reconnects',async t=>{
 const {store,context}=await fixture(t);await store.initialize([],null);const a=job(context,'persisted');await store.save(a);
 if(store.kind==='sqlite')store.connection.close();else await store.connection.end();
 await assert.rejects(store.get(a.id),e=>e.code==='job_storage_unavailable');
 await assert.rejects(store.save(job(context,'must-not-write')),e=>e.code==='job_storage_unavailable');
 assert.equal(store.poisoned,true);
});

test('bounded multi-job reads are context isolated and do not alter terminal records',async t=>{
 const {store,context}=await fixture(t);await store.initialize([],null);const a=job(context,'read-a','completed'),b=job(context,'read-b','failed');await store.save(a);await store.save(b);
 const outside=job(hash(randomUUID()),'outside','completed');
 await store.raw('INSERT INTO dreamina_bridge_jobs(id,context_id,key_hash,digest,status,project_id,units,payload) VALUES(?,?,?,?,?,?,?,?)',[outside.id,outside.context,outside.key,outside.digest,outside.status,null,1,JSON.stringify(outside)]);
 const found=await store.getMany([a.id,b.id,outside.id,randomUUID()]);assert.deepEqual(found,[a,b]);assert.deepEqual(await store.get(a.id),a);assert.deepEqual(await store.get(b.id),b);
 assert.deepEqual(await store.getMany([]),[]);await assert.rejects(store.getMany(Array(51).fill(a.id)),/batch/);
});

async function gatewayFixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'dreamina-gateway-db-'));
 const url=process.env.DREAMINA_TEST_DATABASE_URL || 'sqlite://'+join(dir,'gateway.sqlite');
 const store=await DatabaseStore.open({url,context:hash(randomUUID())});
 await store.raw('CREATE TABLE IF NOT EXISTS tasks (task_id VARCHAR(191) NOT NULL, platform VARCHAR(30), channel_id INTEGER, status VARCHAR(20), private_data TEXT)');
 const created=[];
 const {GatewayTaskReader}=await import('./gateway-task-reader.mjs');
 const reader=await GatewayTaskReader.open({url,channelId:1});
 t.after(async()=>{await reader.close();for(const id of created)await store.raw('DELETE FROM tasks WHERE task_id=?',[id]);await store.close();await rm(dir,{recursive:true,force:true});});
 async function insert(status='QUEUED',overrides={}) {
  const candidate={id:randomUUID(),taskId:'task_'+randomUUID().replaceAll('-','')};
  const row={platform:'dreamina-cli',channel_id:1,status,private_data:JSON.stringify({upstream_task_id:candidate.id,secret:'must-not-be-exposed'}),...overrides};
  await store.raw('INSERT INTO tasks(task_id,platform,channel_id,status,private_data) VALUES(?,?,?,?,?)',[candidate.taskId,row.platform,row.channel_id,row.status,row.private_data]);
  created.push(candidate.taskId);return candidate;
 }
 return {store,url,reader,insert};
}

test('gateway reader confirms only a unique matching nonterminal task and keeps private task data private',async t=>{
 const {store,reader,insert}=await gatewayFixture(t);
 const cases=[];
 for(const status of ['NOT_START','SUBMITTED','QUEUED','IN_PROGRESS'])cases.push([await insert(status),'active']);
 for(const status of ['SUCCESS','FAILURE'])cases.push([await insert(status),'terminal']);
 for(const override of [{status:'UNKNOWN'},{channel_id:3},{platform:'doubao'},{private_data:'{}'},{private_data:'not-json'},{private_data:'null'},{private_data:JSON.stringify({upstream_task_id:randomUUID()})}])cases.push([await insert('QUEUED',override),'mismatch']);
 cases.push([{id:randomUUID(),taskId:'task_missing'},'missing']);
 const duplicate=await insert();
 await store.raw('INSERT INTO tasks(task_id,platform,channel_id,status,private_data) VALUES(?,?,?,?,?)',[duplicate.taskId,'dreamina-cli',1,'QUEUED',JSON.stringify({upstream_task_id:duplicate.id})]);
 cases.push([duplicate,'mismatch']);
 const before=await store.raw('SELECT task_id,platform,channel_id,status,private_data FROM tasks ORDER BY task_id');
 const found=await reader.inspect(cases.map(([c])=>c));
 for(const [candidate,expected] of cases)assert.equal(found.get(candidate.id),expected);
 assert.equal(JSON.stringify([...found]).includes('must-not-be-exposed'),false);
 assert.deepEqual(await store.raw('SELECT task_id,platform,channel_id,status,private_data FROM tasks ORDER BY task_id'),before);
 // Enforce read-only at the database connection as well as in our SELECT-only API.
 if(reader.kind==='postgres')await assert.rejects(reader.connection.query('DELETE FROM tasks WHERE task_id=$1',[cases[0][0].taskId]),/read.only/i);
 else if(reader.kind==='mysql')await assert.rejects(reader.connection.query('DELETE FROM tasks WHERE task_id=?',[cases[0][0].taskId]),/read.only/i);
 else assert.throws(()=>reader.connection.prepare('DELETE FROM tasks WHERE task_id=?').run(cases[0][0].taskId),/readonly/i);
 assert.deepEqual(await store.raw('SELECT task_id,platform,channel_id,status,private_data FROM tasks ORDER BY task_id'),before);
 assert.deepEqual(await reader.inspect([]),new Map());
 await assert.rejects(reader.inspect(Array(201).fill(cases[0][0])),/batch/);
 await assert.rejects(reader.inspect([{id:randomUUID(),taskId:"task_'; DELETE FROM tasks;--"}]),/batch/);
});

test('gateway reader observes terminal changes on its next batch and refuses reads after close',async t=>{
 const {store,reader,insert}=await gatewayFixture(t);
 const candidate=await insert();
 assert.equal((await reader.inspect([candidate])).get(candidate.id),'active');
 await store.raw('UPDATE tasks SET status=? WHERE task_id=?',['FAILURE',candidate.taskId]);
 assert.equal((await reader.inspect([candidate])).get(candidate.id),'terminal');
 await reader.close();
 await assert.rejects(reader.inspect([candidate]),e=>e.code==='gateway_database_unavailable'&&!e.message.includes('secret'));
});

test('gateway reader lazily connects without creating a missing SQLite database and can recover when it appears',async t=>{
 const {GatewayTaskReader}=await import('./gateway-task-reader.mjs');
 const {DatabaseSync}=await import('node:sqlite');
 const {access}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'dreamina-gateway-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'gateway.sqlite');
 const reader=await GatewayTaskReader.open({url:'sqlite://'+path,channelId:1});t.after(()=>reader.close());
 const candidate={id:randomUUID(),taskId:'task_after_recovery'};
 await assert.rejects(reader.inspect([candidate]),e=>e.code==='gateway_database_unavailable'&&!e.message.includes(path));
 await assert.rejects(access(path));
 const db=new DatabaseSync(path);t.after(()=>db.close());
 db.exec('CREATE TABLE tasks(task_id TEXT, platform TEXT, channel_id INTEGER, status TEXT, private_data TEXT)');
 db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(candidate.taskId,'dreamina-cli',1,'QUEUED',JSON.stringify({upstream_task_id:candidate.id}));
 assert.equal((await reader.inspect([candidate])).get(candidate.id),'active');
 db.exec('DROP TABLE tasks');
 await assert.rejects(reader.inspect([candidate]),e=>e.code==='gateway_database_unavailable');
 db.exec('CREATE TABLE tasks(task_id TEXT, platform TEXT, channel_id INTEGER, status TEXT, private_data TEXT)');
 assert.equal((await reader.inspect([candidate])).get(candidate.id),'missing');
});


test('gateway reader times out a blocked database query and reconnects after the lock is released',async t=>{
 const {store,reader,insert}=await gatewayFixture(t);
 if(store.kind==='sqlite'){t.skip('covered by the PostgreSQL/MySQL verification matrix');return;}
 const candidate=await insert();
 assert.equal((await reader.inspect([candidate])).get(candidate.id),'active');
 if(store.kind==='postgres') {
  await store.raw('BEGIN');await store.raw('LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE');
 } else await store.raw('LOCK TABLES tasks WRITE');
 try {await assert.rejects(reader.inspect([candidate]),e=>e.code==='gateway_database_unavailable'&&e.message==='Gateway task confirmation is unavailable.');}
 finally {await store.raw(store.kind==='postgres'?'ROLLBACK':'UNLOCK TABLES');}
 assert.equal((await reader.inspect([candidate])).get(candidate.id),'active');
});

test('gateway SQLite lock contention fails closed and reconnects after release',async t=>{
 const {GatewayTaskReader}=await import('./gateway-task-reader.mjs');
 const {DatabaseSync}=await import('node:sqlite');
 const dir=await mkdtemp(join(tmpdir(),'dreamina-gateway-lock-'));
 const path=join(dir,'host.sqlite');const host=new DatabaseSync(path);
 t.after(()=>rm(dir,{recursive:true,force:true}));t.after(()=>host.close());
 host.exec('CREATE TABLE tasks(task_id TEXT,platform TEXT,channel_id INTEGER,status TEXT,private_data TEXT)');
 const candidate={id:randomUUID(),taskId:'task_sqlite_locked'};
 host.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(candidate.taskId,'dreamina-cli',1,'QUEUED',JSON.stringify({upstream_task_id:candidate.id}));
 const reader=await GatewayTaskReader.open({url:'sqlite://'+path,channelId:1});t.after(()=>reader.close());
 assert.equal((await reader.inspect([candidate])).get(candidate.id),'active');
 host.exec('BEGIN EXCLUSIVE');
 try {await assert.rejects(reader.inspect([candidate]),e=>e.code==='gateway_database_unavailable');}
 finally {host.exec('ROLLBACK');}
 assert.equal((await reader.inspect([candidate])).get(candidate.id),'active');
});


test('adding a model preserves historical tasks, idempotency and canvas ownership across restarts',async t=>{
 const {Bridge,validateConfig}=await import('./bridge.mjs');
 const dir=await mkdtemp(join(tmpdir(),'dreamina-model-upgrade-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const cfg=validateConfig({token:'test-only-bridge-token-32-characters-long',dataDir:dir,cli:process.execPath,
  profile:'upgrade-'+randomUUID(),region:'cn',userId:'123',space:'personal',projectId,publicUrl:'http://127.0.0.1:8787',
  storage:'database',databaseUrl:process.env.DREAMINA_TEST_DATABASE_URL||'sqlite://'+join(dir,'jobs.sqlite'),maxQueue:10,
  models:{'seedance_2.5':{kind:'video',model:'seedance_2.5',maxCredits:60}}});
 const catalogue={items:['seedance_2.5','seedance_2.5_flash'].map(model=>({model,modes:[{name:'t2v',flags:[{flag:'--ratio',values:['16:9']},{flag:'--resolution',values:['480p']},{flag:'--duration',min:4,max:30,step:1},{flag:'--count',min:1,max:4,step:1},{flag:'--prompt',maxLength:15000}]}]}))};
 const cli=async args=>{if(args[0]==='space')return {userId:'123',kind:'personal'};if(args[0]==='model')return catalogue;throw Error('No generation allowed');};
 const original=await Bridge.open(cfg,cli);t.after(()=>original.close());await original.preflight();
 const request={kind:'video',model:'seedance_2.5',prompt:'waves',seconds:5,resolution:'480p',n:1};
 const queued=await original.submit(request,'old-queued');
 const done=await original.submit(request,'old-completed');
 const completed=original.jobs.get(done.id);completed.status='completed';await original.save(completed);
 const registry=await original.store.readCanvas();await original.close();
 const extraModels={'seedance_2.5_flash':{kind:'video',model:'seedance_2.5_flash',maxCredits:60}};
 for(const extensions of [null,[],{'seedance_2.5':{kind:'video',model:'seedance_2.5',maxCredits:1}},{unknown:{kind:'video',model:'unknown',maxCredits:1}}])
  assert.throws(()=>validateConfig({...cfg,additionalModels:extensions}),/additional|model/);
 const expanded=validateConfig({...cfg,additionalModels:extraModels});
 for(let pass=0;pass<2;pass++){
  const restored=await Bridge.open(expanded,cli);t.after(()=>restored.close());await restored.preflight();
  assert.equal((await restored.submit(request,'old-queued')).id,queued.id);
  assert.equal((await restored.loadJob(done.id)).status,'completed');
  const recovered=await restored.store.readCanvas();
  assert.equal(recovered.context,registry.context);
  assert.equal(recovered.canvases[0].projectId,projectId);
  assert.ok(recovered.canvases[0].slots.some(slot=>slot.key===hash('old-queued')));
  const flash=await restored.submit({...request,model:'seedance_2.5_flash'},'flash-new');
  assert.equal((await restored.loadJob(flash.id)).request.model,'seedance_2.5_flash');
  assert.equal(await restored.store.count(),3);
  await restored.close();
 }
 await assert.rejects(Bridge.open({...expanded,userId:'456'},cli),/owned by database storage/);
});
