import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {atomicJSON} from './state-file.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const LIMIT=5;
function fail(message,status=503) {throw Object.assign(new Error(message),{status});}
const summary=c=>({projectId:c.projectId,name:c.name});

export class CanvasPool {
  static async open({path,context,legacyProjectId,jobs}) {
    let state;
    try {state=JSON.parse(await readFile(path,'utf8'));}
    catch(error) {
      if(error.code!=='ENOENT')throw error;
      if(jobs.some(j=>j.projectId && j.projectId!==legacyProjectId))fail('canvas registry missing for bound jobs');
      state={version:1,context,canvases:[{projectId:legacyProjectId,name:'Legacy canvas',legacy:true,ready:true,slots:[]}]};
    }
    if(state.version!==1 || state.context!==context || !Array.isArray(state.canvases))fail('invalid canvas registry context');
    const projects=new Map(),keys=new Set();
    for(const c of state.canvases) {
      if(!UUID.test(c.projectId) || projects.has(c.projectId) || typeof c.name!=='string' || typeof c.ready!=='boolean' || !Array.isArray(c.slots))fail('invalid canvas registry');
      if(c.legacy ? c.projectId!==legacyProjectId :
        !/^\d{8}$/.test(c.day) || !Number.isSafeInteger(c.sequence) || c.sequence<1 || c.slots.length>LIMIT || c.name!==`Nexora-${c.day}-${String(c.sequence).padStart(3,'0')}`)fail('invalid canvas registry allocation');
      for(const slot of c.slots) {
        if(!HASH.test(slot.key) || !HASH.test(slot.digest) || keys.has(slot.key))fail('invalid canvas registry slot');
        keys.add(slot.key);
      }
      projects.set(c.projectId,c);
    }
    if(!projects.get(legacyProjectId)?.legacy)fail('canvas registry missing legacy canvas');
    // Old jobs are never moved. Reconcile fixed-canvas jobs created before
    // rotation or while disabled; rotated jobs must already have a reservation.
    let changed=false;
    for(const job of jobs) {
      const projectId=job.projectId || legacyProjectId,c=projects.get(projectId);
      if(!c)fail('canvas registry missing job canvas');
      const slot=c.slots.find(s=>s.key===job.key);
      if(slot) {if(slot.digest!==job.digest)fail('canvas registry job mismatch');continue;}
      if(!c.legacy || keys.has(job.key) || !HASH.test(job.key) || !HASH.test(job.digest))fail('canvas registry missing job reservation');
      c.slots.push({key:job.key,digest:job.digest});keys.add(job.key);changed=true;
    }
    if(changed)await atomicJSON(path,state);
    return new CanvasPool(path,state);
  }

  constructor(path,state) {this.path=path;this.state=state;this.queue=Promise.resolve();this.creating=new Map();this.poisoned=false;}

  lookup({key,digest}) {
    if(this.poisoned)fail('canvas registry unavailable; restart required');
    for(const c of this.state.canvases) {
      const slot=c.slots.find(s=>s.key===key);
      if(!slot)continue;
      if(slot.digest!==digest)fail('idempotency conflict',409);
      return summary(c);
    }
  }

  transaction(fn) {
    const op=this.queue.then(async()=>{
      if(this.poisoned)fail('canvas registry unavailable; restart required');
      const next=structuredClone(this.state),result=fn(next);
      try {await atomicJSON(this.path,next);}
      catch(error) {this.poisoned=true;throw error;}
      this.state=next;return result;
    });
    this.queue=op.catch(()=>{});return op;
  }

  reserve({key,digest},preferredProjectId) {
    return this.transaction(state=>{
      if(!HASH.test(key) || !HASH.test(digest))fail('invalid canvas reservation');
      for(const c of state.canvases) {
        const slot=c.slots.find(s=>s.key===key);
        if(!slot)continue;
        if(slot.digest!==digest || preferredProjectId && preferredProjectId!==c.projectId)fail('idempotency conflict',409);
        return summary(c);
      }
      let canvas;
      if(preferredProjectId) {
        canvas=state.canvases.find(c=>c.projectId===preferredProjectId);
        if(!canvas)fail('source canvas not registered');
        if(canvas.slots.length>=LIMIT)fail('source canvas capacity reached (5 tasks maximum)',409);
      } else {
        // China has no daylight-saving transition; fixed UTC+8 is unambiguous.
        const day=new Date(Date.now()+8*60*60*1000).toISOString().slice(0,10).replaceAll('-','');
        const today=state.canvases.filter(c=>!c.legacy && c.day===day);
        canvas=today.findLast(c=>c.slots.length<LIMIT);
        if(!canvas) {
          const sequence=Math.max(0,...today.map(c=>c.sequence))+1;
          canvas={projectId:randomUUID(),name:`Nexora-${day}-${String(sequence).padStart(3,'0')}`,day,sequence,ready:false,slots:[]};
          state.canvases.push(canvas);
        }
      }
      canvas.slots.push({key,digest});return summary(canvas);
    });
  }

  ensureCreated(projectId,create) {
    if(this.poisoned)return Promise.reject(new Error('canvas registry unavailable; restart required'));
    const canvas=this.state.canvases.find(c=>c.projectId===projectId);
    if(!canvas)return Promise.reject(new Error('canvas registry missing job canvas'));
    if(canvas.ready)return Promise.resolve();
    if(this.creating.has(projectId))return this.creating.get(projectId);
    // Don't hold the admission lock during the remote call. Creation uses a
    // persisted UUID, so an uncertain response or restart retries that identity.
    const op=(async()=>{
      const result=await create(summary(canvas));
      if(result?.project?.projectId!==projectId)fail('canvas identity mismatch');
      await this.transaction(state=>{state.canvases.find(c=>c.projectId===projectId).ready=true;});
    })().finally(()=>this.creating.delete(projectId));
    this.creating.set(projectId,op);return op;
  }
}
