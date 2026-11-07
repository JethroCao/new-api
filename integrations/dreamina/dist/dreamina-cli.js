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
  apiVersion: 1, key: 'dreamina-cli', name: 'Dreamina CLI Video', icon: 'text:即梦', version: '0.3.0',
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
function seconds_buildSubmitRequest(ctx) {
  if (!ctx.publicTaskId) throw new Error('Gateway public task ID is required for idempotency');
  return {url:base(ctx)+'/v1/jobs',method:'POST',headers:Object.assign(auth(ctx),{'Content-Type':'application/json','Idempotency-Key':ctx.publicTaskId}),body:outbound(ctx)};
}
function upstreamCreditQuote(response, job) {
  const headers=response && response.headers || {};
  const name=Object.keys(headers).find(k=>k.toLowerCase()==='x-upstream-credit-quote');
  if(!name)return undefined;
  // Submit responses expose http.Header (string[]); poll responses flatten
  // headers to strings. Both paths carry the same authenticated metadata.
  const encoded=Array.isArray(headers[name])?headers[name][0]:headers[name];
  let quote;
  if (typeof encoded === 'string' && encoded.length > 0 && encoded.length <= 4096 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    try { quote = JSON.parse(utils.base64URLDecode(encoded.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''))); }
    catch { /* Invalid metadata is handled below. */ }
  }
  if (!object(quote) || quote.source !== 'dreamina_canvas_cli' ||
      !Number.isSafeInteger(quote.credits) || quote.credits < 0 || quote.credits > 1000000000 ||
      !Number.isSafeInteger(quote.quoted_at_ms) || quote.quoted_at_ms <= 0 ||
      !job || quote.model !== job.model || quote.mode !== job.mode || quote.resolution !== job.resolution ||
      quote.ratio !== job.ratio || quote.seconds !== job.seconds || quote.count !== job.n ||
      !(job.mode === 'promote' ? ['submission_response','operation_response'] : ['before_generation']).includes(quote.quote_stage) ||
      (job.billing && (has(job.billing, 'quote_status')
        ? job.billing.quoted_credits !== quote.credits
        : job.billing.basis !== 'accepted_quote' || job.billing.credits !== quote.credits))) {
    if (job?.billing) {
      throw Error('Credit billing quote metadata does not match the task receipt; original generation retained for review');
    }
    return undefined;
  }
  // Stock Task Plugin v1 persists this snapshot in private plugin state.
  // Never expose procurement metadata through taskData or renderers.
  return quote;
}
function seconds_parseSubmitResponse(ctx, response) {
  if (!response.body || typeof response.body.id !== 'string' || !response.body.id) throw new Error('Bridge returned no task ID');
  const quote=upstreamCreditQuote(response, response.body);
  return {taskId:response.body.id,taskData:response.body,...(quote?{state:{creditQuote:quote}}:{})};
}
function seconds_buildQueryRequest(ctx) { return {url:base(ctx)+'/v1/jobs/'+encodeURIComponent(ctx.taskId),method:'GET',headers:auth(ctx)}; }
function seconds_parseTaskResult(ctx, body, response) {
  if (response && response.status !== 200) throw new Error('Bridge query is temporarily unavailable');
  const statuses={queued:'QUEUED',in_progress:'IN_PROGRESS',completed:'SUCCESS',failed:'FAILURE'};
  const status=statuses[(body||{}).status] || 'UNKNOWN';
  const result={status:status};
  // The first authenticated quote remains the audit snapshot on later polls.
  if (body?.id === ctx.taskId && (!ctx.state?.creditQuote || body.billing)) {
    try {
      const quote = upstreamCreditQuote(response, body);
      if (quote && !ctx.state?.creditQuote) result.state = {...ctx.state, creditQuote: quote};
    } catch (error) {
      return {status: 'UNKNOWN', reason: error.message};
    }
  }
  if (status==='SUCCESS') result.progress='100%';
  if (status==='FAILURE') result.reason=body.error && body.error.message || 'Dreamina generation failed';
  if (status==='FAILURE' && body.recovery && body.recovery.message) result.reason+='；'+String(body.recovery.message).slice(0,4096);
  // Existing task log/details fields support text, so abnormal tasks need not
  // masquerade as a fixed 30% progress value or require a new gateway status.
  const action=body && body.recovery && body.recovery.action;
  const progress={manual_review:'提交状态待核查',retry_query:'查询异常，正在重查',retry_download:'正在获取视频'};
  if(progress[action])result.progress=progress[action];
  if (status==='UNKNOWN') result.reason='Unrecognized bridge task status';
  return result;
}
function seconds_extractUsage(ctx) {
  const r=outbound(ctx);
  return {seconds:r.seconds*r.n,resolution:r.resolution.toLowerCase(),mode:r.mode,reference_video:r.references.some(x=>x.type==='video')};
}
function seconds_extractUsageOnComplete(ctx,result,body) {
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
  if(task.status==='SUCCESS'&&d.object==='video'){
    const downloaded=Number.isSafeInteger(d.timings&&d.timings.download_completed_at_ms)&&d.timings.download_completed_at_ms>0?Math.floor(d.timings.download_completed_at_ms/1000):d.completed_at;
    const expires=Number.isSafeInteger(d.content_expires_at)&&d.content_expires_at>0?d.content_expires_at:Number.isSafeInteger(downloaded)&&downloaded>0?downloaded+28800:undefined;
    if(expires){result.content_expires_at=expires;result.content_expired=Date.now()>=expires*1000;}
  }
  for (const key of ['seconds','n','resolution','ratio','mode','warning']) if(d[key]!==undefined) result[key]=d[key];
  if(d.video_count!==undefined) result.video_count=task.status==='SUCCESS'?d.video_count:0;
  // Delivery follows the official host task status. The plugin does not
  // control the host's funding transaction or publish a separate settling state.
  const bridgeCompleted=d.status==='completed' || d.phase==='completed' || d.recovery?.action==='completed';
  if(task.status!=='SUCCESS' && bridgeCompleted) {
    if(task.status==='FAILURE') {
      const message=task.fail_reason || '任务失败，请核查原任务';
      return {...result,phase:'failed',error:{code:'video_generation_failed',message},
        recovery:{action:'review_failure',message,automatic_resubmit:false}};
    }
    return {...result,phase:'needs_attention',recovery:{action:'manual_review',
      message:'任务状态待核查，请稍后查询',automatic_resubmit:false}};
  }
  if(d.recovery && ['wait','completed','manual_review','retry_query','retry_download','add_credits_then_resubmit','fix_input_then_resubmit','review_failure','resubmit'].includes(d.recovery.action)) {
    result.recovery={action:d.recovery.action,message:String(d.recovery.message || '').slice(0,4096),automatic_resubmit:false};
  }
  if(d.phase)result.phase=d.phase;
  if(d.diagnostics) {
    result.diagnostics={};
    for(const key of ['last_query_at_ms','next_poll_at_ms','consecutive_query_errors'])if(Number.isSafeInteger(d.diagnostics[key]))result.diagnostics[key]=d.diagnostics[key];
    const e=d.diagnostics.last_error;
    if(e) {
      result.diagnostics.last_error={};
      for(const key of ['code','message','request_id','stage','at_ms','resolved_at_ms'])if(typeof e[key]==='string' || Number.isSafeInteger(e[key]))result.diagnostics.last_error[key]=e[key];
    }
  }
  if(task.status==='FAILURE') {
    result.error={code:'video_generation_failed',message:task.fail_reason||'Dreamina generation failed'};
    const upstream=d.error && d.error.upstream_code;
    if ((Number.isSafeInteger(upstream) && upstream!==0) || (typeof upstream==='string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(upstream))) result.error.upstream_code=upstream;
  }
  return result;
}}};

// Generated credit variant; rebuild with build-credit-plugin.mjs.
const CREDIT_MODELS=["seedance_2.5","seedance_2.5_draft","seedance_2.0_vip","seedance_2.0_fast_vip","seedance_2.0_mini","seedance_pro_fast","happyhorse_1.1","wan_3.0"];
const PROMOTION_RESERVATION=null;
// Appended to the shared, self-contained protocol by build-credit-plugin.mjs.
meta.version='1.3.0';
meta.models=CREDIT_MODELS.concat(CREDIT_MODELS.includes('seedance_2.5')?['dreamina-video']:[]);
meta.usageSchema={
 credits:{type:'number',unit:'credit',description:{en:'Dreamina credit unit price',zh:'即梦积分单价'}},
 resolution:{enum:['480p','720p','1080p','4k'],description:{en:'Output video resolution',zh:'输出视频分辨率'}},
};

// Measured with Canvas CLI 1.2.0 on 2026-11-05 (2,289 quote-only cases).
// Values are credits, not monetary prices or confirmed ledger deductions.
// Each tier is [no reference video, with reference video].
const CREDIT_RATES = {
 'seedance_2.5': {'480p':[12,9], '720p':[20,13], '1080p':[64,64]},
 'seedance_2.5_draft': {'480p':[9,9]},
 'seedance_2.0_vip': {'720p':[14,14], '1080p':[33,33], '4k':[80,80]},
 'seedance_2.0_fast_vip': {'720p':[6,6]},
 'seedance_2.0_mini': {'720p':[6,6]},
 'seedance_pro_fast': {'720p':[2,null], '1080p':[4,null]},
 'happyhorse_1.1': {'720p':[14,null], '1080p':[18,null]},
 'wan_3.0': {'720p':[14,14], '1080p':[33,33]},
};
// The official limit applies to the sum, not each reference separately.
const REFERENCE_VIDEO_SECONDS = {
 'seedance_2.5':30.2, 'seedance_2.5_draft':30.2,
 'seedance_2.0_vip':15.4, 'seedance_2.0_fast_vip':15.4,
 'seedance_2.0_mini':15.4, 'wan_3.0':15,
};
function reservation(ctx) {
 const r=outbound(ctx);
 if(!CREDIT_MODELS.includes(r.model))throw Error('Credit estimation is not configured for this model');
 // Promotion was not part of the survey and has no separate quote endpoint.
 // Preserve its explicit, operator-selected ceiling instead of inventing a rate.
 if(r.mode==='promote') {
  if(!PROMOTION_RESERVATION)throw Error('Promotion requires an explicit credit reservation');
  return {version:1,request_id:ctx.publicTaskId,reserved_credits:PROMOTION_RESERVATION};
 }
 const video=r.references.some(ref=>ref.type==='video');
 const rates=CREDIT_RATES[r.model][r.resolution.toLowerCase()];
 // extractUsage cannot fetch or inspect uploaded media. Reserve the maximum
 // TOTAL video duration permitted by this model, never trust client metadata.
 // Quote law: round(sum(duration)) once, then add output seconds and apply n.
 // Image/audio references do not add credits in the surveyed combinations.
 const referenceSeconds=video?Math.floor(REFERENCE_VIDEO_SECONDS[r.model]+0.5):0;
 const credits=(r.seconds+referenceSeconds)*rates[video?1:0]*r.n;
 if(!Number.isSafeInteger(credits) || credits<1 || credits>1000000000)throw Error('Invalid estimated credits');
 return {version:2,request_id:ctx.publicTaskId,reserved_credits:credits};
}
export function extractUsage(ctx) {
  if (ctx.usagePurpose === 'billing_ratios') {
    throw Error('Configure a credit billing expression for this Dreamina model');
  }
  return {credits: reservation(ctx).reserved_credits, resolution: outbound(ctx).resolution.toLowerCase()};
}
export function buildSubmitRequest(ctx) {
 const result=seconds_buildSubmitRequest(ctx);
 result.headers['X-Dreamina-Billing']=JSON.stringify(reservation(ctx));
 result.headers['X-Dreamina-Receipt']='header-v1';
 return result;
}
export function buildQueryRequest(ctx) {
 const result=seconds_buildQueryRequest(ctx);
 result.headers['X-Dreamina-Receipt']='header-v1';
 return result;
}

// New bridges keep the billing receipt out of the body persisted as Task.Data.
// A legacy bridge may still return it in the body; private headers take priority
// only when both representations agree. Never reuse an earlier poll's receipt.
function receiptBody(body, response) {
 const headers=response && response.headers || {};
 const name=Object.keys(headers).find(key=>key.toLowerCase()==='x-dreamina-billing-receipt');
 if(!name)return body;
 const encoded=Array.isArray(headers[name])?headers[name][0]:headers[name];
 let receipt;
 if(typeof encoded==='string' && encoded.length>0 && encoded.length<=4096 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
  try {receipt=JSON.parse(utils.base64URLDecode(encoded.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')));}
  catch { /* Reject malformed authenticated metadata below. */ }
 }
 if(!object(body) || !object(receipt) || Object.keys(receipt).some(key=>!['id','billing'].includes(key)) ||
    receipt.id!==body.id || !object(receipt.billing) ||
    (has(body,'billing') && (!object(body.billing) || Object.keys(body.billing).length!==Object.keys(receipt.billing).length ||
      Object.keys(receipt.billing).some(key=>body.billing[key]!==receipt.billing[key])))) {
  throw Error('Credit billing receipt metadata does not match the task; original generation retained for review');
 }
 return {...body,billing:receipt.billing};
}
export function parseSubmitResponse(ctx, response) {
  const body=receiptBody(response.body,response);
  const result = seconds_parseSubmitResponse(ctx, {...response,body});
  const {billing: privateReceipt, ...publicData}=result.taskData;
  result.taskData=publicData;
  const request = outbound(ctx);
  const expected = reservation(ctx);
  result.state = {
    ...(result.state || {}),
    billingReceipt:privateReceipt,
    billing: {...expected, job_id: result.taskId, model: request.model, seconds: request.seconds,
      n: request.n, mode: request.mode, resolution: request.resolution, ratio: request.ratio},
  };
  const stored = {taskId: result.taskId, publicTaskId: ctx.publicTaskId, state: result.state};
  const evidence = billingEvidence(stored, body);
  result.state = observeQuoteState(result.state, evidence);
  return result;
}

// Only a trusted bridge can identify a job created without the credit contract.
// Check the gateway's previous snapshot as well: a lost or invalid new receipt
// must not cause a paid job to settle against an old seconds expression.
function receiptUnit(ctx, body) {
  const previous = ctx.data;
  const frozen = ctx.state && ctx.state.billing;
  const keys = ['model', 'seconds', 'n', 'mode', 'resolution', 'ratio'];

  if (!object(body) || body.object !== 'video' || !ctx.taskId || body.id !== ctx.taskId) {
    throw Error('Credit billing task identity mismatch; original generation retained for review');
  }

  const receipt = body.billing;
  if (body.billing_mode === 'legacy_seconds') {
    if ((ctx.state && ['billing','quotedCredits','quoteStatus','acceptedQuoteCredits','settledCredits','deliveredCount'].some(key => has(ctx.state,key))) ||
        has(body, 'billing') ||
        !object(previous) || has(previous, 'billing') || previous.id !== ctx.taskId ||
        previous.object !== 'video' ||
        (has(previous, 'billing_mode') && previous.billing_mode !== 'legacy_seconds') ||
        keys.some(key => !has(previous, key) || previous[key] !== body[key])) {
      throw Error('Legacy billing identity is missing or inconsistent; original generation retained for review');
    }
    return 'seconds';
  }

  if ((has(body, 'billing_mode') && body.billing_mode !== 'credits') ||
      !object(frozen) || ![1, 2].includes(frozen.version) || !object(receipt) ||
      typeof ctx.publicTaskId !== 'string' || !ctx.publicTaskId ||
      !Number.isSafeInteger(frozen.reserved_credits) || frozen.reserved_credits < 1 || frozen.reserved_credits > 1000000000 ||
      receipt.version !== frozen.version || receipt.request_id !== frozen.request_id ||
      ctx.publicTaskId !== frozen.request_id || receipt.reserved_credits !== frozen.reserved_credits ||
      frozen.job_id !== ctx.taskId || keys.some(key => body[key] !== frozen[key])) {
    throw Error('Credit billing evidence is missing or inconsistent; original generation retained for review');
  }
  return 'credits';
}

// Validate immutable identity separately from the quotation. A genuine failure
// of this task can return its original error before any valid price exists.
function billingEvidence(ctx, body, unit = receiptUnit(ctx, body)) {
  if (unit === 'seconds') return {unit};
  const frozen = ctx.state.billing;
  const receipt = body.billing;
  const staged = has(receipt, 'quote_status') || has(receipt, 'quoted_credits');
  const hasAcceptedAmount = has(receipt, 'credits') || has(receipt, 'basis');
  const amount = staged ? receipt.quoted_credits : hasAcceptedAmount ? receipt.credits : undefined;
  let status = staged ? receipt.quote_status : undefined;
  if (!staged && hasAcceptedAmount) {
    // Older bridges used accepted_quote even if the run was rejected or
    // confirmation never happened. An acceptance timestamp or a successful
    // delivery is independent evidence from that same job.
    const t = body.timings || {};
    const accepted = t.accepted_at_ms > 0 || t.accepted_observed_at_ms > 0 ||
      (body.status === 'completed' && Number.isInteger(body.video_count) && body.video_count > 0);
    status = accepted ? 'accepted' : 'quoted';
  }
  const previous = ctx.data;
  const lastReceipt = previous?.id === ctx.taskId && previous.billing?.request_id === ctx.publicTaskId &&
    previous.billing.version === frozen.version && previous.billing.reserved_credits === frozen.reserved_credits ? previous.billing : undefined;
  if ((staged && (!['quoted', 'confirmed', 'accepted'].includes(status) ||
        ((status === 'accepted') !== hasAcceptedAmount))) ||
      (hasAcceptedAmount && (receipt.basis !== 'accepted_quote' || receipt.credits !== amount)) ||
      ((staged || hasAcceptedAmount) && (!Number.isSafeInteger(amount) || amount < 0 || amount > 1000000000)) ||
      (status === 'accepted' && frozen.version === 1 && amount > frozen.reserved_credits) ||
      (has(ctx.state, 'quotedCredits') && ctx.state.quotedCredits !== amount) ||
      (has(ctx.state, 'acceptedQuoteCredits') && ctx.state.acceptedQuoteCredits !== amount) ||
      (ctx.state.creditQuote && ctx.state.creditQuote.credits !== amount) ||
      (lastReceipt && has(lastReceipt, 'quoted_credits') && lastReceipt.quoted_credits !== amount) ||
      (lastReceipt?.basis === 'accepted_quote' && lastReceipt.credits !== amount)) {
    throw Error('Credit billing quote is missing or inconsistent; original generation retained for review');
  }
  return {unit: 'credits', quoted: amount, status, credits: status === 'accepted' ? amount : undefined};
}

function observeQuoteState(state, evidence) {
  if (evidence.quoted === undefined) return state;
  const phases = ['quoted', 'confirmed', 'accepted'];
  const status = phases.indexOf(state.quoteStatus) > phases.indexOf(evidence.status) ? state.quoteStatus : evidence.status;
  if (state.quotedCredits === evidence.quoted && state.quoteStatus === status &&
      (status === 'accepted' ? state.acceptedQuoteCredits === evidence.quoted : !has(state, 'acceptedQuoteCredits'))) return state;
  const next = {...state, quotedCredits: evidence.quoted, quoteStatus: status};
  if (status === 'accepted') next.acceptedQuoteCredits = evidence.quoted;
  else delete next.acceptedQuoteCredits; // old plugins persisted this name immediately after a quote
  return next;
}

// Terminal parsing and the host's settlement hook use the same evidence.
// A successful response needs verified usage before it can reach settlement.
function completionUsage(ctx, body, evidence) {
  if (body.content_expired === true || body.delivery_verified === false || body.terminal_proof === false ||
      (evidence.unit === 'credits' && (body.delivery_verified !== true || body.terminal_proof !== true))) {
    throw Error('Original operation or media delivery is not verified; original generation retained for review');
  }
  const delivered = body.video_count;
  if (!Number.isSafeInteger(body.n) || body.n < 1 || body.n > 4 ||
      !Number.isSafeInteger(delivered) || delivered < 1 || delivered > body.n) {
    throw Error('Invalid or empty batch delivery count; original generation retained for review');
  }
  if (evidence.unit === 'seconds') {
    return seconds_extractUsageOnComplete(ctx, null, body);
  }
  if (evidence.credits === undefined) {
    throw Error('Credit billing quote is missing from the completed task; original generation retained for review');
  }
  // The batch is homogeneous. Leave fractional customer credits unrounded
  // until the host applies the price and converts money to quota.
  return {credits: evidence.credits * delivered / body.n, resolution: ctx.state.billing.resolution.toLowerCase()};
}

export function parseTaskResult(ctx, body, response) {
  if (response && response.status !== 200) throw Error('Bridge query is temporarily unavailable');
  let result;
  try {
    body=receiptBody(body,response);
    // Bind every response (including failure) before inspecting upstream
    // errors, artifacts or quote metadata that might belong to another task.
    const unit = receiptUnit(ctx, body);
    result = seconds_parseTaskResult(ctx, body, response);
    if (result.status === 'UNKNOWN') return {status:'UNKNOWN', reason:'即梦任务回执待核查：' + result.reason};
    if (result.status === 'FAILURE' && body.status !== 'failed') throw Error(result.reason);
    if (result.status === 'FAILURE') {
      if ((unit === 'credits' || has(body, 'video_count')) && body.video_count !== 0) {
        throw Error('Failure receipt does not prove zero delivered videos; original generation retained for review');
      }
      // A bound, zero-delivery failure needs no price to return the hold.
      // Explicit quote fields must still agree with the original acceptance:
      // absence and contradictory evidence are not interchangeable.
      if (unit === 'credits' && !['quote_status','quoted_credits','credits','basis'].some(key => has(body.billing,key))) {
        return result;
      }
    }
    const evidence = billingEvidence(ctx, body, unit);
    // A bound expired artifact cannot be newly delivered, but expiry is not
    // permission to refund a contradictory original quotation.
    if (result.status === 'SUCCESS' && body.content_expired === true) {
      return {status:'FAILURE', reason:'视频已超过保留期限，无法交付，预扣将退回'};
    }
    const current = result.state || ctx.state;
    const next = observeQuoteState(current, evidence);
    if (unit === 'credits') result.state = {...next,billingReceipt:body.billing};
    else if (next !== current) result.state = next;
    if (result.status === 'SUCCESS') {
      const usage = completionUsage(ctx, body, evidence);
      if (unit === 'credits') {
        result.state = {...result.state, settledCredits:usage.credits, deliveredCount:body.video_count};
      }
    }
    return result;
  } catch (error) {
    // UNKNOWN rejects this receipt. The stock host still applies its own
    // consecutive-poll-failure and timeout policies, which can refund the task.
    return {status:'UNKNOWN', reason:'即梦任务回执待核查：' + error.message};
  }
}

export function extractUsageOnComplete(ctx, result, body) {
  if (result.status !== 'SUCCESS' || body?.status !== 'completed') return {};
  if (!has(body,'billing') && body.billing_mode !== 'legacy_seconds') {
    // The stock adaptor passes the newly returned state on result.plugin_state;
    // ctx.state is the previous poll. Direct JavaScript callers use result.state.
    const state=result.plugin_state || result.state;
    if(!object(state) || !object(state.billingReceipt))throw Error('Current credit billing evidence is missing');
    ctx={...ctx,state};
    body={...body,billing:state.billingReceipt};
  }
  return completionUsage(ctx, body, billingEvidence(ctx, body));
}
