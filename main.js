'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createBridge, DEFAULT_PORT, makeLocalApiKey, normaliseModels, filterFreePlanModels } = require('./bridge');

const CONFIG_FILE = 'cloudflare-workers-ai.json';
const CF_API_ORIGIN = 'https://api.cloudflare.com';
let dataDirectory;
let config = { accountId: '', apiToken: '', localApiKey: makeLocalApiKey() };
let bridge;
let configError = '';
let modelCache = { expiresAt: 0, items: [] };

function validateAccountId(value) {
  return typeof value === 'string' && /^[a-f\d]{32}$/i.test(value.trim());
}

function validateToken(value) {
  return typeof value === 'string' && value.trim().length >= 10 && !/\s/.test(value.trim());
}

async function saveConfig(next) {
  if (!dataDirectory) throw new Error('PI 插件数据目录不可用。');
  const filePath = path.join(dataDirectory, CONFIG_FILE);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(next, null, 2);
  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  config = next;
  configError = '';
  modelCache = { expiresAt: 0, items: [] };
  bridge?.clearModelCache();
}

async function loadConfig() {
  dataDirectory = await pi.plugin.getDataPath();
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) {
    throw new Error('PI 未提供有效的插件数据目录。');
  }
  await fs.mkdir(dataDirectory, { recursive: true });
  const filePath = path.join(dataDirectory, CONFIG_FILE);
  try {
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    config = {
      accountId: validateAccountId(stored.accountId) ? stored.accountId.trim() : '',
      apiToken: typeof stored.apiToken === 'string' ? stored.apiToken : '',
      localApiKey: typeof stored.localApiKey === 'string' && stored.localApiKey.length >= 32
        ? stored.localApiKey
        : makeLocalApiKey(),
    };
    if (!stored.localApiKey) await saveConfig(config);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      configError = '本机配置文件无法读取，请重新保存凭据以覆盖配置。';
      config = { accountId: '', apiToken: '', localApiKey: makeLocalApiKey() };
    }
  }
}

async function fetchCatalog(accountId = config.accountId, apiToken = config.apiToken) {
  if (!validateAccountId(accountId)) throw new Error('Account ID 应为 32 位十六进制字符。');
  if (!validateToken(apiToken)) throw new Error('请填写有效的 Cloudflare API Token。');

  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL(`${CF_API_ORIGIN}/client/v4/accounts/${accountId}/ai/models/search`);
    url.searchParams.set('task', 'Text Generation');
    url.searchParams.set('hide_experimental', 'true');
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '100');

    let response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${apiToken}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new Error(error.name === 'TimeoutError' ? '连接 Cloudflare 模型目录超时。' : '无法连接 Cloudflare 模型目录。');
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Cloudflare 模型目录返回了无效响应。');
    }
    if (!response.ok || payload?.success === false) {
      const message = payload?.errors?.map((item) => item?.message).filter(Boolean).join('; ');
      throw new Error(message || `Cloudflare 模型目录请求失败（HTTP ${response.status}）。`);
    }
    const items = Array.isArray(payload?.result) ? payload.result : [];
    all.push(...items);
    const totalPages = Number(payload?.result_info?.total_pages);
    if ((Number.isInteger(totalPages) && page >= totalPages) || items.length < 100) break;
  }
  return all;
}

async function getModels(force = false) {
  if (!force && modelCache.expiresAt > Date.now()) return modelCache.items;
  const items = normaliseModels(await fetchCatalog());
  modelCache = { expiresAt: Date.now() + 60 * 1000, items };
  return items;
}

function publicStatus() {
  const bridgeStatus = bridge?.status() ?? {
    running: false,
    port: DEFAULT_PORT,
    baseUrl: `http://127.0.0.1:${DEFAULT_PORT}/v1`,
    error: '本机桥接服务尚未启动。',
  };
  return {
    ok: true,
    running: bridgeStatus.running,
    port: bridgeStatus.port,
    baseUrl: bridgeStatus.baseUrl,
    error: bridgeStatus.error || configError,
    configured: Boolean(config.accountId && config.apiToken),
    accountId: config.accountId,
    tokenConfigured: Boolean(config.apiToken),
    localApiKeyPreview: config.localApiKey ? `${config.localApiKey.slice(0, 4)}••••${config.localApiKey.slice(-4)}` : '',
  };
}

async function onPanelInvoke(channel, payload = {}) {
  try {
    switch (channel) {
      case 'cfai.status':
        return publicStatus();
      case 'cfai.save': {
        const accountId = typeof payload.accountId === 'string' ? payload.accountId.trim() : '';
        const apiToken = typeof payload.apiToken === 'string' && payload.apiToken.trim()
          ? payload.apiToken.trim()
          : config.apiToken;
        if (!validateAccountId(accountId)) throw new Error('Account ID 应为 32 位十六进制字符。');
        if (!validateToken(apiToken)) throw new Error('请填写 Cloudflare API Token。');
        await saveConfig({ ...config, accountId, apiToken });
        return publicStatus();
      }
      case 'cfai.test': {
        const accountId = typeof payload.accountId === 'string' ? payload.accountId.trim() : config.accountId;
        const apiToken = typeof payload.apiToken === 'string' && payload.apiToken.trim()
          ? payload.apiToken.trim()
          : config.apiToken;
        const models = filterFreePlanModels(normaliseModels(await fetchCatalog(accountId, apiToken)));
        return { ok: true, count: models.length, models: models.slice(0, 200) };
      }
      case 'cfai.models':
        return { ok: true, models: filterFreePlanModels(await getModels(payload.force === true)) };
      case 'cfai.localKey':
        return { ok: true, localApiKey: config.localApiKey };
      case 'cfai.clear':
        await saveConfig({ ...config, accountId: '', apiToken: '' });
        return publicStatus();
      default:
        return { ok: false, error: '不支持的面板操作。' };
    }
  } catch (error) {
    return { ok: false, error: String(error?.message || '操作失败。') };
  }
}

async function onLoad() {
  await pi.commands.register({
    id: 'cloudflare-workers-ai.open',
    title: 'Cloudflare Workers AI: Open Panel',
    keywords: ['cloudflare', 'workers-ai', 'model'],
    run: async () => pi.ui.openPanel({ title: 'Cloudflare Workers AI' }),
  });
  try {
    await loadConfig();
  } catch (error) {
    configError = String(error?.message || '无法读取 PI 插件数据目录。');
  }
  bridge = createBridge({
    getConfig: () => config,
    listModels: () => getModels(true),
    port: DEFAULT_PORT,
  });
  try {
    await bridge.start();
  } catch {
    // The panel reports the fixed-port conflict; never take over another service.
  }
}

async function onUnload() {
  await bridge?.stop();
  bridge = undefined;
  await pi.commands.unregister('cloudflare-workers-ai.open');
}


module.exports = { onLoad, onUnload, onPanelInvoke };
