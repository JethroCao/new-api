import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,symlink,stat} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {mediaDeadlines,cleanupMedia} from './retention.mjs';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const end=100000,ttl=28800;
function job(status='completed'){return {id,status,completed_at:end,request:{kind:'video',n:1},inputs:[{filename:id+'-input-0.png'}],files:[{filename:id+'-0.bin'}]};}
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'retention-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('deadlines start at terminal completion and local video delivery, never submission',()=>{
 const j=job();j.created_at=1;j.timings={download_completed_at_ms:(end+500)*1000};
 assert.deepEqual(mediaDeadlines(j),{input_expires_at:end+ttl,content_expires_at:end+500+ttl});
 assert.deepEqual(mediaDeadlines(job('failed')),{input_expires_at:end+ttl});
 assert.deepEqual(mediaDeadlines({...j,status:'in_progress'}),{});
 assert.deepEqual(mediaDeadlines({...job(),completed_at:undefined,created_at:1}),{});
 assert.deepEqual(mediaDeadlines({...job(),request:{kind:'image'}}),{});
 assert.equal(mediaDeadlines(job()).content_expires_at,end+ttl);
});
test('cleanup exact boundary removes known expired media only and preserves task metadata',async t=>{
 const dir=await fixture(t),j=job(),before=structuredClone(j);
 for(const name of [id+'-input-0.png',id+'-0.bin',id+'-0.bin.part','credentials.json',other+'-0.bin'])await writeFile(join(dir,name),'data');
 const run=now=>cleanupMedia({dataDir:dir,loadJobs:async()=>new Map([[id,j]]),isBusy:()=>false,now});
 assert.equal((await run((end+ttl)*1000-1)).deleted_files,0);
 const r=await run((end+ttl)*1000);assert.equal(r.deleted_files,3);assert.equal(r.deleted_bytes,12);
 assert.equal(await readFile(join(dir,'credentials.json'),'utf8'),'data');assert.equal(await readFile(join(dir,other+'-0.bin'),'utf8'),'data');
 assert.deepEqual(j,before);assert.equal((await run((end+ttl+100)*1000)).deleted_files,0);
});
test('busy, nonterminal and uncertain jobs are protected; symlinks and outside paths are untouched',async t=>{
 const dir=await fixture(t),j=job();const outside=join(dir,'private.txt');await writeFile(outside,'private');
 await writeFile(join(dir,id+'-0.bin'),'video');await symlink(outside,join(dir,id+'-input-0.png'));
 j.inputs.push({filename:'../private.txt'});
 const options={dataDir:dir,loadJobs:async()=>new Map([[id,j]]),now:(end+ttl+1)*1000};
 assert.equal((await cleanupMedia({...options,isBusy:()=>true})).deleted_files,0);
 j.status='in_progress';j.attention='manual_recovery_required';assert.equal((await cleanupMedia({...options,isBusy:()=>false})).deleted_files,0);
 j.status='completed';assert.equal((await cleanupMedia({...options,isBusy:()=>false})).deleted_files,1);
 assert.equal(await readFile(outside,'utf8'),'private');assert.equal(await readFile(join(dir,id+'-input-0.png'),'utf8'),'private');
});
test('one removal failure is reported and retried later without changing terminal state',async t=>{
 const dir=await fixture(t),j=job();await writeFile(join(dir,id+'-0.bin'),'video');const errors=[];
 const options={dataDir:dir,loadJobs:async()=>new Map([[id,j]]),isBusy:()=>false,now:(end+ttl+1)*1000,onError:e=>errors.push(e)};
 const r=await cleanupMedia({...options,remove:async()=>{throw Object.assign(Error('private URL'),{code:'EACCES'})}});
 assert.equal(r.deleted_files,0);assert.equal(r.errors,1);assert.equal(errors[0].code,'EACCES');assert.equal(JSON.stringify(errors).includes('private'),false);
 assert.equal((await cleanupMedia(options)).deleted_files,1);assert.equal(j.status,'completed');
});
test('recently recovered output retains a new full eight-hour window',async t=>{
 const dir=await fixture(t),j=job();j.timings={download_completed_at_ms:(end+3600)*1000};await writeFile(join(dir,id+'-0.bin'),'video');await writeFile(join(dir,id+'-input-0.png'),'input');
 const r=await cleanupMedia({dataDir:dir,loadJobs:async()=>new Map([[id,j]]),isBusy:()=>false,now:(end+ttl+1)*1000});
 assert.equal(r.deleted_files,1);assert.equal((await stat(join(dir,id+'-0.bin'))).size,5);
});

test('failed multi-video task expires partial successes and remaining download files after terminal eight hours',async t=>{
 const dir=await fixture(t),j=job('failed');j.request.n=2;
 const names=[id+'-0.bin',id+'-1.bin.part',id+'-input-0.png'];for(const n of names)await writeFile(join(dir,n),'data');const before=structuredClone(j);
 const r=await cleanupMedia({dataDir:dir,loadJobs:async()=>new Map([[id,j]]),isBusy:()=>false,now:(end+ttl+1)*1000});
 assert.equal(r.deleted_files,3);assert.deepEqual(j,before);
});

test('repairing a legacy completion cannot extend its original content retention deadline',()=>{
 const job={request:{kind:'video'},status:'completed',completed_at:100000,deliveryExpiresAt:128800,
   timings:{download_completed_at_ms:110000000}};
 assert.equal(mediaDeadlines(job).content_expires_at,128800);
});
