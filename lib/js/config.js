/**
 * 插件配置 → 运行期配置（唯一转换层）。
 *
 * 两个必须在这里解决的问题：
 *
 * 1. **惰性配置值**：DSH 的配置项可能是 `{ get: () => current }`（`volatile()`
 *    字段），直接当字符串用会得到 `"[object Object]"`，甚至让路径/端口全部
 *    失效。所有读取都先过 `unwrapConfigValue()`。
 * 2. **能推导的绝不让人填**：选好服务商后，SMTP/IMAP 服务器、端口、TLS、
 *    认证方式、OAuth scope 全部由预设推导；只有 `custom` 才用用户填的。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  defaultScope, isKnownProvider, normalizeTenant, providerPreset, providerSupportsOAuth,
} from './providers.js';

/** 拆开 DSH 的惰性配置包装。 */
export function unwrapConfigValue(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

function text(value) {
  const plain = unwrapConfigValue(value);
  if (plain === undefined || plain === null) return '';
  return String(plain).trim();
}

function num(value) {
  const plain = unwrapConfigValue(value);
  if (plain === undefined || plain === null || plain === '') return null;
  const parsed = Number(plain);
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value) {
  const plain = unwrapConfigValue(value);
  if (plain === undefined || plain === null || plain === '') return null;
  if (typeof plain === 'boolean') return plain;
  const lowered = String(plain).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(lowered)) return false;
  return null;
}

/** DSH 数据目录（宿主注入 DSH_HOME 时优先）。 */
export function dshHome() {
  return text(process.env.DSH_HOME) || join(homedir(), '.dsh');
}

export function defaultDataDir() {
  return join(dshHome(), 'email-data');
}

/** 邮箱地址校验（只接受 ASCII：全角字符会让 SMTP 回 501 5.1.7）。 */
const ADDRESS_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export function looksLikeEmail(value) {
  return ADDRESS_RE.test(String(value || '').trim());
}

/**
 * 把配置整理成内部结构。
 *
 * @param {object} raw 宿主给的插件配置
 * @param {{env?: object}} [options] 测试可注入环境变量
 */
export function normalizeConfig(raw = {}, options = {}) {
  const env = options.env || process.env;
  const source = raw && typeof raw === 'object' ? raw : {};
  const warnings = [];

  const providerKey = text(source.provider).toLowerCase() || 'outlook';
  if (!isKnownProvider(providerKey)) {
    warnings.push(`未知服务商「${providerKey}」，按 custom 处理`);
  }
  const provider = isKnownProvider(providerKey) ? providerKey : 'custom';
  const preset = providerPreset(provider);

  // OAuth 只有微软邮箱支持；选了其它服务商却写 oauth2 时退回密码模式
  let auth = text(source.auth).toLowerCase() || 'auto';
  if (!['auto', 'oauth2', 'basic'].includes(auth)) {
    warnings.push(`未知认证方式「${auth}」，按服务商预设 ${preset.auth} 处理`);
    auth = 'auto';
  }
  if (auth === 'auto') auth = preset.auth;
  if (auth === 'oauth2' && !providerSupportsOAuth(provider)) {
    warnings.push(`${preset.label} 不支持设备码 OAuth，已改回密码/授权码认证`);
    auth = 'basic';
  }

  let transport = text(source.transport).toLowerCase() || preset.transport || 'smtp';
  if (!['auto', 'graph', 'smtp'].includes(transport)) {
    warnings.push(`未知发信通道「${transport}」，按 auto 处理`);
    transport = 'auto';
  }
  if (transport === 'auto') transport = preset.transport || 'smtp';
  if (transport === 'graph' && !(auth === 'oauth2' && providerSupportsOAuth(provider))) {
    warnings.push('Graph 通道只适用于 Microsoft OAuth2，已改用 SMTP');
    transport = 'smtp';
  }

  const username = text(source.username) || text(env.DSH_EMAIL_USERNAME);
  const password = text(source.password) || text(env.DSH_EMAIL_PASSWORD);
  const fromAddress = text(source.fromAddress) || username;
  const fromName = text(source.fromName);
  if (fromAddress && username && fromAddress.toLowerCase() !== username.toLowerCase()
    && provider !== 'custom') {
    warnings.push(`发件人（${fromAddress}）与登录账号（${username}）不同：多数服务商要求两者一致，否则发信会被拒（550）`);
  }

  const explicitSmtpHost = text(source.smtpHost);
  const smtpHost = explicitSmtpHost || preset.smtp.host;
  const portValue = (value, fallback) => {
    const parsed = num(value);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
  };
  const smtpPort = portValue(source.smtpPort, preset.smtp.port ?? 587);
  let smtpTls = text(source.smtpTls).toLowerCase() || preset.smtp.tls || 'starttls';
  if (!['ssl', 'starttls', 'none'].includes(smtpTls)) {
    warnings.push(`未知 SMTP 加密方式「${smtpTls}」，按端口推断`);
    smtpTls = smtpPort === 465 ? 'ssl' : 'starttls';
  }
  // 端口与加密方式矛盾时按端口纠正：用户改端口不改下拉框是最常见的错配
  if (smtpPort === 465 && smtpTls !== 'ssl') {
    warnings.push('SMTP 端口 465 应使用隐式 TLS，已把加密方式改为 ssl');
    smtpTls = 'ssl';
  }
  if (smtpPort === 587 && smtpTls === 'ssl') {
    warnings.push('SMTP 端口 587 通常用 STARTTLS，已把加密方式改为 starttls');
    smtpTls = 'starttls';
  }

  const imapHost = text(source.imapHost) || preset.imap.host;
  const imapPort = portValue(source.imapPort, preset.imap.port ?? 993);
  let imapTls2 = text(source.imapTls).toLowerCase() || preset.imap.tls || 'ssl';
  if (!['ssl', 'starttls'].includes(imapTls2)) imapTls2 = imapPort === 143 ? 'starttls' : 'ssl';
  // 备用入口：993 被网络封时，143+STARTTLS 是等价可用的通道（实测微软支持）
  const imapFallbacks = text(source.imapHost)
    ? []
    : (preset.imapFallbackPorts || []).filter((item) => item.port !== imapPort);

  const tenantInfo = normalizeTenant(text(source.oauthTenant) || text(env.DSH_EMAIL_OAUTH_TENANT));
  if (tenantInfo.hint) warnings.push(tenantInfo.hint);

  const dataDir = text(source.dataDir) || defaultDataDir();
  const maxAttachmentMb = num(source.maxAttachmentMb) ?? 20;
  const allowAttachmentDirs = text(source.allowAttachmentDirs)
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);

  const scope = text(source.oauthScope) || defaultScope(transport);

  return {
    // 设备码/令牌端点默认由租户推导；这里给自建代理与本地联调留口子
    oauthDeviceUrl: text(source.oauthDeviceUrl) || text(env.DSH_EMAIL_OAUTH_DEVICE_URL),
    oauthTokenUrl: text(source.oauthTokenUrl) || text(env.DSH_EMAIL_OAUTH_TOKEN_URL),
    provider,
    providerLabel: preset.label,
    preset,
    auth,
    transport,
    username,
    password,
    fromAddress,
    fromName,
    smtpHost,
    smtpPort,
    smtpTls,
    // 备用入口：只有用预设主机时才启用（用户手填就代表他要用那个）
    smtpFallbackHosts: explicitSmtpHost ? [] : (preset.smtpFallbackHosts || []),
    imapHost,
    imapPort,
    imapTls: imapTls2,
    imapFallbacks,
    tenant: tenantInfo.tenant,
    clientId: text(source.oauthClientId) || text(env.DSH_EMAIL_OAUTH_CLIENT_ID),
    scope,
    dataDir,
    maxAttachmentMb: Math.min(Math.max(maxAttachmentMb, 1), 50),
    allowAttachmentDirs,
    signature: text(source.signature),
    allowInsecure: bool(source.allowInsecure) === true,
    warnings,
  };
}

/**
 * 配置是否齐备（发信）。返回 `{ready, reason, missing}`。
 *
 * 只检查「本机能否开始」——账号密码对不对只能靠实际 AUTH；所以这里
 * 绝不写「已验证」。
 */
export function sendReadiness(cfg = {}) {
  const missing = [];
  if (!cfg.username) missing.push('邮箱账号（username）');
  else if (!looksLikeEmail(cfg.username)) {
    return { ready: false, missing: ['邮箱账号'], reason: `邮箱账号不是有效的纯 ASCII 地址：${cfg.username}` };
  }
  if (!cfg.fromAddress) missing.push('发件人地址（fromAddress）');
  else if (!looksLikeEmail(cfg.fromAddress)) {
    return { ready: false, missing: ['发件人地址'], reason: `发件人不是有效的纯 ASCII 地址：${cfg.fromAddress}` };
  }
  if (cfg.auth === 'oauth2') {
    // refresh_token 在本地存储里，调用方单独检查；这里只查配置项
    if (!providerSupportsOAuth(cfg.provider)) {
      return { ready: false, missing: [], reason: `${cfg.providerLabel} 不支持 OAuth2，请把认证方式改成密码/授权码` };
    }
  } else if (!cfg.password) {
    missing.push('密码 / 授权码（password）');
  }
  if (cfg.transport === 'smtp') {
    if (!cfg.smtpHost) missing.push('SMTP 服务器（smtpHost）');
    if (!Number.isFinite(Number(cfg.smtpPort))) missing.push('SMTP 端口（smtpPort）');
  }
  if (missing.length) {
    return {
      ready: false,
      missing,
      reason: `还缺：${missing.join('、')}`,
    };
  }
  return { ready: true, missing: [], reason: '' };
}

/** 邮箱地址只保留 ASCII 可打印字符（NFKC 折全角、去零宽字符）。 */
export function sanitizeAddress(value) {
  const normalized = String(value ?? '').normalize('NFKC');
  const matched = normalized.match(/<([^<>]+)>/);
  let addr = (matched ? matched[1] : normalized).trim();
  addr = addr.replace(/^["']+|["']+$/g, '').replace(/[\s\u200B-\u200D\uFEFF]/g, '');
  addr = addr.replace(/[^\x20-\x7E]/g, '');
  const at = addr.lastIndexOf('@');
  if (at < 0) return addr;
  const local = addr.slice(0, at).replace(/^\.+|\.+$/g, '');
  const domain = addr.slice(at + 1).replace(/^\.+|\.+$/g, '').toLowerCase();
  return `${local}@${domain}`;
}

/** 收件人支持字符串（逗号/分号分隔）或数组。 */
export function splitAddresses(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item ?? '').trim()).filter(Boolean);
  }
  return String(raw ?? '')
    .replace(/[，;；]/g, ',')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
