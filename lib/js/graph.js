/**
 * 通过 Microsoft Graph 发信（HTTPS 443）。
 *
 * 为什么需要这条通道：`smtp-mail.outlook.com` 在部分网络里会在 220 问候
 * 之后直接断连（连 EHLO 都收不到回复）。Graph 只要能打开网页就能发信，
 * 所以 Outlook 的 OAuth2 默认走这里；SMTP 只作为可选的兜底
 * （设置里把 transport 改成 smtp 即可，scope 会随之切换）。
 *
 * 附件分两档（Graph 的硬限制）：
 *   · 单封附件总计 ≤ 3MB：一次 `/me/sendMail` 带上 fileAttachment；
 *   · 超过 3MB：先建草稿 → 小附件直接 POST、大附件走 upload session 分片
 *     PUT（每片必须是 320KB 的整数倍，最后一片随意）→ 最后 send。
 *
 * 边界：只做「发一封信」，不读信、不碰日历。令牌由 oauth.js 提供。
 */

import { sanitizeAddress } from './config.js';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Graph 简单附件（base64 塞进 JSON）的总大小上限。 */
export const SIMPLE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;

/** 上传会话分片大小（320KB 的整数倍）。 */
const UPLOAD_CHUNK = 10 * 320 * 1024;

function mailbox(address, name) {
  const clean = sanitizeAddress(address);
  const entry = { emailAddress: { address: clean } };
  if (name) entry.emailAddress.name = String(name);
  return entry;
}

function recipients(list = []) {
  return (Array.isArray(list) ? list : []).map((item) => (
    typeof item === 'string' ? mailbox(item) : mailbox(item.address, item.name)
  )).filter((item) => item.emailAddress.address);
}

function graphMessage(message) {
  const html = String(message.html ?? '');
  const text = String(message.text ?? '');
  const payload = {
    subject: String(message.subject ?? ''),
    body: {
      contentType: html ? 'HTML' : 'Text',
      content: html || text || ' ',
    },
    toRecipients: recipients(message.to || []),
  };
  const cc = recipients(message.cc || []);
  const bcc = recipients(message.bcc || []);
  const replyTo = recipients(message.replyTo || []);
  if (cc.length) payload.ccRecipients = cc;
  if (bcc.length) payload.bccRecipients = bcc;
  if (replyTo.length) payload.replyTo = replyTo;
  return payload;
}

function graphError(status, detail, context = '') {
  const suffix = detail ? `：${detail.slice(0, 300)}` : '';
  const where = context ? `（${context}）` : '';
  if (status === 401) {
    return {
      ok: false,
      code: 401,
      message: `Microsoft Graph 认证失败（401）${where}：请重新运行 email_account（action=authorize）授权一次${suffix}`,
    };
  }
  if (status === 403) {
    return {
      ok: false,
      code: 403,
      message: `Microsoft Graph 权限不足（403）${where}：授权时未同意「发送邮件」权限，`
        + `或企业管理员限制了该应用${suffix}`,
    };
  }
  if (status === 413) {
    return { ok: false, code: 413, message: `邮件超出 Graph 大小限制（413）${where}：把附件降到 20MB 以内或改用网盘链接${suffix}` };
  }
  if (status === 502 || status === 503 || status === 504) {
    return {
      ok: false,
      code: status,
      message: `Microsoft Graph 网关错误（${status}）${where}：请求通常没有到达邮箱服务，常见原因是网络/代理拦截了 graph.microsoft.com，或微软服务暂时不可用。`
        + `请先确认浏览器能打开 https://graph.microsoft.com，换网络（或开启代理）后重试；重试前可先看一眼「已发送」。${suffix}`,
    };
  }
  if (status === 429) {
    return { ok: false, code: 429, message: `Graph 限流（429）${where}：稍等一分钟再发${suffix}` };
  }
  return { ok: false, code: status, message: `Graph 发信失败 HTTP ${status}${where}${suffix || '：无响应体'}` };
}

async function readDetail(response) {
  try {
    const text = await response.text();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      return String(parsed?.error?.message || parsed?.error?.code || text).slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return '';
  }
}

async function graphFetch(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(30_000),
  });
  return response;
}

/**
 * 发一封信。**绝不抛异常**（网络错误也转成可读提示）。
 *
 * @param {{username:string}} cfg
 * @param {object} message {to,cc,bcc,subject,text,html,attachments,replyTo}
 * @param {{accessToken:string, fetchImpl?:Function, baseUrl?:string}} options
 */
export async function graphSend(cfg = {}, message = {}, { accessToken, fetchImpl = fetch, baseUrl = GRAPH_BASE } = {}) {
  const token = String(accessToken || '');
  if (!token) return { ok: false, message: 'Graph 发信缺少 access_token：请先完成授权' };
  const to = recipients(message.to || []);
  if (!to.length) return { ok: false, message: '没有收件人' };
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const totalAttachmentBytes = attachments.reduce((sum, item) => sum + (item.content?.length || 0), 0);
  const auth = { authorization: `Bearer ${token}` };

  if (totalAttachmentBytes <= SIMPLE_ATTACHMENT_LIMIT) {
    const mailMessage = graphMessage(message);
    if (attachments.length) {
      mailMessage.attachments = attachments.map((item) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: item.filename || 'attachment',
        contentType: item.contentType || 'application/octet-stream',
        contentBytes: Buffer.from(item.content).toString('base64'),
      }));
    }
    const payload = { message: mailMessage, saveToSentItems: true };
    let response;
    try {
      response = await graphFetch(fetchImpl, `${baseUrl}/me/sendMail`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(payload),
      });
    } catch (error) {
      return { ok: false, message: graphNetworkMessage(error) };
    }
    if (response.ok || response.status === 202) {
      return {
        ok: true,
        transport: 'graph',
        message: '已通过 Microsoft Graph 提交发送（HTTPS）',
      };
    }
    return graphError(response.status, await readDetail(response), 'sendMail');
  }

  // 大附件：草稿 → 上传 → 发送。任何一步失败都尽量删掉草稿，避免留半成品。
  let draftId = '';
  try {
    const draftResponse = await graphFetch(fetchImpl, `${baseUrl}/me/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(graphMessage(message)),
    });
    if (!draftResponse.ok) {
      return graphError(draftResponse.status, await readDetail(draftResponse), '创建草稿');
    }
    const draft = await draftResponse.json();
    draftId = String(draft?.id || '');
    if (!draftId) return { ok: false, message: 'Graph 创建草稿成功但没有返回消息 id，无法继续上传附件' };

    for (const item of attachments) {
      const content = Buffer.from(item.content);
      const name = item.filename || 'attachment';
      const contentType = item.contentType || 'application/octet-stream';
      if (content.length <= SIMPLE_ATTACHMENT_LIMIT) {
        const response = await graphFetch(fetchImpl, `${baseUrl}/me/messages/${encodeURIComponent(draftId)}/attachments`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name,
            contentType,
            contentBytes: content.toString('base64'),
          }),
        });
        if (!response.ok) {
          const failure = graphError(response.status, await readDetail(response), `上传附件 ${name}`);
          await discardDraft(fetchImpl, baseUrl, draftId, auth);
          return failure;
        }
        continue;
      }
      const uploaded = await uploadLargeAttachment({
        fetchImpl, baseUrl, auth, draftId, name, contentType, content,
      });
      if (!uploaded.ok) {
        await discardDraft(fetchImpl, baseUrl, draftId, auth);
        return uploaded;
      }
    }

    const sendResponse = await graphFetch(fetchImpl, `${baseUrl}/me/messages/${encodeURIComponent(draftId)}/send`, {
      method: 'POST',
      headers: auth,
    });
    if (!sendResponse.ok && sendResponse.status !== 202) {
      const failure = graphError(sendResponse.status, await readDetail(sendResponse), '发送草稿');
      await discardDraft(fetchImpl, baseUrl, draftId, auth);
      return failure;
    }
    return {
      ok: true,
      transport: 'graph',
      message: `已通过 Microsoft Graph 提交发送（HTTPS，${attachments.length} 个附件，大附件走上传会话）`,
    };
  } catch (error) {
    if (draftId) await discardDraft(fetchImpl, baseUrl, draftId, auth);
    return { ok: false, message: `Graph 发信失败：${error?.message ?? error}` };
  }
}

async function uploadLargeAttachment({
  fetchImpl, baseUrl, auth, draftId, name, contentType, content,
}) {
  const sessionResponse = await graphFetch(
    fetchImpl,
    `${baseUrl}/me/messages/${encodeURIComponent(draftId)}/attachments/createUploadSession`,
    {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        AttachmentItem: {
          attachmentType: 'file',
          name,
          size: content.length,
          contentType,
        },
      }),
    },
  );
  if (!sessionResponse.ok) {
    return graphError(sessionResponse.status, await readDetail(sessionResponse), `创建上传会话 ${name}`);
  }
  const session = await sessionResponse.json();
  const uploadUrl = String(session?.uploadUrl || '');
  if (!uploadUrl) return { ok: false, message: `创建上传会话 ${name} 失败：没有返回 uploadUrl` };

  for (let offset = 0; offset < content.length; offset += UPLOAD_CHUNK) {
    const end = Math.min(offset + UPLOAD_CHUNK, content.length);
    const chunk = content.subarray(offset, end);
    // uploadUrl 是预签名的，不要带 Authorization
    const response = await graphFetch(fetchImpl, uploadUrl, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${offset}-${end - 1}/${content.length}`,
      },
      body: chunk,
    });
    if (!response.ok) {
      return graphError(response.status, await readDetail(response), `上传附件 ${name} 分片 ${offset}-${end - 1}`);
    }
  }
  return { ok: true };
}

function graphNetworkMessage(error) {
  const cause = error?.cause?.code || error?.cause?.message || '';
  const reason = error?.message || String(error);
  const detail = cause ? `${reason}（${cause}）` : reason;
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|TLS|certificate/i.test(detail)) {
    return `连接 Microsoft Graph 失败：${detail}。这通常是网络/代理无法访问 graph.microsoft.com（部分地区直连会被阻断）；`
      + '换网络或开启代理后重试，本次没有完成发送。';
  }
  return `连接 Microsoft Graph 失败：${detail}`;
}

/**
 * Graph 只读探针：验证令牌可续期之外，网络是否真的能到 Graph。
 *
 * 只查 1 个文件夹，不读邮件内容、不发信。502/超时会明确告诉用户是网络层问题，
 * 而不是让账号状态在 Graph 完全不可达时仍显示「令牌续期成功」。
 *
 * @returns {Promise<{ok:boolean, message:string, status?:number}>}
 */
export async function graphProbe(cfg = {}, accessToken = '', { fetchImpl = fetch, baseUrl = GRAPH_BASE } = {}) {
  if (!accessToken) return { ok: false, message: 'Graph 探针缺少 access_token' };
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/me/mailFolders?$top=1&$select=id,displayName`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { ok: false, message: graphNetworkMessage(error) };
  }
  if (response.ok) {
    return { ok: true, message: 'Graph 只读访问成功（未发信）：令牌有效，网络能到达 graph.microsoft.com' };
  }
  const failure = graphError(response.status, await readDetail(response), '读取邮箱文件夹');
  return { ok: false, status: response.status, message: failure.message };
}

async function discardDraft(fetchImpl, baseUrl, draftId, auth) {
  try {
    await graphFetch(fetchImpl, `${baseUrl}/me/messages/${encodeURIComponent(draftId)}`, {
      method: 'DELETE',
      headers: auth,
    });
  } catch {
    // 清理失败不影响给用户的结论
  }
}
