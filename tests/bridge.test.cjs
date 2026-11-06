'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBridge, filterFreePlanModels, matchesBearer, normaliseModels } = require('../bridge');

const LOCAL_KEY = 'local-test-key-0123456789abcdef';

function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

async function withBridge(options, run) {
  const bridge = createBridge({
    getConfig: () => ({ accountId: 'a'.repeat(32), apiToken: 'cloudflare-secret', localApiKey: LOCAL_KEY }),
    listModels: async () => [
      { id: '@cf/test/text', catalogId: '215ee9cf-aaa0-48bd-a084-00da8da2fbeb', task: 'Text Generation', name: 'Test model' },
      { id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', catalogId: 'paid-model-catalog-uuid', task: 'Text Generation' },
    ],
    port: 0,
    ...options,
  });
  const status = await bridge.start();
  try {
    await run(`http://127.0.0.1:${bridgePort(bridge, status)}`);
  } finally {
    await bridge.stop();
  }
}

function bridgePort(bridge, status) {
  // The bridge exposes the actual ephemeral port in status for tests only.
  return status.port;
}

test('local bearer key is required and compared exactly', () => {
  assert.equal(matchesBearer(`Bearer ${LOCAL_KEY}`, LOCAL_KEY), true);
  assert.equal(matchesBearer(`Bearer ${LOCAL_KEY}x`, LOCAL_KEY), false);
  assert.equal(matchesBearer(undefined, LOCAL_KEY), false);
});

test('model catalog is normalized, de-duplicated and limited to text generation', () => {
  const models = normaliseModels([
    { id: 'text-1', task: 'Text Generation', name: 'Text One' },
    { id: 'embed-1', task: 'Text Embeddings' },
    { id: 'text-1', task: 'Text Generation' },
  ]);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'text-1');
  assert.equal(models[0].owned_by, 'cloudflare');
});

test('Cloudflare catalog UUID is mapped to the inference model name', () => {
  const models = normaliseModels([
    {
      id: '215ee9cf-aaa0-48bd-a084-00da8da2fbeb',
      name: '@cf/meta/llama-3.1-8b-instruct',
      task: 'Text Generation',
    },
  ]);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, '@cf/meta/llama-3.1-8b-instruct');
});

test('Free model filter removes models that require paid billing only', () => {
  const models = filterFreePlanModels([
    { id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017' },
    { id: '@cf/meta/llama-3.1-8b-instruct' },
  ]);
  assert.deepEqual(models.map((model) => model.id), ['@cf/meta/llama-3.1-8b-instruct']);
});

test('GET /v1/models returns an OpenAI list and rejects missing local credentials', async () => {
  await withBridge({}, async (origin) => {
    const unauthorized = await fetch(`${origin}/v1/models`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${origin}/v1/models`, { headers: { authorization: `Bearer ${LOCAL_KEY}` } });
    assert.equal(authorized.status, 200);
    const body = await authorized.json();
    assert.equal(body.object, 'list');
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, '@cf/test/text');
    assert.equal(body.data[0].catalogId, undefined);
  });
});

test('chat completions forwards JSON, authorization, tool calls and streamed bytes', async () => {
  const requested = [];
  await withBridge({
    fetchImpl: async (url, init) => {
      requested.push({ url: String(url), init, body: JSON.parse(init.body) });
      return response('data: {"choices":[]}\n\ndata: [DONE]\n\n', 200, { 'content-type': 'text/event-stream' });
    },
  }, async (origin) => {
    const payload = {
      model: '215ee9cf-aaa0-48bd-a084-00da8da2fbeb',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object' } } }],
    };
    const result = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${LOCAL_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(result.status, 200);
    assert.match(await result.text(), /data: \[DONE\]/);
    assert.equal(requested[0].url, `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/v1/chat/completions`);
    assert.equal(requested[0].init.headers.authorization, 'Bearer cloudflare-secret');
    assert.deepEqual(requested[0].body, { ...payload, model: '@cf/test/text' });
  });
});
