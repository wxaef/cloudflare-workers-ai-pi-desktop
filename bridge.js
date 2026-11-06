'use strict';

const http = require('node:http');
const { Readable } = require('node:stream');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const SERVICE_NAME = 'pi-cloudflare-workers-ai';
const DEFAULT_PORT = 18766;
const CF_API_ORIGIN = 'https://api.cloudflare.com';
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MODEL_CACHE_MS = 60 * 1000;
// Cloudflare pricing docs: models that require a paid billing method.
const PAID_BILLING_REQUIRED_MODELS = new Set([
  '@cf/moonshotai/kimi-k2.6',
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/zai-org/glm-5.2',
  '@cf/zai-org/glm-5.3',
  '@cf/zai-org/glm-5.3-flash',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  '@cf/deepseek-ai/deepseek-v4-pro-0813',
]);

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function openAiError(res, status, message, code) {
  json(res, status, {
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code,
    },
  });
}

function matchesBearer(header, expected) {
  if (typeof header !== 'string' || typeof expected !== 'string' || !expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const received = Buffer.from(match[1]);
  const actual = Buffer.from(expected);
  return received.length === actual.length && timingSafeEqual(received, actual);
}

function isUuid(value) {
  return typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
}

function normaliseModels(items) {
  const output = [];
  const seen = new Set();
  for (const item of items) {
    const catalogId = typeof item?.id === 'string' ? item.id.trim() : '';
    const modelName = typeof item?.name === 'string' ? item.name.trim() : '';
    const id = isUuid(catalogId) ? modelName : catalogId || modelName;
    if (!id || seen.has(id)) continue;
    const task = typeof item.task === 'string' ? item.task : item.task?.name;
    if (task && !/text\s*generation/i.test(task)) continue;
    seen.add(id);
    output.push({
      id,
      object: 'model',
      created: 0,
      owned_by: 'cloudflare',
      ...(catalogId && catalogId !== id ? { catalogId } : {}),
      ...(modelName && modelName !== id ? { name: modelName } : {}),
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
    });
  }
  return output;
}

function filterFreePlanModels(models) {
  return models.filter((model) => !PAID_BILLING_REQUIRED_MODELS.has(String(model.id).trim().toLowerCase()));
}

async function readJsonBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) {
      const error = new Error('Request body exceeds the 16 MiB limit.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function createBridge({ getConfig, listModels, port = DEFAULT_PORT, fetchImpl = fetch } = {}) {
  if (typeof getConfig !== 'function' || typeof listModels !== 'function') {
    throw new TypeError('getConfig and listModels functions are required.');
  }

  let server;
  let startError = '';
  let modelCache = { expiresAt: 0, data: [] };

  async function cachedModels() {
    if (modelCache.expiresAt > Date.now()) return modelCache.data;
    const data = await listModels();
    modelCache = { expiresAt: Date.now() + MODEL_CACHE_MS, data };
    return data;
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port || DEFAULT_PORT}`);
    if (url.pathname === '/healthz' && req.method === 'GET') {
      return json(res, 200, { ok: true, service: SERVICE_NAME });
    }

    const config = getConfig();
    if (!matchesBearer(req.headers.authorization, config?.localApiKey)) {
      return openAiError(res, 401, 'Missing or invalid local bridge API key.', 'invalid_api_key');
    }
    if (!config?.accountId || !config?.apiToken) {
      return openAiError(res, 503, 'Configure Cloudflare credentials in the plugin panel first.', 'cloudflare_not_configured');
    }

    if (url.pathname === '/v1/models' && req.method === 'GET') {
      try {
        const models = filterFreePlanModels(await cachedModels());
        return json(res, 200, { object: 'list', data: models.map(({ catalogId, ...model }) => model) });
      } catch (error) {
        return openAiError(res, error.statusCode || 502, error.message || 'Could not load the Cloudflare model catalog.', 'model_catalog_unavailable');
      }
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (error) {
        return openAiError(res, error.statusCode || 400, error.message, 'invalid_request');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return openAiError(res, 400, 'Request body must be a JSON object.', 'invalid_request');
      }
      try {
        if (isUuid(payload.model)) {
          try {
            const match = (await cachedModels()).find((model) => model.catalogId === payload.model);
            if (match) payload = { ...payload, model: match.id };
          } catch {
            // Preserve the original model ID so Cloudflare can return its normal error response.
          }
        }
        const accountId = encodeURIComponent(config.accountId);
        const endpoint = `${CF_API_ORIGIN}/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
        const upstream = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiToken}`,
            'content-type': 'application/json',
            accept: req.headers.accept || 'application/json',
          },
          body: JSON.stringify(payload),
          redirect: 'error',
          signal: AbortSignal.timeout(5 * 60 * 1000),
        });
        const headers = { 'cache-control': 'no-store' };
        const contentType = upstream.headers.get('content-type');
        if (contentType) headers['content-type'] = contentType;
        const requestId = upstream.headers.get('cf-ray');
        if (requestId) headers['cf-ray'] = requestId;
        res.writeHead(upstream.status, headers);
        if (!upstream.body) return res.end();
        const stream = Readable.fromWeb(upstream.body);
        stream.on('error', () => {
          if (!res.destroyed) res.destroy();
        });
        res.on('close', () => {
          if (!res.writableEnded) stream.destroy();
        });
        stream.pipe(res);
      } catch (error) {
        if (!res.headersSent) {
          openAiError(res, 502, error.name === 'TimeoutError' ? 'Cloudflare request timed out.' : 'Could not reach Cloudflare Workers AI.', 'upstream_unavailable');
        } else if (!res.destroyed) {
          res.destroy();
        }
      }
      return;
    }

    if (url.pathname.startsWith('/v1/')) {
      return openAiError(res, 404, 'Endpoint is not supported by this bridge.', 'not_found');
    }
    return json(res, 404, { error: 'not_found' });
  }

  async function start() {
    if (server?.listening) return status();
    startError = '';
    server = http.createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) openAiError(res, 500, 'Unexpected bridge error.', 'internal_error');
        else if (!res.destroyed) res.destroy();
      });
    });
    server.requestTimeout = 5 * 60 * 1000;
    server.headersTimeout = 15 * 1000;
    server.keepAliveTimeout = 5 * 1000;
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    }).catch((error) => {
      startError = error.code === 'EADDRINUSE'
        ? `Local port ${port} is already in use; no existing service was changed.`
        : 'Could not start the local bridge.';
      server = undefined;
      throw error;
    });
    server.unref();
    return status();
  }

  async function stop() {
    const current = server;
    server = undefined;
    if (!current?.listening) return;
    current.closeAllConnections?.();
    await new Promise((resolve) => current.close(() => resolve()));
  }
  function status() {
    const activePort = server?.address()?.port ?? port;
    return {
      running: Boolean(server?.listening),
      port: activePort,
      baseUrl: `http://127.0.0.1:${activePort}/v1`,
      error: startError,
    };
  }

  function clearModelCache() {
    modelCache = { expiresAt: 0, data: [] };
  }

  return { start, stop, status, clearModelCache };
}

function makeLocalApiKey() {
  return randomBytes(32).toString('hex');
}

module.exports = {
  DEFAULT_PORT,
  createBridge,
  makeLocalApiKey,
  matchesBearer,
  filterFreePlanModels,
  normaliseModels,
  readJsonBody,
};
