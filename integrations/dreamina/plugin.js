export const meta = {
  apiVersion: 1,
  key: 'dreamina-cli',
  name: 'Dreamina CLI Bridge',
  icon: 'text:即梦',
  version: '0.1.0',
  author: { name: 'JethroCao' },
  description: { en: 'Text-to-image and text-to-video through a local Dreamina Canvas CLI bridge', zh: '通过本地即梦画布 CLI 适配服务生成图片和视频' },
  models: ['dreamina-image', 'dreamina-video'],
  fetchMode: 'per_task',
  protocols: ['openai_image', 'openai_video'],
  usageSchema: {
    image_count: { type: 'number', unit: 'count', description: { en: 'Image generation unit price', zh: '图片生成单价' } },
    seconds: { type: 'number', unit: 'second', description: { en: 'Video generation unit price', zh: '视频生成单价' } },
  },
};

function bounded(value, fallback, max, name) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(name + ' must be an integer between 1 and ' + max);
  return value;
}

function normalize(req, model, kind) {
  if (model !== 'dreamina-' + kind) throw new Error('Model does not support this media operation');
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new Error('JSON object required');
  const allowed = ['model', 'prompt', 'kind'].concat(kind === 'image' ? ['n', 'response_format'] : ['seconds']);
  for (const key of Object.keys(req)) if (allowed.indexOf(key) < 0) throw new Error('Unsupported field: ' + key);
  if (req.kind !== undefined && req.kind !== kind) throw new Error('Media kind mismatch');
  if (typeof req.prompt !== 'string' || !req.prompt.trim() || req.prompt.length > 2000 || req.prompt.indexOf('\0') >= 0) throw new Error('prompt must contain 1 to 2000 characters');
  const body = { model: model, kind: kind, prompt: req.prompt };
  if (kind === 'image') {
    body.n = bounded(req.n, 1, 4, 'n');
    if (req.response_format !== undefined && ['url', 'b64_json'].indexOf(req.response_format) < 0) throw new Error('response_format must be url or b64_json');
  } else body.seconds = bounded(req.seconds, 5, 30, 'seconds');
  return body;
}

function decode(ctx, kind) {
  if (ctx.operation === 'edit') throw new Error('Image editing is not supported by this bridge version');
  if (!ctx.body || ctx.body.kind !== 'json') throw new Error('JSON body required; reference files are not supported');
  const model = ctx.upstreamModel || ctx.model;
  return { kind: 'submit', model: ctx.model, action: kind === 'image' ? 'text_to_image' : 'text_to_video', requestBody: normalize(ctx.body.value, model, kind) };
}

function outbound(ctx) {
  const model = ctx.upstreamModel || ctx.model;
  const kind = model === 'dreamina-image' ? 'image' : 'video';
  return normalize(ctx.requestBody, model, kind);
}

function base(ctx) { return ctx.baseUrl.replace(/\/+$/, ''); }
function auth(ctx) { return { Authorization: 'Bearer ' + ctx.apiKey }; }

export function buildSubmitRequest(ctx) {
  if (!ctx.publicTaskId) throw new Error('Gateway public task ID is required for idempotency');
  const headers = auth(ctx);
  headers['Content-Type'] = 'application/json';
  headers['Idempotency-Key'] = ctx.publicTaskId;
  return { url: base(ctx) + '/v1/jobs', method: 'POST', headers: headers, body: outbound(ctx) };
}

export function parseSubmitResponse(ctx, response) {
  if (!response.body || typeof response.body.id !== 'string' || !response.body.id) throw new Error('Bridge returned no task ID');
  return { taskId: response.body.id, taskData: response.body };
}

export function buildQueryRequest(ctx) {
  return { url: base(ctx) + '/v1/jobs/' + encodeURIComponent(ctx.taskId), method: 'GET', headers: auth(ctx) };
}

export function parseTaskResult(ctx, body, response) {
  if (response && response.status !== 200) throw new Error('Bridge query is temporarily unavailable');
  const statuses = { queued: 'QUEUED', in_progress: 'IN_PROGRESS', completed: 'SUCCESS', failed: 'FAILURE' };
  const status = statuses[(body || {}).status] || 'UNKNOWN';
  const result = { status: status };
  if (status === 'SUCCESS') result.progress = '100%';
  if (status === 'FAILURE') result.reason = body.error && body.error.message || 'Dreamina generation failed';
  if (status === 'UNKNOWN') result.reason = 'Unrecognized bridge task status';
  return result;
}

export function extractUsage(ctx) {
  const req = outbound(ctx);
  return req.kind === 'image' ? { image_count: req.n } : { seconds: req.seconds };
}

export function extractUsageOnComplete(task, result, body) {
  if (!body || body.status !== 'completed') return {};
  if (body.object === 'image') return { image_count: bounded(body.image_count, undefined, 4, 'image_count') };
  if (body.object === 'video') return { seconds: bounded(body.seconds, undefined, 30, 'seconds') };
  throw new Error('Unknown completed media kind');
}

export function listArtifacts(task) {
  return task.status === 'SUCCESS' && task.data && task.data.object === 'video' ? [{ key: 'video', type: 'video' }] : [];
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== 'video') throw new Error('artifact_not_found');
  return { url: base(ctx) + '/v1/jobs/' + encodeURIComponent(ctx.upstreamTaskId) + '/content/0', method: ctx.clientRequest.method, headers: auth(ctx) };
}

export const protocols = {
  openai_image: {
    decodeRequest: function (ctx) { return decode(ctx, 'image'); },
    render: function (ctx, task) {
      const data = task.data && task.data.data;
      if (task.status !== 'SUCCESS' || !Array.isArray(data) || !data.length) throw new Error('Image result is unavailable');
      return { data: data.map(function (item) { return { url: item.url }; }) };
    },
  },
  openai_video: {
    decodeRequest: function (ctx) { return decode(ctx, 'video'); },
    // The host owns public IDs/status fields. Keep bridge internals out of the
    // presenter; clients retrieve bytes using /v1/videos/:id/content.
    render: function (ctx, task) {
      const data = task.data || {};
      const result = {};
      if (data.seconds) result.seconds = data.seconds;
      if (task.status === 'FAILURE') result.error = { code: 'video_generation_failed', message: task.fail_reason || 'Dreamina generation failed' };
      return result;
    },
  },
};
