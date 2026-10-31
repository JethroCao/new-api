import {open,realpath,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const HASH=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function storageError() {
  return Object.assign(new Error('Task storage is unavailable. Please contact the operator.'),{status:503,code:'job_storage_unavailable'});
}

// One session owns a context for its entire lifetime. Never reconnect behind a
// worker: losing the session also loses its database lock, so it must stop.
export class DatabaseStore {
  static async open({url,context}) {
    const store=new DatabaseStore(context);
    try {
      if(!HASH.test(context))throw storageError();
      const parsed=new URL(url);
      if(['postgres:','postgresql:'].includes(parsed.protocol)) {
        const {Client}=await import('pg');
        store.kind='postgres';
        store.connection=new Client({connectionString:url,connectionTimeoutMillis:10000,query_timeout:30000,
          statement_timeout:25000,application_name:'dreamina-bridge',keepAlive:true});
        store.connection.on('error',()=>{store.poisoned=true;});
        store.connection.on('end',()=>{if(!store.closed)store.poisoned=true;});
        await store.connection.connect();
        const [row]=await store.raw('SELECT pg_try_advisory_lock(?) AS acquired',[BigInt.asIntN(64,BigInt('0x'+context.slice(0,16))).toString()]);
        if(!row.acquired)throw storageError();
      } else if(parsed.protocol==='mysql:') {
        const mysql=await import('mysql2/promise');store.kind='mysql';
        store.connection=await mysql.createConnection({uri:url,connectTimeout:10000,enableKeepAlive:true});
        store.connection.on('error',()=>{store.poisoned=true;});
        store.connection.on('end',()=>{if(!store.closed)store.poisoned=true;});
        const [row]=await store.raw('SELECT GET_LOCK(?,0) AS acquired',['dreamina:'+context.slice(0,55)]);
        if(Number(row.acquired)!==1)throw storageError();
      } else if(parsed.protocol==='sqlite:') {
        const {DatabaseSync}=await import('node:sqlite');store.kind='sqlite';
        const path=fileURLToPath('file:'+parsed.pathname);
        store.connection=new DatabaseSync(path);store.connection.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=10000;');
        store.ownerPath=(await realpath(path))+'.owner';
        store.owner=await open(store.ownerPath,'wx',0o600);await store.owner.writeFile(String(process.pid));
      } else throw storageError();
      if(store.kind==='postgres')await store.raw('SELECT pg_advisory_lock(1960040101,1)');
      if(store.kind==='mysql') {const [lock]=await store.raw("SELECT GET_LOCK('dreamina-schema-v1',10) AS acquired");if(Number(lock.acquired)!==1)throw storageError();}
      const text=store.kind==='mysql'?'LONGTEXT':'TEXT';
      await store.raw(`CREATE TABLE IF NOT EXISTS dreamina_bridge_contexts (context_id VARCHAR(64) PRIMARY KEY, canvas_payload ${text} NOT NULL, schema_version INTEGER NOT NULL)`);
      await store.raw(`CREATE TABLE IF NOT EXISTS dreamina_bridge_jobs (
        id VARCHAR(36) PRIMARY KEY, context_id VARCHAR(64) NOT NULL, key_hash VARCHAR(64) NOT NULL,
        digest VARCHAR(64) NOT NULL, status VARCHAR(32) NOT NULL, project_id VARCHAR(36), units INTEGER NOT NULL,
        payload ${text} NOT NULL, UNIQUE(context_id,key_hash)${store.kind==='mysql'?', INDEX dreamina_bridge_active (context_id,status,id)':''})`);
      if(store.kind!=='mysql')await store.raw('CREATE INDEX IF NOT EXISTS dreamina_bridge_active ON dreamina_bridge_jobs(context_id,status,id)');
      if(store.kind==='postgres')await store.raw('SELECT pg_advisory_unlock(1960040101,1)');
      if(store.kind==='mysql')await store.raw("SELECT RELEASE_LOCK('dreamina-schema-v1')");
      return store;
    } catch {await store.close();throw storageError();}
  }

  constructor(context) {this.context=context;this.queue=Promise.resolve();this.poisoned=false;this.closed=false;}
  assertHealthy() {if(this.closed || this.poisoned)throw storageError();}
  async raw(sql,args=[]) {
    if(this.kind==='postgres') {
      let i=0;return (await this.connection.query(sql.replaceAll('?',()=>'$'+(++i)),args)).rows;
    }
    if(this.kind==='mysql')return (await this.connection.query({sql,timeout:30000},args))[0];
    const stmt=this.connection.prepare(sql);
    return /^SELECT\b/i.test(sql)?stmt.all(...args):stmt.run(...args);
  }
  operation(fn) {
    const op=this.queue.then(async()=>{
      this.assertHealthy();
      try {return await fn();}catch {this.poisoned=true;throw storageError();}
    });
    this.queue=op.catch(()=>{});return op;
  }
  async transaction(fn) {
    await this.raw(this.kind==='sqlite'?'BEGIN IMMEDIATE':'BEGIN');
    try {const result=await fn();await this.raw('COMMIT');return result;}
    catch(error) {try {await this.raw('ROLLBACK');}catch {}throw error;}
  }
  initialized() {
    return this.operation(async()=>{
      const [row]=await this.raw('SELECT schema_version FROM dreamina_bridge_contexts WHERE context_id=?',[this.context]);
      if(row && Number(row.schema_version)!==1)throw storageError();return !!row;
    });
  }
  initialize(jobs,registry) {
    return this.operation(()=>this.transaction(async()=>{
      const rows=await this.raw('SELECT schema_version FROM dreamina_bridge_contexts WHERE context_id=?',[this.context]);
      if(rows.length) {if(Number(rows[0].schema_version)!==1)throw storageError();return;}
      for await(const job of jobs)await this.insert(job);
      await this.raw('INSERT INTO dreamina_bridge_contexts(context_id,canvas_payload,schema_version) VALUES(?,?,1)',[this.context,JSON.stringify(registry)]);
    }));
  }
  validate(job) {
    if(job.context!==this.context || !UUID.test(job.id) || !HASH.test(job.key) || !HASH.test(job.digest) ||
      !['queued','in_progress','completed','failed'].includes(job.status) || !Number.isSafeInteger(job.request?.n) || job.request.n<1 || job.request.n>4)throw storageError();
  }
  async insert(job) {
    this.validate(job);
    await this.raw('INSERT INTO dreamina_bridge_jobs(id,context_id,key_hash,digest,status,project_id,units,payload) VALUES(?,?,?,?,?,?,?,?)',
      [job.id,this.context,job.key,job.digest,job.status,job.projectId || null,job.request.n,JSON.stringify(job)]);
  }
  save(job) {
    // Snapshot before queuing so later in-memory mutations cannot change the
    // durable pre-submit state that the caller is waiting for.
    const snapshot=structuredClone(job);
    return this.operation(()=>this.transaction(async()=>{
      this.validate(snapshot);
      const [existing]=await this.raw('SELECT context_id,key_hash,digest FROM dreamina_bridge_jobs WHERE id=?',[snapshot.id]);
      if(!existing)return this.insert(snapshot);
      if(existing.context_id!==this.context || existing.key_hash!==snapshot.key || existing.digest!==snapshot.digest)throw storageError();
      await this.raw('UPDATE dreamina_bridge_jobs SET status=?,project_id=?,units=?,payload=? WHERE id=? AND context_id=?',
        [snapshot.status,snapshot.projectId || null,snapshot.request.n,JSON.stringify(snapshot),snapshot.id,this.context]);
    }));
  }
  get(id) {return this.operation(async()=>{
    const [row]=await this.raw('SELECT payload FROM dreamina_bridge_jobs WHERE context_id=? AND id=?',[this.context,id]);
    if(!row)return undefined;const job=JSON.parse(row.payload);this.validate(job);return job;
  });}
  findKey(key) {return this.operation(async()=>{
    const [row]=await this.raw('SELECT id FROM dreamina_bridge_jobs WHERE context_id=? AND key_hash=?',[this.context,key]);return row?.id;
  });}
  active() {return this.operation(async()=>{
    const rows=await this.raw("SELECT payload FROM dreamina_bridge_jobs WHERE context_id=? AND status NOT IN ('completed','failed')",[this.context]);
    return rows.map(row=>{const job=JSON.parse(row.payload);this.validate(job);return job;});
  });}
  canvasJobs() {return this.operation(async()=>{
    const rows=await this.raw('SELECT key_hash,digest,project_id,units FROM dreamina_bridge_jobs WHERE context_id=?',[this.context]);
    return rows.map(row=>({key:row.key_hash,digest:row.digest,projectId:row.project_id,request:{n:Number(row.units)}}));
  });}
  count() {return this.operation(async()=>Number((await this.raw('SELECT COUNT(*) AS total FROM dreamina_bridge_jobs WHERE context_id=?',[this.context]))[0].total));}
  readCanvas() {return this.operation(async()=>{
    const [row]=await this.raw('SELECT canvas_payload FROM dreamina_bridge_contexts WHERE context_id=?',[this.context]);
    if(!row)throw storageError();return JSON.parse(row.canvas_payload);
  });}
  writeCanvas(state) {const payload=JSON.stringify(state);return this.operation(()=>this.raw('UPDATE dreamina_bridge_contexts SET canvas_payload=? WHERE context_id=?',[payload,this.context]));}
  // Offline export is paged; the caller holds this store's exclusive lock.
  async *all() {
    let after='';
    while(true) {
      const rows=await this.operation(()=>this.raw('SELECT id,payload FROM dreamina_bridge_jobs WHERE context_id=? AND id>? ORDER BY id LIMIT 100',[this.context,after]));
      if(!rows.length)return;
      for(const row of rows){const job=JSON.parse(row.payload);this.validate(job);yield job;after=row.id;}
    }
  }
  async close() {
    if(this.closed)return;
    await this.queue;this.closed=true;
    if(this.connection)try {if(this.kind==='sqlite')this.connection.close();else await this.connection.end();}catch {}
    if(this.owner){await this.owner.close();await unlink(this.ownerPath).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  }
}
