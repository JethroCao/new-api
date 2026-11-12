const SEEDANCE_20 = { resolutions: ["720p", "1080p", "2160p"], minSeconds: 4, maxSeconds: 15, images: 9, videos: 3, audios: 3, references: 12, audioNeedsVisual: true };
const SEEDANCE_20_720P = { ...SEEDANCE_20, resolutions: ["720p"], defaultResolution: "720p" };
const MODELS = {
  "Seedance-2.0": SEEDANCE_20,
  "Seedance-2.0-Fast": SEEDANCE_20_720P,
  "Seedance-2.0-mini": SEEDANCE_20_720P,
  "Seedance-2.5": { resolutions: ["480p", "720p", "1080p"], minSeconds: 4, maxSeconds: 30, images: 30, videos: 10, audios: 10, references: 50 },
  "Wan-3.0": { resolutions: ["480p", "720p", "1080p"], defaultResolution: "1080p", minSeconds: 2, maxSeconds: 30, images: 10, videos: 5, audios: 5, references: 20 },
};
const ASPECT_RATIOS = ["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"];
const SIZES = {
  "854x480": ["480p", "16:9"], "480x854": ["480p", "9:16"],
  "1280x720": ["720p", "16:9"], "720x1280": ["720p", "9:16"],
  "1920x1080": ["1080p", "16:9"], "1080x1920": ["1080p", "9:16"],
  "3840x2160": ["2160p", "16:9"], "2160x3840": ["2160p", "9:16"],
};
const INPUT_FIELDS = ["model", "prompt", "seconds", "duration", "resolution", "size", "ratio", "aspect_ratio", "n", "mode", "input_reference", "references", "images", "videos", "audios", "first_image", "last_image", "generate_audio", "watermark"];
const STATUS = { queued: "QUEUED", running: "IN_PROGRESS", completed: "SUCCESS", failed: "FAILURE" };
const MEDIA_FIELDS = { image: "images", video: "videos", audio: "audios" };
// Public no-input-video rates checked against UStori's account documentation
// on 2026-11-12. Integer hundredths of a credit per second, estimates only.
// Do not apply an account discount twice: charged_amount already includes it.
const CREDIT_RATES = {
  "Seedance-2.0": { "720p": 385, "1080p": 910, "2160p": 2200 },
  "Seedance-2.0-Fast": { "720p": 165 },
  "Seedance-2.0-mini": { "720p": 165 },
  "Seedance-2.5": { "480p": 330, "720p": 495, "1080p": 1760 },
  "Wan-3.0": { "480p": 300, "720p": 600, "1080p": 1200 },
};
const CREDIT_BILLING = "ustori_credits_v1";

export const meta = {
  apiVersion: 1,
  key: "ustori",
  name: "UStori Video",
  icon: "text:US",
  version: "1.1.0",
  author: { name: "Nexora" },
  description: { en: "Video generation through the UStori API", zh: "通过 UStori API 生成视频" },
  baseUrl: "https://platform.ustori.com",
  website: "https://platform.ustori.com/console/docs",
  auth: "api_key",
  models: Object.keys(MODELS),
  fetchMode: "per_task",
  protocols: ["openai_video"],
  usageSchema: {
    credits: { type: "number", unit: "credit", description: { en: "UStori credit unit price", zh: "UStori 积分单价" } },
    resolution: { enum: ["480p", "720p", "1080p", "2160p"], description: { en: "Output video resolution", zh: "输出视频分辨率" } },
    video_input: { enum: ["none", "video"], description: { en: "Reference video input", zh: "参考视频输入" } },
  },
};

function modelName(value) {
  const name = meta.models.find(model => typeof value === "string" && model.toLowerCase() === value.toLowerCase());
  if (!name) throw new Error("Unsupported UStori video model");
  return name;
}

function aliased(primary, alias, field) {
  if (primary !== undefined && alias !== undefined && primary !== alias) throw new Error(field + " conflicts with its alias");
  return primary === undefined ? alias : primary;
}

function httpURL(value) {
  return typeof value === "string" && value.length <= 65536 && /^https?:\/\/[^/@?#]+(?:[/?#].*)?$/i.test(value) && !/[\s\\\u0000-\u001f\u007f]/.test(value);
}

function mediaURL(value, field) {
  if (!httpURL(value)) throw new Error(field + " must be an HTTP(S) URL without credentials");
  return value;
}

function normalizeInput(request, model) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("JSON object required");
  for (const key of Object.keys(request)) {
    if (!INPUT_FIELDS.includes(key)) throw new Error("Unsupported UStori video field: " + key);
  }
  if (request.n !== undefined && request.n !== 1) throw new Error("n must be 1 for UStori video requests");

  const spec = MODELS[model];
  const isWan = model === "Wan-3.0";
  const requestedDuration = aliased(request.duration, request.seconds, "duration");
  const duration = requestedDuration === undefined ? 5 : requestedDuration;
  if (!(isWan && duration === -1) && (!Number.isSafeInteger(duration) || duration < spec.minSeconds || duration > spec.maxSeconds)) {
    throw new Error("duration must be an integer between " + spec.minSeconds + " and " + spec.maxSeconds + (isWan ? ", or -1 for automatic duration" : ""));
  }
  let resolution = typeof request.resolution === "string" ? request.resolution.toLowerCase() : request.resolution;
  if (resolution === "4k") resolution = "2160p";
  let ratio = aliased(request.aspect_ratio, request.ratio, "aspect_ratio");
  if (request.size !== undefined) {
    const size = typeof request.size === "string" && Object.hasOwn(SIZES, request.size) ? SIZES[request.size] : null;
    if (!size) throw new Error("Unsupported size; use resolution and ratio");
    resolution = aliased(resolution, size[0], "resolution");
    ratio = aliased(ratio, size[1], "aspect_ratio");
  }
  if (resolution === undefined) resolution = spec.defaultResolution;
  if (!spec.resolutions.includes(resolution)) throw new Error("resolution must be one of " + spec.resolutions.join(", "));
  if (ratio !== undefined && !ASPECT_RATIOS.includes(ratio) && !(isWan && ratio === "adaptive")) throw new Error("Unsupported aspect_ratio");
  const input = { duration, resolution };
  if (ratio !== undefined) input.aspect_ratio = ratio;

  const hasNativeMedia = ["images", "videos", "audios", "first_image", "last_image"].some(key => request[key] !== undefined);
  const references = request.references === undefined ? [] : request.references;
  if (!Array.isArray(references) || references.length > spec.references) throw new Error("Invalid references count");
  const hasReferenceList = references.length > 0;
  if ((hasReferenceList && request.input_reference !== undefined) || ((hasReferenceList || request.input_reference !== undefined) && hasNativeMedia)) {
    throw new Error("Use one of references, input_reference, or the UStori media fields");
  }
  if (request.mode !== undefined && !["t2v", "m2v", "first_last_frame"].includes(request.mode)) throw new Error("Unsupported UStori video mode");
  if (hasReferenceList) {
    const frames = request.mode === "first_last_frame" || (request.mode === undefined && references.length === 1 && references[0]?.type === "image");
    if (frames && references.length > 2) throw new Error("First/last frame mode accepts up to two images");
    for (let index = 0; index < references.length; index++) {
      const reference = references[index];
      if (typeof reference?.type !== "string" || !Object.hasOwn(MEDIA_FIELDS, reference.type)) throw new Error("Each reference must have type image, video, or audio");
      const url = mediaURL(reference.url, "Reference");
      if (frames) {
        if (reference.type !== "image") throw new Error("First/last frames must be images");
        input[index === 0 ? "first_image" : "last_image"] = url;
      } else {
        const key = MEDIA_FIELDS[reference.type];
        (input[key] ||= []).push(url);
      }
    }
  } else {
    const firstImage = request.input_reference === undefined ? request.first_image : request.input_reference;
    if (firstImage !== undefined) input.first_image = mediaURL(firstImage, "first_image");
    if (request.last_image !== undefined) input.last_image = mediaURL(request.last_image, "last_image");
    for (const key of ["images", "videos", "audios"]) {
      if (request[key] === undefined) continue;
      if (!Array.isArray(request[key]) || !request[key].length || request[key].length > spec[key]) throw new Error("Invalid " + key + " count");
      input[key] = request[key].map(url => mediaURL(url, key));
    }
  }

  let referenceCount = 0;
  for (const key of ["images", "videos", "audios"]) {
    const count = input[key]?.length || 0;
    if (count > spec[key]) throw new Error("Too many " + key + " references");
    referenceCount += count;
  }
  if (referenceCount > spec.references) throw new Error("Too many references for this model");
  if (input.last_image && !input.first_image) throw new Error("last_image requires first_image");
  if (input.first_image && referenceCount) throw new Error("First/last frames cannot be combined with reference media");
  if (input.first_image && !isWan && ratio !== undefined) throw new Error("Seedance first/last frames follow the source image; omit ratio and size");
  // UStori bills the combined input and output duration. The public API does
  // not give us a trusted reference duration, so do not accept an unmetered job.
  if (input.videos?.length) throw new Error("UStori reference video duration cannot be verified for billing");
  if (spec.audioNeedsVisual && input.audios && !input.images && !input.videos) throw new Error("Audio references require an image or video reference on this model");
  const mode = input.first_image ? "first_last_frame" : referenceCount ? "m2v" : "t2v";
  if (request.mode !== undefined && request.mode !== mode) throw new Error("mode does not match the supplied media");

  if (request.prompt !== undefined) {
    if (typeof request.prompt !== "string" || (isWan && request.prompt.length > 20000)) throw new Error("Invalid prompt");
    if (request.prompt.trim()) input.prompt = request.prompt;
  }
  if (!input.prompt && (mode === "t2v" || (mode === "first_last_frame" && !isWan))) throw new Error("This video request requires a prompt");
  for (const key of ["generate_audio", "watermark"]) {
    if (request[key] === undefined) continue;
    if (!isWan || typeof request[key] !== "boolean") throw new Error(key + " must be a boolean and is supported only on Wan-3.0");
    input[key] = request[key];
  }
  return { input, mode };
}

function tasksURL(ctx) {
  return ctx.baseUrl.replace(/\/+$/, "") + "/api/v1/tasks";
}

function videoURLs(data) {
  const urls = data?.result?.videos;
  // The host accepts up to 64 artifacts per task.
  if (!Array.isArray(urls) || !urls.length || urls.length > 64 || !urls.every(httpURL)) return [];
  return urls;
}

export function buildSubmitRequest(ctx) {
  if (!ctx.publicTaskId) throw new Error("Gateway task ID required for UStori idempotency");
  return {
    url: tasksURL(ctx),
    method: "POST",
    headers: { Authorization: "Bearer " + ctx.apiKey, "Content-Type": "application/json", "Idempotency-Key": ctx.publicTaskId },
    body: { model: modelName(ctx.upstreamModel || ctx.model), input: ctx.requestBody },
  };
}

export function parseSubmitResponse(ctx, response) {
  const body = response.body;
  if (typeof body?.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) throw new Error("UStori returned an invalid task ID");
  // A receipt with an ID can be polled even if UStori adds an initial status.
  const recognized = typeof body.status === "string" && Object.hasOwn(STATUS, body.status);
  return {
    taskId: body.id,
    taskData: recognized ? { status: body.status } : {},
    state: { autoDuration: ctx.requestBody.duration === -1, billingMode: CREDIT_BILLING, model: modelName(ctx.upstreamModel || ctx.model) },
  };
}

export function buildQueryRequest(ctx) {
  return { url: tasksURL(ctx) + "/" + encodeURIComponent(ctx.taskId), method: "GET", headers: { Authorization: "Bearer " + ctx.apiKey } };
}

function automaticOutputSeconds(body) {
  // This is the documented rounded-up output duration, not UStori's invoice quantity.
  const seconds = body?.usage?.video_seconds;
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= MODELS["Wan-3.0"].maxSeconds ? seconds : null;
}

function finalBillingIssue(body) {
  // Only explicit, recognized billing states can wait without consuming the
  // host's consecutive-error budget. Invalid values remain UNKNOWN; neither
  // this wait nor its warning disables the host's overall task timeout.
  const amount = body.charged_amount;
  const version = body.billing_rule_version;
  if (amount != null && (!Number.isSafeInteger(amount) || amount < 0 || amount > 100000000000000)) return { status: "invalid", code: "ustori_billing_amount_invalid", message: "UStori 返回的实际扣款金额格式或范围异常" };
  if (version != null && version !== "discount_cent_v1") return { status: "invalid", code: "ustori_billing_version_unsupported", message: "UStori 返回的计费版本无法识别，不能确认金额单位" };
  if (body.billing_status === "reserved") return { status: "pending", code: "ustori_billing_pending", message: "UStori 视频已生成，正在等待上游完成结算" };
  if (body.billing_status !== "charged") return { status: "invalid", code: "ustori_billing_status_invalid", message: "UStori 已完成任务的扣款状态缺失或异常" };
  if (amount == null) return { status: "pending", code: "ustori_billing_amount_pending", message: "UStori 已标记扣款，正在等待实际扣款金额" };
  if (version == null) return { status: "pending", code: "ustori_billing_version_pending", message: "UStori 已标记扣款，正在等待计费版本以确认金额单位" };
  return null;
}

function chargedCredits(ctx, body) {
  // The authenticated task API returns microyuan, not credits: 1 credit is
  // CNY 0.10 = 100,000 microyuan. Keep fractional credits and explicit zero.
  // Only this billing version's units have been verified; do not guess when
  // the provider changes them or substitute reserved_amount/standard_amount.
  const amount = body?.charged_amount;
  if (ctx.state?.billingMode !== CREDIT_BILLING || body?.id !== ctx.taskId ||
      body.model_name !== ctx.state.model || body.status !== "completed" ||
      finalBillingIssue(body) !== null) {
    return null;
  }
  return amount / 100000;
}

export function parseTaskResult(ctx, body) {
  if (!body || body.id !== ctx.taskId) return { status: "UNKNOWN", reason: "ustori_receipt_mismatch: UStori 回执与原任务不匹配，请管理员核对，勿重复提交" };
  if (typeof body.status !== "string" || !Object.hasOwn(STATUS, body.status)) return { status: "UNKNOWN", reason: "ustori_task_status_unknown: UStori 任务状态无法识别，请管理员核对，勿重复提交" };
  const creditBilling = ctx.state?.billingMode === CREDIT_BILLING;
  if ((ctx.state?.billingMode !== undefined && !creditBilling) ||
      (creditBilling && body.model_name !== ctx.state.model)) return { status: "UNKNOWN", reason: "ustori_billing_context_mismatch: UStori 回执模型或本地计费版本不匹配，请管理员核对，勿重复提交" };
  const status = STATUS[body.status];
  if (status === "SUCCESS") {
    if (!videoURLs(body).length) return { status: "UNKNOWN", reason: "ustori_video_missing: UStori 已标记完成但缺少有效视频地址，请管理员核对交付与扣款，勿重复提交" };
    if (creditBilling) {
      const issue = finalBillingIssue(body);
      if (issue) {
        const reason = issue.code + ": " + issue.message + "；请勿重复提交，请管理员在任务超时前核对上游账单";
        if (issue.status === "pending") return { status: "IN_PROGRESS", progress: "99%", reason };
        return { status: "UNKNOWN", reason };
      }
    } else if (ctx.state?.autoDuration && automaticOutputSeconds(body) === null) {
      // Missing completion facts otherwise cause the host to settle the reservation.
      return { status: "UNKNOWN", reason: "UStori did not return a valid automatic output duration" };
    }
  }
  if (status === "FAILURE") {
    const message = typeof body.error_message === "string" ? body.error_message.trim() : "";
    return { status, reason: message || (body.cancelled_at ? "UStori video task was cancelled" : "UStori video generation failed") };
  }
  return { status };
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") throw new Error("Configure a credit billing expression for this UStori model");
  const input = ctx.requestBody;
  const model = modelName(ctx.upstreamModel || ctx.model);
  const spec = MODELS[model];
  const seconds = input.duration === -1 && model === "Wan-3.0" ? spec.maxSeconds : input.duration;
  const rate = CREDIT_RATES[model][input.resolution];
  if (!Number.isSafeInteger(seconds) || seconds < spec.minSeconds || seconds > spec.maxSeconds ||
      !Number.isSafeInteger(rate) || input.videos?.length) throw new Error("Invalid UStori credit estimate");
  // UStori rounds the whole charge up to 0.1 credit. Rates are integers to
  // avoid floating-point over-reservation at exact rounding boundaries.
  // New requests intentionally omit seconds: old seconds expressions then
  // fail before submission, rather than silently continuing the old tariff.
  return { credits: Math.ceil(seconds * rate / 10) / 10, resolution: input.resolution, video_input: "none" };
}

export function extractUsageOnComplete(ctx, result, body) {
  if (result.status !== "SUCCESS") return null;
  if (ctx.state?.billingMode === CREDIT_BILLING) {
    const credits = chargedCredits(ctx, body);
    if (credits === null) throw new Error("UStori final charged amount is missing or invalid");
    return { credits };
  }
  // Tasks submitted before 1.1.0 keep their frozen seconds expression. Never
  // reinterpret an old reservation as credits during a rolling upgrade.
  if (!ctx.state?.autoDuration) return null;
  const seconds = automaticOutputSeconds(body);
  return seconds === null ? null : { seconds };
}

export function listArtifacts(task) {
  if (task.status !== "SUCCESS") return [];
  return videoURLs(task.data).map((_, index) => ({ key: index === 0 ? "video" : "video-" + (index + 1), type: "video" }));
}

export function buildContentRequest(ctx) {
  const key = ctx.artifactKey;
  if (key !== "video" && (!/^video-[1-9][0-9]?$/.test(key) || key === "video-1")) throw new Error("artifact_not_found");
  const index = key === "video" ? 0 : Number(key.slice(6)) - 1;
  const url = videoURLs(ctx.data)[index];
  if (!url) throw new Error("artifact_not_found");
  return { url, method: ctx.clientRequest.method, credentialless: true };
}

export const protocols = {
  openai_video: {
    decodeRequest(ctx) {
      if (ctx.body?.kind !== "json") throw new Error("UStori requires a JSON body with reference media URLs");
      const model = modelName(ctx.upstreamModel || ctx.model);
      const { input, mode } = normalizeInput(ctx.body.value, model);
      return { kind: "submit", model: ctx.model, action: mode, requestBody: input };
    },
    render(_ctx, task) {
      if (task.status === "FAILURE") return { error: { code: "video_generation_failed", message: task.fail_reason || "UStori video generation failed" } };
      if (task.status === "IN_PROGRESS" && task.data?.status === "completed" && videoURLs(task.data).length) {
        const issue = finalBillingIssue(task.data);
        if (issue?.status === "pending") return { billing: { ...issue, message: issue.message + "；系统将继续查询原任务，请勿重复提交；如持续未更新，请联系管理员在任务超时前核对" } };
      }
      if (task.status !== "SUCCESS") return {};
      const urls = videoURLs(task.data);
      return urls.length ? { video_url: urls[0], video_urls: urls } : {};
    },
  },
};
