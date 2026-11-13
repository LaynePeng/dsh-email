/**
 * 状态与自检：告诉用户「现在能不能发、缺什么、授权到哪一步」。
 *
 * 两个动作严格分开：
 *   · `buildStatus()` 只读本地配置/令牌，不联网、零副作用；
 *   · `probeStatus()` 才真的连一次服务器（SMTP 登录或 Graph 令牌续期），
 *     且**不发测试邮件**——发信是用户的决定，不是自检的副产品。
 */

import fs from 'node:fs';

import { sendReadiness } from './config.js';
import { graphProbe } from './graph.js';
import { getAccessToken, oauthConfig, scopeSatisfies } from './oauth.js';
import { smtpProbe } from './smtp.js';

function remainingText(expiresAt) {
  const ms = Number(expiresAt) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return '已过期';
  const minutes = Math.ceil(ms / 60000);
  return `${minutes} 分钟后过期`;
}

/** 本地状态（不联网）。 */
export function buildStatus(cfg, store) {
  const checks = [];
  const readiness = sendReadiness(cfg);
  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  push('邮箱账号', Boolean(cfg.username), cfg.username || '未填写（设置 → 插件 → 邮件助手）');
  push('发件人', Boolean(cfg.fromAddress), cfg.fromAddress || '未填写（留空应等于邮箱账号）');

  let authOk = false;
  let authDetail = '';
  const record = cfg.username ? store.account(cfg.username) : null;
  if (cfg.auth === 'oauth2') {
    if (!record?.refreshToken) {
      authDetail = '尚未授权：运行 email_oauth（action=start）完成微软设备码登录';
    } else {
      const conf = oauthConfig(cfg);
      authOk = scopeSatisfies(record.scope, conf.scope);
      authDetail = authOk
        ? `已授权（${record.tenant || 'common'}，${record.transport || '?'} 通道，${record.obtainedAt ? `授权于 ${record.obtainedAt.slice(0, 10)}` : '时间未知'}）`
        : `已授权权限缺少当前通道必需项：需要重新授权（已授权：${record.scope || '未知'}）`;
    }
  } else {
    authOk = Boolean(cfg.password);
    authDetail = authOk ? '已填写密码/授权码（不会被回显）' : '未填写密码/授权码';
  }
  push('认证', authOk, authDetail);

  const channelOk = cfg.transport === 'graph'
    ? authOk
    : Boolean(cfg.smtpHost) && Number(cfg.smtpPort) > 0;
  push('发信通道', channelOk, cfg.transport === 'graph'
    ? 'Microsoft Graph（HTTPS 443）'
    : `SMTP ${cfg.smtpHost || '(未填)'}:${cfg.smtpPort || '-'}（${cfg.smtpTls || '-'}）`);

  const graphOauth = cfg.auth === 'oauth2' && cfg.transport === 'graph';
  const imapOk = Boolean(cfg.imapHost) && !graphOauth;
  push('收件（IMAP）', imapOk, imapOk
    ? `${cfg.imapHost}:${cfg.imapPort}（只读）`
    : (graphOauth
      ? 'Graph 发信通道不含 IMAP 权限：读信需把 transport 改成 smtp 并重新授权（不影响发信）'
      : '未配置 imapHost（不影响发信）'));

  let dirOk = false;
  let dirDetail = cfg.dataDir;
  try {
    // 只检查目录可创建/可写；不往里面写测试文件
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    fs.accessSync(cfg.dataDir, fs.constants.W_OK);
    dirOk = true;
  } catch (error) {
    dirDetail = `${cfg.dataDir}（不可写：${error?.message ?? error}）`;
  }
  push('令牌/审计目录', dirOk, dirDetail);

  const pendingRaw = store.pending();
  const pending = pendingRaw
    ? {
      userCode: pendingRaw.userCode,
      verificationUri: pendingRaw.verificationUri,
      expiresText: remainingText(pendingRaw.expiresAt),
      expired: pendingRaw.expired,
    }
    : null;

  const ready = readiness.ready
    && checks.filter((check) => ['发件人', '认证', '发信通道'].includes(check.name)).every((check) => check.ok);

  return {
    ready,
    provider: cfg.provider,
    providerLabel: cfg.providerLabel,
    username: cfg.username,
    fromAddress: cfg.fromAddress,
    transport: cfg.transport,
    auth: cfg.auth,
    smtp: cfg.transport === 'smtp'
      ? { host: cfg.smtpHost, port: cfg.smtpPort, tls: cfg.smtpTls }
      : null,
    imap: { host: cfg.imapHost, port: cfg.imapPort },
    limits: { maxAttachmentMb: cfg.maxAttachmentMb },
    checks,
    pending,
    recent: store.recentSends(3),
    warnings: [...(cfg.warnings || []), ...(store.warnings || [])],
    readiness,
  };
}

/** 便于模型和人读的状态文本（表格 + 待办）。 */
export function renderStatus(status) {
  const mark = (ok) => (ok ? '✅' : '❌');
  const lines = [
    `# 邮件状态：${status.providerLabel}${status.username ? `（${status.username}）` : ''}`,
    '',
    '| 项目 | 状态 |',
    '|---|---|',
    `| 能否发信 | ${status.ready ? '✅ 配置齐备（尚未实际发信）' : '❌ 还不能发'} |`,
    `| 认证方式 | ${status.auth === 'oauth2' ? 'OAuth2 设备码' : '密码 / 授权码'} |`,
    `| 发信通道 | ${status.transport === 'graph' ? 'Microsoft Graph（HTTPS）' : `SMTP ${status.smtp?.host}:${status.smtp?.port}（${status.smtp?.tls}）`} |`,
    `| 附件上限 | 单封 ${status.limits.maxAttachmentMb} MB |`,
  ];
  for (const check of status.checks) {
    lines.push(`| ${check.name} | ${mark(check.ok)} ${check.detail} |`);
  }
  lines.push('');
  if (status.pending) {
    lines.push('## 授权进行中（未完成）', '');
    lines.push(`打开 ${status.pending.verificationUri || 'https://microsoft.com/devicelogin'} 输入代码 **${status.pending.userCode || '(未知)'}**（${status.pending.expiresText}）。`);
    if (status.pending.expired) lines.push('设备码已过期：重新运行 `email_oauth`（action=start）拿新码。');
    lines.push('');
  }
  if (status.recent?.length) {
    lines.push('## 最近发信', '');
    for (const item of status.recent) {
      lines.push(`- ${item.at?.replace('T', ' ').slice(0, 19) || '?'} ${item.ok ? '✅' : '❌'} ${item.to?.join(', ') || ''}「${item.subject || ''}」${item.detail ? `：${item.detail}` : ''}`);
    }
    lines.push('');
  }
  if (status.warnings?.length) {
    lines.push('## 提示', '');
    for (const warning of status.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  if (!status.ready) {
    lines.push('## 下一步', '');
    if (status.auth === 'oauth2' && !status.checks.find((c) => c.name === '认证')?.ok) {
      lines.push('1. 运行 `email_oauth`（action=start），按返回的网址+代码在浏览器完成授权；');
      lines.push('2. 再运行 `email_oauth`（action=poll）确认拿到令牌。');
    } else {
      lines.push('1. 在「设置 → 插件 → 邮件助手」填写邮箱账号与密码/授权码；');
      lines.push('2. 运行 `email_status`（probe=true）验证能否登录。');
    }
  } else {
    lines.push('发信前建议先 `email_send`（dry_run=true）预览草稿，确认后再正式发送。');
  }
  return lines.join('\n');
}

/**
 * 联网自检（不发信）。
 *
 * @param {object} cfg
 * @param {import('./store.js').EmailStore} store
 * @param {{deps?:object}} [context]
 */
export async function probeStatus(cfg, store, context = {}) {
  const deps = context.deps || {};
  if (!cfg.username) return { ok: false, message: '邮箱账号未填写：无法自检' };
  if (cfg.auth === 'oauth2') {
    const token = await getAccessToken(cfg, store, { fetchImpl: deps.fetchImpl });
    if (!token.ok) return { ok: false, message: token.message };
    if (cfg.transport === 'graph') {
      const graph = await graphProbe(cfg, token.token, { fetchImpl: deps.fetchImpl, baseUrl: deps.graphBaseUrl });
      if (!graph.ok) return { ok: false, message: `令牌续期成功，但 Graph 不可达：${graph.message}` };
      return {
        ok: true,
        message: `✅ ${graph.message}。本次自检没有发送任何邮件，也没有验证收件人地址`,
      };
    }
    return smtpProbe({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      tls: cfg.smtpTls,
      allowInsecure: cfg.allowInsecure,
      username: cfg.username,
      accessToken: token.token,
      auth: 'oauth2',
      connect: deps.connect,
      timeoutMs: deps.timeoutMs,
    });
  }
  return smtpProbe({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    tls: cfg.smtpTls,
    allowInsecure: cfg.allowInsecure,
    username: cfg.username,
    password: cfg.password,
    auth: 'basic',
    connect: deps.connect,
    timeoutMs: deps.timeoutMs,
  });
}
