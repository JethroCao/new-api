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
 const a=job(context,'a','completed');await store.save(a);
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
