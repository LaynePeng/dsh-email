/**
 * Microsoft OAuth2（设备码流程）—— Hotmail / Outlook / Live / M365 发信授权。
 *
 * 背景：Outlook 个人版已关闭 SMTP Basic Auth（`535 5.7.139`），只认 OAuth2。
 * 设备码流程是这里唯一合适的授权方式：
 *   1. `startDeviceCode()` 申请设备码 → 用户看到 `user_code` 与验证网址；
 *   2. 用户在浏览器里输入码并同意 → 我们轮询令牌端点；
 *   3. 拿到 `refresh_token` 后落到 `oauth.json`（0600），之后静默续期；
 *   4. 发信时用 access_token：Graph 走 HTTPS，SMTP 走 AUTH XOAUTH2。
 *
 * 刻意不做授权码 + loopback 回调：DSH 宿主里临时监听端口有权限/防火墙的
 * 不确定性，而设备码只需要用户复制一次码。用户自己的 Azure 应用也可以：
 * 在设置里填 clientId（应用要允许公共客户端流）。
 *
 * 注意 scope 与资源：Microsoft v2.0 的**一个请求只能要一个资源**的 scope。
 * Graph（`graph.microsoft.com/Mail.Send`）与 outlook.office（SMTP.Send /
 * IMAP）不能混在一起要，所以 scope 由 transport 决定（见 providers.js）。
 */

import {
  AUTH_BASE, PUBLIC_CLIENT_ID, defaultScope, endpointsFor, normalizeTenant, providerSupportsOAuth,
} from './providers.js';

const HTTP_TIMEOUT_MS = 20_000;

/** access_token 内存缓存（按 client + tenant + scope + refresh_token 尾段区分）。 */
const tokenCache = new Map();

function cacheKey(cfg, refreshToken) {
  return [cfg.provider, cfg.clientId, cfg.tenant, cfg.scope, String(refreshToken).slice(-12)].join('|');
}

export function resetTokenCache() {
  tokenCache.clear();
}

/**
 * 已授权 scope 是否覆盖当前通道需要的 scope。
 *
 * 不能做「集合相等」：微软返回的 scope 常包含应用在 Azure 里已获同意的
 * 其它权限（例如 Graph 的 SMTP.Send / IMAP.AccessAsUser.All）。多出来的
 * 权限不影响使用，只有**缺少**必需项才应该要求重新授权。
 */
export function scopeSatisfies(granted, required) {
  const grantedSet = new Set(String(granted || '').split(/\s+/).filter(Boolean));
  // offline_access 只用于申请 refresh_token，不会出现在 access_token 的
  // scope 里；把它当必需项会让刚授权成功的账号一直被判定为「缺权限」。
  const ignored = new Set(['offline_access']);
  const needed = String(required || '').split(/\s+/).filter((scope) => scope && !ignored.has(scope));
  if (!needed.length) return true;
  if (!grantedSet.size) return true; // 历史记录没存 scope：不据此拦截
  return needed.every((scope) => grantedSet.has(scope));
}

function fetchFailure(error) {
  const cause = error?.cause?.code || error?.cause?.message || '';
  const reason = error?.message || String(error);
  return `${reason}${cause ? `（${cause}）` : ''}`;
}

async function postForm(url, data, { fetchImpl = fetch } = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null && value !== '') body.set(key, String(value));
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 300) };
  }
  return { status: response.status, payload };
}

/** 把 Azure 的错误码翻成人话（AADSTS 天书对用户毫无意义）。 */
export function explainOAuthError(payload = {}, status = 0) {
  const code = String(payload.error || '');
  const desc = String(payload.error_description || payload.raw || '');
  const aad = (desc.match(/AADSTS\d+/) || [''])[0];
  // 先认 OAuth 标准错误码：invalid_grant 的描述里常同时带 AADSTS 码，
  // 先查 AADSTS 表会把「令牌被吊销」误报成「账号权限被拒」。
  if (code === 'authorization_pending') return '等待你在浏览器里完成授权…';
  if (code === 'slow_down') return '轮询太快，稍后继续';
  if (code === 'expired_token') return '设备码已过期，请重新发起授权';
  if (code === 'authorization_declined' || code === 'access_denied') return '你在浏览器里拒绝了授权';
  if (code === 'invalid_grant') {
    return `授权已失效（refresh_token 过期或被吊销），请重新授权${aad ? `（${aad}）` : ''}`;
  }
  if (code === 'invalid_client') return `客户端校验失败：${desc || '检查 oauthClientId'}`;
  if (code === 'invalid_scope') return `scope 不合法：${desc || '检查 transport 与 oauthScope'}`;
  if (code === 'unauthorized_client') return '该应用不支持设备码流程：清空 oauthClientId 用内置客户端，或让管理员允许公共客户端流';
  const map = {
    AADSTS7000215: '客户端密钥不对（用内置客户端请清空 oauthClientSecret）',
    AADSTS700016: '客户端 ID 不存在（oauthClientId 填错了？清空即可用内置公共客户端）',
    AADSTS900023: '租户标识无效：个人账号留空即可，不要填邮箱',
    AADSTS65001: '用户/管理员尚未同意该应用：重试授权并在浏览器点「同意」；组织账号可能需管理员批准',
    AADSTS500011: '该账号不在这个租户里：组织账号填自己的租户域名或 ID，个人账号留空',
    AADSTS50034: '账号不存在或不在该租户',
    AADSTS70000: '授权被拒：账号可能不支持该权限，或组织策略关闭了 SMTP/Graph',
    AADSTS28000: 'scope 不合法：Graph 与 outlook.office 属于不同资源，不能放同一个请求',
    AADSTS90009: '资源与 scope 不匹配：检查 transport（graph 用 Graph scope，smtp 用 outlook.office scope）',
  };
  if (aad && map[aad]) return `${map[aad]}（${aad}）`;
  if (!status) return `网络错误：${desc || '连不上微软登录服务'}`;
  return `${code || `HTTP ${status}`}：${desc.slice(0, 240) || '未知错误'}`;
}

/** 整理 OAuth 参数（scope 由 transport 决定；用户显式填 scope 时以用户为准）。 */
export function oauthConfig(cfg = {}, options = {}) {
  const tenantInfo = normalizeTenant(cfg.tenant || '');
  const tenant = tenantInfo.tenant;
  const endpoints = endpointsFor(tenant);
  const clientId = String(cfg.clientId || '').trim() || PUBLIC_CLIENT_ID;
  const transport = String(cfg.transport || 'smtp').toLowerCase() === 'graph' ? 'graph' : 'smtp';
  return {
    provider: String(cfg.provider || 'outlook').toLowerCase(),
    tenant,
    tenantHint: tenantInfo.hint,
    clientId,
    scope: String(cfg.scope || '').trim() || defaultScope(transport),
    transport,
    deviceUrl: String(options.deviceUrl || cfg.oauthDeviceUrl || '').trim() || endpoints.deviceUrl,
    tokenUrl: String(options.tokenUrl || cfg.oauthTokenUrl || '').trim() || endpoints.tokenUrl,
    authBase: AUTH_BASE,
  };
}

/** 第一步：申请设备码。 */
export async function startDeviceCode(cfg = {}, { fetchImpl, deviceUrl } = {}) {
  const conf = oauthConfig(cfg, { deviceUrl });
  if (!providerSupportsOAuth(conf.provider)) {
    return { ok: false, message: '设备码授权目前只支持 Microsoft 账号（Outlook/Hotmail）' };
  }
  if (!conf.clientId) return { ok: false, message: '缺少 OAuth 客户端 ID' };
  let res;
  try {
    res = await postForm(conf.deviceUrl, { client_id: conf.clientId, scope: conf.scope }, { fetchImpl });
  } catch (error) {
    return {
      ok: false,
      message: `申请设备码失败：${fetchFailure(error)}。请确认网络能打开 https://login.microsoftonline.com（公司代理/防火墙可能拦截）`,
    };
  }
  const payload = res.payload || {};
  if (!payload.device_code) {
    return { ok: false, message: `申请设备码失败：${explainOAuthError(payload, res.status)}` };
  }
  const expiresIn = Number(payload.expires_in) || 900;
  return {
    ok: true,
    deviceCode: String(payload.device_code),
    userCode: String(payload.user_code || ''),
    verificationUri: String(payload.verification_uri || payload.verification_url || ''),
    expiresIn,
    interval: Number(payload.interval) || 5,
    scope: conf.scope,
    clientId: conf.clientId,
    tenant: conf.tenant,
    transport: conf.transport,
    message: String(payload.message || ''),
    hint: conf.tenantHint || '',
  };
}

/** 第二步：单次轮询。返回 {status: pending|slow_down|done|error}。 */
export async function pollDeviceCode(cfg = {}, deviceCode = '', { fetchImpl, tokenUrl } = {}) {
  const conf = oauthConfig(cfg, { tokenUrl });
  if (!deviceCode) return { status: 'error', message: '没有设备码，请先发起授权' };
  let res;
  try {
    res = await postForm(conf.tokenUrl, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: conf.clientId,
      device_code: deviceCode,
    }, { fetchImpl });
  } catch (error) {
    return { status: 'error', message: `轮询失败：${fetchFailure(error)}（网络能打开微软登录页吗？）` };
  }
  const payload = res.payload || {};
  if (payload.access_token) {
    return {
      status: 'done',
      accessToken: String(payload.access_token),
      refreshToken: String(payload.refresh_token || ''),
      expiresIn: Number(payload.expires_in) || 3600,
      scope: String(payload.scope || conf.scope),
      clientId: conf.clientId,
      tenant: conf.tenant,
      transport: conf.transport,
    };
  }
  const code = String(payload.error || '');
  if (code === 'authorization_pending') return { status: 'pending', message: '等待你在浏览器里完成授权…' };
  if (code === 'slow_down') return { status: 'pending', slowDown: true, message: '轮询太快，已放慢' };
  return { status: 'error', message: explainOAuthError(payload, res.status) };
}

/**
 * 用 refresh_token 换 access_token（内存缓存 + 静默续期）。
 *
 * @returns {Promise<{ok:boolean, token?:string, expiresIn?:number, refreshToken?:string, message?:string}>}
 */
export async function refreshAccessToken(cfg = {}, refreshToken = '', { fetchImpl, tokenUrl } = {}) {
  const conf = oauthConfig(cfg, { tokenUrl });
  if (!refreshToken) return { ok: false, message: '尚未授权：请先完成设备码授权' };
  const key = cacheKey(conf, refreshToken);
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now()) return { ok: true, token: hit.token, expiresIn: Math.round((hit.exp - Date.now()) / 1000) };

  let res;
  try {
    res = await postForm(conf.tokenUrl, {
      grant_type: 'refresh_token',
      client_id: conf.clientId,
      refresh_token: refreshToken,
      scope: conf.scope,
    }, { fetchImpl });
  } catch (error) {
    return { ok: false, message: `刷新 access_token 失败：${fetchFailure(error)}（检查网络/代理）` };
  }
  const payload = res.payload || {};
  if (!payload.access_token) {
    return { ok: false, message: `刷新 access_token 失败：${explainOAuthError(payload, res.status)}` };
  }
  const ttl = Number(payload.expires_in) || 3600;
  tokenCache.set(key, {
    token: String(payload.access_token),
    exp: Date.now() + Math.max(ttl - 120, 60) * 1000,
  });
  return {
    ok: true,
    token: String(payload.access_token),
    expiresIn: ttl,
    refreshToken: String(payload.refresh_token || ''),
  };
}

/**
 * 从本地存储取令牌（授权 → 续期 → 缓存）。
 *
 * @param {object} cfg 运行期配置（normalizeConfig 的结果）
 * @param {import('./store.js').EmailStore} store
 */
export async function getAccessToken(cfg = {}, store, { fetchImpl } = {}) {
  if (!store) return { ok: false, message: '内部错误：缺少令牌存储' };
  if (!providerSupportsOAuth(cfg.provider)) {
    return { ok: false, message: `${cfg.providerLabel || cfg.provider} 不支持 OAuth2，请把 auth 改成 basic` };
  }
  const record = store.account(cfg.username);
  if (!record?.refreshToken) {
    return {
      ok: false,
      needsAuth: true,
      message: '尚未授权：请先运行 email_oauth（action=start）完成微软设备码登录',
    };
  }
  // 换了 transport/scope 后旧令牌可能不适用：只拦「缺少必需权限」，
  // 不拦「多授权了别的权限」（微软常见行为，见 scopeSatisfies）。
  const conf = oauthConfig(cfg);
  if (!scopeSatisfies(record.scope, conf.scope)) {
    return {
      ok: false,
      needsAuth: true,
      message: `当前通道（${conf.transport}）缺少必需权限：请重新运行 email_oauth（action=start）授权一次。`
        + `已授权：${record.scope}`,
    };
  }
  const result = await refreshAccessToken(cfg, record.refreshToken, { fetchImpl });
  if (!result.ok) return { ok: false, needsAuth: /失效|吊销|invalid_grant/i.test(result.message || ''), message: result.message };
  if (result.refreshToken && result.refreshToken !== record.refreshToken) {
    store.setAccount(cfg.username, { refreshToken: result.refreshToken });
  }
  return { ok: true, token: result.token, expiresIn: result.expiresIn, record };
}
