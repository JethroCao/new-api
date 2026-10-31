import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Bridge,validateConfig,createServer} from './bridge.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const request={kind:'video',model:'dreamina-video',prompt:'waves',seconds:5};
const media=Buffer.from('000000186674797069736f6d0000020069736f6d','hex');
async function fixture(t,storage="file") {
  const dir=await mkdtemp(join(tmpdir(),'dreamina-history-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const cfg=validateConfig({token:'test-history-token-at-least-32-characters',dataDir:dir,cli:process.execPath,projectId:'c2679e06-fce3-4b3c-9038-3729d426c2b8',userId:String(BigInt('0x'+randomUUID().replaceAll('-','').slice(0,12))),space:'personal',publicUrl:'http://127.0.0.1:8787',maxQueue:2,maxJobs:2,historyCacheSize:2,
    models:{'dreamina-video':{kind:'video',model:'video-test',ratio:'16:9',resolution:'720p',durations:[5],maxCredits:10}}});
  if(storage==='database'){cfg.storage=storage;cfg.databaseUrl=process.env.DREAMINA_TEST_DATABASE_URL || 'sqlite://'+join(dir,'jobs.sqlite');}
  const cli=async()=>{throw Error('history access must not invoke CLI');};
  const bridge=await Bridge.open(cfg,cli);t.after(()=>bridge.close());
  return {bridge,cfg,cli,dir};
}
async function finish(bridge,result,status) {
  const job=bridge.jobs.get(result.id);job.status=status;job.completed_at=Math.floor(Date.now()/1000);
  if(status==='completed') {
    const filename=job.id+'-0.bin';await writeFile(join(bridge.config.dataDir,filename),media);
    job.files=[{filename,size:media.length,mime:'video/mp4',sha256:createHash('sha256').update(media).digest('hex')}];
  }
  await bridge.save(job);
}

test('terminal history beyond the former limit never blocks admission; active capacity still applies',async t=>{
  const {bridge}=await fixture(t,'database');
  const first=await bridge.submit(request,'old-success');await finish(bridge,first,'completed');
  const second=await bridge.submit(request,'old-failure');await finish(bridge,second,'failed');
  const third=await bridge.submit(request,'new-1');
  const fourth=await bridge.submit(request,'new-2');
  await assert.rejects(bridge.submit(request,'overflow'),e=>e.status===429 && e.code==='active_queue_full');
  assert.equal((await bridge.submit(request,'old-success')).id,first.id,'replays succeed even when the active queue is full');
  await assert.rejects(bridge.submit({...request,prompt:'changed'},'old-success'),e=>e.status===409);
  await finish(bridge,third,'failed');
  assert.ok((await bridge.submit(request,'after-terminal')).id);
  assert.equal(bridge.get(fourth.id).status,'queued');
});

test('evicted history survives restart, authenticated queries, range downloads and idempotent replay',async t=>{
  const {bridge,cfg,cli,dir}=await fixture(t);const jobs=[];
  for(let i=0;i<8;i++) {
    const j=await bridge.submit(request,'history-'+i);jobs.push(j);await finish(bridge,j,i%2?'failed':'completed');
  }
  assert.ok(bridge.jobs.size<=2,'full terminal records have a bounded memory cache');
  assert.equal(bridge.jobs.has(jobs[0].id),false);
  await bridge.close();
  const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());
  assert.ok(restored.jobs.size<=2);
  const server=createServer(restored);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port;
  const headers={Authorization:'Bearer '+cfg.token};
  for(const j of jobs) {
    const response=await fetch(base+'/v1/jobs/'+j.id,{headers});assert.equal(response.status,200);
    assert.equal((await response.json()).id,j.id);
  }
  const response=await fetch(base+'/v1/jobs/'+jobs[0].id+'/content/0',{headers:{...headers,Range:'bytes=0-7'}});
  assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),media.subarray(0,8));
  assert.equal((await restored.submit(request,'history-0')).id,jobs[0].id);
  await assert.rejects(restored.submit({...request,prompt:'changed'},'history-0'),e=>e.status===409);
  assert.ok((await restored.submit(request,'new-after-restart')).id);
  assert.ok(restored.jobs.size<=3);
  assert.equal(JSON.parse(await readFile(join(dir,jobs[0].id+'.json'),'utf8')).status,'completed');
});

test('a missing indexed history record fails closed instead of generating a duplicate',async t=>{
  const {bridge,dir,cfg,cli}=await fixture(t);const a=await bridge.submit(request,'keep-key');await finish(bridge,a,'completed');
  for(let i=0;i<3;i++){const j=await bridge.submit(request,'evict-'+i);await finish(bridge,j,'failed');}
  await rm(join(dir,a.id+'.json'));
  await assert.rejects(bridge.submit(request,'keep-key'),e=>e.status===503 && e.code==='job_storage_unavailable');
  await bridge.close();const restored=await Bridge.open(cfg,cli);t.after(()=>restored.close());
  await assert.rejects(restored.submit(request,'keep-key'),e=>e.status===503 && e.code==='job_storage_unavailable');
});


test('migrates over 1000 legacy terminal files without loading full history or blocking new work',async t=>{
  const {bridge,cfg,cli,dir}=await fixture(t);
  const first=await bridge.submit(request,'legacy-first');await finish(bridge,first,'failed');
  const template=JSON.parse(await readFile(join(dir,first.id+'.json'),'utf8'));await bridge.close();
  for(let i=0;i<1001;i++) {
    const job={...template,id:randomUUID(),key:createHash('sha256').update('legacy-'+i).digest('hex')};
    await writeFile(join(dir,job.id+'.json'),JSON.stringify(job));
  }
  const restored=await Bridge.open({...cfg,maxJobs:1000,storage:'database',migrateLegacy:true,databaseUrl:process.env.DREAMINA_TEST_DATABASE_URL || 'sqlite://'+join(dir,'jobs.sqlite')},cli);t.after(()=>restored.close());
  assert.equal(restored.storedJobs,1002);assert.ok(restored.jobs.size<=2);
  assert.ok((await restored.submit(request,'admitted-over-1000')).id);
  const replay=await restored.submit(request,'legacy-0');assert.equal(replay.status,'failed');
  await restored.close();
  const configPath=join(dir,'maintenance-config.json');await writeFile(configPath,JSON.stringify(restored.config));
  const result=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./storage-admin.mjs',import.meta.url)),'migrate'],{env:{...process.env,DREAMINA_BRIDGE_CONFIG:configPath,DREAMINA_BRIDGE_TOKEN:cfg.token,DREAMINA_DATABASE_URL:restored.config.databaseUrl}});
  const report=JSON.parse(result.stdout);assert.equal(report.total,1003);assert.equal(report.legacyCompared,1002);
});


test('database migration preserves history, media and replays and forbids stale file fallback',async t=>{
 const {bridge,cfg,cli,dir}=await fixture(t);
 const first=await bridge.submit(request,'migration-success');await finish(bridge,first,'completed');
 const original=JSON.parse(await readFile(join(dir,first.id+'.json'),'utf8'));await bridge.close();
 const database={...cfg,storage:'database',migrateLegacy:true,databaseUrl:process.env.DREAMINA_TEST_DATABASE_URL || 'sqlite://'+join(dir,'jobs.sqlite')};
 const migrated=await Bridge.open(database,cli);
 assert.deepEqual(await migrated.loadJob(first.id),original);
 assert.equal((await migrated.submit(request,'migration-success')).id,first.id);
 const added=await migrated.submit(request,'database-only');await finish(migrated,added,'failed');
 await assert.rejects(readFile(join(dir,added.id+'.json')),e=>e.code==='ENOENT');
 await migrated.close();
 const configPath=join(dir,'maintenance-config.json');await writeFile(configPath,JSON.stringify(database));
 const target=join(dir,'export');
 const exported=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./storage-admin.mjs',import.meta.url)),'export',target],{env:{...process.env,DREAMINA_BRIDGE_CONFIG:configPath,DREAMINA_BRIDGE_TOKEN:cfg.token,DREAMINA_DATABASE_URL:database.databaseUrl}});
 assert.equal(JSON.parse(exported.stdout).total,2);
 assert.deepEqual(JSON.parse(await readFile(join(target,first.id+'.json'),'utf8')),original);
 assert.equal(JSON.parse(await readFile(join(target,added.id+'.json'),'utf8')).status,'failed');
 // An old file snapshot cannot silently replace the new database state.
 await assert.rejects(Bridge.open(cfg,cli),/database/);
 await rm(join(dir,first.id+'.json'));
 const restored=await Bridge.open(database,cli);t.after(()=>restored.close());
 assert.equal((await restored.loadJob(added.id)).status,'failed');
 assert.equal((await restored.submit(request,'migration-success')).id,first.id);
 const server=createServer(restored);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/jobs/'+first.id+'/content/0',{headers:{Authorization:'Bearer '+cfg.token,Range:'bytes=0-7'}});
 assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),media.subarray(0,8));
 restored.store.poisoned=true;
 await assert.rejects(restored.submit(request,'db-outage'),e=>e.status===503 && e.code==='job_storage_unavailable');
});

test('remigration after file rollback rejects unimported jobs before taking database ownership',async t=>{
 const {bridge,cfg,cli,dir}=await fixture(t);
 const a=await bridge.submit(request,'before-rollback');await finish(bridge,a,'completed');await bridge.close();
 const database={...cfg,storage:'database',migrateLegacy:true,databaseUrl:process.env.DREAMINA_TEST_DATABASE_URL || 'sqlite://'+join(dir,'jobs.sqlite')};
 const migrated=await Bridge.open(database,cli);await migrated.close();
 // All DB metadata at this point equals the old files, so these are a complete
 // rollback snapshot. The restored file service subsequently accepts a job.
 await rm(join(dir,'.database-storage.json'));
 const rolledBack=await Bridge.open(cfg,cli);
 const b=await rolledBack.submit(request,'paid-after-rollback');const paid=rolledBack.jobs.get(b.id);paid.status='in_progress';await rolledBack.save(paid);await rolledBack.close();
 await assert.rejects(Bridge.open(database,cli),e=>e.status===503 && e.code==='job_storage_unavailable');
 await assert.rejects(readFile(join(dir,'.database-storage.json')),e=>e.code==='ENOENT');
 const retained=await Bridge.open(cfg,cli);t.after(()=>retained.close());
 assert.equal((await retained.submit(request,'paid-after-rollback')).id,b.id);
 assert.equal(retained.get(b.id).status,'in_progress');
});
