/**
 * 邮件组装（RFC 5322 / MIME），零依赖。
 *
 * 这里只做「把一封邮件变成能直接交给 SMTP DATA 的字节串」，不发信、不读配置。
 * 单独成模块是为了能被单测逐字节校验——邮件格式的坑（编码后的主题、附件
 * 文件名、Bcc 泄漏、附件头注入）都在这层，不在传输层。
 *
 * 约定：
 *   · 正文与附件一律 base64 传输，所以整封信是 7-bit 安全的，不需要 8BITMIME；
 *   · Bcc **只用于信封**（RCPT TO），绝不写进头部——否则密送就白送了；
 *   · 主题/显示名/附件名按 RFC 2047 / RFC 2231 编码，中文不会变乱码；
 *   · 所有头部值先拒绝 CR/LF，避免头部注入。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CRLF = '\r\n';

/** 常见附件扩展名 → MIME。未知类型按 application/octet-stream。 */
const MIME_BY_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  eml: 'message/rfc822',
  ics: 'text/calendar',
  log: 'text/plain',
  sqlite: 'application/vnd.sqlite3',
  db: 'application/octet-stream',
  bin: 'application/octet-stream',
};

export function contentTypeFor(filename) {
  const ext = path.extname(String(filename || '')).replace(/^\./, '').toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function asciiOnly(text) {
  return /^[\x20-\x7E]*$/.test(text);
}

function b64(text) {
  return Buffer.from(String(text ?? ''), 'utf8').toString('base64');
}

/**
 * RFC 2047 编码（B 编码），并按 75 字符上限分片 + 折行。
 *
 * 纯 ASCII 原样返回；非 ASCII 才编码。分片按**字节**而不是字符做，避免把
 * 一个 UTF-8 多字节字符劈成两半（那会直接乱码）。
 */
export function encodeHeaderValue(value) {
  const input = String(value ?? '');
  assertNoHeaderInjection(input, '头部');
  if (asciiOnly(input)) return input;
  const chunks = [];
  let current = '';
  let bytes = 0;
  for (const char of input) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > 45 && current) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks.map((chunk) => `=?UTF-8?B?${b64(chunk)}?=`).join(`${CRLF} `);
}

/** 头部值里出现 CR/LF 一律拒绝：那是头部注入，不是「用户想换行」。 */
export function assertNoHeaderInjection(value, label = '头部') {
  if (/[\r\n]/.test(String(value ?? ''))) {
    throw new Error(`${label}里不能包含换行符（防止邮件头注入）`);
  }
}

/**
 * 已编码/已折行后的头部值校验：允许 RFC 5322 折行（CRLF + 空格/制表符），
 * 其它位置的 CR/LF 仍然拒绝。
 *
 * 为什么单独一个函数：`encodeHeaderValue()` 对长中文会折成多段
 * `=?UTF-8?B?...?=`（段间是 CRLF+空格），`formatMailboxList()` 对长收件人
 * 列表也按逗号折行。这些折行是**合法的**，用 `assertNoHeaderInjection()`
 * 复查会把它们误判成头部注入——实测症状就是「长中文主题发不出去，
 * 报 Subject 含换行符」。真正的注入风险在**原始输入**上，那里已经拦过。
 */
export function assertSafeFoldedHeader(value, label = '头部') {
  const text = String(value ?? '');
  // 先干掉合法折行，剩下的 CR/LF 就是真注入
  const unfolded = text.replace(/\r\n[ \t]+/g, ' ');
  if (/[\r\n]/.test(unfolded)) {
    throw new Error(`${label}里不能包含换行符（防止邮件头注入）`);
  }
}

/** 显示名：ASCII 时按需加引号，非 ASCII 走 RFC 2047。 */
function formatDisplayName(name) {
  const value = String(name ?? '').trim();
  if (!value) return '';
  assertNoHeaderInjection(value, '显示名');
  if (!asciiOnly(value)) return encodeHeaderValue(value);
  if (/[,;:<>@\\"]/.test(value)) return `"${value.replace(/(["\\])/g, '\\$1')}"`;
  return value;
}

/** `姓名 <a@b.com>`（没有姓名就只给地址）。 */
export function formatMailbox(mailbox) {
  if (!mailbox) return '';
  if (typeof mailbox === 'string') {
    assertNoHeaderInjection(mailbox, '邮箱地址');
    return mailbox.trim();
  }
  const address = String(mailbox.address ?? '').trim();
  const name = formatDisplayName(mailbox.name);
  return name ? `${name} <${address}>` : address;
}

/** 长收件人列表按逗号折行（每行尽量不超过 72 字符，符合 RFC 5322 建议）。 */
export function formatMailboxList(mailboxes = []) {
  const lines = [];
  let current = '';
  for (const mailbox of mailboxes) {
    const formatted = formatMailbox(mailbox);
    if (!formatted) continue;
    const candidate = current ? `${current}, ${formatted}` : formatted;
    if (current && candidate.length > 72) {
      lines.push(`${current},${CRLF}`);
      current = formatted;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.join(' ');
}

/** 本地时区的 RFC 2822 时间。 */
export function rfc2822Date(now = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${days[now.getDay()]}, ${pad(now.getDate())} ${months[now.getMonth()]} ${now.getFullYear()} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} `
    + `${sign}${pad(Math.trunc(abs / 60))}${pad(abs % 60)}`;
}

/** base64 正文每行 76 字符（RFC 2045）。 */
export function wrapBase64(text) {
  const raw = b64(text);
  const lines = [];
  for (let i = 0; i < raw.length; i += 76) lines.push(raw.slice(i, i + 76));
  return lines.join(CRLF);
}

function wrapBase64Buffer(buffer) {
  const raw = Buffer.from(buffer).toString('base64');
  const lines = [];
  for (let i = 0; i < raw.length; i += 76) lines.push(raw.slice(i, i + 76));
  return lines.join(CRLF);
}

/**
 * 附件文件名编码。
 *
 * 非 ASCII 文件名只用 RFC 2231 的 `filename*=UTF-8''…`；同时保留一个 ASCII
 * 兜底 `filename="…"`，给不认 2231 的老客户端。两者都做，不冲突。
 */
function encodeFilename(filename) {
  const name = String(filename || 'attachment').replace(/[\r\n"]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const fallback = asciiOnly(name) ? name : name.replace(/[^\x20-\x7E]/g, '_');
  return { fallback: fallback || 'attachment', encoded };
}

/**
 * HTML → 纯文本（给只显示纯文本的客户端兜底）。
 *
 * 不追求完美排版，只保证「HTML 里写了字，纯文本里也能看到」。脚本/样式先删，
 * 块级标签换行，实体解码，连续空行压缩。
 */
export function htmlToText(html) {
  let text = String(html ?? '');
  text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|table|section|article)>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '- ');
  text = text.replace(/<[^>]+>/g, '');
  const entities = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  };
  for (const [entity, char] of Object.entries(entities)) {
    text = text.split(entity).join(char);
  }
  text = text.replace(/&#(\d+);/g, (_match, code) => {
    const value = Number(code);
    return Number.isFinite(value) && value > 0 && value <= 0x10FFFF ? String.fromCodePoint(value) : '';
  });
  text = text.replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
    const value = Number.parseInt(code, 16);
    return Number.isFinite(value) && value > 0 && value <= 0x10FFFF ? String.fromCodePoint(value) : '';
  });
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 生成 Message-ID（域名取发件人域名，退化为 localhost）。 */
export function makeMessageId(fromAddress = '') {
  const domain = String(fromAddress).split('@').pop() || 'localhost';
  return `<${crypto.randomBytes(12).toString('hex')}@${domain}>`;
}

function headerBlock(headers) {
  const lines = [];
  for (const [name, value] of headers) {
    if (value === undefined || value === null || value === '') continue;
    // 值可能已被 RFC 2047 编码并折行：只拦真注入，不拦合法折行
    assertSafeFoldedHeader(value, name);
    lines.push(`${name}: ${value}`);
  }
  return lines;
}

/**
 * 组装一封信。
 *
 * @param {object} message
 * @param {{address:string,name?:string}} message.from
 * @param {Array<{address:string,name?:string}>} message.to
 * @param {Array} [message.cc]
 * @param {Array} [message.bcc]        只进信封，不进头部
 * @param {string} message.subject
 * @param {string} [message.text]
 * @param {string} [message.html]
 * @param {Array<{filename:string, content:Buffer, contentType?:string}>} [message.attachments]
 * @param {string} [message.inReplyTo]
 * @param {string} [message.references]
 * @param {Array<[string,string]>} [message.extraHeaders]
 * @param {{messageId?:string, date?:string}} [options]
 * @returns {{raw:string, messageId:string, hasHtml:boolean, size:number}}
 */
export function buildMimeMessage(message = {}, options = {}) {
  const from = message.from || {};
  if (!from.address) throw new Error('缺少发件人地址');
  const subject = String(message.subject ?? '');
  assertNoHeaderInjection(subject, '主题');
  const text = String(message.text ?? '');
  const html = String(message.html ?? '');
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const messageId = options.messageId || makeMessageId(from.address);
  assertNoHeaderInjection(messageId, 'Message-ID');

  const headers = headerBlock([
    ['Date', options.date || rfc2822Date()],
    ['From', formatMailbox(from)],
    ['To', formatMailboxList(message.to || [])],
    ['Cc', formatMailboxList(message.cc || [])],
    ['Reply-To', formatMailboxList(message.replyTo || [])],
    ['Subject', encodeHeaderValue(subject)],
    ['Message-ID', messageId],
    ['In-Reply-To', message.inReplyTo || ''],
    ['References', message.references || ''],
    ['MIME-Version', '1.0'],
    ['X-Mailer', 'dsh-email'],
  ]);
  for (const [name, value] of message.extraHeaders || []) {
    assertNoHeaderInjection(name, '扩展头部名');
    assertNoHeaderInjection(value, name);
    headers.push(`${name}: ${value}`);
  }

  const textPart = text || (html ? htmlToText(html) : '');
  const contentParts = [];

  if (html) {
    const boundary = `=_alt_${crypto.randomBytes(8).toString('hex')}`;
    contentParts.push({
      type: `multipart/alternative; boundary="${boundary}"`,
      body: [
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64(textPart || ' '),
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64(html),
        '',
        `--${boundary}--`,
      ].join(CRLF),
    });
  } else {
    contentParts.push({
      type: 'text/plain; charset=UTF-8',
      body: wrapBase64(textPart || ' '),
    });
  }

  let body;
  if (attachments.length) {
    const boundary = `=_mix_${crypto.randomBytes(8).toString('hex')}`;
    const attachmentParts = attachments.map((attachment) => {
      const filename = attachment.filename || 'attachment';
      const contentType = attachment.contentType || contentTypeFor(filename);
      const { fallback, encoded } = encodeFilename(filename);
      return [
        `--${boundary}`,
        `Content-Type: ${contentType}; name="${fallback}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
        '',
        wrapBase64Buffer(attachment.content),
      ].join(CRLF);
    });
    body = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      `Content-Type: ${contentParts[0].type}`,
      '',
      contentParts[0].body,
      '',
      ...attachmentParts.flatMap((part) => [part, '']),
      `--${boundary}--`,
    ].join(CRLF);
  } else {
    body = [`Content-Type: ${contentParts[0].type}`, '', contentParts[0].body].join(CRLF);
  }

  const raw = `${[...headers, body].join(CRLF)}${CRLF}`;
  return {
    raw,
    messageId,
    hasHtml: Boolean(html),
    size: Buffer.byteLength(raw, 'utf8'),
  };
}

/** DATA 阶段点转义：以 `.` 开头的行前面再加一个点。 */
export function dotStuff(raw) {
  return String(raw).split('\r\n').map((line) => (line.startsWith('.') ? `.${line}` : line)).join(CRLF);
}

/** 判断 child 是否位于 parent 目录内（含 parent 本身）。 */
export function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 解析并校验附件路径。
 *
 * 安全边界：**默认只允许工作区内的文件**。这是给模型调用的工具，不能让它
 * 随手把 `~/.ssh/id_rsa` 当附件发出去；需要额外目录时由用户显式配置
 * `allowAttachmentDirs`。
 *
 * @param {Array<string|{path:string,filename?:string}>} inputs
 * @param {{workspace?:string, allowDirs?:string[], maxBytes?:number}} options
 * @returns {{attachments:Array, totalBytes:number}}
 */
export function prepareAttachments(inputs = [], options = {}) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const workspace = options.workspace ? path.resolve(options.workspace) : process.cwd();
  const roots = [workspace];
  for (const dir of options.allowDirs || []) {
    if (dir) roots.push(path.resolve(dir));
  }
  const realRoots = roots.map((root) => {
    try {
      return fs.realpathSync(root);
    } catch {
      return root;
    }
  });
  const maxBytes = Number(options.maxBytes) || 20 * 1024 * 1024;

  const attachments = [];
  let totalBytes = 0;
  for (const input of list) {
    const raw = typeof input === 'string' ? input : String(input?.path ?? '');
    if (!raw.trim()) continue;
    const candidate = path.isAbsolute(raw) ? raw : path.resolve(workspace, raw);
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      throw new Error(`附件不存在或不可读：${raw}`);
    }
    if (!realRoots.some((root) => isInside(real, root))) {
      throw new Error(`附件不在允许的目录内：${raw}（默认只允许工作区 ${workspace}，可用 allowAttachmentDirs 增加目录）`);
    }
    let stat;
    try {
      stat = fs.statSync(real);
    } catch (error) {
      throw new Error(`读不到附件 ${raw}：${error?.message ?? error}`);
    }
    if (!stat.isFile()) throw new Error(`附件不是文件：${raw}`);
    totalBytes += stat.size;
    if (totalBytes > maxBytes) {
      throw new Error(`附件总大小超过上限 ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    const filename = String(
      (typeof input === 'object' && input?.filename) || path.basename(real),
    ).replace(/[\r\n]/g, ' ').trim() || 'attachment';
    attachments.push({
      filename,
      contentType: contentTypeFor(filename),
      content: fs.readFileSync(real),
      size: stat.size,
      path: real,
    });
  }
  return { attachments, totalBytes };
}
