import { createServer as httpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, opendir, rename, unlink, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { VIDEO_MODELS, normalizeVideo } from './plugin.js';
import { readReference } from './media-input.mjs';
import { isAbsolute, join } from 'node:path';
import { atomicJSON } from './state-file.mjs';
import { CanvasPool } from './canvas-pool.mjs';
import { DatabaseStore, storageError } from './database-store.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const terminal = job => ['completed', 'failed'].includes(job.status);
function fail(message, status = 400, code) { throw Object.assign(new Error(message), { status, code }); }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function equal(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validateConfig(input) {
  const c = { host: '127.0.0.1', port: 8787, profile: 'default', region: 'cn',
    storage: 'file', migrateLegacy: false, pollMs: 1000, pollIntervalMs: 5000, catalogTTLms: 60000, commandTimeoutMs: 120000, maxQueue: 20, historyCacheSize: 100,
    maxConcurrent: 2, maxAdmissions: 2, maxInputBytes: 64 * 1024 * 1024, maxMediaBytes: 512 * 1024 * 1024, mediaTTL: 3600, maxQueueWaitSeconds: 1800, leaseSeconds: 300, submitWorkers: 6, pollWorkers: 4, downloadWorkers: 2, unlimitedCredits: false, canvasTaskLimit: 0, ...input };
  if (!['file','database'].includes(c.storage) || typeof c.migrateLegacy!=='boolean') fail('invalid storage configuration');
  if (c.storage==='database' && !c.databaseUrl) fail('database storage requires DREAMINA_DATABASE_URL');
  if (![0,5].includes(c.canvasTaskLimit)) fail('invalid config canvasTaskLimit (0 or 5)');
  if (typeof c.unlimitedCredits !== 'boolean') fail('invalid config unlimitedCredits');
  if (typeof c.token !== 'string' || c.token.length < 32 || /\s/.test(c.token)) fail('config token must have at least 32 non-whitespace characters');
  if (!UUID.test(c.projectId) || !/^\d+$/.test(c.userId || '')) fail('config projectId and userId are required');
  if (c.space !== 'personal' && !/^team:\d+$/.test(c.space || '')) fail('config space must be personal or team:<id>');
  if (!ID.test(c.profile) || c.region !== 'cn') fail('invalid config profile or region');
  if (!isAbsolute(c.cli || '') || !isAbsolute(c.dataDir || '')) fail('config cli and dataDir must be absolute paths');
  let url;
  try { url = new URL(c.publicUrl); } catch { fail('invalid config publicUrl'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('invalid config publicUrl');
  c.publicUrl = url.origin;
  for (const [key, min, max] of [['port', 1, 65535], ['pollMs', 1000, 60000], ['commandTimeoutMs', 1000, 600000],
    ['maxQueue', 1, 200], ['maxConcurrent', 1, 200], ['maxAdmissions', 1, 200], ['maxInputBytes', 1, 64 * 1024 * 1024], ['historyCacheSize', 1, 1000], ['maxMediaBytes', 1, 1073741824], ['mediaTTL', 60, 86400],
    ['maxQueueWaitSeconds', 1, 1800], ['leaseSeconds', 1, 300], ['submitWorkers', 1, 12], ['pollWorkers', 1, 8], ['downloadWorkers', 1, 4], ['pollIntervalMs', 1000, 60000], ['catalogTTLms', 1000, 60000]]) {
    if (!integer(c[key], min, max)) fail('invalid config ' + key);
  }
  if (!c.models || Array.isArray(c.models) || !Object.keys(c.models).length) fail('config models are required');
  for (const [alias, m] of Object.entries(c.models)) {
    if (Object.hasOwn(VIDEO_MODELS, alias)) {
      if (m.kind !== 'video' || m.model !== alias || !integer(m.maxCredits, 0, 100000)) fail('invalid config model: ' + alias);
      continue;
    }
    if (!['dreamina-image', 'dreamina-video'].includes(alias) || m.kind !== alias.slice(9) || !/^[A-Za-z0-9_.-]{1,160}$/.test(m.model || '') ||
        !/^\d{1,2}:\d{1,2}$/.test(m.ratio || '') || !/^[A-Za-z0-9]{1,16}$/.test(m.resolution || '') || !integer(m.maxCredits, 0, 100000)) fail('invalid config model: ' + alias);
    const values = m.kind === 'image' ? m.counts : m.durations;
    const max = m.kind === 'image' ? 4 : 30;
    if (!Array.isArray(values) || !values.length || values.some(v => !integer(v, 1, max)) || !values.includes(m.kind === 'image' ? 1 : 5)) fail('invalid config counts/durations: ' + alias);
  }
  return c;
}

// Select public error fields only. Never persist the entire upstream envelope.
function upstreamError(sources) {
  const result = {};
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const candidate of [source.submissionError, source.error, source]) {
      if (!candidate || typeof candidate !== 'object') continue;
      const rawCode = candidate.serviceCode ?? candidate.errorCode ?? candidate.code;
      const code = Number.isSafeInteger(rawCode) && rawCode !== 0 ? rawCode
        : typeof rawCode === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(rawCode) && rawCode !== '0' ? rawCode : undefined;
      const rawMessage = candidate.errorMessage ?? candidate.serviceMessage ?? candidate.message;
      const message = typeof rawMessage === 'string' && rawMessage.trim() ? rawMessage.slice(0, 4096) : undefined;
      if (result.code === undefined && code !== undefined) result.code = code;
      if (result.message === undefined && message !== undefined) result.message = message;
      if (result.code !== undefined && result.message !== undefined) return result;
    }
  }
  return result;
}

// argv is passed without a shell. User text stays one --prompt=<value> argument.
export function runCLI(executable, args, timeout = 120000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [], stderr = []; let bytes = 0; let failure;
    const timer = setTimeout(() => { failure = new Error('CLI timeout'); child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { failure = new Error('CLI output limit'); child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    // Parse only structured public errors; never log or persist raw stderr.
    child.stderr.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { failure = new Error('CLI output limit'); child.kill('SIGKILL'); }
      else stderr.push(chunk);
    });
    child.on('error', () => { failure = new Error('CLI could not start'); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) {
        let cliError;
        for (const output of [Buffer.concat(chunks).toString('utf8'),Buffer.concat(stderr).toString('utf8')]) {
          for (const line of [output,...output.split('\n').reverse()]) {
            try {
              const envelope=JSON.parse(line);
              if(envelope.ok!==false || !envelope.error)continue;
              cliError=upstreamError([envelope.error]);
              const requestId=envelope.meta?.requestId;
              if(typeof requestId==='string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(requestId))cliError.request_id=requestId;
              break;
            } catch { /* Plain stderr is deliberately discarded. */ }
          }
          if(cliError)break;
        }
        return reject(Object.assign(new Error('CLI command failed'), { exitCode: code, cliError }));
      }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error('CLI invalid JSON')); }
      if (result.ok !== true || !result.data) {
        return reject(Object.assign(new Error('CLI command failed'), { exitCode: code }));
      }
      resolvePromise(result.data);
    });
  });
}

function mediaType(bytes, kind) {
  if (kind === 'image') {
    if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  } else {
    if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
    if (bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) return 'video/webm';
  }
  fail('unsupported media format');
}

export class Bridge {
  static async open(config, cli) {
    const bridge = new Bridge(config, cli);
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    // Fail closed after an unclean shutdown. The operator verifies the old PID
    // has exited before removing .lock; two workers must never own one profile.
    bridge.lock = await open(join(config.dataDir, '.lock'), 'wx', 0o600);
    try {
      await bridge.lock.writeFile(String(process.pid));
      let marker;
      try {marker=JSON.parse(await readFile(join(config.dataDir,'.database-storage.json'),'utf8'));}
      catch(error) {if(error.code!=='ENOENT')throw storageError();}
      if(marker && (config.storage!=='database' || marker.context!==bridge.contextKey))fail('This data directory is owned by database storage; restore/export it before switching storage.',503);
      let canvasJobs=[];
      if(config.storage==='database') {
        bridge.store=await DatabaseStore.open({url:config.databaseUrl,context:bridge.contextKey});
        if(!await bridge.store.initialized()) {
          if(marker)throw storageError(); // Never initialize an empty replacement database over existing ownership.
          const legacy=[];
          for await(const entry of await opendir(config.dataDir)) {
            if(!/^[0-9a-f-]{36}\.json$/.test(entry.name))continue;
            if(!config.migrateLegacy)fail('Legacy jobs require an explicit database migration.',503);
            const job=JSON.parse(await readFile(join(config.dataDir,entry.name),'utf8'));
            if(job.id+'.json'!==entry.name || job.context!==bridge.contextKey)throw storageError();
            legacy.push(job);
          }
          // Validate and reconcile the registry before committing any imported job.
          let state=null;
          try {state=JSON.parse(await readFile(join(config.dataDir,'canvases.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
          const staging={readCanvas:async()=>state,writeCanvas:async value=>{state=value;}};
          await CanvasPool.open({context:bridge.contextKey,legacyProjectId:config.projectId,jobs:legacy,store:staging});
          await bridge.store.initialize(legacy,state);
        } else if(!marker) {
          // A previous file rollback may have accepted new work. An existing
          // DB context is NOT proof that these files were already migrated.
          // Also covers a crash after migration commit but before marker write.
          let compared=0;
          for await(const entry of await opendir(config.dataDir)) {
            if(!/^[0-9a-f-]{36}\.json$/.test(entry.name))continue;
            const legacy=JSON.parse(await readFile(join(config.dataDir,entry.name),'utf8'));
            if(legacy.id+'.json'!==entry.name || !isDeepStrictEqual(legacy,await bridge.store.get(legacy.id)))throw storageError();
            compared++;
          }
          if(compared!==await bridge.store.count())throw storageError();
          let registry;
          try {registry=JSON.parse(await readFile(join(config.dataDir,'canvases.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
          if(registry && !isDeepStrictEqual(registry,await bridge.store.readCanvas()))throw storageError();
        }
        await atomicJSON(join(config.dataDir,'.database-storage.json'),{version:1,context:bridge.contextKey});
        for(const job of await bridge.store.active())bridge.cacheJob(job);
        bridge.storedJobs=await bridge.store.count();
        canvasJobs=await bridge.store.canvasJobs();
      } else {
        await mkdir(join(config.dataDir,'keys'),{recursive:true,mode:0o700});
        for await (const entry of await opendir(config.dataDir)) {
          const name=entry.name;
          if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
          const job = JSON.parse(await readFile(join(config.dataDir, name), 'utf8'));
          if (!UUID.test(job.id) || name !== job.id + '.json' || job.context !== bridge.contextKey) fail('stored job context mismatch', 503);
          await bridge.indexJob(job);bridge.cacheJob(job);bridge.storedJobs++;
          canvasJobs.push({key:job.key,digest:job.digest,projectId:job.projectId,request:{n:job.request.n}});
        }
      }
      bridge.canvases = await CanvasPool.open({path:join(config.dataDir,'canvases.json'),context:bridge.contextKey,
        legacyProjectId:config.projectId,jobs:canvasJobs,store:bridge.store});
      return bridge;
    } catch (error) { await bridge.close(); throw error; }
  }

  constructor(config, cli) {
    this.config = config;
    const invokeCLI = cli || (args => runCLI(config.cli, ['--format=json', '--non-interactive', '--profile=' + config.profile, '--region=' + config.region, ...args], config.commandTimeoutMs));
    this.cli = args => {this.store?.assertHealthy();return invokeCLI(args);};
    this.contextKey = hash(JSON.stringify([config.profile, config.region, config.userId, config.space, config.projectId, config.models]));
    this.jobs = new Map(); this.history = new Map(); this.storedJobs = 0; this.admissions = Promise.resolve();
    this.lastQueuedId = null; this.lastPolledId = null; this.lastDownloadedId = null;
    this.nextPoll = new Map(); this.nextDownload = new Map();
    this.catalogCheckedAt = null; this.catalogRefresh = null; this.contextCheck = null;
    this.inFlight = new Map();
    this.promptLimits = new Map();
    this.videoCatalog = new Map();
    this.leases = new Map(); // Deliberately not restored after downtime.
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.admissions;
    await Promise.allSettled([...this.inFlight.values()].map(work => work.promise));
    if (this.store) await this.store.close();
    if (this.lock) { await this.lock.close(); await unlink(join(this.config.dataDir, '.lock')).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }

  async checkContext() {
    // Share only simultaneous checks. Never cache successful identity checks:
    // a later workflow must detect account/space drift before a paid mutation.
    if (!this.contextCheck) {
      this.contextCheck = (async () => {
        const s = await this.cli(['space', 'current']);
        const space = s.kind === 'personal' ? 'personal' : s.kind === 'team' ? 'team:' + s.team?.teamId : '';
        if (s.userId !== this.config.userId || space !== this.config.space) fail('context_mismatch', 503);
      })().finally(() => { this.contextCheck = null; });
    }
    await this.contextCheck;
  }

  async refreshVideoCatalog() {
    if (this.catalogCheckedAt !== null && Date.now() - this.catalogCheckedAt < this.config.catalogTTLms) return;
    if (!this.catalogRefresh) {
      this.catalogRefresh = (async () => {
        const list = await this.cli(['model', 'list', '--type=video']);
        if (!Array.isArray(list.items) || !list.items.length) fail('live model unavailable');
        this.videoCatalog = new Map(list.items.map(m => [m.model, m]));
        this.catalogCheckedAt = Date.now();
      })().finally(() => { this.catalogRefresh = null; });
    }
    await this.catalogRefresh;
  }

  recordTime(job, phase) {
    job.timings ||= {};
    if (job.timings[phase] !== undefined) return;
    job.timings[phase] = Date.now();
    this.onEvent?.({event:'dreamina_phase',job_id:job.id,phase,at_ms:job.timings[phase]});
  }

  async preflight() {
    await this.checkContext();
    const catalogues = new Map();
    for (const [alias, m] of Object.entries(this.config.models)) {
      if (!catalogues.has(m.kind)) catalogues.set(m.kind, await this.cli(['model', 'list', '--type=' + m.kind]));
      const list = catalogues.get(m.kind);
      const model = list.items?.find(item => item.model === m.model);
      if (Object.hasOwn(VIDEO_MODELS, alias)) {
        if (!model?.modes?.length) fail('configured model unavailable: ' + alias, 503);
        this.videoCatalog.set(alias, model);
        continue;
      }
      const mode = model?.modes?.find(item => item.name === (m.kind === 'image' ? 't2i' : 't2v'));
      if (!mode) fail('configured model/mode unavailable: ' + alias, 503);
      const flags = new Map((mode.flags || []).map(f => [f.flag, f]));
      for (const [name, values] of [['ratio', [m.ratio]], ['resolution', [m.resolution]],
        [m.kind === 'image' ? 'count' : 'duration', m.kind === 'image' ? m.counts : m.durations]]) {
        const spec = flags.get('--' + name);
        if (!spec || values.some(v => spec.values ? !spec.values.includes(v) :
          typeof v !== 'number' || v < spec.min || v > spec.max || spec.step && (v - spec.min) % spec.step !== 0)) fail('configured ' + name + ' unavailable: ' + alias, 503);
      }
      const max = flags.get('--prompt')?.maxLength;
      if (!integer(max, 1, 100000)) fail('model prompt limit unavailable: ' + alias, 503);
      this.promptLimits.set(alias, Math.min(2000, max));
    }
    if (catalogues.has('video')) this.catalogCheckedAt = Date.now();
  }

  validateLiveVideo(request) {
    const model = this.videoCatalog.get(request.model);
    if (!model) fail('video model catalogue unavailable', 503);
    if (request.mode === 'promote') return; // Promotion has its own live spec.
    const matching = model.modes.filter(mode => mode.name === request.mode);
    const valid = matching.some(mode => {
      const flags = new Map((mode.flags || []).map(f => [f.flag, f]));
      for (const [name, value] of [['ratio',request.ratio],['resolution',request.resolution],['duration',request.seconds],['count',request.n]]) {
        const spec = flags.get('--'+name);
        if (!spec || (spec.values ? !spec.values.includes(value) : !integer(value,spec.min,spec.max) || spec.step && (value-spec.min)%spec.step!==0)) return false;
      }
      const prompt = flags.get('--prompt');
      if (!prompt || request.prompt.length > prompt.maxLength || request.prompt.length < (prompt.minLength || 0)) return false;
      const refs=request.references, caps=mode.references;
      if (!caps) return refs.length===0;
      if (refs.length<caps.min || refs.length>caps.max) return false;
      for (const type of ['image','video','audio']) {
        const count=refs.filter(r=>r.type===type).length, rule=(caps.types||[]).find(t=>t.mediaType===type);
        if (rule ? count<rule.min || count>rule.max : count>0) return false;
      }
      return !caps.requireAnyOfTypes || refs.some(r=>caps.requireAnyOfTypes.includes(r.type));
    });
    if (!valid) fail('requested parameters are not available in the live CLI model specification');
  }

  validate(body, source = this.jobs.get(body?.source_job_id)) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid request body');
    if (Object.hasOwn(VIDEO_MODELS, body.model)) {
      if (!Object.hasOwn(this.config.models, body.model)) fail('unsupported model/kind');
      if (body.mode === 'promote') {
        if (Object.keys(body).some(k => !['kind','model','mode','source_job_id','resolution','ratio','seconds','n','references'].includes(k)) ||
            body.model !== 'seedance_2.5' || body.kind !== 'video' || !source || source.status !== 'completed' || source.request.model !== 'seedance_2.5_draft' || source.request.n !== 1 || source.files.length !== 1 ||
            body.resolution !== '1080p' || body.seconds !== source.request.seconds || body.ratio !== source.request.ratio || body.n !== 1 || !Array.isArray(body.references) || body.references.length) fail('invalid draft promotion source or parameters');
        return {kind:'video',model:body.model,mode:'promote',source_job_id:source.id,resolution:'1080p',ratio:source.request.ratio,seconds:source.request.seconds,n:1,references:[]};
      }
      let r;
      try { r = normalizeVideo(body, body.model, false); } catch(e) { fail(e.message); }
      this.validateLiveVideo(r);
      return r;
    }
    const m = Object.hasOwn(this.config.models, body.model) ? this.config.models[body.model] : undefined;
    if (!m || m.kind !== body.kind) fail('unsupported model/kind');
    const allowed = ['model', 'kind', 'prompt', ...(m.kind === 'image' ? ['n'] : ['seconds'])];
    if (Object.keys(body).some(k => !allowed.includes(k))) fail('unsupported request field');
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > (this.promptLimits.get(body.model) || 2000) || /\0|\{\{/.test(body.prompt)) fail('invalid prompt');
    const count = m.kind === 'image' ? (body.n === undefined ? 1 : body.n) : 1;
    const seconds = m.kind === 'video' ? (body.seconds === undefined ? 5 : body.seconds) : undefined;
    if (m.kind === 'image' && !m.counts.includes(count)) fail('invalid image count');
    if (m.kind === 'video' && !m.durations.includes(seconds)) fail('invalid video seconds');
    return { kind: m.kind, model: body.model, prompt: body.prompt, n: count, ...(seconds === undefined ? {} : { seconds }) };
  }

  submit(body, key, waitForGateway = false) {
    const op = this.admissions.then(async () => {
      if (this.closed) fail('bridge closed', 503);
      this.store?.assertHealthy();
      const source = body?.mode==='promote' ? await this.loadJob(body.source_job_id) : undefined;
      const request = this.validate(body,source);
      if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key)) fail('invalid Idempotency-Key');
      const keyHash = hash(key), digest = hash(JSON.stringify(request));
      const existingId = await this.findJobKey(keyHash);
      const existing = existingId ? await this.loadJob(existingId,true) : undefined;
      if (existing) {
        if (existing.digest !== digest) fail('idempotency conflict', 409);
        return this.get(existing.id,existing);
      }
      if (request.n > this.config.maxConcurrent) fail('requested count exceeds generation capacity', 429);
      if ([...this.jobs.values()].filter(j => !terminal(j)).reduce((n,j) => n + j.request.n, 0) + request.n > this.config.maxQueue) fail('Active video queue is full. Please retry after existing tasks finish.', 429, 'active_queue_full');
      const job = { id: randomUUID(), key: keyHash, digest, context: this.contextKey, request,
        nodeId: 'node_' + Array.from(randomBytes(10), b => '0123456789abcdefghjkmnpqrstvwxyz'[b & 31]).join(''), updateId: randomUUID(), submitId: randomUUID(),
        status: 'queued', created_at: Math.floor(Date.now() / 1000), timings: {admitted_at_ms: Date.now()}, files: [], inputs: [] };
      // Only local file identities/hashes are persisted. In particular, signed
      // input URLs and base64 payloads never enter job snapshots or responses.
      let saving=false;
      try {
        let remaining = this.config.maxInputBytes;
        const inputDeadline = AbortSignal.timeout(30000);
        for (const ref of request.references || []) {
          let media;
          try { media = await readReference(ref, remaining, inputDeadline); } catch { fail('invalid or unavailable reference media'); }
          remaining -= media.bytes.length;
          const resourceId = randomUUID(), filename = job.id + '-input-' + job.inputs.length + '.' + media.extension;
          const file = await open(join(this.config.dataDir, filename), 'wx', 0o600);
          try { await file.writeFile(media.bytes); await file.sync(); } finally { await file.close(); }
          job.inputs.push({resourceId,filename,type:ref.type,sha256:hash(media.bytes),uploaded:false});
        }
        if (request.references) request.references = job.inputs.map(input => ({type:input.type}));
        const reserved = this.canvases.lookup(job);
        if (reserved) {
          job.projectId = reserved.projectId;
          job.canvasName = reserved.name;
        } else if (this.config.canvasTaskLimit === 5) {
          const canvas = await this.canvases.reserve(job, source ? this.projectId(source) : undefined);
          job.projectId = canvas.projectId;
          job.canvasName = canvas.name;
        } else {
          // Fixed mode only affects new independent jobs. Source-bound work
          // must keep its project even when rotation has been switched off.
          job.projectId = source ? this.projectId(source) : this.config.projectId;
          if (job.projectId !== this.config.projectId) await this.canvases.reserve(job, job.projectId);
        }
        saving=true;
        await this.save(job);
      } catch(e) {
        // A lost commit response may still mean the job was persisted. Keep
        // its inputs until recovery establishes the authoritative DB state.
        if(!saving)for (const input of job.inputs) await unlink(join(this.config.dataDir,input.filename)).catch(()=>{});
        throw e;
      }
      this.storedJobs++;
      await this.indexJob(job);
      if (!waitForGateway) this.leases.set(job.id, Date.now() + this.config.leaseSeconds * 1000);
      return this.get(job.id);
    });
    this.admissions = op.catch(() => {});
    return op;
  }

  async save(job) {
    try { if(this.store)await this.store.save(job);else await atomicJSON(join(this.config.dataDir, job.id + '.json'), job); }
    catch { fail('Task storage is unavailable. Please contact the operator.',503,'job_storage_unavailable'); }
    this.cacheJob(job);
  }

  cacheJob(job) {
    this.jobs.set(job.id,job);
    this.history.delete(job.id);
    if(!terminal(job))return;
    this.history.set(job.id,true);
    this.nextPoll.delete(job.id);this.nextDownload.delete(job.id);this.leases.delete(job.id);
    while(this.history.size>this.config.historyCacheSize) {
      const id=this.history.keys().next().value;
      this.history.delete(id);this.jobs.delete(id);
    }
  }

  async loadJob(id, indexed=false) {
    if(!UUID.test(id || ''))fail('job not found',404);
    this.store?.assertHealthy();
    const cached=this.jobs.get(id);
    if(cached){this.cacheJob(cached);return cached;}
    let job;
    try {
      job=this.store?await this.store.get(id):JSON.parse(await readFile(join(this.config.dataDir,id+'.json'),'utf8'));
      if(!job)throw Object.assign(new Error('missing job'),{code:'ENOENT'});
    }
    catch(error) {
      if(error.code==='ENOENT' && !indexed)fail('job not found',404);
      fail('Task storage is unavailable. Please contact the operator.',503,'job_storage_unavailable');
    }
    if(job.id!==id || job.context!==this.contextKey)fail('Task storage is unavailable. Please contact the operator.',503,'job_storage_unavailable');
    this.cacheJob(job);
    return job;
  }

  async findJobKey(key) {
    if(this.store)return this.store.findKey(key);
    let record;
    try { record=JSON.parse(await readFile(join(this.config.dataDir,'keys',key+'.json'),'utf8')); }
    catch(error) {
      if(error.code!=='ENOENT')fail('Task storage is unavailable. Please contact the operator.',503,'job_storage_unavailable');
      // A job may have been durably saved before its index write failed.
      // Recover that same identity; never create a second job for this key.
      const saved=[...this.jobs.values()].find(j=>j.key===key);
      if(!saved)return undefined;
      await this.indexJob(saved);return saved.id;
    }
    if(record.context!==this.contextKey || record.key!==key || !UUID.test(record.id))fail('Task storage is unavailable. Please contact the operator.',503,'job_storage_unavailable');
    return record.id;
  }

  async indexJob(job) {
    if(this.store)return; // Unique key and job are committed in the same database transaction.
    if(!/^[0-9a-f]{64}$/.test(job.key))fail('invalid stored job key',503,'job_storage_unavailable');
    const path=join(this.config.dataDir,'keys',job.key+'.json');
    try {
      let existing;
      try {existing=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(existing) {
        if(existing.id!==job.id || existing.key!==job.key || existing.context!==this.contextKey)throw Error('index identity mismatch');
      } else await atomicJSON(path,{key:job.key,id:job.id,context:this.contextKey});
    } catch {fail('Task storage is unavailable. Please contact the operator.',503,'job_storage_unavailable');}
  }

  projectId(job) { return job.projectId || this.config.projectId; }

  get(id, j = this.jobs.get(id)) {
    if (!j) fail('job not found', 404);
    return { id: j.id, object: j.request.kind === 'video' ? 'video' : 'image', model: j.request.model,
      status: j.status, created_at: j.created_at, completed_at: j.completed_at,
      n: j.request.n, mode:j.request.mode, ratio:j.request.ratio, resolution:j.request.resolution,
      video_count:j.request.kind === 'video' && j.status === 'completed' ? j.files.length : 0,
      reference_video:(j.request.references || []).some(r=>r.type==='video'),
      ...(j.request.model === 'seedance_2.5_draft' ? {warning:'样片最长存储 7 天，过期后不可再生成正片；具体期限以即梦服务端为准'} : {}),
      seconds: j.request.seconds, image_count: j.status === 'completed' ? j.files.length : j.request.n,
      timings: j.timings ? {...j.timings} : undefined,
      phase: terminal(j) ? j.status : j.attention ? 'needs_attention' : j.downloadResources ? 'downloading' : j.status,
      recovery: this.recovery(j), diagnostics: j.diagnostics ? structuredClone(j.diagnostics) : undefined,
      progress: j.status === 'completed' ? 100 : 0, attention: j.attention, error: j.error,
      data: j.status === 'completed' && j.request.kind === 'image' ? j.files.map((f, i) => ({ url: this.mediaURL(j.id, i) })) : [] };
  }

  recovery(job) {
    let action='wait', message='正在处理，请勿重复提交';
    if(job.status==='completed'){action='completed';message='生成完成';}
    else if(job.status==='failed') {
      action='review_failure';message='任务失败，请核对原因后再提交';
      if(String(job.error?.upstream_code)==='20005'){action='add_credits_then_resubmit';message='请补充当前成员积分后重新提交';}
      if(['20100','20115'].includes(String(job.error?.upstream_code))){action='fix_input_then_resubmit';message='请修改输入内容后重新提交，不自动重试';}
      if(job.error?.code==='queue_expired'){action='resubmit';message='本地排队超时，可重新提交';}
    } else if(job.downloadResources){action='retry_download';message='正在获取生成结果，请勿重新生成';}
    else if(['manual_recovery_required','submission_uncertain','operation_mismatch','resources_missing','resource_count_mismatch','invalid_resource_id','context_mismatch'].includes(job.attention)){
      action='manual_review';message='提交状态待核查，请勿重复提交';
    } else if(job.attention){action='retry_query';message='状态查询或准备异常，正在重查，请勿重复提交';}
    return {action,message,automatic_resubmit:false};
  }

  recordIssue(job, stage, source = {}, fallback = 'status_unavailable') {
    const upstream=upstreamError([source]);
    const issue={code:upstream.code ?? fallback,message:this.cleanMessage(upstream.message || fallback),stage,at_ms:Date.now()};
    if(typeof source.request_id==='string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(source.request_id))issue.request_id=source.request_id;
    job.diagnostics ||= {};
    job.diagnostics.last_error=issue;
    this.onEvent?.({event:'dreamina_attention',job_id:job.id,stage,code:issue.code,at_ms:issue.at_ms});
  }

  cleanMessage(message) {
    return message.replaceAll(this.config.token, '[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
      .replace(/https?:\/\/[^\s<>"']+/gi, '[redacted URL]')
      .replace(/((?:access_token|refresh_token|api_key|token|signature|X-Tos-Signature)=)[^\s&]+/gi, '$1[redacted]');
  }

  observe(id, job) {
    const result = this.get(id,job);
    if (result.status === 'queued') this.leases.set(id, Date.now() + this.config.leaseSeconds * 1000);
    return result;
  }

  mediaURL(id, index) {
    const expires = Math.floor(Date.now() / 1000) + this.config.mediaTTL;
    const path = '/v1/jobs/' + id + '/content/' + index;
    return this.config.publicUrl + path + '?expires=' + expires + '&sig=' + this.sign(path, expires);
  }

  sign(path, expires) { return createHmac('sha256', this.config.token).update('media\n' + path + '\n' + expires).digest('hex'); }

  tick() {
    if(this.store?.poisoned)return Promise.reject(storageError());
    if (this.closed) return Promise.resolve();
    if (this.schedulerError) return Promise.reject(this.schedulerError);
    const pending = [];
    // Reserve worker and generation slots synchronously before starting any
    // asynchronous work. Overlapping timer ticks cannot dispatch a job twice.
    let occupied = [...this.jobs.values()].reduce((n,j) => n +
      (j.status === 'in_progress' || j.status === 'queued' && this.inFlight.has(j.id) ? j.request.n : 0), 0);
    for (const lane of ['download', 'poll', 'submit']) {
      const workers = [...this.inFlight.values()].filter(w => w.lane === lane);
      let available = this.config[lane + 'Workers'] - workers.length;
      const busyCanvases = new Set(workers.map(w => w.projectId));
      const candidates = [...this.jobs.values()].filter(j => lane === 'submit' ? j.status === 'queued' :
        j.status === 'in_progress' && (lane === 'download' ? !!j.downloadResources : !j.downloadResources));
      const cursor = lane === 'poll' ? 'lastPolledId' : lane === 'download' ? 'lastDownloadedId' : 'lastQueuedId';
      const previous = candidates.findIndex(j => j.id === this[cursor]);
      for (let offset = 1; offset <= candidates.length && available > 0; offset++) {
        const job = candidates[(previous + offset) % candidates.length];
        if (this.inFlight.has(job.id)) continue;
        if (lane === 'poll' && Date.now() < Math.max(this.nextPoll.get(job.id) || 0, job.diagnostics?.next_poll_at_ms || 0)) continue;
        if (lane === 'download' && Date.now() < (this.nextDownload.get(job.id) || 0)) continue;
        const expired = job.status === 'queued' && Date.now() >= (job.created_at + this.config.maxQueueWaitSeconds) * 1000;
        const projectId = this.projectId(job);
        if (lane === 'submit' && !expired) {
          if (!(this.leases.get(job.id) > Date.now()) || occupied + job.request.n > this.config.maxConcurrent || busyCanvases.has(projectId)) continue;
          occupied += job.request.n;
          busyCanvases.add(projectId);
        }
        available--; this[cursor] = job.id;
        const work = {lane, projectId};
        this.inFlight.set(job.id, work);
        work.promise = Promise.resolve().then(async () => {
          if (expired) { this.failed(job, 'queue_expired'); await this.save(job); }
          else await this.processJob(job);
        }).catch(error => {
          this.schedulerError = error;
          throw error;
        }).finally(() => {
          if (!terminal(job) && lane === 'poll') this.nextPoll.set(job.id, Date.now() + this.config.pollIntervalMs);
          if (!terminal(job) && lane === 'download') this.nextDownload.set(job.id, Date.now() + this.config.pollIntervalMs);
          this.inFlight.delete(job.id);
        });
        pending.push(work.promise);
      }
    }
    return Promise.all(pending).then(() => {});
  }

  async processJob(job) {
    if (terminal(job)) return;
    if (job.status === 'queued') this.recordTime(job, 'preparation_started_at_ms');
    try { await this.checkContext(); } catch (error) {
      job.attention = error.message === 'context_mismatch' ? 'context_mismatch' : 'cli_unavailable';
      this.recordIssue(job,'context',error.cliError,job.attention);
      job.diagnostics.next_poll_at_ms=Date.now()+60000;
      await this.save(job); return;
    }
    if (this.closed) return;
    delete job.attention;
    if (job.downloadResources) return this.downloadJob(job);
    if (job.status === 'queued') {
      const source=job.request.mode==='promote' ? await this.loadJob(job.request.source_job_id,true) : undefined;
      this.recordTime(job, 'context_checked_at_ms');
      // A context check may itself take a long time. Re-check the start window
      // immediately before any command that can authorize a charge.
      if (Date.now() >= (job.created_at + this.config.maxQueueWaitSeconds) * 1000) {
        this.failed(job, 'queue_expired'); await this.save(job); return;
      }
      if (!(this.leases.get(job.id) > Date.now())) { job.attention = 'awaiting_gateway'; await this.save(job); return; }
      try {
        await this.canvases.ensureCreated(this.projectId(job), canvas =>
          this.cli(['canvas','create',canvas.name,'--project-id='+canvas.projectId]));
      } catch { job.attention='canvas_creation_pending';await this.save(job);return; }
      this.recordTime(job, 'canvas_ready_at_ms');
      if (this.closed) return;
      if (Date.now() >= (job.created_at+this.config.maxQueueWaitSeconds)*1000 || !(this.leases.get(job.id)>Date.now())) {
        job.attention='awaiting_gateway';await this.save(job);return;
      }
      if (Object.hasOwn(VIDEO_MODELS, job.request.model)) {
        try {
          await this.refreshVideoCatalog();
          this.validateLiveVideo(job.request);
          if (job.request.mode === 'promote') {
            const details = await this.cli(['model','seedance_2.5_draft']);
            const generation = details.matches?.map(m=>m.generation).find(g=>g?.generationKind==='sample' && g.mode===source.request.mode);
            const values = generation?.draftPromotion?.params?.find(p=>p.name==='resolution')?.rule?.stringValues;
            if (!values?.includes(job.request.resolution)) fail('promotion resolution unavailable');
          }
        } catch { job.attention='model_unavailable'; await this.save(job); return; }
        this.recordTime(job, 'model_checked_at_ms');
        try {
          for (const input of job.inputs || []) {
            if (this.closed) return;
            if(input.uploaded) continue;
            const path=join(this.config.dataDir,input.filename);
            if(hash(await readFile(path))!==input.sha256) fail('input checksum mismatch');
            const result=await this.cli(['resource','upload','--file='+path,'--type='+input.type,'--project-id='+this.projectId(job),'--resource-id='+input.resourceId]);
            if(result.resourceId!==input.resourceId || result.mediaType!==input.type) fail('input upload mismatch');
            input.uploaded=true; await this.save(job);
          }
        } catch { job.attention='reference_upload_pending'; await this.save(job); return; }
        this.recordTime(job, 'references_ready_at_ms');
        // Preparation can take longer than the lease. Never generate for a
        // gateway that abandoned a request while it was downloading/uploading.
        if (Date.now() >= (job.created_at+this.config.maxQueueWaitSeconds)*1000 || !(this.leases.get(job.id)>Date.now())) {
          job.attention='awaiting_gateway';await this.save(job);return;
        }
      }
      if (this.closed) return;
      // Durable transition BEFORE any remote mutation. A crash from here on
      // only permits read-only recovery of this exact submit identity.
      job.status = 'in_progress';
      this.recordTime(job, 'submit_started_at_ms');
      await this.save(job);
      const r = job.request, m = this.config.models[r.model];
      const video = Object.hasOwn(VIDEO_MODELS, r.model);
      // Only the operator can approve uncapped spending. Client payloads cannot
      // override this policy; the gateway still reserves user quota first.
      const creditApproval = this.config.unlimitedCredits ? '--yes' : '--credit-ceiling=' + m.maxCredits;
      const args = r.mode === 'promote' ? ['node','promote','video-sample','--project-id='+this.projectId(job),
        '--node-id='+source.nodeId,'--submit-id='+job.submitId,'--resolution='+r.resolution,
        '--title=Video promotion',creditApproval] :
        ['node', 'create', r.kind, '--project-id=' + this.projectId(job),
        '--node-id=' + job.nodeId, '--update-id=' + job.updateId, '--submit-id=' + job.submitId,
        '--mode=' + (video ? r.mode : r.kind === 'image' ? 't2i' : 't2v'), '--model=' + m.model,
        '--prompt=' + r.prompt, '--ratio=' + (video ? r.ratio : m.ratio), '--resolution=' + (video ? r.resolution : m.resolution),
        '--count='+r.n, ...(r.kind === 'video' ? ['--duration=' + r.seconds] : []),
        ...(video ? ['--title=Video generation', ...(job.inputs || []).map(input=>'--ref=res:'+input.resourceId)] : []),
        creditApproval, '--run'];
      try {
        const result = await this.cli(args);
        if (r.mode === 'promote') {
          if (result.submitId !== job.submitId) job.attention = 'submission_uncertain';
          else if (String(result.state).toLowerCase() === 'rejected') this.failed(job,'submission_rejected', result);
          else if (!['accepted','completed','in_progress'].includes(String(result.state).toLowerCase())) job.attention='submission_uncertain';
        } else if (String(result.submission?.state).toLowerCase() === 'rejected') this.failed(job, 'submission_rejected', result.submission, result);
        else if (!result.submission || result.submission.submitId && result.submission.submitId !== job.submitId) job.attention = 'submission_uncertain';
        const accepted = r.mode === 'promote' ? result.state : result.submission?.state;
        if (!job.attention && job.status === 'in_progress' && ['accepted','completed','in_progress'].includes(String(accepted).toLowerCase())) this.recordTime(job, 'accepted_at_ms');
      } catch (error) {
        // Exit 10 is documented as quotation awaiting approval, without debit.
        if (error.exitCode === 10) this.failed(job, 'credit_approval_required');
        else if(['20005','20100','20115'].includes(String(error.cliError?.code))) this.failed(job,'submission_rejected',error.cliError);
        else {
          job.attention = 'submission_uncertain';
          this.recordIssue(job,'submit',error.cliError,'submission_uncertain');
        }
      }
      await this.save(job); return;
    }
    job.timings ||= {};
    const polledAt = Date.now();
    if (job.timings.last_poll_started_at_ms !== undefined) job.timings.max_poll_gap_ms = Math.max(job.timings.max_poll_gap_ms || 0, polledAt - job.timings.last_poll_started_at_ms);
    job.timings.last_poll_started_at_ms = polledAt;
    job.timings.poll_count = (job.timings.poll_count || 0) + 1;
    let operation;
    try { operation = await this.cli(['operation', 'status', job.submitId, '--project-id=' + this.projectId(job)]); }
    catch (error) {
      job.timings.last_poll_finished_at_ms = Date.now();
      job.timings.poll_error_count = (job.timings.poll_error_count || 0) + 1;
      this.onEvent?.({event:'dreamina_poll',job_id:job.id,at_ms:Date.now(),duration_ms:Date.now()-polledAt,state:'status_unavailable',poll_count:job.timings.poll_count});
      const uncertain=['cli.operation_submission_absent','cli.operation_identity_unknown','cli.operation_context_mismatch'].includes(error.cliError?.code);
      job.attention = uncertain ? 'manual_recovery_required' : 'status_unavailable';
      this.recordIssue(job,'query',error.cliError,'status_unavailable');
      job.diagnostics.consecutive_query_errors=(job.diagnostics.consecutive_query_errors || 0)+1;
      const delay=uncertain ? 60000 : Math.min(60000,5000 * 2 ** Math.min(job.diagnostics.consecutive_query_errors-1,4));
      job.diagnostics.next_poll_at_ms=Date.now()+delay;
      await this.save(job); return;
    }
    job.timings.last_poll_finished_at_ms = Date.now();
    job.diagnostics ||= {};
    job.diagnostics.consecutive_query_errors=0;
    job.diagnostics.next_poll_at_ms=0;
    job.diagnostics.last_query_at_ms=Date.now();
    if(job.diagnostics.last_error && !job.diagnostics.last_error.resolved_at_ms)job.diagnostics.last_error.resolved_at_ms=Date.now();
    this.onEvent?.({event:'dreamina_poll',job_id:job.id,at_ms:Date.now(),duration_ms:Date.now()-polledAt,state:String(operation.state).slice(0,40),poll_count:job.timings.poll_count});
    if (operation.operationRef && operation.operationRef !== job.submitId) {
      job.attention = 'operation_mismatch'; job.diagnostics.next_poll_at_ms=Date.now()+60000; await this.save(job); return;
    }
    if (String(operation.submission?.state).toLowerCase() === 'accepted' && job.timings.accepted_at_ms === undefined) this.recordTime(job, 'accepted_observed_at_ms');
    const resources = operation.resources || [];
    const state = String(operation.state).toLowerCase();
    const submission = String(operation.submission?.state).toLowerCase();
    // A failed aggregate can include successful outputs in a multi-output job.
    // Keep those deliveries and their existing partial billing, but a pending
    // placeholder alone must never mask a definitive upstream failure.
    if ((submission === 'rejected' || state === 'failed') && !resources.some(r=>r.state==='succeeded')) {
      this.failed(job, 'generation_failed', ...resources.filter(r => r.state === 'failed'), operation.submission, operation); await this.save(job); return;
    }
    if (!resources.length || (state !== 'failed' && submission !== 'rejected' && resources.some(r => !['succeeded', 'failed'].includes(r.state)))) {
      if (['absent', 'unknown', 'awaiting_confirmation'].includes(submission) || state === 'unknown') job.attention = 'manual_recovery_required';
      else if (!resources.length && ['succeeded', 'completed'].includes(state)) job.attention = 'resources_missing';
      if(job.attention)job.diagnostics.next_poll_at_ms=Date.now()+60000;
      await this.save(job); return;
    }
    if (resources.length !== job.request.n || new Set(resources.map(r => r.resourceId)).size !== resources.length) {
      job.attention = 'resource_count_mismatch'; await this.save(job); return;
    }
    const successful = resources.filter(r => r.state === 'succeeded');
    if (!successful.length) { this.failed(job, 'generation_failed', ...resources.filter(r => r.state === 'failed'), operation.submission, operation); await this.save(job); return; }
    // Persist the successful resource IDs before releasing the poll worker.
    // Restart resumes downloads only; never resubmit or wait for another query.
    if (successful.some(r => !ID.test(r.resourceId))) { job.attention='invalid_resource_id';await this.save(job);return; }
    job.downloadResources = successful.map(r => r.resourceId);
    this.recordTime(job, 'upstream_completed_observed_at_ms');
    await this.save(job);
  }

  async downloadJob(job) {
    this.recordTime(job, 'download_started_at_ms');
    await this.save(job);
    try {
      for (let i = 0; i < job.downloadResources.length; i++) {
        if (this.closed) return;
        const resourceId = job.downloadResources[i];
        if (!ID.test(resourceId)) fail('invalid resource ID');
        if (job.files[i]?.resourceId === resourceId) continue;
        job.files[i] = await this.download(job, resourceId, i);
        await this.save(job);
      }
      job.status = 'completed'; job.completed_at = Math.floor(Date.now() / 1000);
      this.recordTime(job, 'download_completed_at_ms');
    } catch { job.attention = 'download_failed'; }
    await this.save(job);
  }

  failed(job, code, ...sources) {
    const upstream = upstreamError(sources);
    let message = upstream.message || (upstream.code !== undefined ? 'Dreamina service error: ' + upstream.code : code.replaceAll('_', ' '));
    // Operator-confirmed meaning; keep the machine-readable upstream code.
    if (String(upstream.code) === '20115') message = '20115:本次生成的输出视频未通过版权审核';
    if (String(upstream.code) === '20100') message = '20100:本次输入文本敏感，已被安全审核拦截';
    if (String(upstream.code) === '20005') message = '20005:即梦当前成员可用积分不足';
    // Public error text is retained; known credentials are never echoed.
    message = this.cleanMessage(message);
    job.status = 'failed';
    job.completed_at = Math.floor(Date.now()/1000);
    delete job.attention;
    this.recordIssue(job,'terminal',upstream,code);
    job.diagnostics.next_poll_at_ms=0;
    job.error = {code, message, ...(upstream.code !== undefined ? {upstream_code: upstream.code} : {})};
  }

  async download(job, resourceId, index) {
    const filename = job.id + '-' + index + '.bin';
    const partial = join(this.config.dataDir, filename + '.part');
    await unlink(partial).catch(e => { if (e.code !== 'ENOENT') throw e; });
    const result = await this.cli(['resource', 'download', resourceId, '--project-id=' + this.projectId(job), '--output=' + partial]);
    const info = await stat(partial);
    if (!info.isFile() || !info.size || info.size > this.config.maxMediaBytes || result.path !== partial || result.size !== info.size) fail('invalid download');
    const file = await open(partial, 'r');
    let mime;
    try { const bytes = Buffer.alloc(32); const { bytesRead } = await file.read(bytes, 0, 32, 0); mime = mediaType(bytes.subarray(0, bytesRead), job.request.kind); }
    finally { await file.close(); }
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(partial)) digest.update(chunk);
    if (digest.digest('hex') !== result.sha256) fail('download checksum mismatch');
    await rename(partial, join(this.config.dataDir, filename));
    return { resourceId, filename, size: info.size, mime };
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function content(bridge, req, res, id, index) {
  const job = await bridge.loadJob(id), file = job?.files[index];
  if (job?.status !== 'completed' || !file) fail('content not found', 404);
  const path = join(bridge.config.dataDir, file.filename);
  const info = await stat(path);
  if (info.size !== file.size) fail('content unavailable', 503);
  let start = 0, end = file.size - 1, status = 200;
  const headers = { 'Content-Type': file.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes' };
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!range || !(range[1] || range[2])) fail('invalid range', 416);
    if (!range[1]) start = Math.max(0, file.size - Number(range[2]));
    else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
    if (!Number.isSafeInteger(start) || start > end || start >= file.size) fail('invalid range', 416);
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}

export function createServer(bridge) {
  // Bound base64 buffers and the serialized admission backlog independently
  // of generation concurrency. Queries/downloads remain available under load.
  let admissions = 0;
  return httpServer({ requestTimeout: 120000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (req, res) => {
    try {
      const url = new URL(req.url, 'http://bridge.local');
      const media = /^\/v1\/jobs\/([0-9a-f-]{36})\/content\/(\d{1,2})$/.exec(url.pathname);
      const bearer = typeof req.headers.authorization === 'string' && equal(req.headers.authorization, 'Bearer ' + bridge.config.token);
      const expires = url.searchParams.get('expires') || '';
      const now = Math.floor(Date.now() / 1000);
      const signed = media && /^\d{1,12}$/.test(expires) && Number(expires) > now && Number(expires) <= now + bridge.config.mediaTTL &&
        equal(url.searchParams.get('sig') || '', bridge.sign(url.pathname, expires));
      if (!bearer && !(signed && ['GET', 'HEAD'].includes(req.method))) fail('unauthorized', 401);
      if (media && ['GET', 'HEAD'].includes(req.method)) return await content(bridge, req, res, media[1], Number(media[2]));
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: bridge.schedulerError || bridge.store?.poisoned ? 'error' : 'ok', storage:bridge.config.storage, stored_jobs:bridge.storedJobs, cached_history:bridge.history.size, queued: [...bridge.jobs.values()].filter(j => !terminal(j)).length,
        waiting: [...bridge.jobs.values()].filter(j => j.status === 'queued').length,
        running: [...bridge.jobs.values()].filter(j => j.status === 'in_progress').length,
        submit_workers: [...bridge.inFlight.values()].filter(w => w.lane === 'submit').length,
        poll_workers: [...bridge.inFlight.values()].filter(w => w.lane === 'poll').length,
        download_workers: [...bridge.inFlight.values()].filter(w => w.lane === 'download').length,
        downloading: [...bridge.jobs.values()].filter(j => j.status === 'in_progress' && j.downloadResources).length });
      if (req.method === 'POST' && url.pathname === '/v1/jobs') {
        if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') fail('JSON required', 415);
        if (admissions >= bridge.config.maxAdmissions) fail('Too many simultaneous submission requests. Please retry shortly.',429,'submission_admission_full');
        admissions++;
        try {
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > Math.ceil(bridge.config.maxInputBytes * 4 / 3) + 262144) fail('body too large', 413); chunks.push(chunk); }
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('invalid JSON'); }
          return json(res, 202, await bridge.submit(body, req.headers['idempotency-key'], true));
        } finally { admissions--; }
      }
      const query = /^\/v1\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === 'GET' && query) return json(res, 200, bridge.observe(query[1],await bridge.loadJob(query[1])));
      fail('not found', 404);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: { ...(error.code ? {code:error.code} : {}), message: error.status ? error.message : 'bridge internal error' } });
      else res.destroy();
    }
  });
}
