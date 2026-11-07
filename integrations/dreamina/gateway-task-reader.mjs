import {fileURLToPath} from 'node:url';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TASK_ID=/^task_[A-Za-z0-9_-]{1,180}$/;
const ACTIVE=new Set(['NOT_START','SUBMITTED','QUEUED','IN_PROGRESS']);
const TERMINAL=new Set(['SUCCESS','FAILURE']);
const TIMEOUT_MS=2000;
function unavailable() {
  // Raw driver errors may contain credentials, SQL or private task values.
  return Object.assign(new Error('Gateway task confirmation is unavailable.'),{code:'gateway_database_unavailable'});
}

// This reader never owns or migrates the gateway database. It is independent
// from bridge storage so a read outage cannot poison the bridge's writer.
export class GatewayTaskReader {
  static async open({url,channelId}) {
    try {
      const parsed=new URL(url);
      if(!['postgres:','postgresql:','mysql:','sqlite:'].includes(parsed.protocol) ||
          !Number.isSafeInteger(channelId) || channelId<1)throw Error();
      return new GatewayTaskReader(url,parsed,channelId);
    } catch {throw new Error('Invalid gateway database configuration.');}
  }

  constructor(url,parsed,channelId) {
    this.url=url;this.parsed=parsed;this.channelId=channelId;
    this.kind=['postgres:','postgresql:'].includes(parsed.protocol)?'postgres':parsed.protocol.slice(0,-1);
    this.queue=Promise.resolve();this.closed=false;this.connection=null;this.broken=false;
  }

  async connect() {
    if(this.connection && !this.broken)return;
    await this.disconnect();this.broken=false;
    if(this.kind==='postgres') {
      const {Client}=await import('pg');
      this.connection=new Client({connectionString:this.url,connectionTimeoutMillis:TIMEOUT_MS,
        query_timeout:TIMEOUT_MS,statement_timeout:TIMEOUT_MS,keepAlive:true,application_name:'dreamina-gateway-reader'});
      this.connection.on('error',()=>{this.broken=true;});
      this.connection.on('end',()=>{this.broken=true;});
      await this.connection.connect();
      await this.connection.query('SET default_transaction_read_only = on');
    } else if(this.kind==='mysql') {
      const mysql=await import('mysql2/promise');
      this.connection=await mysql.createConnection({uri:this.url,connectTimeout:TIMEOUT_MS,enableKeepAlive:true});
      this.connection.on('error',()=>{this.broken=true;});
      this.connection.on('end',()=>{this.broken=true;});
      await this.connection.query({sql:'SET SESSION TRANSACTION READ ONLY',timeout:TIMEOUT_MS});
    } else {
      const {DatabaseSync}=await import('node:sqlite');
      this.connection=new DatabaseSync(fileURLToPath('file:'+this.parsed.pathname),{readOnly:true});
      // SQLite's driver is synchronous: fail immediately on lock contention
      // so optional confirmation cannot stall HTTP, polling or downloads.
      this.connection.exec('PRAGMA busy_timeout=0');
    }
  }

  async read(candidates) {
    await this.connect();
    const sql='SELECT task_id,platform,channel_id,status,private_data FROM tasks WHERE task_id IN ('+
      candidates.map(()=>'?').join(',')+') LIMIT 401';
    const args=candidates.map(candidate=>candidate.taskId);
    if(this.kind==='postgres') {
      let index=0;
      await this.connection.query('BEGIN READ ONLY');
      const {rows}=await this.connection.query(sql.replaceAll('?',()=>'$'+(++index)),args);
      await this.connection.query('COMMIT');return rows;
    }
    if(this.kind==='mysql') {
      await this.connection.query({sql:'START TRANSACTION READ ONLY',timeout:TIMEOUT_MS});
      const [rows]=await this.connection.query({sql,timeout:TIMEOUT_MS},args);
      await this.connection.query({sql:'COMMIT',timeout:TIMEOUT_MS});return rows;
    }
    this.connection.exec('BEGIN');
    const rows=this.connection.prepare(sql).all(...args);
    this.connection.exec('COMMIT');return rows;
  }

  inspect(candidates) {
    if(!Array.isArray(candidates) || candidates.length>200 || candidates.some(candidate=>
      !candidate || !UUID.test(candidate.id) || !TASK_ID.test(candidate.taskId)) ||
      new Set(candidates.map(candidate=>candidate.id)).size!==candidates.length ||
      new Set(candidates.map(candidate=>candidate.taskId)).size!==candidates.length) {
      return Promise.reject(new Error('Invalid gateway task read batch.'));
    }
    // Snapshot caller-owned values before waiting for an earlier batch.
    const batch=candidates.map(({id,taskId})=>({id,taskId}));
    const operation=this.queue.then(async()=>{
      if(this.closed)throw unavailable();
      if(!batch.length)return new Map();
      try {
        const rows=await this.read(batch);
        // Never make a decision from a truncated set of duplicate task rows.
        if(rows.length>400)throw unavailable();
        const byTask=new Map();
        for(const row of rows) {
          const found=byTask.get(row.task_id) || [];
          found.push(row);byTask.set(row.task_id,found);
        }
        const result=new Map();
        for(const {id,taskId} of batch) {
          const found=byTask.get(taskId) || [];
          let state=found.length?'mismatch':'missing';
          if(found.length===1) {
            const row=found[0];let privateData;
            try {privateData=typeof row.private_data==='string'?JSON.parse(row.private_data):row.private_data;}catch {}
            if(row.platform==='dreamina-cli' && Number(row.channel_id)===this.channelId &&
                privateData && !Array.isArray(privateData) && privateData.upstream_task_id===id) {
              if(ACTIVE.has(row.status))state='active';
              else if(TERMINAL.has(row.status))state='terminal';
            }
          }
          result.set(id,state);
        }
        return result;
      } catch {
        await this.disconnect();throw unavailable();
      }
    });
    this.queue=operation.catch(()=>{});return operation;
  }

  async disconnect() {
    const connection=this.connection;this.connection=null;
    if(!connection)return;
    try {
      if(this.kind==='sqlite')connection.close();
      else if(this.kind==='mysql')connection.destroy();
      else await connection.end();
    } catch {}
  }

  async close() {
    this.closed=true;await this.queue;await this.disconnect();
  }
}
