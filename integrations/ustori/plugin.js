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

export const meta = {
  apiVersion: 1,
  key: "ustori",
  name: "UStori Video",
  icon: "text:US",
  version: "1.0.1",
  author: { name: "Nexora" },
  description: { en: "Video generation through the UStori API", zh: "通过 UStori API 生成视频" },
  baseUrl: "https://platform.ustori.com",
  website: "https://platform.ustori.com/console/docs",
  auth: "api_key",
  models: Object.keys(MODELS),
  fetchMode: "per_task",
  protocols: ["openai_video"],
  usageSchema: {
    seconds: { type: "number", unit: "second", description: { en: "Video generation unit price", zh: "视频生成单价" } },
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
  return { taskId: body.id, taskData: recognized ? { status: body.status } : {}, state: { autoDuration: ctx.requestBody.duration === -1 } };
}

export function buildQueryRequest(ctx) {
  return { url: tasksURL(ctx) + "/" + encodeURIComponent(ctx.taskId), method: "GET", headers: { Authorization: "Bearer " + ctx.apiKey } };
}

function automaticOutputSeconds(body) {
  // This is the documented rounded-up output duration, not UStori's invoice quantity.
  const seconds = body?.usage?.video_seconds;
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= MODELS["Wan-3.0"].maxSeconds ? seconds : null;
}

export function parseTaskResult(ctx, body) {
  if (!body || body.id !== ctx.taskId || typeof body.status !== "string" || !Object.hasOwn(STATUS, body.status)) return { status: "UNKNOWN" };
  const status = STATUS[body.status];
  if (status === "SUCCESS") {
    if (!videoURLs(body).length) return { status: "UNKNOWN" };
    if (ctx.state?.autoDuration && automaticOutputSeconds(body) === null) {
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
  if (ctx.usagePurpose === "billing_ratios") return null;
  const input = ctx.requestBody;
  const spec = MODELS[modelName(ctx.upstreamModel || ctx.model)];
  return { seconds: input.duration === -1 ? spec.maxSeconds : input.duration, resolution: input.resolution, video_input: input.videos?.length ? "video" : "none" };
}

export function extractUsageOnComplete(ctx, result, body) {
  if (result.status !== "SUCCESS" || !ctx.state?.autoDuration) return null;
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
      if (task.status !== "SUCCESS") return {};
      const urls = videoURLs(task.data);
      return urls.length ? { video_url: urls[0], video_urls: urls } : {};
    },
  },
};
