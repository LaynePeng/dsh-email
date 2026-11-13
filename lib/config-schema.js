/**
 * 设置页表单 schema（DSH 设置 → 插件 → 邮件助手）。
 *
 * DSH 的设置页由插件导出的 `Config` 自动生成：只有声明了 volatile 的字段才会
 * 出现在表单里，保存后写入当前 profile 的 cordis.patch.yml，并由 `lib/js/config.js`
 * 整理成运行期配置。
 *
 * 字段名必须与 config.js 的读取一一对应——写错一个就是「设置页能改、实际不生效」
 * 这种最难查的静默失败（test/config.test.mjs 会逐字段校验）。
 *
 * schemastery 取不到时 `Config` 为 undefined：插件照常工作，只是设置页没有表单。
 * 不用静态 import 就是为了这个——它由宿主提供，拿不到也不该让工具一起挂掉。
 */

import { PROVIDER_ORDER, PROVIDERS } from './js/providers.js';

let z;
export let schemaError = '';

try {
  const mod = await import('@deepseek-ai/schemastery');
  z = mod?.default ?? mod?.Schema ?? mod;
  if (!z || typeof z.object !== 'function') {
    schemaError = `@deepseek-ai/schemastery 的导出形状不符合预期（keys: ${Object.keys(mod || {}).join(', ') || '空'}）`;
    z = undefined;
  }
} catch (error) {
  // 最常见原因：package.json 没把 schemastery 声明为 peerDependency
  schemaError = `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
  z = undefined;
}

const providerOptions = PROVIDER_ORDER.map((key) => z ? z.const(key) : key);

/**
 * 字段说明表（唯一事实源）。
 *
 * [键, 构造器, 说明, 默认值, 是否 secret]
 */
export const FIELD_SPECS = [
  ['provider', (a) => a.union(providerOptions),
    `服务商：${PROVIDER_ORDER.map((key) => `${key}=${PROVIDERS[key].label}`).join(' / ')}`, 'outlook'],
  ['auth', (a) => a.union([a.const('auto'), a.const('oauth2'), a.const('basic')]),
    '认证方式：auto 按服务商自动选（Outlook=OAuth2，其它=授权码）；也可手动强制 oauth2 / basic', 'auto'],
  ['username', (a) => a.string(),
    '邮箱账号（完整地址，如 me@outlook.com）。发件人留空时也用它', ''],
  ['password', (a) => a.string(),
    'basic 模式的密码/授权码（QQ/163/Gmail 等多数要「授权码」，不是登录密码）', '', true],
  ['fromName', (a) => a.string(), '发件人显示名（可选），如「张三」或「DSH 助手」', ''],
  ['fromAddress', (a) => a.string(), '发件人地址，留空＝邮箱账号。多数服务商要求它等于登录账号', ''],
  ['transport', (a) => a.union([a.const('auto'), a.const('graph'), a.const('smtp')]),
    '发信通道：auto=Outlook 走 Graph、其它走 SMTP；graph=Microsoft Graph（HTTPS 443，网络封 SMTP 时用）；smtp=标准 SMTP', 'auto'],
  ['smtpHost', (a) => a.string(), 'SMTP 服务器，留空＝服务商预设（如 smtp.qq.com）', ''],
  ['smtpPort', (a) => a.number().min(1).max(65535),
    'SMTP 端口：465（隐式 TLS）或 587（STARTTLS）；留空＝按服务商预设'],
  ['smtpTls', (a) => a.union([a.const('ssl'), a.const('starttls'), a.const('none')]),
    'SMTP 加密：ssl=465，starttls=587；留空＝按服务商/端口自动判断；none 仅限本机中继（并显式允许明文）'],
  ['imapHost', (a) => a.string(), 'IMAP 服务器（读信用），留空＝服务商预设', ''],
  ['imapPort', (a) => a.number().min(1).max(65535), 'IMAP 端口（留空＝993，隐式 TLS）'],
  ['oauthTenant', (a) => a.string(),
    'OAuth 租户：个人账号（Hotmail/Outlook/Live）留空；组织账号填租户域名或 ID。这里不能填邮箱', ''],
  ['oauthClientId', (a) => a.string(),
    'OAuth 客户端 ID：留空＝内置公共客户端；用自己的 Azure 应用时填（应用需允许公共客户端流）', ''],
  ['oauthScope', (a) => a.string(),
    '高级：覆盖默认 OAuth scope。Graph 与 outlook.office 属于不同资源，不能混写。留空＝按通道自动选', ''],
  ['dataDir', (a) => a.string(), 'OAuth 令牌与发信记录目录，留空＝$DSH_HOME/email-data', ''],
  ['maxAttachmentMb', (a) => a.number().min(1).max(50), '单封邮件附件总大小上限（MB）', 20],
  ['allowAttachmentDirs', (a) => a.string(),
    '额外允许读取附件的目录（分号分隔）。默认只允许当前工作区内的文件，防止误发 ~/.ssh 之类', ''],
  ['signature', (a) => a.string(), '默认签名（纯文本，可选）：正式发信时附在正文末尾', ''],
  ['allowInsecure', (a) => a.boolean(),
    '允许明文 SMTP（仅本机中继/测试）。默认关闭——明文里会带账号密码', false],
];

export const SETTINGS_KEYS = FIELD_SPECS.map(([key]) => key);

export const builtFields = [];

function buildConfig(api) {
  const shape = {};
  for (const [key, make, description, defaultValue, isSecret] of FIELD_SPECS) {
    try {
      let schema = make(api);
      if (isSecret && typeof schema.role === 'function') schema = schema.role('secret');
      schema = schema.description(description);
      if (defaultValue !== undefined) schema = schema.default(defaultValue);
      // `.extra('volatile', true)` 是「进设置表单」的开关，缺了就不显示
      shape[key] = schema.extra('volatile', true);
    } catch (error) {
      builtFields.push({ key, ok: false, reason: String(error?.message ?? error) });
    }
  }
  return api.object(shape);
}

let resolvedConfig;
try {
  resolvedConfig = z ? buildConfig(z) : undefined;
} catch (error) {
  resolvedConfig = undefined;
  schemaError = schemaError || `构建设置 schema 失败：${error?.message ?? error}`;
  builtFields.push({ key: '(object)', ok: false, reason: String(error?.message ?? error) });
}

export const Config = resolvedConfig;
