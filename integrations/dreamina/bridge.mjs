import { createServer as httpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, opendir, rename, unlink, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { VIDEO_MODELS, normalizeVideo, PROMOTION_UNSUPPORTED } from './plugin.js';
import { readReference } from './media-input.mjs';
import { isAbsolute, join } from 'node:path';
import { atomicJSON } from './state-file.mjs';
import { CanvasPool } from './canvas-pool.mjs';
import { DatabaseStore, storageError } from './database-store.mjs';
import {MEDIA_RETENTION_SECONDS,mediaDeadlines,cleanupMedia as removeExpiredMedia} from './retention.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const failedOperationStates = new Set(['failed','cancelled','canceled','expired']);
const isTerminalOperation = state => failedOperationStates.has(state) || state === 'succeeded' || state === 'completed';
const terminal = job => ['completed', 'failed'].includes(job.status);
// Keep the credit identity even when its persisted contract is damaged.
const hasCreditBilling = job => Object.hasOwn(job, 'billing') || job.billingMode === 'credits';
function fail(message, status = 400, code) { throw Object.assign(new Error(message), { status, code }); }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
// Credential and workspace errors affect the worker, not an individual file.
const identityRecoveryCodes = new Set([
  'cli.auth_required', 'cli.authentication_required', 'cli.auth_refresh_failed', 'cli.auth_refresh_unavailable',
  'cli.auth_state_failed', 'cli.auth_unavailable', 'cli.context_changed', 'cli.canvas_space_mismatch',
  'cli.operation_context_invalid', 'cli.operation_context_mismatch', 'cli.operation_identity_unknown',
]);
// Team names can change; the CLI returns account and team IDs as exact strings.
function consumptionSubjectError(subject, config) {
  if (!subject || typeof subject.userId !== 'string' || !subject.userId ||
      !['personal', 'team'].includes(subject.kind) ||
      (subject.kind === 'team' && (typeof subject.teamId !== 'string' || !subject.teamId))) {
    return 'credit_subject_unverified';
  }
  const space = subject.kind === 'personal' ? 'personal' : 'team:' + subject.teamId;
  if (subject.userId !== config.userId || space !== config.space ||
      (subject.kind === 'personal' && subject.teamId != null && subject.teamId !== '')) {
    return 'credit_subject_mismatch';
  }
  return null;
}

const runConflictMessages = {
  run_subject_mismatch: '即梦运行回执报告的扣费账号或团队与本渠道不符，请管理员核查原操作，请勿重新生成',
  run_generation_changed: '即梦运行回执报告生成参数已变化，请管理员核查原操作，请勿重新生成',
  run_resource_mismatch: '即梦受理回执的输出资源与请求不一致，请管理员核查原操作，请勿重新生成',
  promotion_source_mismatch: '即梦转正回执报告的来源与原样片不符，请管理员核查原操作，请勿重新生成',
};

// Accumulate facts only from a response already bound to this operation.
// Once all n identities are known, a short later response cannot substitute a
// different resource. Explicit later failures revoke provisional successes.
function observeOutputResources(job, resources) {
  if (!Array.isArray(resources)) return false;
  const successful = new Set(job.observedSuccessIds || []);
  const members = new Set([...(job.observedResourceIds || []), ...successful]);
  const states = new Map(job.observedResourceStates || [...members].map(id => [id, successful.has(id) ? 'succeeded' : 'pending']));
  const seen = new Map();
  for (const output of resources) {
    if (!output || typeof output !== 'object') return false;
    const {resourceId, state} = output;
    if (resourceId == null && state !== 'succeeded') continue; // legacy pending placeholder
    if (typeof resourceId !== 'string' || !ID.test(resourceId) ||
        (seen.has(resourceId) && seen.get(resourceId) !== state)) return false;
    seen.set(resourceId, state);
    members.add(resourceId);
    if (members.size > job.request.n) return false;
    if (state !== undefined) states.set(resourceId, state);
    else if (!states.has(resourceId)) states.set(resourceId, 'pending');
    if (state === 'succeeded') successful.add(resourceId);
    else if (state !== undefined) successful.delete(resourceId);
  }
  job.observedResourceIds = [...members];
  job.observedResourceStates = [...states];
  job.observedSuccessIds = job.observedResourceIds.filter(id => successful.has(id));
  return true;
}

function matchesVideoDraft(node, job, request) {
  if (node?.node) {
    if (node.nodeId !== job.nodeId || node.result != null && node.result !== 'FOUND') return false;
    node = node.node;
  }
  const g=node?.generation,r=request,refs=g?.references??[];
  return node?.nodeId===job.nodeId && g && g.model===r.model && g.mode===r.mode && g.prompt===r.prompt &&
    g.ratio===r.ratio && g.resolution===r.resolution && g.durationSeconds===r.seconds && g.outputCount===r.n &&
    Array.isArray(refs) && refs.every(ref=>ref && typeof ref.id==='string') &&
    isDeepStrictEqual(refs.map(ref=>ref.id),(job.inputs||[]).map(input=>input.resourceId));
}
function equal(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validateConfig(input) {
  const c = { host: '127.0.0.1', port: 8787, profile: 'default', region: 'cn',
    storage: 'file', migrateLegacy: false, pollMs: 1000, pollIntervalMs: 3000, catalogTTLms: 60000, commandTimeoutMs: 120000, maxQueue: 20, historyCacheSize: 100,
    maxConcurrent: 2, maxAdmissions: 2, maxInputBytes: 64 * 1024 * 1024, maxMediaBytes: 512 * 1024 * 1024, mediaTTL: 3600, maxQueueWaitSeconds: 1800, leaseSeconds: 300, submitWorkers: 6, pollWorkers: 4, downloadWorkers: 2, uploadWorkers: 4, inputPreparationWorkers: 4, unlimitedCredits: false, canvasTaskLimit: 0, canvasChannel: '', ...input };
  if (!['file','database'].includes(c.storage) || typeof c.migrateLegacy!=='boolean') fail('invalid storage configuration');
  if (c.storage==='database' && !c.databaseUrl) fail('database storage requires DREAMINA_DATABASE_URL');
  if (![0,5].includes(c.canvasTaskLimit)) fail('invalid config canvasTaskLimit (0 or 5)');
  if (!['','A','B'].includes(c.canvasChannel)) fail('invalid config canvasChannel (A or B)');
  if (c.gatewayChannelId !== undefined && !integer(c.gatewayChannelId,1,2147483647)) fail('invalid config gatewayChannelId');
  if (typeof c.unlimitedCredits !== 'boolean') fail('invalid config unlimitedCredits');
  if (c.creditCostCnyPerCredit !== undefined && (typeof c.creditCostCnyPerCredit !== 'string' ||
      !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,12})?$/.test(c.creditCostCnyPerCredit) || Number(c.creditCostCnyPerCredit) <= 0)) fail('invalid config creditCostCnyPerCredit');
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
    ['maxQueueWaitSeconds', 1, 1800], ['leaseSeconds', 1, 300], ['submitWorkers', 1, 12], ['pollWorkers', 1, 8], ['downloadWorkers', 1, 4], ['uploadWorkers', 1, 4], ['inputPreparationWorkers', 1, 4], ['pollIntervalMs', 1000, 60000], ['catalogTTLms', 1000, 60000]]) {
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

function redactCreditToken(source, token) {
  const safe={...source};
  for(const key of ['code','message','request_id'])if(typeof safe[key]==='string')safe[key]=safe[key].replaceAll(token,'[redacted]');
  return safe;
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

// Read at explicit offsets so verification and a subsequent Range stream can
// share the same open file without advancing its implicit cursor.
async function mediaFileDigest(handle, size) {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(size, 256 * 1024));
  for (let position = 0; position < size;) {
    const {bytesRead} = await handle.read(buffer,0,Math.min(buffer.length,size-position),position);
    if (bytesRead === 0) return null;
    digest.update(buffer.subarray(0,bytesRead));
    position += bytesRead;
  }
  return digest.digest('hex');
}

function artifactFingerprint(info, sha256) {
  return [info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs,sha256].join(':');
}

async function verifiedMediaFile(handle, record, cache) {
  if (!Number.isSafeInteger(record.size) || record.size <= 0 || !/^[a-f0-9]{64}$/.test(record.sha256)) return false;
  const info = await handle.stat({bigint:true});
  if (!info.isFile() || info.size !== BigInt(record.size)) return false;
  const stamp = artifactFingerprint(info, record.sha256);
  if (cache.get(record) === stamp) return true;
  if (await mediaFileDigest(handle,record.size) !== record.sha256) return false;
  if (artifactFingerprint(await handle.stat({bigint:true}),record.sha256) !== stamp) return false;
  cache.set(record,stamp);
  return true;
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
        legacyProjectId:config.projectId,jobs:canvasJobs,store:bridge.store,canvasChannel:config.canvasChannel});
      return bridge;
    } catch (error) { await bridge.close(); throw error; }
  }

  constructor(config, cli) {
    this.config = config;
    const invokeCLI = cli || (args => runCLI(config.cli, ['--format=json', '--non-interactive', '--profile=' + config.profile, '--region=' + config.region, ...args], config.commandTimeoutMs));
    this.cli = args => {this.store?.assertHealthy();return invokeCLI(args);};
    this.contextKey = hash(JSON.stringify([config.profile, config.region, config.userId, config.space, config.projectId, config.models]));
    this.jobs = new Map(); this.history = new Map(); this.storedJobs = 0; this.admissions = Promise.resolve();
    this.pendingAdmissions = new Map(); this.preparingUnits = 0;
    this.activePreparations = 0; this.preparationWaiters = []; this.readInput = readReference;
    this.lastQueuedId = null; this.lastPolledId = null; this.lastDownloadedId = null;
    this.nextPoll = new Map(); this.nextDownload = new Map();
    this.catalogCheckedAt = null; this.catalogRefresh = null; this.contextCheck = null;
    this.inFlight = new Map();
    this.verifiedMedia = new WeakMap();
    this.receiptChecks = new Map();
    this.promptLimits = new Map();
    this.activeUploads = 0;
    this.uploadWaiters = [];
    this.videoCatalog = new Map();
    this.leases = new Map(); // Deliberately not restored after downtime.
    this.gatewayLeases = new Map(); this.gatewayBlocks = new Set(); this.dispatchChecks = new Set();
    this.gatewayTaskReader = null; this.gatewayConfirmation = null;
    this.nextGatewayConfirmation = 0; this.gatewayConfirmationFailures = 0;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.admissions;
    await Promise.allSettled([...this.pendingAdmissions.values()].map(pending => pending.promise));
    if(this.gatewayConfirmation)await this.gatewayConfirmation;
    if(this.gatewayTaskReader?.close)await this.gatewayTaskReader.close();
    if(this.mediaCleanup)await this.mediaCleanup.catch(()=>{});
    await Promise.allSettled([...this.inFlight.values()].map(work => work.promise));
    await Promise.allSettled([...this.receiptChecks.values()]);
    if (this.store) await this.store.close();
    if (this.lock) { await this.lock.close(); await unlink(join(this.config.dataDir, '.lock')).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }

  cleanupMedia() {
    if(this.mediaCleanup)return this.mediaCleanup;
    if(this.closed)return Promise.resolve({deleted_files:0,deleted_bytes:0,errors:0});
    this.mediaCleanup=removeExpiredMedia({dataDir:this.config.dataDir,
      loadJobs:async ids=>{
        const jobs=new Map(ids.filter(id=>this.jobs.has(id)).map(id=>[id,this.jobs.get(id)]));
        const missing=ids.filter(id=>!jobs.has(id));
        if(this.store){for(const job of await this.store.getMany(missing))jobs.set(job.id,job);}
        else for(const id of missing){
          try{const job=JSON.parse(await readFile(join(this.config.dataDir,id+'.json'),'utf8'));if(job.id===id&&job.context===this.contextKey)jobs.set(id,job);}
          catch(error){if(error.code!=='ENOENT')throw error;}
        }
        return jobs;
      },isBusy:id=>this.closed||this.inFlight.has(id),
      onError:error=>this.onEvent?.({event:'dreamina_cleanup_error',...error})
    }).finally(()=>{this.mediaCleanup=undefined;});
    return this.mediaCleanup;
  }

  async verifyCurrentSpace() {
    const space = await this.cli(['space', 'current']);
    const issue = consumptionSubjectError({...space, teamId: space?.team?.teamId}, this.config);
    if (issue) fail(issue === 'credit_subject_mismatch' ? 'context_mismatch' : 'context_unverified', 503, issue);
  }

  async checkContext() {
    // Share only simultaneous checks. Never cache successful identity checks:
    // a later workflow must detect account/space drift before a paid mutation.
    if (!this.contextCheck) {
      this.contextCheck = this.verifyCurrentSpace().finally(() => { this.contextCheck = null; });
    }
    await this.contextCheck;
  }

  async holdForContext(job, error) {
    const mismatch = error.code === 'credit_subject_mismatch' || error.cliError?.code === 'cli.canvas_space_mismatch';
    if (job.status === 'queued' && mismatch) {
      // No paid command has run. The customer can be refunded immediately.
      this.failed(job, 'credit_subject_mismatch', {code:error.cliError?.code});
    } else {
      // Submitted work must stay attached to its original account. Checking
      // identity is not a failed attempt to download any individual resource.
      job.attention = mismatch ? 'context_mismatch' : 'context_unverified';
      this.recordIssue(job, 'context', error.cliError, job.attention);
      job.diagnostics.next_context_check_at_ms = Date.now() + 60000;
    }
    await this.save(job);
  }

  async prepareDispatch(job) {
    // No paid call has begun. Keep the durable barrier write and final
    // identity read eligible for batch confirmation
    // so a slow CLI context lookup cannot repeatedly exhaust its short lease.
    this.dispatchChecks.add(job.id);
    try {
      job.status = 'in_progress';
      this.recordTime(job, 'submit_started_at_ms');
      await this.save(job);
      try { await this.verifyCurrentSpace(); }
      catch (error) {
        job.status = 'queued'; // this invocation has certainly not dispatched
        await this.holdForContext(job, error);
        return false;
      }
      if (this.closed || !this.dispatchAllowed(job) ||
          Date.now() >= (job.created_at + this.config.maxQueueWaitSeconds) * 1000) {
        job.status = 'queued'; job.attention = 'awaiting_gateway'; await this.save(job);
        return false;
      }
      return true;
    } finally { this.dispatchChecks.delete(job.id); }
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

  submit(body, key, waitForGateway = false, billing) {
    // Only admission bookkeeping is serialized. Never hold this lock while
    // waiting for input media: one slow origin must not stall unrelated POSTs.
    const admission = this.admissions.then(async () => {
      if (body && typeof body === 'object' &&
          (body.mode === 'promote' || Object.hasOwn(body, 'source_job_id') || Object.hasOwn(body, 'draft_task_id'))) {
        fail(PROMOTION_UNSUPPORTED, 400, 'promotion_not_supported');
      }
      if (this.closed) fail('bridge closed', 503);
      this.store?.assertHealthy();
      const source = body?.mode==='promote' ? await this.loadJob(body.source_job_id) : undefined;
      const request = this.validate(body,source);
      if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key)) fail('invalid Idempotency-Key');
      if (billing !== undefined) {
        if (!billing || Array.isArray(billing) || Object.keys(billing).some(k=>!['version','request_id','reserved_credits'].includes(k)) ||
            ![1,2].includes(billing.version) || (billing.version===2 && request.mode==='promote') || billing.request_id!==key || !integer(billing.reserved_credits,1,1000000000) || !Object.hasOwn(VIDEO_MODELS,request.model)) fail('invalid gateway billing reservation');
        billing={version:billing.version,request_id:key,reserved_credits:billing.reserved_credits};
      }
      const keyHash = hash(key), digest = hash(JSON.stringify(billing ? {request,billing} : request));
      const pending = this.pendingAdmissions.get(keyHash);
      if (pending) {
        if (pending.digest !== digest) fail('idempotency conflict', 409);
        return {result: pending.promise};
      }
      const existingId = await this.findJobKey(keyHash);
      const existing = existingId ? await this.loadJob(existingId,true) : undefined;
      if (existing) {
        if (existing.digest !== digest) fail('idempotency conflict', 409);
        // Retrying POST proves receipt by the bridge, not host persistence.
        return {result: waitForGateway ? this.verifyDelivery(existing) : this.observe(existing.id,existing)};
      }
      if (request.n > this.config.maxConcurrent) fail('requested count exceeds generation capacity', 429);
      const activeUnits = [...this.jobs.values()].filter(j => !terminal(j)).reduce((n,j) => n + j.request.n, 0);
      if (activeUnits + this.preparingUnits + request.n > this.config.maxQueue) fail('Active video queue is full. Please retry after existing tasks finish.', 429, 'active_queue_full');
      const job = { id: randomUUID(), key: keyHash, digest, context: this.contextKey, request, ...(billing?{billing}:{}),
        ...(waitForGateway && /^task_[A-Za-z0-9_-]{1,160}$/.test(key) ? {gatewayTaskId:key} : {}),
        ...(request.kind === 'video' ? {billingMode: billing ? 'credits' : 'legacy_seconds'} : {}),
        nodeId: 'node_' + Array.from(randomBytes(10), b => '0123456789abcdefghjkmnpqrstvwxyz'[b & 31]).join(''), updateId: randomUUID(), submitId: randomUUID(),
        status: 'queued', created_at: Math.floor(Date.now() / 1000), timings: {admitted_at_ms: Date.now()}, files: [], inputs: [] };
      const reservation = {digest, units: request.n};
      this.preparingUnits += reservation.units;
      this.pendingAdmissions.set(keyHash,reservation);
      reservation.promise = this.prepareAdmission(job,source,waitForGateway,reservation).finally(() => {
        this.preparingUnits -= reservation.units;
        this.pendingAdmissions.delete(keyHash);
      });
      // Wrapping the promise prevents the admission lock from awaiting I/O.
      return {result: reservation.promise};
    });
    this.admissions = admission.then(() => {}, () => {});
    return admission.then(({result}) => result);
  }

  async prepareAdmission(job, source, waitForGateway, reservation) {
    const request = job.request;
    let saving=false, preparing=false;
    try {
      if (request.references?.length) {
        if (this.activePreparations < this.config.inputPreparationWorkers) this.activePreparations++;
        else await new Promise(resolve => this.preparationWaiters.push(resolve));
        preparing=true;
        if (this.closed) fail('bridge closed',503);
        this.recordTime(job,'input_preparation_started_at_ms');
        let remaining = this.config.maxInputBytes;
        const inputDeadline = AbortSignal.timeout(30000);
        for (const ref of request.references) {
          if (this.closed) fail('bridge closed',503);
          let media;
          try { media = await this.readInput(ref,remaining,inputDeadline); } catch { fail('invalid or unavailable reference media'); }
          if (this.closed) fail('bridge closed',503);
          remaining -= media.bytes.length;
          const resourceId = randomUUID(), filename = job.id + '-input-' + job.inputs.length + '.' + media.extension;
          // Track before writing so a failed write also removes the partial file.
          job.inputs.push({resourceId,filename,type:ref.type,sha256:hash(media.bytes),uploaded:false});
          const file = await open(join(this.config.dataDir,filename),'wx',0o600);
          try { await file.writeFile(media.bytes); await file.sync(); } finally { await file.close(); }
        }
        this.recordTime(job,'input_preparation_completed_at_ms');
      }
      // Signed URLs and base64 never enter durable snapshots.
      if (request.references) request.references = job.inputs.map(input => ({type:input.type}));
      const commit = this.admissions.then(async () => {
        if (this.closed) fail('bridge closed',503);
        this.store?.assertHealthy();
        const reserved = this.canvases.lookup(job);
        if (reserved) {
          job.projectId = reserved.projectId;
          job.canvasName = reserved.name;
        } else if (this.config.canvasTaskLimit === 5) {
          const canvas = await this.canvases.reserve(job,source ? this.projectId(source) : undefined);
          job.projectId = canvas.projectId;
          job.canvasName = canvas.name;
        } else {
          job.projectId = source ? this.projectId(source) : this.config.projectId;
          if (job.projectId !== this.config.projectId) await this.canvases.reserve(job,job.projectId);
        }
        saving=true;
        await this.save(job);
        // The durable job now holds this capacity; do not double count it.
        this.preparingUnits -= reservation.units; reservation.units=0;
        this.storedJobs++;
        await this.indexJob(job);
        if (!waitForGateway) this.leases.set(job.id,Date.now()+this.config.leaseSeconds*1000);
        return this.get(job.id);
      });
      this.admissions = commit.then(() => {}, () => {});
      return await commit;
    } catch(error) {
      // A lost commit response may mean the snapshot is already durable.
      if(!saving)for(const input of job.inputs)await unlink(join(this.config.dataDir,input.filename)).catch(()=>{});
      throw error;
    } finally {
      if(preparing) {
        const next=this.preparationWaiters.shift();
        if(next)next();else this.activePreparations--;
      }
    }
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
    this.nextPoll.delete(job.id);this.nextDownload.delete(job.id);this.leases.delete(job.id);this.gatewayLeases.delete(job.id);this.gatewayBlocks.delete(job.id);
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
    let billing = j.billing;
    if (billing && j.upstreamCreditQuote) {
      const credits = j.upstreamCreditQuote.credits;
      // Existing jobs also have acceptance timings or completed downloads.
      // Only an accepted operation can attach billable credits to the receipt.
      const accepted = !j.runConflict && (j.timings?.accepted_at_ms !== undefined ||
        j.timings?.accepted_observed_at_ms !== undefined || (j.status === 'completed' && j.files.length > 0));
      const status = accepted ? 'accepted' : j.timings?.credit_confirmed_at_ms !== undefined ? 'confirmed' : 'quoted';
      billing = {...billing, quoted_credits: credits, quote_status: status};
      if (accepted) Object.assign(billing, {basis: 'accepted_quote', credits});
    }
    return { id: j.id, object: j.request.kind === 'video' ? 'video' : 'image', model: j.request.model,
      status: j.status, created_at: j.created_at, completed_at: j.completed_at,
      ...(hasCreditBilling(j) || j.terminalOperationState !== undefined ? {terminal_proof: isTerminalOperation(j.terminalOperationState)} : {}),
      ...(j.billingResolutionExpiresAt ? {billing_unresolved: !j.upstreamCreditQuote, billing_resolution_expires_at: j.billingResolutionExpiresAt} : {}),
      // Historical jobs have no mode field. A saved credit contract always wins;
      // new credit jobs retain their identity even if their contract is damaged.
      ...(j.request.kind === 'video' ? {billing_mode: Object.hasOwn(j,'billing') ? 'credits' : j.billingMode ?? 'legacy_seconds'} : {}),
      ...(billing ? {billing} : {}),
      ...mediaDeadlines(j),
      ...(mediaDeadlines(j).content_expires_at?{content_expired:Date.now()>=mediaDeadlines(j).content_expires_at*1000}:{}),
      n: j.request.n, mode:j.request.mode, ratio:j.request.ratio, resolution:j.request.resolution,
      video_count:j.request.kind === 'video' && j.status === 'completed' ? j.files.length : 0,
      reference_video:(j.request.references || []).some(r=>r.type==='video'),
      ...(j.request.model === 'seedance_2.5_draft' ? {warning:'样片最长存储 7 天，具体期限以即梦服务端为准；' + PROMOTION_UNSUPPORTED} : {}),
      seconds: j.request.seconds, image_count: j.status === 'completed' ? j.files.length : j.request.n,
      timings: j.timings ? {...j.timings} : undefined,
      phase: terminal(j) ? j.status : j.attention ? 'needs_attention' : j.downloadResources ? 'downloading' : j.status,
      recovery: this.recovery(j), diagnostics: j.diagnostics ? structuredClone(j.diagnostics) : undefined,
      progress: j.status === 'completed' ? 100 : 0, attention: j.attention, error: j.error,
      data: j.status === 'completed' && j.request.kind === 'image' ? j.files.map((f, i) => ({ url: this.mediaURL(j.id, i) })) : [] };
  }

  recovery(job) {
    if (job.runConflict && Object.hasOwn(runConflictMessages, job.runConflict)) {
      return {action: job.status === 'failed' ? 'review_failure' : 'manual_review',
        message: runConflictMessages[job.runConflict], automatic_resubmit: false};
    }
    let action='wait', message='正在处理，请勿重复提交';
    if(job.status==='completed'){action='completed';message='生成完成';}
    else if(job.status==='failed') {
      action='review_failure';message='任务失败，请核对原因后再提交';
      if(String(job.error?.upstream_code)==='20005'){action='add_credits_then_resubmit';message='请补充当前成员积分后重新提交';}
      if(['20100','20110','20115'].includes(String(job.error?.upstream_code))){action='fix_input_then_resubmit';message='请修改输入内容后重新提交，不自动重试';}
      if(job.error?.code==='queue_expired'){action='resubmit';message='本地排队超时，可重新提交';}
      if(job.error?.code==='download_failed'){action='review_failure';message='原生成资源已保留，请联系管理员恢复下载，请勿重新生成';}
    } else if (['context_mismatch','context_unverified'].includes(job.attention)) {
      action = 'manual_review'; message = '请管理员核对原渠道的 CLI 账号和空间，系统将按原任务重查，请勿重新生成';
    } else if(job.downloadResources){action='retry_download';message='正在获取生成结果，请勿重新生成';}
    else if(['manual_recovery_required','submission_uncertain','operation_mismatch','resources_missing','resource_count_mismatch','invalid_resource_id'].includes(job.attention)){
      action='manual_review';message='提交状态待核查，请勿重复提交';
    } else if(job.attention){action='retry_query';message='状态查询或准备异常，正在重查，请勿重复提交';}
    return {action,message,automatic_resubmit:false};
  }

  // A paid command may already have run. Carry the conflict across restarts
  // and only inspect that operation. No later poll may turn it into a delivery.
  flagRunConflict(job, code) {
    job.runConflict = code;
    job.attention = 'run_conflict';
    this.recordIssue(job, 'submit', {code, message: runConflictMessages[code]});
    job.diagnostics.next_poll_at_ms = Date.now() + 60000;
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

  resumeUnverifiedCompletion(job) {
    if (!hasCreditBilling(job) || job.status !== 'completed' || !UUID.test(job.submitId || '')) return false;
    const missingQuote = job.billing && job.request.mode === 'promote' && !job.upstreamCreditQuote;
    if (isTerminalOperation(job.terminalOperationState) && !missingQuote) return false;
    if (missingQuote) job.billingResolutionExpiresAt ||= mediaDeadlines(job).content_expires_at ||
      Math.floor(Date.now() / 1000) + MEDIA_RETENTION_SECONDS;
    job.deliveryExpiresAt ||= mediaDeadlines(job).content_expires_at;
    job.status = 'in_progress';
    job.attention = missingQuote ? 'billing_quote_pending' : 'terminal_verification_pending';
    job.unverifiedDownloadResources = job.downloadResources || job.files.map(file => file.resourceId);
    delete job.downloadResources;
    delete job.observedResourceIds;
    delete job.observedResourceStates;
    delete job.observedSuccessIds;
    return true;
  }

  async observe(id, job = this.jobs.get(id)) {
    if (this.closed) fail('bridge closed', 503);
    if (!job) fail('job not found', 404);
    if (job.status === 'queued') this.leases.set(id, Date.now() + this.config.leaseSeconds * 1000);
    if (this.receiptChecks.has(id)) return this.receiptChecks.get(id);
    const check = this.verifyDelivery(job).finally(() => this.receiptChecks.delete(id));
    this.receiptChecks.set(id,check);
    return check;
  }

  async verifyDelivery(job) {
    const id = job.id;
    // Do not expose an in-memory completion before the worker's durable save.
    if (job.status === 'completed' && this.inFlight.has(id)) await this.inFlight.get(id).promise;
    if (this.resumeUnverifiedCompletion(job)) await this.save(job);
    if (job.status !== 'completed') return this.get(id,job);
    // Legacy completions predate terminal receipts and checksums. Preserve
    // their original result without issuing new credit delivery evidence.
    if (!hasCreditBilling(job)) return this.get(id,job);
    const expires = mediaDeadlines(job).content_expires_at;
    if (expires && Date.now() >= expires * 1000) return {...this.get(id,job),delivery_verified:false};
    // Historical records without a submission identity remain downloadable,
    // but cannot establish new terminal billing evidence.
    if (!UUID.test(job.submitId || '')) return this.get(id,job);
    const files = job.files;
    const snapshot = files.slice();
    let intact = snapshot.length > 0;
    for (const file of snapshot) {
      const handle = await open(join(this.config.dataDir,file.filename),constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
      if (!handle) { intact = false; break; }
      try { if (!await verifiedMediaFile(handle,file,this.verifiedMedia).catch(() => false)) intact = false; }
      finally { await handle.close(); }
      if (!intact) break;
    }
    if (job.status !== 'completed' || job.files !== files || files.length !== snapshot.length ||
        snapshot.some((file,index) => files[index] !== file)) return this.get(id,job);
    if (expires && Date.now() >= expires * 1000) return {...this.get(id,job),delivery_verified:false};
    if (intact) return {...this.get(id,job),delivery_verified:true};
    // Recovery downloads the already bound resources; it never submits again.
    // Preserve the original deadline so repair cannot extend retention forever.
    job.deliveryExpiresAt ||= expires || Math.floor(Date.now() / 1000) + MEDIA_RETENTION_SECONDS;
    job.status = 'in_progress';
    job.attention = 'artifact_integrity_failed';
    job.downloadResources ||= job.files.map(file => file.resourceId);
    job.downloadAttempts = job.downloadResources.map(() => 0);
    this.recordIssue(job,'download',{code:'artifact_integrity_failed',message:'生成文件缺失或完整性校验失败，正在恢复原资源下载，请勿重新生成'});
    job.diagnostics.next_download_at_ms = 0;
    await this.save(job);
    return {...this.get(id,job),delivery_verified:false};
  }

  mediaURL(id, index) {
    const expires = Math.floor(Date.now() / 1000) + this.config.mediaTTL;
    const path = '/v1/jobs/' + id + '/content/' + index;
    return this.config.publicUrl + path + '?expires=' + expires + '&sig=' + this.sign(path, expires);
  }

  sign(path, expires) { return createHmac('sha256', this.config.token).update('media\n' + path + '\n' + expires).digest('hex'); }

  dispatchAllowed(job) {
    return !this.closed && !terminal(job) && !this.gatewayBlocks.has(job.id) &&
      Math.max(this.leases.get(job.id) || 0, this.gatewayLeases.get(job.id) || 0) > Date.now();
  }

  confirmGatewayTasks() {
    if (this.gatewayConfirmation) return this.gatewayConfirmation;
    if (this.closed || !this.gatewayTaskReader || Date.now() < this.nextGatewayConfirmation) return Promise.resolve();
    const started = Date.now();
    this.nextGatewayConfirmation = started + 1000;
    const candidates = [];
    for (const job of this.jobs.values()) {
      if ((job.status !== 'queued' && !this.dispatchChecks.has(job.id)) ||
          started >= (job.created_at + this.config.maxQueueWaitSeconds) * 1000) continue;
      const taskId = job.gatewayTaskId || job.billing?.request_id;
      if (typeof taskId !== 'string' || !/^task_[A-Za-z0-9_-]{1,160}$/.test(taskId) || hash(taskId) !== job.key) continue;
      candidates.push({id: job.id, taskId});
    }
    if (!candidates.length) return Promise.resolve();
    // maxQueue bounds this set at 200. This is one indexed host read, never a
    // scan of historical jobs or one query/timer per pending task.
    const confirmation = (async () => {
      let matches;
      try { matches = await this.gatewayTaskReader.inspect(candidates); }
      catch {
        this.gatewayConfirmationFailures = Math.min(this.gatewayConfirmationFailures + 1, 6);
        this.nextGatewayConfirmation = Date.now() + Math.min(30000, 1000 * 2 ** (this.gatewayConfirmationFailures - 1));
        this.onEvent?.({event: 'dreamina_gateway_confirmation_unavailable', retry_at_ms: this.nextGatewayConfirmation});
        return; // existing authenticated host polls can still grant their lease
      }
      if (this.closed) return;
      this.gatewayConfirmationFailures = 0;
      for (const {id, taskId} of candidates) {
        const job = this.jobs.get(id);
        if (!job || (job.status !== 'queued' && !this.dispatchChecks.has(id)) || terminal(job) || hash(taskId) !== job.key) continue;
        const state = matches.get(id);
        if (state !== 'active') {
          this.gatewayLeases.delete(id);
          if (state === 'terminal' || state === 'mismatch') {
            this.gatewayBlocks.add(id);
            this.leases.delete(id); // do not let an older GET override a known host rejection
          }
          continue;
        }
        // Freshness is measured from query start, not response arrival. Long
        // preparation workflows are reconfirmed in subsequent batches.
        if (Date.now() >= started + 5000) continue;
        this.gatewayBlocks.delete(id);
        if (job.timings?.gateway_confirmed_at_ms === undefined) {
          this.recordTime(job, 'gateway_confirmed_at_ms');
          await this.save(job);
        }
        if (!this.closed && !terminal(job) && (job.status === 'queued' || this.dispatchChecks.has(id))) this.gatewayLeases.set(id, started + 5000);
      }
    })();
    this.gatewayConfirmation = confirmation.finally(() => { this.gatewayConfirmation = null; });
    return this.gatewayConfirmation;
  }

  tick() {
    const confirmation = this.confirmGatewayTasks();
    // Existing polls/downloads must keep moving while the optional host read
    // is pending. A confirmed batch wakes free submission workers immediately.
    const scheduled = this.dispatchReadyJobs();
    if (!this.gatewayConfirmation) return scheduled;
    return Promise.all([scheduled, confirmation.then(() => this.dispatchReadyJobs())]).then(() => {});
  }

  dispatchReadyJobs() {
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
        if (lane === 'download' && Date.now() < Math.max(this.nextDownload.get(job.id) || 0, job.diagnostics?.next_download_at_ms || 0)) continue;
        const expired = job.status === 'queued' && Date.now() >= (job.created_at + this.config.maxQueueWaitSeconds) * 1000;
        if (!expired && Date.now() < (job.diagnostics?.next_context_check_at_ms || 0)) continue;
        const projectId = this.projectId(job);
        if (lane === 'submit' && !expired) {
          if (!this.dispatchAllowed(job) || occupied + job.request.n > this.config.maxConcurrent || busyCanvases.has(projectId)) continue;
          occupied += job.request.n;
          busyCanvases.add(projectId);
        }
        available--; this[cursor] = job.id;
        const work = {lane, projectId};
        this.inFlight.set(job.id, work);
        work.promise = Promise.resolve().then(async () => {
          if (expired) {
            if (job.attention === 'context_mismatch') this.failed(job, 'credit_subject_mismatch');
            else if (job.attention === 'context_unverified') {
              const last = job.diagnostics?.last_error;
              this.failed(job, 'credit_subject_unverified',
                last?.code !== 'context_unverified' ? {code:last?.code, request_id:last?.request_id} : {});
            } else this.failed(job, 'queue_expired');
            await this.save(job);
          } else await this.processJob(job);
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

  async uploadReference(job, input, saveCheckpoint) {
    // Share one budget across all submit workers; release only after the
    // resource identity and upload checkpoint have been durably saved.
    if (this.activeUploads < this.config.uploadWorkers) this.activeUploads++;
    else await new Promise(resolve => this.uploadWaiters.push(resolve));
    try {
      if (this.closed) return;
      const path = join(this.config.dataDir, input.filename);
      if (hash(await readFile(path)) !== input.sha256) fail('input checksum mismatch');
      const result = await this.cli(['resource','upload','--file='+path,'--type='+input.type,'--project-id='+this.projectId(job),'--resource-id='+input.resourceId]);
      if (result.resourceId !== input.resourceId || result.mediaType !== input.type) fail('input upload mismatch');
      input.uploaded = true;
      await saveCheckpoint();
    } finally {
      const next = this.uploadWaiters.shift();
      if (next) next();
      else this.activeUploads--;
    }
  }

  async uploadReferences(job) {
    const inputs = job.inputs || [];
    let cursor = 0, failure;
    let checkpoints = Promise.resolve();
    const saveCheckpoint = () => {
      const saved = checkpoints.then(() => this.save(job));
      checkpoints = saved.catch(() => {});
      return saved;
    };
    // Keep the array order stable even when individual uploads finish out of
    // order. Drain started work on failure so a retry cannot overlap it.
    await Promise.all(Array.from({length: Math.min(inputs.length, this.config.uploadWorkers)}, async () => {
      while (!this.closed && !failure && cursor < inputs.length) {
        const input = inputs[cursor++];
        if (input.uploaded) continue;
        try { await this.uploadReference(job, input, saveCheckpoint); }
        catch (error) { failure ||= error; }
      }
    }));
    if (failure) throw failure;
  }

  creditQuote(job, credits, stage, draftVersion, nodeId = job.nodeId) {
    if (!integer(credits,0,1000000000)) return undefined;
    const r=job.request;
    return {source:'dreamina_canvas_cli',credits,quoted_at_ms:Date.now(),quote_stage:stage,
      ...(integer(draftVersion,0,Number.MAX_SAFE_INTEGER)?{draft_version:draftVersion}:{}),
      ...(typeof nodeId==='string' && /^node_[A-Za-z0-9_-]{1,128}$/.test(nodeId)?{node_id:nodeId}:{}),
      submit_id:job.submitId,model:r.model,mode:r.mode,resolution:r.resolution,ratio:r.ratio,seconds:r.seconds,count:r.n,
      reference_types:(r.references||[]).map(ref=>ref.type),
      ...(this.config.creditCostCnyPerCredit?{cost_cny_per_credit:this.config.creditCostCnyPerCredit}:{})};
  }

  creditQuoteHeader(job) {
    if(!job.upstreamCreditQuote)return undefined;
    const encoded=Buffer.from(JSON.stringify(job.upstreamCreditQuote)).toString('base64');
    // Audit metadata must never turn a valid task status into a query error.
    if(encoded.length>4096)return undefined;
    return encoded;
  }

  async submitQuotedVideo(job) {
    const configured = this.config.models[job.request.model];
    const r = Object.hasOwn(VIDEO_MODELS, job.request.model) ? job.request :
      {...job.request, model: configured.model, mode: 't2v', ratio: configured.ratio, resolution: configured.resolution};
    const project='--project-id='+this.projectId(job), node='--node-id='+job.nodeId;
    const preexistingSavedDraft=job.draftSaved===true;
    if (!job.draftSaved) {
      // A pure save is safe to recover, but inspect an uncertain save before
      // replaying its original identity. Never use this path after node run.
      if (job.draftSaveAttempted) {
        let shown;
        try { shown=await this.cli(['node','show',project,node]); }
        catch(error){this.failed(job,'draft_save_unavailable',error.cliError);await this.save(job);return;}
        const saved=Array.isArray(shown?.nodes)?shown.nodes.find(n=>n?.nodeId===job.nodeId):undefined;
        if(saved) {
          if(!matchesVideoDraft(saved,job,r)) {
            this.failed(job,'draft_changed');await this.save(job);return;
          }
          job.draftSaved=true;
        } else if(!Array.isArray(shown?.nodes)) {this.failed(job,'draft_save_unavailable');await this.save(job);return;}
      }
      if(!job.draftSaved) {
        job.draftSaveAttempted=true;
        await this.save(job);
        let saved;
        try { saved=await this.cli(['node','create','video',project,node,'--update-id='+job.updateId,
          '--mode='+r.mode,'--model='+r.model,'--prompt='+r.prompt,'--ratio='+r.ratio,'--resolution='+r.resolution,
          '--count='+r.n,'--duration='+r.seconds,'--title=Video generation',...(job.inputs||[]).map(input=>'--ref=res:'+input.resourceId)]); }
        catch(error) {
          // A save has no generation side effect. Keep its identity for a
          // readback on the next leased attempt, bounded by the queue window.
          job.attention='draft_save_pending';this.recordIssue(job,'save',error.cliError,'draft_save_pending');await this.save(job);return;
        }
        if(saved?.node && saved.node.nodeId!==job.nodeId || !integer(saved?.mutation?.savedDraftVersion,0,Number.MAX_SAFE_INTEGER)) {
          this.failed(job,'draft_save_unavailable');await this.save(job);return;
        }
        job.draftSaved=true;
      }
      await this.save(job);
    }
    if(preexistingSavedDraft || job.upstreamCreditQuote) {
      let shown;
      try {shown=await this.cli(['node','show',project,node]);}
      catch(error){this.failed(job,'draft_save_unavailable',error.cliError);await this.save(job);return;}
      if(!matchesVideoDraft(Array.isArray(shown?.nodes)?shown.nodes.find(n=>n?.nodeId===job.nodeId):undefined,job,r)) {
        this.failed(job,'draft_changed');await this.save(job);return;
      }
    }
    let quoted;
    try {quoted=await this.cli(['node','quote',project,node]);}
    catch(error){this.failed(job,'credit_quote_unavailable',error.cliError);await this.save(job);return;}
    const item=quoted?.items?.[0];
    if(!Array.isArray(quoted?.items) || quoted.items.length!==1 || !item || item.nodeId!==job.nodeId || item.error ||
        !integer(item.maxCredits,0,1000000000) || quoted.totalMaxCredits!==item.maxCredits ||
        !integer(quoted.draftVersion,0,Number.MAX_SAFE_INTEGER) || quoted.confirmable===false || item.generationDiff?.length) {
      this.failed(job,'credit_quote_unavailable',item?.error);await this.save(job);return;
    }
    const quoteSubjectError = consumptionSubjectError(quoted.consumptionSubject, this.config);
    if (quoteSubjectError) {
      this.failed(job, quoteSubjectError); await this.save(job); return;
    }
    if(job.upstreamCreditQuote && job.upstreamCreditQuote.credits!==item.maxCredits) {
      this.failed(job,'credit_quote_changed');await this.save(job);return;
    }
    job.upstreamCreditQuote ||= this.creditQuote(job,item.maxCredits,'before_generation',quoted.draftVersion);
    // Storage is a barrier: a write error propagates and stops the scheduler.
    // Never authorize a run that cannot be recovered with this quote.
    await this.save(job);
    // v1 is a hard ceiling; v2 is a usage estimate settled by the stock host.
    // The operator's upstream spending policy below remains authoritative.
    if(job.billing?.version===1 && item.maxCredits>job.billing.reserved_credits) {
      this.failed(job,'credit_reservation_exceeded');await this.save(job);return;
    }
    if(!this.config.unlimitedCredits && item.maxCredits>configured.maxCredits) {
      this.failed(job,'credit_approval_required');await this.save(job);return;
    }
    if(this.closed || !this.dispatchAllowed(job) || Date.now()>=(job.created_at+this.config.maxQueueWaitSeconds)*1000) {
      job.attention='awaiting_gateway';await this.save(job);return;
    }
    let approval;
    try {approval=await this.cli(['node','confirm',project,node,'--credit-ceiling='+item.maxCredits]);}
    catch(error){this.failed(job,error.exitCode===10?'credit_approval_required':'credit_confirmation_unavailable',error.cliError);await this.save(job);return;}
    if(typeof approval?.creditConfirmationToken!=='string' || !approval.creditConfirmationToken || approval.creditConfirmationToken.length>16384 ||
        approval.creditCeiling!==item.maxCredits) {
      this.failed(job,'credit_confirmation_unavailable');await this.save(job);return;
    }
    const confirmedSubjectError = consumptionSubjectError(approval.consumptionSubject, this.config);
    if (confirmedSubjectError) {
      this.failed(job, confirmedSubjectError); await this.save(job); return;
    }
    this.recordTime(job, 'credit_confirmed_at_ms');
    if(this.closed || !this.dispatchAllowed(job) || Date.now()>=(job.created_at+this.config.maxQueueWaitSeconds)*1000) {
      job.attention='awaiting_gateway';await this.save(job);return;
    }
    if (!(await this.prepareDispatch(job))) return;
    try {
      // The opaque token remains local to this invocation; it never enters
      // job data, errors, response headers, or emitted diagnostics.
      const result=await this.cli(['node','run',project,node,'--submit-id='+job.submitId,'--credit-token='+approval.creditConfirmationToken]);
      const submitted=result?.items?.[0];
      const matches = Array.isArray(result?.items) && result.items.length === 1 &&
        submitted?.nodeId === job.nodeId && submitted?.submitId === job.submitId;
      const state = matches ? String(submitted.state).toLowerCase() : '';
      if (state === 'rejected') {
        this.failed(job, 'submission_rejected', redactCreditToken(upstreamError([submitted]), approval.creditConfirmationToken));
      } else {
        if (['accepted', 'completed', 'in_progress'].includes(state)) this.recordTime(job, 'accepted_at_ms');
        else job.attention = 'submission_uncertain';
        // The CLI may omit the run subject. A reported conflicting subject or
        // a change to the saved generation plan invalidates its agreed pricing.
        if (matches && result?.consumptionSubject != null && consumptionSubjectError(result.consumptionSubject, this.config)) {
          this.flagRunConflict(job, 'run_subject_mismatch');
        } else if (matches && submitted.generationDiff != null && (!Array.isArray(submitted.generationDiff) ||
            submitted.generationDiff.some(diff => !diff || typeof diff.to !== 'string' || diff.from !== diff.to))) {
          this.flagRunConflict(job, 'run_generation_changed');
        } else if (['accepted','completed','in_progress'].includes(state) && submitted.resources != null &&
            !observeOutputResources(job, submitted.resources)) {
          this.flagRunConflict(job, 'run_resource_mismatch');
        }
      }
    } catch(error) {
      const publicError=redactCreditToken(error.cliError,approval.creditConfirmationToken);
      if(error.exitCode===10)this.failed(job,'credit_approval_required');
      else if(['20005','20100','20110','20115'].includes(String(publicError.code)))this.failed(job,'submission_rejected',publicError);
      else {job.attention='submission_uncertain';this.recordIssue(job,'submit',publicError,'submission_uncertain');}
    }
    await this.save(job);
  }

  async processJob(job) {
    this.resumeUnverifiedCompletion(job);
    if (terminal(job)) return;
    if (job.billingResolutionExpiresAt && !job.upstreamCreditQuote && Date.now() >= job.billingResolutionExpiresAt * 1000) {
      this.failed(job,'billing_quote_unavailable'); await this.save(job); return;
    }
    if (job.deliveryExpiresAt && Date.now() >= job.deliveryExpiresAt * 1000) {
      this.failed(job,'artifact_expired'); await this.save(job); return;
    }
    if (job.status === 'queued') this.recordTime(job, 'preparation_started_at_ms');
    try { await this.checkContext(); }
    catch (error) { await this.holdForContext(job, error); return; }
    if (job.diagnostics?.next_context_check_at_ms) {
      delete job.diagnostics.next_context_check_at_ms;
      if (job.diagnostics.last_error?.stage === 'context') {
        job.diagnostics.last_error.resolved_at_ms = Date.now();
      }
    }
    if (this.closed) return;
    delete job.attention;
    if (job.downloadResources) {
      if (isTerminalOperation(job.terminalOperationState)) return this.downloadJob(job);
      // Pre-upgrade workers could checkpoint downloads while the operation
      // was still running. Revalidate once using the original submit ID.
      job.unverifiedDownloadResources = job.downloadResources;
      delete job.downloadResources;
      delete job.observedSuccessIds;
      delete job.observedResourceIds;
      delete job.observedResourceStates;
    }
    if (job.status === 'queued') {
      const source=job.request.mode==='promote' ? await this.loadJob(job.request.source_job_id,true) : undefined;
      this.recordTime(job, 'context_checked_at_ms');
      // A context check may itself take a long time. Re-check the start window
      // immediately before any command that can authorize a charge.
      if (Date.now() >= (job.created_at + this.config.maxQueueWaitSeconds) * 1000) {
        this.failed(job, 'queue_expired'); await this.save(job); return;
      }
      if (!this.dispatchAllowed(job)) { job.attention = 'awaiting_gateway'; await this.save(job); return; }
      try {
        await this.canvases.ensureCreated(this.projectId(job), canvas =>
          this.cli(['canvas','create',canvas.name,'--project-id='+canvas.projectId]));
      } catch { job.attention='canvas_creation_pending';await this.save(job);return; }
      this.recordTime(job, 'canvas_ready_at_ms');
      if (this.closed) return;
      if (Date.now() >= (job.created_at+this.config.maxQueueWaitSeconds)*1000 || !this.dispatchAllowed(job)) {
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
          await this.uploadReferences(job);
        } catch { job.attention='reference_upload_pending'; await this.save(job); return; }
        this.recordTime(job, 'references_ready_at_ms');
        // Preparation can take longer than the lease. Never generate for a
        // gateway that abandoned a request while it was downloading/uploading.
        if (Date.now() >= (job.created_at+this.config.maxQueueWaitSeconds)*1000 || !this.dispatchAllowed(job)) {
          job.attention='awaiting_gateway';await this.save(job);return;
        }
      }
      if (this.closed) return;
      if (job.request.kind === 'video' && job.request.mode !== 'promote') return this.submitQuotedVideo(job);
      // Promotion itself has no read-only quote API. Verify the original node's
      // consumption subject on its own canvas; its price does not price promotion.
      const project = this.projectId(job);
      let identityError;
      try {
        if (job.request.mode === 'promote') {
          if (!source || source.context !== job.context || this.projectId(source) !== project) {
            identityError = 'credit_subject_mismatch';
          } else {
            const result = await this.cli(['node', 'quote', '--project-id=' + project, '--node-id=' + source.nodeId]);
            if (result?.items?.length !== 1 || result.items[0]?.nodeId !== source.nodeId || result.items[0].error) {
              identityError = 'credit_subject_unverified';
            } else {
              identityError = consumptionSubjectError(result.consumptionSubject, this.config);
            }
          }
        } else {
          // Legacy image creation encapsulates quote and run. An explicit scoped
          // read verifies this canvas is accessible in the configured space.
          const result = await this.cli(['node', 'find', '--project-id=' + project, '--limit=1']);
          if (result?.projectId !== project) identityError = 'credit_subject_unverified';
        }
      } catch (error) {
        await this.holdForContext(job, error); return;
      }
      if (identityError) {
        this.failed(job, identityError); await this.save(job); return;
      }
      if (this.closed || Date.now() >= (job.created_at + this.config.maxQueueWaitSeconds) * 1000 ||
          !this.dispatchAllowed(job)) {
        job.attention = 'awaiting_gateway'; await this.save(job); return;
      }
      // Durable transition BEFORE any remote mutation. A crash from here on
      // only permits read-only recovery of this exact submit identity.
      const r = job.request, m = this.config.models[r.model];
      // Only the operator can approve uncapped spending. Client payloads cannot
      // override this policy; the gateway still reserves user quota first.
      const ceiling=job.billing ? Math.min(job.billing.reserved_credits,this.config.unlimitedCredits?job.billing.reserved_credits:m.maxCredits) : m.maxCredits;
      const creditApproval = this.config.unlimitedCredits && !job.billing ? '--yes' : '--credit-ceiling=' + ceiling;
      const args = r.mode === 'promote' ? ['node','promote','video-sample','--project-id='+this.projectId(job),
        '--node-id='+source.nodeId,'--submit-id='+job.submitId,'--resolution='+r.resolution,
        '--title=Video promotion',creditApproval] :
        ['node', 'create', 'image', '--project-id=' + project, '--node-id=' + job.nodeId,
        '--update-id=' + job.updateId, '--submit-id=' + job.submitId, '--mode=t2i', '--model=' + m.model,
        '--prompt=' + r.prompt, '--ratio=' + m.ratio, '--resolution=' + m.resolution,
        '--count=' + r.n, creditApproval, '--run'];
      if (!(await this.prepareDispatch(job))) return;
      try {
        const result = await this.cli(args);
        if (r.mode === 'promote') {
          // The CLI has no separate promotion quote command. This is a
          // post-submission quote, never a pre-generation or actual debit.
          if (result.submitId !== job.submitId) job.attention = 'submission_uncertain';
          else if (String(result.state).toLowerCase() === 'rejected') this.failed(job,'submission_rejected', result);
          else if (!['accepted','completed','in_progress'].includes(String(result.state).toLowerCase())) job.attention='submission_uncertain';
          // Only the matching accepted operation can supply billing evidence.
          // Later success of our original operation must never make a quote
          // from an unrelated or uncertain response payable.
          else {
            this.recordTime(job,'accepted_at_ms');
            if ((Object.hasOwn(result,'sourceNodeId') && result.sourceNodeId !== source.nodeId) ||
                (Object.hasOwn(result,'sourceResourceId') && result.sourceResourceId !== source.files[0].resourceId)) {
              this.flagRunConflict(job,'promotion_source_mismatch');
            } else if (result.resourceIds != null && (!Array.isArray(result.resourceIds) ||
                !observeOutputResources(job, result.resourceIds.map(resourceId => ({resourceId, state:'pending'}))))) {
              this.flagRunConflict(job,'run_resource_mismatch');
            } else if (!job.upstreamCreditQuote) {
              job.upstreamCreditQuote=this.creditQuote(job,result.totalMaxCredits,'submission_response',undefined,result.nodeId??null);
            }
          }
        } else if (String(result.submission?.state).toLowerCase() === 'rejected') this.failed(job, 'submission_rejected', result.submission, result);
        else if (!result.submission || result.submission.submitId && result.submission.submitId !== job.submitId) job.attention = 'submission_uncertain';
        const accepted = r.mode === 'promote' ? result.state : result.submission?.state;
        if (!job.attention && job.status === 'in_progress' && ['accepted','completed','in_progress'].includes(String(accepted).toLowerCase())) this.recordTime(job, 'accepted_at_ms');
      } catch (error) {
        // Exit 10 is documented as quotation awaiting approval, without debit.
        if (error.exitCode === 10) this.failed(job, 'credit_approval_required');
        else if(['20005','20100','20110','20115'].includes(String(error.cliError?.code))) this.failed(job,'submission_rejected',error.cliError);
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
      if (error.cliError?.code === 'cli.operation_submission_absent') {
        // Missing/expired records are terminal by operator policy. This does
        // not prove the original submission was uncharged; keep any recorded
        // run conflict for review and never resubmit the operation.
        this.failed(job, 'submission_absent', error.cliError);
        this.recordIssue(job, 'terminal', error.cliError);
        await this.save(job); return;
      }
      this.onEvent?.({event:'dreamina_poll',job_id:job.id,at_ms:Date.now(),duration_ms:Date.now()-polledAt,state:'status_unavailable',poll_count:job.timings.poll_count});
      const uncertain=['cli.operation_identity_unknown','cli.operation_context_mismatch'].includes(error.cliError?.code);
      job.attention = job.runConflict ? 'run_conflict' : uncertain ? 'manual_recovery_required' : 'status_unavailable';
      this.recordIssue(job,'query',error.cliError,'status_unavailable');
      job.diagnostics.consecutive_query_errors=(job.diagnostics.consecutive_query_errors || 0)+1;
      const delay=uncertain || job.runConflict ? 60000 : Math.min(60000,5000 * 2 ** Math.min(job.diagnostics.consecutive_query_errors-1,4));
      job.diagnostics.next_poll_at_ms=Date.now()+delay;
      await this.save(job); return;
    }
    job.timings.last_poll_finished_at_ms = Date.now();
    job.diagnostics ||= {};
    job.diagnostics.consecutive_query_errors=0;
    job.diagnostics.next_poll_at_ms=0;
    job.diagnostics.last_query_at_ms=Date.now();
    this.onEvent?.({event:'dreamina_poll',job_id:job.id,at_ms:Date.now(),duration_ms:Date.now()-polledAt,state:String(operation?.state).slice(0,40),poll_count:job.timings.poll_count});
    if (operation?.operationRef !== job.submitId ||
        (operation.submission?.submitId != null && operation.submission.submitId !== job.submitId)) {
      job.attention = 'operation_mismatch';
      this.recordIssue(job, 'query', {code:'operation_mismatch',message:'即梦查询回执无法对应原操作，等待核查，未重新提交'});
      job.diagnostics.next_poll_at_ms = Date.now() + 60000;
      await this.save(job); return;
    }
    const state = String(operation.state).toLowerCase();
    const submission = String(operation.submission?.state).toLowerCase();
    // An ambiguous submission cannot promote cached resources to evidence
    // of acceptance or delivery. Only query the same submit ID again.
    if (state === 'unknown' || ['absent','unknown','awaiting_confirmation'].includes(submission)) {
      job.attention = job.runConflict ? 'run_conflict' : 'manual_recovery_required';
      job.diagnostics.next_poll_at_ms = Date.now() + 60000;
      await this.save(job); return;
    }
    const outputs = Array.isArray(operation.resources) ? operation.resources : [];
    // Acceptance belongs to the original operation even when a changed
    // generation plan prevents customer delivery and settlement.
    if (job.timings.accepted_at_ms === undefined &&
        (['accepted','completed','in_progress'].includes(submission) ||
         outputs.some(r => r?.state === 'succeeded' && typeof r.resourceId === 'string' && ID.test(r.resourceId)))) {
      this.recordTime(job, 'accepted_observed_at_ms');
    }
    if (job.runConflict) {
      if (isTerminalOperation(state)) {
        const ids = outputs.map(r => r?.resourceId);
        job.runConflictResourceIds = [...new Set(ids.filter(id => typeof id === 'string' && ID.test(id)))].slice(0, job.request.n);
        this.failed(job, job.runConflict, {message:runConflictMessages[job.runConflict]});
      } else {
        job.attention = 'run_conflict';
        job.diagnostics.next_poll_at_ms = Date.now() + 60000;
      }
      await this.save(job); return;
    }
    if(job.diagnostics.last_error && !job.diagnostics.last_error.resolved_at_ms)job.diagnostics.last_error.resolved_at_ms=Date.now();
    const resources = operation.resources ?? [];
    if (!observeOutputResources(job, resources)) {
      job.attention = 'resource_count_mismatch';
      job.diagnostics.next_poll_at_ms = Date.now() + 60000;
      await this.save(job); return;
    }

    // An individually successful output is provisional until the original
    // operation reaches a terminal state (e.g. final copyright review).
    const failed = failedOperationStates.has(state);
    if (!isTerminalOperation(state)) {
      await this.save(job); return;
    }
    const serviceCode = operation.submissionError?.serviceCode;
    const hasServiceCode = (Number.isSafeInteger(serviceCode) && serviceCode > 0) ||
      (typeof serviceCode === 'string' && /^[1-9]\d{0,15}$/.test(serviceCode));
    const refusal = submission === 'rejected' ||
      (failed && hasServiceCode && operation.submissionError?.retryable === false);
    const outstanding = [...job.observedResourceStates.map(([, state]) => state), ...resources.filter(r => !r.resourceId).map(r => r.state)]
      .some(state => !['succeeded', 'failed'].includes(state) && !(refusal && state === 'pending'));
    if (outstanding) { await this.save(job); return; }

    // If the refusal cannot be attributed to specific failed children, rely
    // only on successes confirmed in this final receipt, never on earlier ones.
    if (failed && !refusal && !resources.length && job.observedSuccessIds.length) {
      // Nothing in this failed receipt identifies which earlier outputs, if
      // any, survived. Query the same operation again before publishing.
      job.attention = 'resources_missing';
      job.diagnostics.next_poll_at_ms = Date.now() + 60000;
      await this.save(job); return;
    }
    const unscopedRefusal = refusal && !resources.some(r => r.state === 'failed' && r.resourceId);
    // A complete terminal list is authoritative for public artifact ordering.
    // A shortened list cannot reorder the members omitted from that receipt.
    const terminalIDs = [...new Set(resources.map(r => r.resourceId).filter(id => typeof id === 'string'))];
    const order = terminalIDs.length === job.observedResourceIds.length ? terminalIDs : job.observedResourceIds;
    const ids = order.filter(id => job.observedSuccessIds.includes(id) &&
      (!unscopedRefusal || resources.some(r => r.resourceId === id && r.state === 'succeeded')));
    if (!ids.length) {
      if (failed || refusal) this.failed(job, 'generation_failed', ...resources.filter(r => r.state === 'failed'), operation.submission, operation);
      else {
        job.attention = 'resources_missing';
        job.diagnostics.next_poll_at_ms = Date.now() + 60000;
      }
      await this.save(job); return;
    }
    if (job.billing && job.request.mode === 'promote' && !job.upstreamCreditQuote) {
      // A node quote would price the source draft, not this promotion. Only
      // the response bound to this original operation can recover its quote.
      const credits = operation.totalMaxCredits ?? operation.submission?.totalMaxCredits;
      const subject = operation.consumptionSubject ?? operation.submission?.consumptionSubject;
      if (subject != null && consumptionSubjectError(subject,this.config)) {
        this.flagRunConflict(job,'run_subject_mismatch'); await this.save(job); return;
      }
      if (operation.totalMaxCredits != null && operation.submission?.totalMaxCredits != null &&
          operation.totalMaxCredits !== operation.submission.totalMaxCredits) {
        job.attention = 'billing_quote_pending';
      } else {
        job.upstreamCreditQuote = this.creditQuote(job,credits,'operation_response',undefined,operation.nodeId ?? null);
      }
      if (!job.upstreamCreditQuote) {
        job.billingResolutionExpiresAt ||= Math.floor(Date.now() / 1000) + MEDIA_RETENTION_SECONDS;
        job.attention = 'billing_quote_pending';
        job.diagnostics.next_poll_at_ms = Date.now() + 60000;
        await this.save(job); return;
      }
    }
    if (job.unverifiedDownloadResources) {
      const previous = job.unverifiedDownloadResources;
      const attempts = job.downloadAttempts || [];
      job.downloadAttempts = ids.map(id => attempts[previous.indexOf(id)] || 0);
      job.files = job.files.filter(file => ids.includes(file.resourceId));
      delete job.unverifiedDownloadResources;
    }
    job.terminalOperationState = state;
    job.downloadResources = ids;
    this.recordTime(job, 'upstream_completed_observed_at_ms');
    await this.save(job);
  }

  async downloadJob(job) {
    this.recordTime(job, 'download_started_at_ms');
    job.diagnostics ||= {};
    if (!job.downloadAttempts) {
      job.downloadAttempts = job.downloadResources.map(() => 0);
      // Older workers stopped at the first failed download and kept a shared
      // counter. Preserve that budget when its attribution is unambiguous.
      if (!job.files.length) job.downloadAttempts[0] = job.diagnostics.download_failures || 0;
    }
    await this.save(job);
    let retryAttempts = 0;
    for (const [index, resourceId] of job.downloadResources.entries()) {
      if (this.closed) return;
      const savedIndex = job.files.findIndex(f => f.resourceId === resourceId);
      if (savedIndex >= 0) {
        // A restored checkpoint must still refer to this resource's real file.
        const saved = job.files[savedIndex];
        const filename = job.id + '-' + index + '.bin';
        const path = join(this.config.dataDir, filename);
        if (saved.filename === filename && saved.sha256) {
          const handle = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
          if (handle) {
            try {
              if (await verifiedMediaFile(handle,saved,this.verifiedMedia).catch(() => false)) continue;
            } finally { await handle.close(); }
          }
        }
        job.files.splice(savedIndex, 1);
      }
      if (job.downloadAttempts[index] >= 5) continue;
      try {
        if (typeof resourceId !== 'string' || !ID.test(resourceId)) fail('invalid resource ID');
        const file = await this.download(job, resourceId, index);
        job.files.push(file);
      } catch (error) {
        const source = error.cliError || (error.code === 'media_download_too_large'
          ? {code:error.code, message:'Downloaded media exceeds the bridge size limit'} : {});
        if (identityRecoveryCodes.has(source.code)) {
          await this.holdForContext(job, error);
          return;
        }
        const permanent = ['cli.download_too_large', 'media_download_too_large'].includes(source.code);
        job.downloadAttempts[index] = permanent ? 5 : job.downloadAttempts[index] + 1;
        job.diagnostics.download_failures = (job.diagnostics.download_failures || 0) + 1;
        if (job.downloadAttempts[index] < 5) retryAttempts = Math.max(retryAttempts, job.downloadAttempts[index]);
        this.recordIssue(job, 'download', source, 'download_failed');
      }
      // Keep progress across restarts; persist failure counts per resource,
      // without conflating a storage error with a failed CLI download.
      await this.save(job);
    }
    if (retryAttempts) {
      job.attention = 'download_failed';
      job.diagnostics.next_download_at_ms = Date.now() + Math.min(60000, 5000 * 2 ** (retryAttempts - 1));
    } else if (job.files.length) {
      // Public artifact keys are dense and preserve upstream output order,
      // even if a later resource was verified before a retried earlier one.
      job.files.sort((a,b) => job.downloadResources.indexOf(a.resourceId) - job.downloadResources.indexOf(b.resourceId));
      job.status = 'completed'; job.completed_at = Math.floor(Date.now() / 1000);
      delete job.attention;
      this.recordTime(job, 'download_completed_at_ms');
      job.diagnostics.next_download_at_ms = 0;
      if (job.files.length === job.downloadResources.length && job.diagnostics.last_error?.stage === 'download') {
        job.diagnostics.last_error.resolved_at_ms = Date.now();
      }
    } else {
      const issue = job.diagnostics.last_error;
      this.failed(job, 'download_failed', issue);
      if (issue?.stage === 'download') job.diagnostics.last_error = issue;
      job.diagnostics.next_download_at_ms = 0;
    }
    await this.save(job);
  }

  failed(job, code, ...sources) {
    const upstream = upstreamError(sources);
    let message = upstream.message || (upstream.code !== undefined ? 'Dreamina service error: ' + upstream.code : code.replaceAll('_', ' '));
    const quoteMessages={credit_reservation_exceeded:'即梦报价超过本次已预留积分，未提交生成，请联系管理员调整预留设置',draft_save_unavailable:'无法确认视频草稿已保存，未提交生成',draft_changed:'视频草稿参数已变化，未提交生成，请核对后重新提交',
      credit_quote_unavailable:'无法取得完整有效的即梦积分报价，未提交生成，请稍后重新提交',credit_quote_changed:'即梦积分报价已变化，未提交生成，请重新提交',
      credit_confirmation_unavailable:'无法确认本次积分消费授权，未提交生成，请稍后重新提交',
      credit_subject_unverified:'无法核实目标画布的即梦扣费账号和空间，已停止生成，请管理员核对渠道配置',
      credit_subject_mismatch:'即梦扣费账号或空间与当前渠道配置不一致，已停止生成，请管理员核对账号和团队'};
    if(quoteMessages[code] && !upstream.message)message=quoteMessages[code];
    // Operator-confirmed meaning; keep the machine-readable upstream code.
    if (String(upstream.code) === '20115') message = '20115:本次生成的输出视频未通过版权审核';
    if (String(upstream.code) === '20100') message = '20100:本次输入文本敏感，已被安全审核拦截';
    if (String(upstream.code) === '20110') message = '20110:输入图片版权校验未通过';
    if (String(upstream.code) === '20005') message = '20005:即梦当前成员可用积分不足';
    if (upstream.code === 'cli.operation_submission_absent') message = 'cli.operation_submission_absent：提交记录不存在或已过期';
    if (code === 'billing_quote_unavailable') message = '原转正任务的积分报价无法恢复，核查期限已到，未交付且未重新生成，请联系管理员核查原任务';
    if (code === 'artifact_expired') message = '原生成文件已超过保留期限，无法交付，请勿重新生成';
    if (code === 'download_failed') message = '视频已生成，但结果下载失败，重试次数已用尽：' + message;
    if (upstream.code === 'cli.download_too_large') message = 'cli.download_too_large：视频已生成，但文件超过即梦 CLI 下载大小限制，无法交付';
    if (upstream.code === 'media_download_too_large') message = 'media_download_too_large：视频已生成，但文件超过适配服务下载大小限制，无法交付';
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
    const info = await lstat(partial);
    if (info.size > this.config.maxMediaBytes) {
      await unlink(partial);
      fail('media exceeds download size limit', 502, 'media_download_too_large');
    }
    if (!info.isFile() || !info.size || result?.resourceId !== resourceId || result.path !== partial || result.size !== info.size) fail('invalid download');
    const file = await open(partial, constants.O_RDONLY | constants.O_NOFOLLOW);
    let mime, sha256;
    try {
      const bytes = Buffer.alloc(32);
      const {bytesRead} = await file.read(bytes,0,bytes.length,0);
      mime = mediaType(bytes.subarray(0,bytesRead),job.request.kind);
      sha256 = await mediaFileDigest(file,info.size);
      if (!sha256 || sha256 !== result.sha256) fail('download checksum mismatch');
    } finally { await file.close(); }
    await rename(partial, join(this.config.dataDir, filename));
    return { resourceId, filename, size: info.size, mime, sha256 };
  }
}

function json(res, status, body, privateReceipt = false) {
  if (privateReceipt && body.billing) {
    const {billing, ...publicBody} = body;
    res.setHeader('X-Dreamina-Billing-Receipt', Buffer.from(JSON.stringify({id:body.id,billing})).toString('base64'));
    body = publicBody;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function content(bridge, req, res, id, index) {
  const job = await bridge.loadJob(id), file = job?.files[index];
  if (job?.status !== 'completed' || !file) fail('content not found', 404);
  const expires=mediaDeadlines(job).content_expires_at;
  if(expires&&Date.now()>=expires*1000)fail('视频文件已过期（保留 8 小时），请使用下游已保存的副本',410,'artifact_expired');
  let handle,streaming=false;
  try {
    handle=await open(join(bridge.config.dataDir,file.filename),constants.O_RDONLY | constants.O_NOFOLLOW);
    if (file.sha256 !== undefined) {
      if (!await verifiedMediaFile(handle,file,bridge.verifiedMedia)) {
        fail('视频文件完整性校验失败；原生成资源已保留，请联系管理员恢复下载',503,'artifact_integrity_failed');
      }
    } else {
      // Already-settled legacy files have no original checksum to verify.
      const info=await handle.stat();
      if (!info.isFile() || info.size !== file.size) fail('content unavailable',503);
    }
    let start=0,end=file.size-1,status=200;
    const headers={'Content-Type':file.mime,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store','Accept-Ranges':'bytes'};
    if(req.headers.range){
      const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(!range||!(range[1]||range[2]))fail('invalid range',416);
      if(!range[1])start=Math.max(0,file.size-Number(range[2]));
      else{start=Number(range[1]);if(range[2])end=Math.min(end,Number(range[2]));}
      if(!Number.isSafeInteger(start)||start>end||start>=file.size)fail('invalid range',416);
      status=206;headers['Content-Range']=`bytes ${start}-${end}/${file.size}`;
    }
    headers['Content-Length']=end-start+1;res.writeHead(status,headers);
    if(req.method==='HEAD')return res.end();
    const stream=handle.createReadStream({start,end});streaming=true;
    stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }catch(error){
    if(error.code==='ENOENT'&&expires&&Date.now()>=expires*1000)fail('视频文件已过期（保留 8 小时），请使用下游已保存的副本',410,'artifact_expired');
    throw error;
  }finally{if(handle&&!streaming)await handle.close();}
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
        preparing_requests: bridge.pendingAdmissions.size, preparing_units: bridge.preparingUnits,
        active_input_preparations: bridge.activePreparations,
        gateway_confirmation_enabled: !!bridge.gatewayTaskReader, gateway_confirmation_failures: bridge.gatewayConfirmationFailures,
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
          let billing;
          if(req.headers['x-dreamina-billing']!==undefined) {
            const raw=req.headers['x-dreamina-billing'];
            if(typeof raw!=='string' || raw.length>1024)fail('invalid gateway billing reservation');
            try {billing=JSON.parse(raw);}catch {fail('invalid gateway billing reservation');}
          }
          const result=await bridge.submit(body, req.headers['idempotency-key'], true, billing);
          const job=await bridge.loadJob(result.id);
          const quote=bridge.creditQuoteHeader(job);
          if(quote)res.setHeader('X-Upstream-Credit-Quote',quote);
          return json(res,202,result,req.headers['x-dreamina-receipt']==='header-v1');
        } finally { admissions--; }
      }
      const query = /^\/v1\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === 'GET' && query) {
        const job=await bridge.loadJob(query[1]);
        const quote=bridge.creditQuoteHeader(job);
        if(quote)res.setHeader('X-Upstream-Credit-Quote',quote);
        return json(res,200,await bridge.observe(query[1],job),req.headers['x-dreamina-receipt']==='header-v1');
      }
      fail('not found', 404);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: { ...(error.code ? {code:error.code} : {}), message: error.status ? error.message : 'bridge internal error' } });
      else res.destroy();
    }
  });
}
