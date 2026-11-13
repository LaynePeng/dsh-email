/**
 * 邮件服务商预设（唯一事实源）。
 *
 * 为什么要有这张表：用户只该回答两个问题——「用哪家邮箱」「账号是什么」。
 * 服务器、端口、TLS、认证方式全部由预设决定；只有 `custom` 才暴露手填项。
 *
 * 每个预设的字段：
 *   auth      默认认证方式：oauth2（微软设备码）或 basic（密码/授权码）
 *   transport 发信通道：graph（HTTPS 443）或 smtp
 *   smtp      { host, port, tls }：tls = ssl（连接即 TLS，465）/ starttls（587）
 *   imap      { host, port }：读信（993 隐式 TLS）
 *   hint      设置页/状态里给用户看的说明
 *
 * `outlook` 默认走 Graph：smtp-mail.outlook.com 在部分网络会在 220 问候后
 * 直接断连（连 EHLO 都收不到），Graph 走 443 更稳；想走 SMTP XOAUTH2 的用户
 * 把 transport 改成 smtp 即可（授权时会自动换成 SMTP/IMAP 的 scope）。
 */

/** 内置 OAuth 公共客户端（多租户、允许设备码流程）。可在设置里填自己的 Azure 应用 ID 覆盖。 */
export const PUBLIC_CLIENT_ID = 'bec6c4fa-626d-4382-860f-0e3e4900ffd1';

/** 微软登录服务基址（设备码/令牌轮流按租户拼）。 */
export const AUTH_BASE = 'https://login.microsoftonline.com';

/** 个人账号默认租户。 */
export const DEFAULT_TENANT = 'common';

/** 发信 scope（Graph 资源）。 */
export const GRAPH_SCOPE = 'offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read';

/** 发信 + 读信 scope（outlook.office 资源，仅 SMTP/IMAP 通道可用）。 */
export const SMTP_SCOPE = 'offline_access https://outlook.office.com/SMTP.Send https://outlook.office.com/IMAP.AccessAsUser.All';

export const PROVIDERS = {
  outlook: {
    label: 'Outlook / Hotmail',
    auth: 'oauth2',
    transport: 'graph',
    // 实测（2026-11）：`smtp-mail.outlook.com:587` 在 STARTTLS 升级阶段会被
    // 网络间歇重置（4/4 失败），而 `smtp.office365.com:587` 稳定 4/4 成功——
    // 两者是同一套后端，只是入口不同。所以主用 office365，outlook 作备用。
    smtp: { host: 'smtp.office365.com', port: 587, tls: 'starttls' },
    smtpFallbackHosts: ['smtp-mail.outlook.com'],
    imap: { host: 'outlook.office365.com', port: 993 },
    hint: '微软账号：用设备码授权登录，不需要密码/应用专用密码。个人账号（Hotmail/Outlook/Live）无需填租户',
  },
  gmail: {
    label: 'Gmail',
    auth: 'basic',
    transport: 'smtp',
    smtp: { host: 'smtp.gmail.com', port: 465, tls: 'ssl' },
    imap: { host: 'imap.gmail.com', port: 993 },
    hint: '需先开启两步验证，再生成「应用专用密码」；登录密码会被拒绝',
  },
  qq: {
    label: 'QQ 邮箱',
    auth: 'basic',
    transport: 'smtp',
    smtp: { host: 'smtp.qq.com', port: 465, tls: 'ssl' },
    imap: { host: 'imap.qq.com', port: 993 },
    hint: 'QQ 邮箱设置 → 账户 → 开启 SMTP 服务，用生成的「授权码」而不是 QQ 密码',
  },
  '163': {
    label: '163 邮箱',
    auth: 'basic',
    transport: 'smtp',
    smtp: { host: 'smtp.163.com', port: 465, tls: 'ssl' },
    imap: { host: 'imap.163.com', port: 993 },
    hint: '163 邮箱设置里开启 SMTP/IMAP，用「授权码」登录',
  },
  '126': {
    label: '126 邮箱',
    auth: 'basic',
    transport: 'smtp',
    smtp: { host: 'smtp.126.com', port: 465, tls: 'ssl' },
    imap: { host: 'imap.126.com', port: 993 },
    hint: '126 邮箱设置里开启 SMTP/IMAP，用「授权码」登录',
  },
  sina: {
    label: '新浪邮箱',
    auth: 'basic',
    transport: 'smtp',
    smtp: { host: 'smtp.sina.com', port: 465, tls: 'ssl' },
    imap: { host: 'imap.sina.com', port: 993 },
    hint: '新浪邮箱需在设置里开启 SMTP 服务，密码通常是登录密码或独立授权码',
  },
  aliyun: {
    label: '阿里云邮箱',
    auth: 'basic',
    transport: 'smtp',
    smtp: { host: 'smtp.aliyun.com', port: 465, tls: 'ssl' },
    imap: { host: 'imap.aliyun.com', port: 993 },
    hint: '企业邮箱把服务器改成 smtp.qiye.aliyun.com（或自定义）',
  },
  icloud: {
    label: 'iCloud 邮箱',
    auth: 'basic',
    transport: 'smtp',
    smtp: { host: 'smtp.mail.me.com', port: 587, tls: 'starttls' },
    imap: { host: 'imap.mail.me.com', port: 993 },
    hint: 'Apple ID 需开启双重认证并生成「App 专用密码」',
  },
  zoho: {
    label: 'Zoho 邮箱',
    auth: 'basic',
    transport: 'smtp',
    smtp: { host: 'smtp.zoho.com', port: 465, tls: 'ssl' },
    imap: { host: 'imap.zoho.com', port: 993 },
    hint: 'Zoho 需在账户安全里开启 SMTP，并使用应用专用密码',
  },
  fastmail: {
    label: 'Fastmail',
    auth: 'basic',
    transport: 'smtp',
    smtp: { host: 'smtp.fastmail.com', port: 465, tls: 'ssl' },
    imap: { host: 'imap.fastmail.com', port: 993 },
    hint: 'Fastmail 需在设置里创建 App Password',
  },
  custom: {
    label: '自定义 SMTP',
    auth: 'basic',
    transport: 'smtp',
    smtp: { host: '', port: 587, tls: 'starttls' },
    imap: { host: '', port: 993 },
    hint: '自己填服务器、端口与加密方式（465=ssl，587=starttls）',
  },
};

/** 展示顺序（`'163'`/`'126'` 是数字键，对象键顺序会把它们排到最前）。 */
export const PROVIDER_ORDER = [
  'outlook', 'qq', '163', '126', 'gmail', 'sina', 'aliyun', 'icloud', 'zoho', 'fastmail', 'custom',
];

export function providerPreset(key) {
  return PROVIDERS[String(key || '').trim().toLowerCase()] || PROVIDERS.custom;
}

export function isKnownProvider(key) {
  return Object.hasOwn(PROVIDERS, String(key || '').trim().toLowerCase());
}

/** 只有微软邮箱支持设备码 OAuth；其它服务商走密码/授权码。 */
export function providerSupportsOAuth(key) {
  return String(key || '').trim().toLowerCase() === 'outlook';
}

/**
 * 租户规范化。
 *
 * Azure 对「租户填了邮箱」只回 `AADSTS900023: ... is neither a valid DNS name,
 * nor a valid external domain`，完全不指向字段。这里提前纠正：
 *   · 留空 → common（个人账号与组织账号都能走）；
 *   · 看起来是邮箱/网址 → common，并给出提示；
 *   · consumers/organizations/common、GUID、域名 → 原样。
 */
export function normalizeTenant(raw) {
  const value = String(raw || '').trim();
  if (!value) return { tenant: DEFAULT_TENANT, hint: '' };
  const low = value.toLowerCase();
  if (['common', 'consumers', 'organizations'].includes(low)) return { tenant: low, hint: '' };
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    return {
      tenant: DEFAULT_TENANT,
      hint: `「租户」填的是邮箱（${value}），已改用 ${DEFAULT_TENANT}；个人账号请留空，组织账号填租户域名或 ID`,
    };
  }
  if (/^https?:\/\//i.test(value) || value.includes('/')) {
    return {
      tenant: DEFAULT_TENANT,
      hint: `「租户」看起来是网址（${value}），已改用 ${DEFAULT_TENANT}；应填租户域名或 ID`,
    };
  }
  return { tenant: value, hint: '' };
}

/** 按租户拼出设备码/令牌端点。 */
export function endpointsFor(tenant) {
  const base = `${AUTH_BASE}/${tenant}/oauth2/v2.0`;
  return {
    deviceUrl: `${base}/devicecode`,
    tokenUrl: `${base}/token`,
  };
}

/** 默认 scope：按发信通道选择（Graph 与 outlook.office 属于不同资源，不能混在一个请求里）。 */
export function defaultScope(transport) {
  return String(transport || '').toLowerCase() === 'graph' ? GRAPH_SCOPE : SMTP_SCOPE;
}
