import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from './plugin.js';

const decode = (kind, value, extra = {}) => plugin.protocols['openai_' + kind].decodeRequest({ model: 'dreamina-' + kind, operation: kind === 'image' ? 'generate' : 'create', body: { kind: 'json', value }, ...extra });
test('image and video usage exactly match normalized outbound defaults and bounds', () => {
  for (const kind of ['image', 'video']) {
    const intent = decode(kind, { model: 'dreamina-' + kind, prompt: 'paper boat' });
    const ctx = { ...intent, upstreamModel: intent.model, publicTaskId: 'task-123', baseUrl: 'http://localhost:8787/', apiKey: 'secret' };
    const request = plugin.buildSubmitRequest(ctx);
    assert.equal(request.url, 'http://localhost:8787/v1/jobs');
    assert.equal(request.headers['Idempotency-Key'], 'task-123');
    assert.equal(request.body.kind, kind);
    assert.deepEqual(plugin.extractUsage(ctx), kind === 'image' ? { image_count: 1 } : { seconds: 5 });
    assert.equal(request.body[kind === 'image' ? 'n' : 'seconds'], kind === 'image' ? 1 : 5);
  }
  for (const n of [0, 5, 1.5, '2', null]) assert.throws(() => decode('image', { prompt: 'x', n }));
  for (const seconds of [0, 31, 1.5, '5', null]) assert.throws(() => decode('video', { prompt: 'x', seconds }));
  assert.deepEqual(plugin.extractUsageOnComplete({}, {}, { object: 'image', status: 'completed', image_count: 2 }), { image_count: 2 });
  assert.throws(() => plugin.extractUsageOnComplete({}, {}, { object: 'image', status: 'completed', image_count: 9000 }));
});
test('unsupported image edits/references and parameters are rejected instead of ignored', () => {
  assert.throws(() => decode('image', { prompt: 'x' }, { operation: 'edit' }));
  assert.throws(() => decode('video', { prompt: 'x', input_reference: 'https://example.com/a.png' }));
  assert.throws(() => decode('image', { prompt: 'x', size: '1024x1024' }));
  assert.throws(() => decode('image', { prompt: 'x' }, { model: 'dreamina-video' }));
  assert.throws(() => plugin.buildSubmitRequest({ requestBody: { prompt: 'x' } }));
});
test('query errors cannot become successful/terminal tasks and unknown states remain unknown', () => {
  assert.throws(() => plugin.parseTaskResult({}, { error: 'unavailable' }, { status: 503 }));
  assert.equal(plugin.parseTaskResult({}, { status: 'surprise' }, { status: 200 }).status, 'UNKNOWN');
  assert.equal(plugin.parseTaskResult({}, { status: 'completed' }, { status: 200 }).status, 'SUCCESS');
  assert.equal(plugin.parseTaskResult({}, { status: 'failed', error: { message: 'rejected' } }, { status: 200 }).reason, 'rejected');
});
test('video artifacts use private upstream ID and bearer key; image render only returns media', () => {
  assert.deepEqual(plugin.listArtifacts({ status: 'SUCCESS', data: { object: 'video' } }), [{ key: 'video', type: 'video' }]);
  assert.deepEqual(plugin.listArtifacts({ status: 'SUCCESS', data: { object: 'image' } }), []);
  const content = plugin.buildContentRequest({ upstreamTaskId: 'abc', artifactKey: 'video', baseUrl: 'http://localhost:8787', apiKey: 'secret', clientRequest: { method: 'GET' } });
  assert.equal(content.url, 'http://localhost:8787/v1/jobs/abc/content/0');
  assert.equal(content.headers.Authorization, 'Bearer secret');
  assert.throws(() => plugin.buildContentRequest({ artifactKey: 'other' }));
  assert.deepEqual(plugin.protocols.openai_image.render({}, { status: 'SUCCESS', data: { data: [{ url: 'http://example/a?sig=x' }], attention: 'private', id: 'private' } }), { data: [{ url: 'http://example/a?sig=x' }] });
});
