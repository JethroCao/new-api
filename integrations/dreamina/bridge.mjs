import { createServer as httpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { VIDEO_MODELS, normalizeVideo } from './plugin.js';
import { readReference } from './media-input.mjs';
import { isAbsolute, join } from 'node:path';
import { atomicJSON } from './state-file.mjs';
import { CanvasPool } from './canvas-pool.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const terminal = job => ['completed', 'failed'].includes(job.status);
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function equal(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validateConfig(input) {
  const c = { host: '127.0.0.1', port: 8787, profile: 'default', region: 'cn',
    pollMs: 5000, commandTimeoutMs: 120000, maxQueue: 20, maxJobs: 1000,
    maxConcurrent: 2, maxAdmissions: 2, maxInputBytes: 64 * 1024 * 1024, maxMediaBytes: 512 * 1024 * 1024, mediaTTL: 3600, maxQueueWaitSeconds: 1800, leaseSeconds: 300, submitWorkers: 6, pollWorkers: 2, unlimitedCredits: false, canvasTaskLimit: 0, ...input };
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
    ['maxQueue', 1, 200], ['maxConcurrent', 1, 200], ['maxAdmissions', 1, 200], ['maxInputBytes', 1, 64 * 1024 * 1024], ['maxJobs', 1, 100000], ['maxMediaBytes', 1, 1073741824], ['mediaTTL', 60, 86400],
    ['maxQueueWaitSeconds', 1, 1800], ['leaseSeconds', 1, 300], ['submitWorkers', 1, 6], ['pollWorkers', 1, 2]]) {
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
    for (const candidate of [source.error, source]) {
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
    const chunks = []; let bytes = 0; let failure;
    const timer = setTimeout(() => { failure = new Error('CLI timeout'); child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { failure = new Error('CLI output limit'); child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.stderr.resume(); // Never log CLI stderr: it may contain authentication material.
    child.on('error', () => { failure = new Error('CLI could not start'); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(Object.assign(new Error('CLI command failed'), { exitCode: code }));
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
      for (const name of await readdir(config.dataDir)) {
        if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
        const job = JSON.parse(await readFile(join(config.dataDir, name), 'utf8'));
        if (!UUID.test(job.id) || name !== job.id + '.json' || job.context !== bridge.contextKey) fail('stored job context mismatch', 503);
        bridge.jobs.set(job.id, job);
        bridge.keys.set(job.key, job.id);
      }
      bridge.canvases = await CanvasPool.open({path:join(config.dataDir,'canvases.json'),context:bridge.contextKey,
        legacyProjectId:config.projectId,jobs:[...bridge.jobs.values()]});
      return bridge;
    } catch (error) { await bridge.close(); throw error; }
  }

  constructor(config, cli) {
    this.config = config;
    this.cli = cli || (args => runCLI(config.cli, ['--format=json', '--non-interactive', '--profile=' + config.profile, '--region=' + config.region, ...args], config.commandTimeoutMs));
    this.contextKey = hash(JSON.stringify([config.profile, config.region, config.userId, config.space, config.projectId, config.models]));
    this.jobs = new Map(); this.keys = new Map(); this.admissions = Promise.resolve();
    this.lastQueuedId = null; this.lastPolledId = null;
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
    if (this.lock) { await this.lock.close(); await unlink(join(this.config.dataDir, '.lock')).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }

  async checkContext() {
    const s = await this.cli(['space', 'current']);
    const space = s.kind === 'personal' ? 'personal' : s.kind === 'team' ? 'team:' + s.team?.teamId : '';
    if (s.userId !== this.config.userId || space !== this.config.space) fail('context_mismatch', 503);
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

  validate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid request body');
    if (Object.hasOwn(VIDEO_MODELS, body.model)) {
      if (!Object.hasOwn(this.config.models, body.model)) fail('unsupported model/kind');
      if (body.mode === 'promote') {
        const source = this.jobs.get(body.source_job_id);
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
      const request = this.validate(body);
      if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key)) fail('invalid Idempotency-Key');
      const keyHash = hash(key), digest = hash(JSON.stringify(request));
      const existing = this.jobs.get(this.keys.get(keyHash));
      if (existing) {
        if (existing.digest !== digest) fail('idempotency conflict', 409);
        return this.get(existing.id);
      }
      if (request.n > this.config.maxConcurrent) fail('requested count exceeds generation capacity', 429);
      if (this.jobs.size >= this.config.maxJobs || [...this.jobs.values()].filter(j => !terminal(j)).reduce((n,j) => n + j.request.n, 0) + request.n > this.config.maxQueue) fail('queue/storage capacity reached', 429);
      const job = { id: randomUUID(), key: keyHash, digest, context: this.contextKey, request,
        nodeId: 'node_' + Array.from(randomBytes(10), b => '0123456789abcdefghjkmnpqrstvwxyz'[b & 31]).join(''), updateId: randomUUID(), submitId: randomUUID(),
        status: 'queued', created_at: Math.floor(Date.now() / 1000), files: [], inputs: [] };
      // Only local file identities/hashes are persisted. In particular, signed
      // input URLs and base64 payloads never enter job snapshots or responses.
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
          const source = request.mode === 'promote' ? this.jobs.get(request.source_job_id) : undefined;
          const canvas = await this.canvases.reserve(job, source ? this.projectId(source) : undefined);
          job.projectId = canvas.projectId;
          job.canvasName = canvas.name;
        } else {
          // Fixed mode only affects new independent jobs. Source-bound work
          // must keep its project even when rotation has been switched off.
          const source = request.mode === 'promote' ? this.jobs.get(request.source_job_id) : undefined;
          job.projectId = source ? this.projectId(source) : this.config.projectId;
          if (job.projectId !== this.config.projectId) await this.canvases.reserve(job, job.projectId);
        }
        await this.save(job);
      } catch(e) {
        for (const input of job.inputs) await unlink(join(this.config.dataDir,input.filename)).catch(()=>{});
        throw e;
      }
      this.jobs.set(job.id, job); this.keys.set(keyHash, job.id);
      if (!waitForGateway) this.leases.set(job.id, Date.now() + this.config.leaseSeconds * 1000);
      return this.get(job.id);
    });
    this.admissions = op.catch(() => {});
    return op;
  }

  async save(job) { await atomicJSON(join(this.config.dataDir, job.id + '.json'), job); }

  projectId(job) { return job.projectId || this.config.projectId; }

  get(id) {
    const j = this.jobs.get(id);
    if (!j) fail('job not found', 404);
    return { id: j.id, object: j.request.kind === 'video' ? 'video' : 'image', model: j.request.model,
      status: j.status, created_at: j.created_at, completed_at: j.completed_at,
      n: j.request.n, mode:j.request.mode, ratio:j.request.ratio, resolution:j.request.resolution,
      video_count:j.request.kind === 'video' && j.status === 'completed' ? j.files.length : 0,
      reference_video:(j.request.references || []).some(r=>r.type==='video'),
      ...(j.request.model === 'seedance_2.5_draft' ? {warning:'样片最长存储 7 天，过期后不可再生成正片；具体期限以即梦服务端为准'} : {}),
      seconds: j.request.seconds, image_count: j.status === 'completed' ? j.files.length : j.request.n,
      progress: j.status === 'completed' ? 100 : 0, attention: j.attention, error: j.error,
      data: j.status === 'completed' && j.request.kind === 'image' ? j.files.map((f, i) => ({ url: this.mediaURL(j.id, i) })) : [] };
  }

  observe(id) {
    const result = this.get(id);
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
    if (this.closed) return Promise.resolve();
    if (this.schedulerError) return Promise.reject(this.schedulerError);
    const pending = [];
    // Reserve worker and generation slots synchronously before starting any
    // asynchronous work. Overlapping timer ticks cannot dispatch a job twice.
    let occupied = [...this.jobs.values()].reduce((n,j) => n +
      (j.status === 'in_progress' || j.status === 'queued' && this.inFlight.has(j.id) ? j.request.n : 0), 0);
    for (const lane of ['poll', 'submit']) {
      const workers = [...this.inFlight.values()].filter(w => w.lane === lane);
      let available = this.config[lane === 'poll' ? 'pollWorkers' : 'submitWorkers'] - workers.length;
      const busyCanvases = new Set(workers.map(w => w.projectId));
      const candidates = [...this.jobs.values()].filter(j => j.status === (lane === 'poll' ? 'in_progress' : 'queued'));
      const cursor = lane === 'poll' ? 'lastPolledId' : 'lastQueuedId';
      const previous = candidates.findIndex(j => j.id === this[cursor]);
      for (let offset = 1; offset <= candidates.length && available > 0; offset++) {
        const job = candidates[(previous + offset) % candidates.length];
        if (this.inFlight.has(job.id)) continue;
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
        }).finally(() => { this.inFlight.delete(job.id); });
        pending.push(work.promise);
      }
    }
    return Promise.all(pending).then(() => {});
  }

  async processJob(job) {
    try { await this.checkContext(); } catch (error) {
      job.attention = error.message === 'context_mismatch' ? 'context_mismatch' : 'cli_unavailable';
      await this.save(job); return;
    }
    if (this.closed) return;
    delete job.attention;
    if (job.status === 'queued') {
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
      if (this.closed) return;
      if (Date.now() >= (job.created_at+this.config.maxQueueWaitSeconds)*1000 || !(this.leases.get(job.id)>Date.now())) {
        job.attention='awaiting_gateway';await this.save(job);return;
      }
      if (Object.hasOwn(VIDEO_MODELS, job.request.model)) {
        try {
          const list = await this.cli(['model','list','--type=video']);
          const spec = list.items?.find(m => m.model===job.request.model);
          if (!spec) fail('live model unavailable');
          this.videoCatalog.set(job.request.model,spec);
          this.validateLiveVideo(job.request);
          if (job.request.mode === 'promote') {
            const details = await this.cli(['model','seedance_2.5_draft']);
            const source = this.jobs.get(job.request.source_job_id);
            const generation = details.matches?.map(m=>m.generation).find(g=>g?.generationKind==='sample' && g.mode===source.request.mode);
            const values = generation?.draftPromotion?.params?.find(p=>p.name==='resolution')?.rule?.stringValues;
            if (!values?.includes(job.request.resolution)) fail('promotion resolution unavailable');
          }
        } catch { job.attention='model_unavailable'; await this.save(job); return; }
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
      await this.save(job);
      const r = job.request, m = this.config.models[r.model];
      const video = Object.hasOwn(VIDEO_MODELS, r.model);
      // Only the operator can approve uncapped spending. Client payloads cannot
      // override this policy; the gateway still reserves user quota first.
      const creditApproval = this.config.unlimitedCredits ? '--yes' : '--credit-ceiling=' + m.maxCredits;
      const args = r.mode === 'promote' ? ['node','promote','video-sample','--project-id='+this.projectId(job),
        '--node-id='+this.jobs.get(r.source_job_id).nodeId,'--submit-id='+job.submitId,'--resolution='+r.resolution,
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
      } catch (error) {
        // Exit 10 is documented as quotation awaiting approval, without debit.
        if (error.exitCode === 10) this.failed(job, 'credit_approval_required');
        else job.attention = 'submission_uncertain';
      }
      await this.save(job); return;
    }
    let operation;
    try { operation = await this.cli(['operation', 'status', job.submitId, '--project-id=' + this.projectId(job)]); }
    catch { job.attention = 'status_unavailable'; await this.save(job); return; }
    if (operation.operationRef && operation.operationRef !== job.submitId) {
      job.attention = 'operation_mismatch'; await this.save(job); return;
    }
    const resources = operation.resources || [];
    const state = String(operation.state).toLowerCase();
    const submission = String(operation.submission?.state).toLowerCase();
    if (!resources.length && (submission === 'rejected' || state === 'failed')) {
      this.failed(job, 'generation_failed', ...resources.filter(r => r.state === 'failed'), operation.submission, operation); await this.save(job); return;
    }
    if (!resources.length || resources.some(r => !['succeeded', 'failed'].includes(r.state))) {
      if (['absent', 'unknown', 'awaiting_confirmation'].includes(submission) || state === 'unknown') job.attention = 'manual_recovery_required';
      else if (!resources.length && ['succeeded', 'completed'].includes(state)) job.attention = 'resources_missing';
      await this.save(job); return;
    }
    if (resources.length !== job.request.n || new Set(resources.map(r => r.resourceId)).size !== resources.length) {
      job.attention = 'resource_count_mismatch'; await this.save(job); return;
    }
    const successful = resources.filter(r => r.state === 'succeeded');
    if (!successful.length) { this.failed(job, 'generation_failed', ...resources.filter(r => r.state === 'failed'), operation.submission, operation); await this.save(job); return; }
    try {
      for (let i = 0; i < successful.length; i++) {
        if (this.closed) return;
        const resourceId = successful[i].resourceId;
        if (!ID.test(resourceId)) fail('invalid resource ID');
        if (job.files[i]?.resourceId === resourceId) continue;
        job.files[i] = await this.download(job, resourceId, i);
        await this.save(job);
      }
      job.status = 'completed'; job.completed_at = Math.floor(Date.now() / 1000);
    } catch { job.attention = 'download_failed'; }
    await this.save(job);
  }

  failed(job, code, ...sources) {
    const upstream = upstreamError(sources);
    let message = upstream.message || (upstream.code !== undefined ? 'Dreamina service error: ' + upstream.code : code.replaceAll('_', ' '));
    // Public error text is retained; known credentials are never echoed.
    message = message.replaceAll(this.config.token, '[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
      .replace(/((?:access_token|refresh_token|api_key|token|signature|X-Tos-Signature)=)[^\s&]+/gi, '$1[redacted]');
    job.status = 'failed';
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
  const job = bridge.jobs.get(id), file = job?.files[index];
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
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: bridge.schedulerError ? 'error' : 'ok', queued: [...bridge.jobs.values()].filter(j => !terminal(j)).length,
        waiting: [...bridge.jobs.values()].filter(j => j.status === 'queued').length,
        running: [...bridge.jobs.values()].filter(j => j.status === 'in_progress').length,
        submit_workers: [...bridge.inFlight.values()].filter(w => w.lane === 'submit').length,
        poll_workers: [...bridge.inFlight.values()].filter(w => w.lane === 'poll').length });
      if (req.method === 'POST' && url.pathname === '/v1/jobs') {
        if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') fail('JSON required', 415);
        if (admissions >= bridge.config.maxAdmissions) fail('submission admission capacity reached', 429);
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
      if (req.method === 'GET' && query) return json(res, 200, bridge.observe(query[1]));
      fail('not found', 404);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: { message: error.status ? error.message : 'bridge internal error' } });
      else res.destroy();
    }
  });
}
