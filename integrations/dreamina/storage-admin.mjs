import {readFile,mkdir,stat,opendir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Bridge,validateConfig} from './bridge.mjs';
import {atomicJSON} from './state-file.mjs';

// Offline only: Bridge.open acquires both the data-directory and DB writer
// locks. This tool never calls the CLI or schedules generation.
let bridge;
try {
  const action=process.argv[2];
  if(!['migrate','verify','export'].includes(action))throw Error('Use storage-admin.mjs migrate|verify|export [new-export-directory]');
  const input=JSON.parse(await readFile(process.env.DREAMINA_BRIDGE_CONFIG,'utf8'));
  const config=validateConfig({...input,storage:'database',migrateLegacy:action==='migrate',token:process.env.DREAMINA_BRIDGE_TOKEN,databaseUrl:process.env.DREAMINA_DATABASE_URL});
  bridge=await Bridge.open(config,async()=>{throw Error('CLI is disabled during storage maintenance');});
  const counts={},missingMedia=[];let total=0,legacyCompared=0;
  let target;
  if(action==='export') {
    if(!process.argv[3])throw Error('An empty new export directory is required');
    target=resolve(process.argv[3]);await mkdir(target,{mode:0o700});
  }
  for await(const job of bridge.store.all()) {
    total++;counts[job.status]=(counts[job.status] || 0)+1;
    if(action==='migrate' || action==='verify') {
      try {
        const legacy=JSON.parse(await readFile(join(config.dataDir,job.id+'.json'),'utf8'));
        // Migration is offline; every field must match, including diagnostic,
        // upstream and idempotency identities, not merely the record count.
        if(JSON.stringify(job)!==JSON.stringify(legacy))throw Error('Legacy/database task mismatch: '+job.id);
        legacyCompared++;
      } catch(error) {if(error.code!=='ENOENT')throw error;}
    }
    for(const file of job.files || [])try {const info=await stat(join(config.dataDir,file.filename));if(info.size!==file.size)missingMedia.push(job.id);}catch{missingMedia.push(job.id);}
    if(target)await atomicJSON(join(target,job.id+'.json'),job);
  }
  if(action==='migrate' || action==='verify') {
    let sourceCount=0;
    for await(const entry of await opendir(config.dataDir))if(/^[0-9a-f-]{36}\.json$/.test(entry.name))sourceCount++;
    if(sourceCount!==legacyCompared)throw Error('Legacy task set is not fully represented in database');
  }
  if(target)await atomicJSON(join(target,'canvases.json'),await bridge.store.readCanvas());
  console.log(JSON.stringify({action,total,statuses:counts,legacyCompared,missingMedia:missingMedia.length,exportDirectory:target}));
  if(missingMedia.length)process.exitCode=2;
} catch(error) {console.error(error.code==='job_storage_unavailable'?error.message:'Storage maintenance failed: '+error.message);process.exitCode=1;}
finally {if(bridge)await bridge.close();}
