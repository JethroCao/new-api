// Appended to the shared, self-contained protocol by build-credit-plugin.mjs.
meta.version='1.6.0';
meta.models=CREDIT_MODELS.concat(CREDIT_MODELS.includes('seedance_2.5')?['dreamina-video']:[]);
meta.usageSchema={
 credits:{type:'number',unit:'credit',description:{en:'Dreamina credit unit price',zh:'即梦积分单价'}},
 resolution:{enum:['480p','720p','1080p','4k'],description:{en:'Output video resolution',zh:'输出视频分辨率'}},
};

const imageModels = CREDIT_MODELS.filter(model=>has(IMAGE_MODELS,model));
if (imageModels.length) {
  const videos = meta.models.filter(model=>!has(IMAGE_MODELS,model));
  meta.name='Dreamina CLI';
  meta.description={en:'Image and video generation through the official Dreamina Canvas CLI',zh:'通过官方即梦画布 CLI 生成图片和视频'};
  meta.protocols = [...(videos.length?[{name:'openai_video',models:videos}]:[]),{name:'openai_image',models:imageModels}];
  meta.usageProfiles=[{models:imageModels,schema:{
    credits:meta.usageSchema.credits,
    resolution:{enum:['1k','1.5k','2k','4k'],description:{en:'Output image resolution',zh:'输出图片分辨率'}},
  }}];
  protocols.openai_image={decodeRequest:decodeImage,render:(_ctx,task)=>({data:task.data.data.map(entry=>({url:entry.url}))})};
}

// The CLI takes a resolution tier and aspect ratio, never arbitrary pixels.
const imageSizes = {
  '1024x1024':['1K','1:1'], '1536x1536':['1.5K','1:1'], '2048x2048':['2K','1:1'], '4096x4096':['4K','1:1'],
  '1536x1024':['1.5K','3:2'], '1024x1536':['1.5K','2:3'],
  '2496x1664':['2K','3:2'], '1664x2496':['2K','2:3'], '2304x1728':['2K','4:3'], '1728x2304':['2K','3:4'],
  '2560x1440':['2K','16:9'], '1440x2560':['2K','9:16'], '2848x1600':['2K','16:9'], '1600x2848':['2K','9:16'],
  '3840x2160':['4K','16:9'], '2160x3840':['4K','9:16'],
};

function decodeImage(ctx) {
  const body=ctx.body || {};
  let raw, uploads=[];
  if (body.kind==='json' && object(body.value)) raw={...body.value};
  else if (body.kind==='multipart') {
    raw={};
    for (const [key,values] of Object.entries(body.fields||{})) {
      if (!Array.isArray(values) || values.length!==1) throw Error('Repeated field: '+key);
      raw[key]=values[0];
    }
    const files=body.files||[];
    const fields=new Set(files.map(f=>f.field));
    let ordered=files;
    if (files.length && !(fields.size===1 && (fields.has('image') || fields.has('image[]')))) {
      const indexed=files.map(file=>{
        const match=/^image\[(\d+)\]$/.exec(file.field);
        if (!match || !Number.isSafeInteger(Number(match[1]))) throw Error('Expected consistently numbered image uploads');
        return {index:Number(match[1]),file};
      });
      if (new Set(indexed.map(item=>item.index)).size!==indexed.length) throw Error('Duplicate image upload index');
      ordered=indexed.sort((a,b)=>a.index-b.index).map(item=>item.file);
    }
    let bytes=0;
    for (const f of ordered) {
      if (!String(f.mimeType).startsWith('image/')) throw Error('Expected an image upload');
      bytes+=bounded(f.size,undefined,1,MAX_INPUT_BYTES,'file size');
      if (bytes>MAX_INPUT_BYTES) throw Error('Total reference files exceed 64 MiB');
      uploads.push({__fileRef:f.ref,encoding:'dataUrl',mimeType:f.mimeType,maxBytes:MAX_INPUT_BYTES});
    }
  } else throw Error('JSON or multipart body required');
  const {image,response_format,size,stream,...req}=raw;
  if (stream!==undefined && stream!==false && !(body.kind==='multipart' && stream==='false')) throw Error('Image streaming is not supported');
  if (size!==undefined && size!=='auto') {
    if (typeof size!=='string') throw Error('Invalid image size');
    const pair=imageSizes[size.toLowerCase()];
    const tier=/^(1k|1\.5k|2k|4k)$/i.test(size)?size.toUpperCase():undefined;
    if (!tier && !has(imageSizes,size.toLowerCase())) throw Error('Unsupported image size; use resolution and ratio');
    const resolution=tier || pair[0];
    if (req.resolution!==undefined && (typeof req.resolution!=='string' || req.resolution.toUpperCase()!==resolution)) throw Error('size conflicts with resolution');
    req.resolution=resolution;
    if (!tier) {
      if (req.ratio!==undefined && req.ratio!==pair[1]) throw Error('size conflicts with ratio');
      req.ratio=pair[1];
    }
  }
  if (response_format!==undefined && !['url','b64_json'].includes(response_format)) throw Error('Unsupported response_format');
  if ((image!==undefined && (uploads.length || req.references!==undefined)) || (uploads.length && req.references!==undefined)) throw Error('Conflicting reference image inputs');
  if (image!==undefined) {
    const urls=Array.isArray(image)?image:[image];
    if (urls.some(url=>typeof url!=='string')) throw Error('Expected reference image URLs');
    req.references=urls.map(url=>({type:'image',url}));
  }
  if (uploads.length) req.references=uploads.map(url=>({type:'image',url}));
  const normalized=normalizeImage(req,ctx.upstreamModel||ctx.model,uploads.length>0);
  if (ctx.operation !== (normalized.mode==='i2i'?'edit':'generate')) throw Error('Use the edits endpoint with reference images and generations without them');
  return {kind:'submit',model:ctx.model,action:normalized.mode,requestBody:normalized};
}
function creditOutbound(ctx) {
  const model=ctx.upstreamModel||ctx.model;
  return has(IMAGE_MODELS,model)?normalizeImage(ctx.requestBody,model,true):outbound(ctx);
}
function deliveredCount(body) {
  return body.object==='image'?body.image_count:body.video_count;
}

// Measured with Canvas CLI 1.2.0 on 2026-11-05 (2,289 quote-only cases).
// Flash added from the 2026-11-13 survey (184 quote-only cases, CLI 1.2.0).
// Values are credits, not monetary prices or confirmed ledger deductions.
// Each tier is [no reference video, with reference video].
const CREDIT_RATES = {
 'seedance_2.5': {'480p':[12,9], '720p':[20,13], '1080p':[64,64]},
 'seedance_2.5_flash': {'480p':[7,7], '720p':[19,7]},
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
 'seedance_2.5':30.2, 'seedance_2.5_draft':30.2, 'seedance_2.5_flash':30.2,
 'seedance_2.0_vip':15.4, 'seedance_2.0_fast_vip':15.4,
 'seedance_2.0_mini':15.4, 'wan_3.0':15,
};
function reservation(ctx,r=creditOutbound(ctx)) {
 if(!CREDIT_MODELS.includes(r.model))throw Error('Credit estimation is not configured for this model');
 if (r.kind==='image') return {version:2,request_id:ctx.publicTaskId,reserved_credits:IMAGE_MODELS[r.model].rates[r.resolution]*r.n};
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
  const r=creditOutbound(ctx);
  return {credits:reservation(ctx,r).reserved_credits,resolution:r.resolution.toLowerCase()};
}
export function buildSubmitRequest(ctx) {
 const r=creditOutbound(ctx), result=bridgeSubmit(ctx,r);
 result.headers['X-Dreamina-Billing']=JSON.stringify(reservation(ctx,r));
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
  const request = creditOutbound(ctx);
  const expected = reservation(ctx,request);
  result.state = {
    ...(result.state || {}),
    billingReceipt:privateReceipt,
    billing: {...expected, job_id: result.taskId, model: request.model, ...(request.kind==='video'?{seconds:request.seconds}:{}),
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
  const keys = ['model','n','mode','resolution','ratio'];
  if (body?.object !== 'image') keys.push('seconds');

  if (!object(body) || body.object !== (frozen && has(IMAGE_MODELS,frozen.model) ? 'image' : 'video') || !ctx.taskId || body.id !== ctx.taskId) {
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
  const delivered = deliveredCount(body);
  const image = body.object === 'image';
  if (image && (!Array.isArray(body.data) || body.data.length!==delivered ||
      body.data.some(entry=>!entry || typeof entry.url!=='string' || !/^https?:\/\//.test(entry.url)) ||
      new Set(body.data.map(entry=>entry.url)).size!==delivered)) throw Error('Image delivery receipt mismatch');
  if (!Number.isSafeInteger(body.n) || body.n < 1 || body.n > (image ? IMAGE_MODELS[body.model].max : 4) ||
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
      if ((unit === 'credits' || has(body, 'video_count')) && (deliveredCount(body) !== 0 || body.object==='image' && (!Array.isArray(body.data) || body.data.length!==0))) {
        throw Error('Failure receipt does not prove zero delivered outputs; original generation retained for review');
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
      return {status:'FAILURE', reason:body.object==='image'?'图片已超过保留期限，无法交付，预扣将退回':'视频已超过保留期限，无法交付，预扣将退回'};
    }
    const current = result.state || ctx.state;
    const next = observeQuoteState(current, evidence);
    if (unit === 'credits') result.state = {...next,billingReceipt:body.billing};
    else if (next !== current) result.state = next;
    if (result.status === 'SUCCESS') {
      const usage = completionUsage(ctx, body, evidence);
      if (unit === 'credits') {
        result.state = {...result.state, settledCredits:usage.credits, deliveredCount:deliveredCount(body)};
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
