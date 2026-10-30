import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {CanvasPool} from './canvas-pool.mjs';

const hash = x => createHash('sha256').update(String(x)).digest('hex');
const legacy = 'c2679e06-fce3-4b3c-9038-3729d426c2b8';
const identity = n => ({key:hash(n),digest:hash('body-'+n)});
async function fixture(t,jobs=[]) {
  const dir=await mkdtemp(join(tmpdir(),'canvas-pool-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const options={path:join(dir,'canvases.json'),context:hash('context'),legacyProjectId:legacy,jobs};
  return {pool:await CanvasPool.open(options),options};
}

test('concurrent allocations cap canvases at five and duplicate keys survive restart',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-30T04:00:00Z')});
  const {pool,options}=await fixture(t);
  const allocations=await Promise.all(Array.from({length:11},(_,i)=>pool.reserve(identity(i))));
  assert.deepEqual(allocations.map(x=>x.name),Array(5).fill('Nexora-20261030-001').concat(Array(5).fill('Nexora-20261030-002'),'Nexora-20261030-003'));
  assert.equal(new Set(allocations.map(x=>x.projectId)).size,3);
  const reopened=await CanvasPool.open(options);
  assert.deepEqual(await reopened.reserve(identity(0)),allocations[0]);
  await assert.rejects(reopened.reserve({...identity(0),digest:hash('different')}),/idempotency conflict/);
  assert.equal((await reopened.reserve(identity(11))).projectId,allocations[10].projectId);
  const state=JSON.parse(await readFile(options.path,'utf8'));
  assert.deepEqual(state.canvases.filter(x=>!x.legacy).map(x=>x.slots.length),[5,5,2]);
});

test('Beijing midnight opens a new dated canvas even if the old one is not full',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-30T15:59:59Z')});
  const {pool}=await fixture(t);
  const a=await pool.reserve(identity(1));
  t.mock.timers.tick(1000);
  const b=await pool.reserve(identity(2));
  assert.equal(a.name,'Nexora-20261030-001');assert.equal(b.name,'Nexora-20261031-001');
  assert.notEqual(a.projectId,b.projectId);
  assert.deepEqual(await pool.reserve(identity(1)),a);
});

test('promotion consumes a slot in its source canvas and rejects the sixth request',async t=>{
  const {pool}=await fixture(t);
  const first=await pool.reserve(identity(0));
  for(let i=1;i<5;i++)assert.equal((await pool.reserve(identity(i),first.projectId)).projectId,first.projectId);
  await assert.rejects(pool.reserve(identity(5),first.projectId),/source canvas capacity reached/);
  assert.deepEqual(await pool.reserve(identity(0),first.projectId),first);
  assert.notEqual((await pool.reserve(identity(5))).projectId,first.projectId);
});

test('legacy jobs including failures consume source capacity but are never moved',async t=>{
  const jobs=Array.from({length:6},(_,i)=>({...identity(i),status:i%2?'failed':'completed'}));
  const {pool}=await fixture(t,jobs);
  await assert.rejects(pool.reserve(identity(10),legacy),/source canvas capacity reached/);
  assert.notEqual((await pool.reserve(identity(10))).projectId,legacy);
  let calls=0;await pool.ensureCreated(legacy,async()=>{calls++;});assert.equal(calls,0);
});

test('canvas creation failures reuse durable UUID and concurrent creation runs once',async t=>{
  const {pool,options}=await fixture(t);const canvas=await pool.reserve(identity(0));
  let attempts=[];
  await assert.rejects(pool.ensureCreated(canvas.projectId,async c=>{attempts.push(c.projectId);throw Error('timeout');}),/timeout/);
  const reopened=await CanvasPool.open(options);
  const create=async c=>{attempts.push(c.projectId);return {project:{projectId:c.projectId,name:'renamed manually'}};};
  await Promise.all([reopened.ensureCreated(canvas.projectId,create),reopened.ensureCreated(canvas.projectId,create)]);
  assert.deepEqual(attempts,[canvas.projectId,canvas.projectId]);
  const again=await CanvasPool.open(options);
  await again.ensureCreated(canvas.projectId,()=>{throw Error('must not create again');});
});

test('mismatched create response never marks a canvas ready',async t=>{
  const {pool,options}=await fixture(t);const canvas=await pool.reserve(identity(0));
  await assert.rejects(pool.ensureCreated(canvas.projectId,async()=>({project:{projectId:legacy}})),/canvas identity mismatch/);
  assert.equal(JSON.parse(await readFile(options.path,'utf8')).canvases.find(x=>x.projectId===canvas.projectId).ready,false);
});

test('missing or corrupt registry cannot silently reassign bound jobs',async t=>{
  const {pool,options}=await fixture(t);const canvas=await pool.reserve(identity(0));
  const bound={...identity(0),projectId:canvas.projectId};
  await rm(options.path);
  await assert.rejects(CanvasPool.open({...options,jobs:[bound]}),/canvas registry/);
  await writeFile(options.path,'broken');
  await assert.rejects(CanvasPool.open(options));
});

test('a failed registry write blocks further allocations until a safe reload',async t=>{
  const {pool,options}=await fixture(t);
  await pool.reserve(identity(0));
  const dir=join(options.path,'..'),moved=dir+'-moved';
  await rename(dir,moved);
  try {
    await assert.rejects(pool.reserve(identity(1)),/ENOENT/);
  } finally {await rename(moved,dir);}
  await assert.rejects(pool.reserve(identity(2)),/restart required/);
  const reopened=await CanvasPool.open(options);
  for(let i=1;i<5;i++)await reopened.reserve(identity(i));
  const state=JSON.parse(await readFile(options.path,'utf8'));
  assert.equal(state.canvases.filter(x=>!x.legacy).length,1);
  assert.equal(state.canvases.find(x=>!x.legacy).slots.length,5);
});
