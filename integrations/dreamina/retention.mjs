import {readdir,lstat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
export const MEDIA_RETENTION_SECONDS=8*60*60;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mediaName=/^([0-9a-f-]{36})-(?:input-\d+\.[a-z0-9]{1,8}|\d+\.bin(?:\.part)?)$/;
const timestamp=n=>Number.isSafeInteger(n)&&n>0?n:undefined;
export function mediaDeadlines(job){
 if(job?.request?.kind!=='video'||!['completed','failed'].includes(job.status))return {};
 const completed=timestamp(job.completed_at),downloaded=timestamp(job.timings?.download_completed_at_ms);
 const delivered=downloaded?Math.floor(downloaded/1000):completed;
 const end=completed||(job.status==='completed'?delivered:undefined);
 return {...(end?{input_expires_at:end+MEDIA_RETENTION_SECONDS}:{}),...(job.status==='completed'&&delivered?{content_expires_at:Math.min(delivered+MEDIA_RETENTION_SECONDS,timestamp(job.deliveryExpiresAt)||Infinity)}:{})};
}
export async function cleanupMedia({dataDir,loadJobs,isBusy=()=>false,now=Date.now(),onError=()=>{},remove=unlink}){
 const groups=new Map();
 for(const entry of await readdir(dataDir,{withFileTypes:true})){
  if(!entry.isFile())continue; // Never follow symlinks or enter credential/recovery directories.
  const match=mediaName.exec(entry.name);if(!match||!uuid.test(match[1]))continue;
  if(!groups.has(match[1]))groups.set(match[1],[]);groups.get(match[1]).push(entry.name);
 }
 const ids=[...groups.keys()],result={deleted_files:0,deleted_bytes:0,errors:0};
 for(let offset=0;offset<ids.length;offset+=50){
  const batch=ids.slice(offset,offset+50),jobs=await loadJobs(batch);
  for(const id of batch){
   const job=jobs.get(id);if(!job||job.id!==id||isBusy(id))continue;
   const deadlines=mediaDeadlines(job);
   for(const name of groups.get(id)){
    const input=(job.inputs||[]).some(f=>f.filename===name);
    const output=(job.files||[]).some(f=>f.filename===name);
    const partial=Array.from({length:Number.isSafeInteger(job.request?.n)&&job.request.n<=4?job.request.n:0},(_,i)=>id+'-'+i+'.bin.part').includes(name);
    const expires=output?(deadlines.content_expires_at||deadlines.input_expires_at):input||partial?deadlines.input_expires_at:undefined;
    if(!expires||now<expires*1000||isBusy(id))continue;
    try{
     const path=join(dataDir,name),info=await lstat(path);if(!info.isFile())continue;
     await remove(path);result.deleted_files++;result.deleted_bytes+=info.size;
    }catch(error){if(error.code==='ENOENT')continue;result.errors++;onError({job_id:id,code:error.code||'cleanup_failed'});}
   }
  }
 }
 return result;
}
