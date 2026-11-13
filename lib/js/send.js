/**
 * 发信编排：校验 → 组装 → 选通道 → 发送 → 审计。
 *
 * 这一层是**唯一**决定「这封信怎么发出去」的地方：
 *   · dry_run 只组装草稿，不连网、不读令牌——预览必须永远可用；
 *   · graph 通道：先 refresh_token 换 access_token，再 HTTPS 提交；
 *   · smtp 通道：basic 用密码/授权码，oauth2 用 XOAUTH2。
 *
 * 约定：**绝不抛异常**。所有失败都返回 `{ok:false, message}`，message 是能
 * 直接照着改的说明（缺什么配置、该重新授权、附件路径不对……）。
 */

import {
  looksLikeEmail, sanitizeAddress, sendReadiness, splitAddresses,
} from './config.js';
import { graphSend } from './graph.js';
import { buildMimeMessage, htmlToText, prepareAttachments } from './message.js';
import { getAccessToken, oauthConfig, refreshAccessToken } from './oauth.js';
import { SMTP_SCOPE } from './providers.js';
import { smtpSend } from './smtp.js';

/**
 * Graph 通道失败后是否值得尝试 SMTP 回落。
 *
 * 实测背景：部分网络会选择性重置「带微软 OAuth 令牌的 HTTPS 请求」
 * （graph.microsoft.com 匿名 401 可通、带 token 即断），而同期的
 * smtp-mail.outlook.com:587 STARTTLS 能正常完成 XOAUTH2 发信。只对
 * 「网关/网络类」失败回落；401/403（令牌/权限问题）换通道也一样失败，
 * 直接把原因告诉用户。
 */
function graphFailureAllowsSmtpFallback(result) {
  if (result.ok) return false;
  const code = Number(result.code);
  if (code === 401 || code === 403) return false; // 令牌/权限问题，换通道无意义
  if (code === 413) return false; // 邮件太大，SMTP 也一样被拒
  if (code === 429) return false; // 限流：稍后重试，不是换通道能解决的
  // 502/503/504/网络错误/超时：都值得一试
  return true;
}

/**
 * 取 SMTP scope 的 access_token。
 *
 * 同一个 refresh_token 可以向不同资源换令牌：Graph 失败后用
 * outlook.office.com/SMTP.Send 的 scope 重新刷新即可拿到 SMTP 令牌，
 * 不需要用户重新授权（前提是授权时同意过 SMTP.Send——设备码流程里
 * 它和 Mail.Send 一起出现在同一应用上）。
 */
async function getSmtpAccessToken(cfg, store, { fetchImpl } = {}) {
  const record = store.account(cfg.username);
  if (!record?.refreshToken) {
    return { ok: false, message: '尚未授权：请先完成设备码授权' };
  }
  const refreshed = await refreshAccessToken(
    { ...cfg, scope: SMTP_SCOPE },
    record.refreshToken,
    { fetchImpl },
  );
  if (!refreshed.ok) return refreshed;
  if (refreshed.refreshToken && refreshed.refreshToken !== record.refreshToken) {
    store.setAccount(cfg.username, { refreshToken: refreshed.refreshToken });
  }
  return { ok: true, token: refreshed.token };
}

/**
 * Graph 熔断窗口。
 *
 * 为什么需要：Graph 被网络拦时每次都要等超时（实测 30–60 秒）才回落 SMTP，
 * 用户每发一封就要多等一分钟。记住「刚才 Graph 不通」，在窗口内直接走 SMTP，
 * 过期后再试一次 Graph（网络恢复能自动回到主通道）。
 */
export const GRAPH_COOLDOWN_MS = 10 * 60 * 1000;
let graphCooldownUntil = 0;

/** 清掉熔断（换配置/重新授权/自检成功后调用）。 */
export function resetGraphCooldown() {
  graphCooldownUntil = 0;
}

/** 剩余熔断时间（毫秒），0 表示没有熔断。 */
export function graphCooldownRemaining(now = Date.now()) {
  return Math.max(0, graphCooldownUntil - now);
}

/** 一封邮件最多允许的收件人（防止模型把通讯录整段塞进来群发）。 */
export const MAX_RECIPIENTS = 50;

function toMailbox(value) {
  if (value && typeof value === 'object') {
    return { address: sanitizeAddress(value.address), name: String(value.name || '').trim() };
  }
  return { address: sanitizeAddress(value), name: '' };
}

/** 规范化收件人列表：去重、校验、限量。 */
function normalizeRecipients(raw, label) {
  const list = splitAddresses(raw).map(toMailbox).filter((item) => item.address);
  const seen = new Set();
  const unique = [];
  const invalid = [];
  for (const item of list) {
    if (!looksLikeEmail(item.address)) {
      invalid.push(item.address);
      continue;
    }
    const key = item.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  if (invalid.length) {
    return { ok: false, message: `${label}里有无效邮箱地址：${invalid.join('、')}（只接受纯 ASCII 地址）` };
  }
  if (unique.length > MAX_RECIPIENTS) {
    return { ok: false, message: `${label}超过 ${MAX_RECIPIENTS} 个上限（当前 ${unique.length} 个）：请确认这不是群发` };
  }
  return { ok: true, list: unique };
}

function appendSignature(text, html, signature) {
  const sig = String(signature || '').trim();
  if (!sig) return { text, html };
  const nextText = `${text}${text ? '\n\n' : ''}-- \n${sig}`;
  const nextHtml = html
    ? `${html}<div style="margin-top:16px;color:#666;font-size:13px;white-space:pre-wrap">-- <br>${escapeHtml(sig)}</div>`
    : html;
  return { text: nextText, html: nextHtml };
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 草稿预览（dry_run 的返回值）：只描述「将会发什么」，不读令牌。 */
export function renderDraft(draft = {}) {
  const lines = ['📧 邮件草稿（未发送 · dry_run）', ''];
  lines.push(`收件人：${(draft.to || []).map((item) => item.address).join(', ') || '(空)'}`);
  if (draft.cc?.length) lines.push(`抄送：${draft.cc.map((item) => item.address).join(', ')}`);
  if (draft.bcc?.length) lines.push(`密送：${draft.bcc.map((item) => item.address).join(', ')}`);
  lines.push(`主题：${draft.subject || '(空)'}`);
  lines.push(`发件人：${draft.from?.name ? `${draft.from.name} <${draft.from.address}>` : draft.from?.address || '(未配置)'}`);
  lines.push(`通道：${draft.transport === 'graph' ? 'Microsoft Graph（HTTPS）' : `SMTP ${draft.smtpHost || ''}${draft.smtpTls ? `（${draft.smtpTls}）` : ''}`}`);
  if (draft.attachments?.length) {
    lines.push(`附件：${draft.attachments.map((item) => `${item.filename}（${formatBytes(item.size)}）`).join('、')}`);
  }
  lines.push('', '正文（纯文本）：');
  lines.push(draft.text || '(空)');
  if (draft.html) {
    lines.push('', `HTML 正文：${draft.html.length} 字符（收件人优先看到它；纯文本客户端看到上面的正文）`);
  }
  if (draft.warnings?.length) {
    lines.push('', '提示：');
    for (const warning of draft.warnings) lines.push(`- ${warning}`);
  }
  lines.push('', '确认内容无误后，去掉 dry_run 用同样的参数再调用一次才会真正发送。');
  return lines.join('\n');
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 发一封邮件。
 *
 * @param {object} cfg normalizeConfig 的结果
 * @param {import('./store.js').EmailStore} store
 * @param {object} args 工具参数
 * @param {{workspace?:string, deps?:object}} [context] deps 供测试注入 fetchImpl/connect
 */
export async function sendEmail(cfg, store, args = {}, context = {}) {
  const deps = context.deps || {};
  try {
    const dryRun = args.dry_run === true || args.dryRun === true;
    const to = normalizeRecipients(args.to, '收件人');
    if (!to.ok) return { ok: false, message: to.message };
    if (!to.list.length) return { ok: false, message: '收件人不能为空' };
    const cc = normalizeRecipients(args.cc, '抄送');
    if (!cc.ok) return { ok: false, message: cc.message };
    const bcc = normalizeRecipients(args.bcc, '密送');
    if (!bcc.ok) return { ok: false, message: bcc.message };

    const subject = String(args.subject ?? '').trim();
    if (!subject) return { ok: false, message: '主题不能为空：请给邮件一个能说明来意的主题（不要发无主题邮件）' };

    const text = String(args.body ?? args.text ?? '');
    const html = String(args.html ?? '');
    if (!text.trim() && !html.trim()) return { ok: false, message: '正文不能为空：至少给出纯文本正文（body）' };

    const readiness = sendReadiness(cfg);

    let prepared;
    try {
      prepared = prepareAttachments(args.attachments || [], {
        workspace: context.workspace,
        allowDirs: cfg.allowAttachmentDirs,
        maxBytes: cfg.maxAttachmentMb * 1024 * 1024,
      });
    } catch (error) {
      return { ok: false, message: `附件处理失败：${error?.message ?? error}` };
    }

    const signed = appendSignature(text, html, cfg.signature);
    const from = { address: cfg.fromAddress, name: cfg.fromName };
    const draft = {
      from,
      to: to.list,
      cc: cc.list,
      bcc: bcc.list,
      subject,
      text: signed.text,
      html: signed.html,
      attachments: prepared.attachments.map((item) => ({
        filename: item.filename, size: item.size, contentType: item.contentType,
      })),
      transport: cfg.transport,
      smtpHost: cfg.smtpHost,
      smtpTls: cfg.smtpTls,
      warnings: [
        ...(cfg.warnings || []),
        ...(readiness.ready ? [] : [`配置尚不完整：${readiness.reason}（预览可用，正式发送前需要先补齐）`]),
      ],
    };

    if (dryRun) {
      return { ok: true, dryRun: true, draft, message: renderDraft(draft) };
    }
    if (!readiness.ready) {
      return { ok: false, message: `邮件配置还不完整：${readiness.reason}。设置位置：设置 → 插件 → 邮件助手` };
    }

    let result;
    if (cfg.transport === 'graph') {
      const cooling = graphCooldownRemaining() > 0 && Boolean(cfg.smtpHost);
      let graphError = null;

      if (!cooling) {
        const token = await getAccessToken(cfg, store, { fetchImpl: deps.fetchImpl });
        if (!token.ok) {
          return { ok: false, needsAuth: token.needsAuth, message: `发信前拿不到访问令牌：${token.message}` };
        }
        result = await graphSend(cfg, {
        to: to.list,
        cc: cc.list,
        bcc: bcc.list,
        subject,
        text: signed.text,
        html: signed.html,
        attachments: prepared.attachments,
        }, { accessToken: token.token, fetchImpl: deps.fetchImpl, baseUrl: deps.graphBaseUrl });
        result.transport = 'graph';
        if (result.ok) {
          graphCooldownUntil = 0; // 通了就解除熔断
        } else if (graphFailureAllowsSmtpFallback(result)) {
          // 网关/网络类失败：记一笔，接下来 10 分钟直接走 SMTP，不必每封等超时
          graphCooldownUntil = Date.now() + GRAPH_COOLDOWN_MS;
          graphError = result;
        }
      }

      // 回落 SMTP：同一 refresh_token 换 SMTP 令牌，不需要重新授权。
      const shouldFallback = Boolean(cfg.smtpHost) && (cooling || graphError);
      if (shouldFallback) {
        const smtpToken = await getSmtpAccessToken(cfg, store, { fetchImpl: deps.fetchImpl });
        if (smtpToken.ok) {
          const fallback = await sendViaSmtpChannel(cfg, {
            to: to.list, cc: cc.list, bcc: bcc.list, subject, signed, prepared,
            accessToken: smtpToken.token, deps, attempts: deps.smtpAttempts,
          });
          if (fallback.ok) {
            fallback.fallbackFrom = 'graph';
            if (cooling) {
              const minutes = Math.ceil(graphCooldownRemaining() / 60000);
              fallback.message = `${fallback.message}（Graph 近期不通，已直接走 SMTP；约 ${minutes} 分钟后会再试 Graph）`;
            }
            result = fallback;
          } else {
            // 两条路都失败：两条原因都给出来，否则用户只看到 Graph 的表象
            result = {
              ok: false,
              transport: 'graph',
              message: `Graph 与 SMTP 两条通道都失败：\n`
                + `· Graph：${cooling ? '近期不通，本次已跳过（冷却中）' : graphError.message}\n`
                + `· SMTP：${fallback.message}`,
            };
          }
        } else {
          result = {
            ok: false,
            transport: 'graph',
            needsAuth: smtpToken.needsAuth,
            message: `Graph 发信失败，且取不到 SMTP 令牌：${cooling ? '（冷却中跳过）' : graphError.message}\n· 换 SMTP 令牌失败：${smtpToken.message}`,
          };
        }
      }
    } else {
      let accessToken = '';
      if (cfg.auth === 'oauth2') {
        const token = await getAccessToken(cfg, store, { fetchImpl: deps.fetchImpl });
        if (!token.ok) {
          return { ok: false, needsAuth: token.needsAuth, message: `发信前拿不到访问令牌：${token.message}` };
        }
        accessToken = token.token;
      }
      const replyHeaders = {
        inReplyTo: String(args.in_reply_to || ''),
        references: String(args.references || ''),
      };
      for (const [key, value] of Object.entries(replyHeaders)) {
        if (/[\r\n]/.test(value)) {
          return { ok: false, message: `${key} 不能包含换行符（防止邮件头注入）` };
        }
      }
      // 统一走 sendViaSmtpChannel：它带「主入口失败换备用入口」与网络重试。
      // 曾经这里留着一份内联实现，导致 SMTP 主通道享受不到入口回退。
      result = await sendViaSmtpChannel(cfg, {
        to: to.list,
        cc: cc.list,
        bcc: bcc.list,
        subject,
        signed,
        prepared,
        accessToken,
        deps,
        attempts: deps.smtpAttempts,
        replyTo: args.reply_to ? [toMailbox(args.reply_to)] : [],
        inReplyTo: String(args.in_reply_to || ''),
        references: String(args.references || ''),
      });
    }

    const summary = {
      to: to.list.map((item) => item.address),
      cc: cc.list.map((item) => item.address),
      bcc: bcc.list.map((item) => item.address),
      subject,
      attachments: draft.attachments,
      transport: result.transport,
      fallbackFrom: result.fallbackFrom || '',
      messageId: result.messageId || '',
      response: result.response || '',
      secure: result.secure,
    };
    if (store) {
      store.appendSend({
        to: summary.to,
        cc: summary.cc,
        subject,
        transport: result.transport,
        ok: result.ok === true,
        messageId: summary.messageId,
        detail: result.message,
      });
    }
    if (!result.ok) {
      return { ok: false, message: result.message, summary };
    }
    return {
      ok: true,
      summary,
      transport: result.transport,
      fallbackFrom: result.fallbackFrom || '',
      messageId: summary.messageId,
      message: result.message || '邮件已被服务器接收',
      draft,
    };
  } catch (error) {
    return { ok: false, message: `发信失败（内部错误）：${error?.message ?? error}` };
  }
}


/**
 * SMTP 通道发信（主通道 transport=smtp 与 Graph 回落共用）。
 *
 * 抽成独立函数是为了「Graph 被网络拦截时自动切 SMTP」能复用同一条路径，
 * 包括消息组装、信封、附件与可注入的连接工厂。
 */
async function sendViaSmtpChannel(cfg, {
  to = [], cc = [], bcc = [], subject = '', signed = {}, prepared = { attachments: [] },
  accessToken = '', deps = {}, attempts,
  replyTo = [], inReplyTo = '', references = '',
} = {}) {
  const from = { address: cfg.fromAddress, name: cfg.fromName };
  const built = buildMimeMessage({
    from,
    to,
    cc,
    bcc,
    subject,
    text: signed.text || (signed.html ? htmlToText(signed.html) : ''),
    html: signed.html,
    attachments: prepared.attachments,
    replyTo,
    inReplyTo,
    references,
  });
  const envelopeTo = [...to, ...cc, ...bcc].map((item) => item.address);
  // 主入口 + 备用入口：微软同一套后端有多个 SMTP 入口，实测其中某个入口
  // 会在 STARTTLS 阶段被网络重置，换入口即可。只在「网络层失败」时换，
  // 认证失败换入口没有意义。
  const hosts = [cfg.smtpHost, ...(cfg.smtpFallbackHosts || [])].filter(Boolean);
  const tried = [];
  let result = { ok: false, message: '未配置 SMTP 服务器' };

  for (const host of hosts) {
    result = await smtpSend({
      host,
      port: cfg.smtpPort,
      tls: cfg.smtpTls,
      allowInsecure: cfg.allowInsecure,
      username: cfg.username,
      password: cfg.password,
      accessToken,
      auth: cfg.auth,
      envelopeFrom: from.address,
      envelopeTo,
      rawMessage: built.raw,
      connect: deps.connect,
      timeoutMs: deps.timeoutMs,
      attempts,
      retryDelayMs: deps.retryDelayMs,
      sleepImpl: deps.sleepImpl,
    });
    result.transport = 'smtp';
    if (result.ok) {
      result.messageId = built.messageId;
      result.host = host;
      if (tried.length) {
        result.message = `${result.message}（主入口 ${tried[0].host} 不可用，已改用 ${host}）`;
      }
      return result;
    }
    tried.push({ host, message: result.message });
    // 认证/地址/内容问题：换入口无用，直接返回
    if (!isRetryableChooseHost(result)) break;
  }

  if (tried.length > 1) {
    result.message = `${result.message}（已尝试入口：${tried.map((item) => item.host).join('、')}）`;
  }
  return result;
}

/**
 * 换 SMTP 入口是否可能有效。
 *
 * 只有「连接/握手阶段」的失败才值得换入口——那是入口线路问题；
 * 认证失败（535）、地址被拒（501/550）、被判垃圾（554）换到哪个入口都一样。
 */
function isRetryableChooseHost(result) {
  if (!result || result.ok) return false;
  const message = String(result.message || '');
  if (/认证失败|授权码|应用专用密码|OAuth2|InvalidAuthenticationToken|拒绝地址|垃圾邮件/.test(message)) {
    return false;
  }
  return ['greeting', 'ehlo', 'starttls'].includes(String(result.stage || ''))
    || /ECONNRESET|ETIMEDOUT|EPIPE|超时|连接被服务器关闭|disconnected before secure/i.test(message);
}

/** 工具层用的「成功回执」文本（绝不写成「已送达」——服务器接收不等于对方看到）。 */
export function renderReceipt(result = {}) {
  const summary = result.summary || {};
  const lines = [
    `✅ 邮件已被${result.transport === 'graph' ? 'Microsoft Graph' : 'SMTP 服务器'}接收`,
    '',
    `收件人：${(summary.to || []).join(', ')}`,
  ];
  if (summary.cc?.length) lines.push(`抄送：${summary.cc.join(', ')}`);
  if (summary.bcc?.length) lines.push(`密送：${summary.bcc.join(', ')}`);
  lines.push(`主题：${summary.subject || ''}`);
  if (summary.attachments?.length) {
    lines.push(`附件：${summary.attachments.map((item) => item.filename).join('、')}`);
  }
  lines.push(`通道：${summary.transport === 'graph' ? 'Microsoft Graph（HTTPS）' : `SMTP（${summary.secure ? 'TLS' : '明文'}）`}`);
  if (summary.fallbackFrom) lines.push('回落：Graph 被网络拦截，已自动改走 SMTP 完成发送（授权不变，无需重试）');
  if (summary.messageId) lines.push(`Message-ID：${summary.messageId}`);
  if (summary.response) lines.push(`服务器应答：${summary.response}`);
  lines.push('', '说明：「服务器已接收」不等于对方已读；退信会回到发件箱。');
  return lines.join('\n');
}
