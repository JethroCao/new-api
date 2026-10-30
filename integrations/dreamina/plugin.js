// Self-contained uploadable Task Plugin v1. The Node bridge imports this same
// catalogue/validator; no Node APIs or imports may be used in this file.
const SEEDANCE_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
export const VIDEO_MODELS = {
  'happyhorse_1.1': { resolutions: ['720P', '1080P'], minSeconds: 4, maxSeconds: 15, promptLimit: 2500, ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '9:21', '21:9'], frames: 1, references: { total: 9, image: 9, video: 0, audio: 0 }, requireVisual: true },
  'seedance_2.0_fast_vip': { resolutions: ['720p'], minSeconds: 4, maxSeconds: 15, promptLimit: 4000, ratios: SEEDANCE_RATIOS, frames: 2, references: { total: 12, image: 9, video: 3, audio: 3 }, requireVisual: true },
  'seedance_2.0_mini': { resolutions: ['720p'], minSeconds: 4, maxSeconds: 15, promptLimit: 4000, ratios: SEEDANCE_RATIOS, frames: 2, references: { total: 12, image: 9, video: 3, audio: 3 }, requireVisual: true },
  'seedance_2.0_vip': { resolutions: ['720p', '1080p', '4k'], minSeconds: 4, maxSeconds: 15, promptLimit: 4000, ratios: SEEDANCE_RATIOS, frames: 2, references: { total: 12, image: 9, video: 3, audio: 3 }, requireVisual: true },
  'seedance_2.5': { resolutions: ['480p', '720p', '1080p'], minSeconds: 4, maxSeconds: 30, promptLimit: 15000, ratios: SEEDANCE_RATIOS, frames: 2, references: { total: 50, image: 30, video: 10, audio: 10 }, requireVisual: false },
  'seedance_2.5_draft': { resolutions: ['480p'], minSeconds: 4, maxSeconds: 30, promptLimit: 15000, ratios: SEEDANCE_RATIOS, frames: 2, references: { total: 50, image: 30, video: 10, audio: 10 }, requireVisual: false, draft: true },
  'seedance_pro_fast': { resolutions: ['720p', '1080p'], minSeconds: 5, maxSeconds: 10, promptLimit: 2000, ratios: SEEDANCE_RATIOS, frames: 1 },
  'wan_3.0': { resolutions: ['720P', '1080P'], minSeconds: 4, maxSeconds: 15, promptLimit: 20000, ratios: ['16:9', '4:3', '1:1', '3:4', '9:16'], frames: 2, references: { total: 20, image: 10, video: 5, audio: 5 }, requireVisual: true },
};
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const meta = {
  apiVersion: 1, key: 'dreamina-cli', name: 'Dreamina CLI Video', icon: 'text:即梦', version: '0.2.1',
  'author': { name: 'JethroCao' },
  'description': { en: 'Video generation through the official Dreamina Canvas CLI', zh: '通过官方即梦画布 CLI 生成视频' },
  'models': Object.keys(VIDEO_MODELS).concat(['dreamina-video']),
  fetchMode: 'per_task', protocols: ['openai_video'],
  usageSchema: {
    seconds: { type: 'number', unit: 'second', description: { en: 'Video generation unit price', zh: '视频生成单价' } },
    resolution: { enum: ['480p', '720p', '1080p', '4k'], description: { en: 'Output video resolution', zh: '输出视频分辨率' } },
    mode: { enum: ['t2v', 'first_last_frame', 'm2v', 'promote'], description: { en: 'Video generation mode', zh: '视频生成模式' } },
    reference_video: { type: 'boolean', description: { en: 'Reference video present', zh: '存在参考视频' } },
  },
};

function bounded(value, fallback, min, max, name) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value === 'string' && /^\d{1,3}$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(name + ' must be an integer between ' + min + ' and ' + max);
  return value;
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function has(o, key) { return Object.prototype.hasOwnProperty.call(o, key); }
export function canonicalModel(model) { return model === 'dreamina-video' ? 'seedance_2.5' : model; }

export function normalizeVideo(req, model, allowFileRefs) {
  if (!object(req)) throw new Error('JSON object required');
  model = canonicalModel(model);
  if (!has(VIDEO_MODELS, model)) throw new Error('Unsupported video model');
  const spec = VIDEO_MODELS[model];
  const allowed = ['model', 'kind', 'prompt', 'seconds', 'n', 'ratio', 'resolution', 'size', 'mode', 'references', 'input_reference', 'draft_task_id'];
  for (const key of Object.keys(req)) if (allowed.indexOf(key) < 0) throw new Error('Unsupported field: ' + key);
  if (req.kind !== undefined && req.kind !== 'video') throw new Error('Media kind mismatch');
  if (req.mode === 'promote') {
    for (const key of Object.keys(req)) if (['model', 'kind', 'mode', 'draft_task_id', 'resolution'].indexOf(key) < 0) throw new Error('Promotion inherits all generation parameters from the draft');
    if (model !== 'seedance_2.5' || typeof req.draft_task_id !== 'string' || !/^task_[A-Za-z0-9_-]{1,128}$/.test(req.draft_task_id)) throw new Error('Promotion requires a public draft task ID and seedance_2.5');
    if (req.resolution !== undefined && String(req.resolution).toLowerCase() !== '1080p') throw new Error('Draft promotion supports 1080p');
    return { kind: 'video', model: model, mode: 'promote', draft_task_id: req.draft_task_id, resolution: '1080p' };
  }
  if (req.draft_task_id !== undefined) throw new Error('draft_task_id requires promote mode');
  const refs = req.references === undefined ? [] : req.references;
  if (!Array.isArray(refs) || refs.length > 50) throw new Error('references must be an array with at most 50 items');
  if (req.input_reference !== undefined && refs.length) throw new Error('Use either input_reference or references');
  const inputs = req.input_reference === undefined ? refs : [{ type: 'image', url: req.input_reference }];
  const references = inputs.map(function (ref) {
    if (!object(ref) || Object.keys(ref).some(k => ['type', 'url'].indexOf(k) < 0) || ['image', 'video', 'audio'].indexOf(ref.type) < 0) throw new Error('Each reference requires type and url');
    const u = ref.url;
    if (object(u)) {
      if (!allowFileRefs || typeof u.__fileRef !== 'string' || u.__fileRef.indexOf('request_file:') !== 0 || u.encoding !== 'dataUrl' || Object.keys(u).some(k => ['__fileRef','encoding','mimeType','maxBytes'].indexOf(k) < 0)) throw new Error('File placeholders must come from multipart uploads');
    } else if (typeof u !== 'string' || !(/^(https:\/\/|data:(image|video|audio)\/)/.test(u)) || /[\x00-\x20]/.test(u) || u.length > Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 256) throw new Error('Reference must be an HTTPS URL or base64 media data URL');
    return { type: ref.type, url: u };
  });
  const mode = req.mode === undefined ? (references.length === 0 ? 't2v' : references.length === 1 && references[0].type === 'image' ? 'first_last_frame' : 'm2v') : req.mode;
  if (['t2v','first_last_frame','m2v'].indexOf(mode) < 0) throw new Error('Unsupported video mode');
  if (mode === 't2v' && references.length) throw new Error('t2v does not accept references');
  if (mode === 'first_last_frame' && (!references.length || references.length > spec.frames || references.some(r => r.type !== 'image'))) throw new Error('Unsupported first/last frame references');
  if (mode === 'm2v') {
    const caps = spec.references;
    if (!caps || !references.length || references.length > caps.total) throw new Error('Unsupported multimodal reference count');
    for (const type of ['image','video','audio']) if (references.filter(r => r.type === type).length > caps[type]) throw new Error('Too many ' + type + ' references');
    if (spec.requireVisual && !references.some(r => r.type !== 'audio')) throw new Error('This model requires an image or video reference');
  }
  const prompt = req.prompt === undefined ? '' : req.prompt;
  // The CLI normalizes whitespace in resource placeholders. Reserve the
  // entire opening delimiter, including escaped/unknown spellings, so prompt
  // parsing can never add resources outside the validated references array.
  if (typeof prompt !== 'string' || (mode === 't2v' && !prompt.trim()) || prompt.length > spec.promptLimit || /\0|\{\{/.test(prompt)) throw new Error('Invalid prompt; canvas placeholder delimiters are not allowed');
  let resolution = req.resolution, ratio = req.ratio;
  if (req.size !== undefined) {
    const sizes = { '854x480':['480p','16:9'], '480x854':['480p','9:16'], '1280x720':['720p','16:9'], '720x1280':['720p','9:16'], '1920x1080':['1080p','16:9'], '1080x1920':['1080p','9:16'], '3840x2160':['4k','16:9'], '2160x3840':['4k','9:16'] };
    if (!has(sizes, req.size)) throw new Error('Unsupported size; use resolution and ratio');
    const pair = sizes[req.size];
    if (resolution !== undefined && String(resolution).toLowerCase() !== pair[0] || ratio !== undefined && ratio !== pair[1]) throw new Error('size conflicts with resolution or ratio');
    resolution = pair[0]; ratio = pair[1];
  }
  if (resolution === undefined) resolution = spec.resolutions[0];
  resolution = spec.resolutions.find(v => typeof resolution === 'string' && v.toLowerCase() === resolution.toLowerCase());
  if (!resolution) throw new Error('Unsupported model resolution');
  if (ratio === undefined) ratio = '16:9';
  if (spec.ratios.indexOf(ratio) < 0) throw new Error('Unsupported model ratio');
  return { kind:'video', model:model, prompt:prompt, mode:mode, resolution:resolution, ratio:ratio,
    seconds:bounded(req.seconds,5,spec.minSeconds,spec.maxSeconds,'seconds'), n:bounded(req.n,1,1,4,'n'), references:references };
}

function decode(ctx) {
  if (ctx.operation !== 'create') throw new Error('Only video creation is supported');
  const body = ctx.body || {};
  let req;
  if (body.kind === 'json') req = body.value;
  else if (body.kind === 'multipart') {
    req = {};
    for (const key of Object.keys(body.fields || {})) {
      const values = body.fields[key];
      if (!Array.isArray(values) || values.length !== 1) throw new Error('Repeated field: ' + key);
      req[key] = key === 'references' ? JSON.parse(values[0]) : values[0];
    }
    const files = body.files || [];
    if (files.length) {
      if (req.references !== undefined || req.input_reference !== undefined) throw new Error('Do not mix uploaded files and reference URLs');
      req.references = files.map(function (f) {
        if (['input_reference','references','references[]'].indexOf(f.field) < 0) throw new Error('Unsupported reference file field');
        if (!Number.isSafeInteger(f.size) || f.size < 1 || f.size > MAX_INPUT_BYTES) throw new Error('Reference file size exceeds 64 MiB');
        const type = String(f.mimeType || '').split('/')[0];
        return { type:type, url:{__fileRef:f.ref,encoding:'dataUrl',mimeType:f.mimeType,maxBytes:MAX_INPUT_BYTES} };
      });
      if (files.reduce((sum,f)=>sum+f.size,0) > MAX_INPUT_BYTES) throw new Error('Total reference files exceed 64 MiB');
    }
  } else throw new Error('JSON or multipart body required');
  const normalized = normalizeVideo(req, ctx.upstreamModel || ctx.model, body.kind === 'multipart');
  const intent = {kind:'submit',model:ctx.model,action:normalized.mode,requestBody:normalized};
  if (normalized.mode === 'promote') intent.originTaskIds = [normalized.draft_task_id];
  return intent;
}

function outbound(ctx) {
  const r = normalizeVideo(ctx.requestBody, ctx.upstreamModel || ctx.model, true);
  if (r.mode !== 'promote') return r;
  const sources = ctx.originTasks || [];
  const source = sources.find(s => s.taskId === r.draft_task_id);
  const d = source && source.data;
  if (!source || source.status !== 'SUCCESS' || !d || d.model !== 'seedance_2.5_draft' || d.video_count !== 1 || d.n !== 1 || !source.upstreamTaskId) throw new Error('Promotion requires an owned, completed single-video draft task');
  if (VIDEO_MODELS['seedance_2.5'].ratios.indexOf(d.ratio) < 0) throw new Error('Invalid draft ratio');
  return {kind:'video',model:r.model,mode:'promote',source_job_id:source.upstreamTaskId,resolution:r.resolution,ratio:d.ratio,seconds:bounded(d.seconds,undefined,4,30,'draft seconds'),n:1,references:[]};
}
function base(ctx) { return ctx.baseUrl.replace(/\/+$/, ''); }
function auth(ctx) { return { Authorization:'Bearer ' + ctx.apiKey }; }
export function buildSubmitRequest(ctx) {
  if (!ctx.publicTaskId) throw new Error('Gateway public task ID is required for idempotency');
  return {url:base(ctx)+'/v1/jobs',method:'POST',headers:Object.assign(auth(ctx),{'Content-Type':'application/json','Idempotency-Key':ctx.publicTaskId}),body:outbound(ctx)};
}
export function parseSubmitResponse(ctx, response) {
  if (!response.body || typeof response.body.id !== 'string' || !response.body.id) throw new Error('Bridge returned no task ID');
  return {taskId:response.body.id,taskData:response.body};
}
export function buildQueryRequest(ctx) { return {url:base(ctx)+'/v1/jobs/'+encodeURIComponent(ctx.taskId),method:'GET',headers:auth(ctx)}; }
export function parseTaskResult(ctx, body, response) {
  if (response && response.status !== 200) throw new Error('Bridge query is temporarily unavailable');
  const statuses={queued:'QUEUED',in_progress:'IN_PROGRESS',completed:'SUCCESS',failed:'FAILURE'};
  const status=statuses[(body||{}).status] || 'UNKNOWN';
  const result={status:status};
  if (status==='SUCCESS') result.progress='100%';
  if (status==='FAILURE') result.reason=body.error && body.error.message || 'Dreamina generation failed';
  if (status==='UNKNOWN') result.reason='Unrecognized bridge task status';
  return result;
}
export function extractUsage(ctx) {
  const r=outbound(ctx);
  return {seconds:r.seconds*r.n,resolution:r.resolution.toLowerCase(),mode:r.mode,reference_video:r.references.some(x=>x.type==='video')};
}
export function extractUsageOnComplete(ctx,result,body) {
  if (!body || body.status!=='completed') return {};
  if (body.object!=='video') throw new Error('Unknown completed media kind');
  return {seconds:bounded(body.seconds,undefined,4,30,'seconds')*bounded(body.video_count,undefined,1,4,'video_count')};
}
export function listArtifacts(task) {
  if (task.status!=='SUCCESS' || !task.data || task.data.object!=='video') return [];
  const count=bounded(task.data.video_count,1,1,4,'video_count');
  return Array.from({length:count},(_,i)=>({key:i===0?'video':'video-'+(i+1),type:'video'}));
}
export function buildContentRequest(ctx) {
  const key=String(ctx.artifactKey||'');
  const index=key==='video'?0:/^video-[2-4]$/.test(key)?Number(key.slice(6))-1:-1;
  if (index<0 || index>=bounded(ctx.data && ctx.data.video_count,1,1,4,'video_count')) throw new Error('artifact_not_found');
  return {url:base(ctx)+'/v1/jobs/'+encodeURIComponent(ctx.upstreamTaskId)+'/content/'+index,method:ctx.clientRequest.method,headers:auth(ctx)};
}
export const protocols={openai_video:{decodeRequest:decode,render:function(ctx,task){
  const d=task.data||{}, result={};
  for (const key of ['seconds','n','video_count','resolution','ratio','mode','warning']) if(d[key]!==undefined) result[key]=d[key];
  if(task.status==='FAILURE') {
    result.error={code:'video_generation_failed',message:task.fail_reason||'Dreamina generation failed'};
    const upstream=d.error && d.error.upstream_code;
    if ((Number.isSafeInteger(upstream) && upstream!==0) || (typeof upstream==='string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(upstream))) result.error.upstream_code=upstream;
  }
  return result;
}}};
