/**
 * 邮件解析（收件用）：头部解码、multipart 拆分、字符集转换、附件清单。
 *
 * 只做「读给人/模型看」需要的事：主题、发件人、时间、纯文本/HTML 正文、附件名。
 * 附件内容不下载（读一封信不该顺带拉 20MB 附件），只报告名字/类型/大小。
 *
 * 容错原则：真实邮件经常不合规（缺结束边界、声明 charset 错误、截断）。
 * 解析器**绝不抛**——能拿到多少给多少，拿不到的字段留空并在结果里说明。
 */

import { htmlToText } from './message.js';

const CRLF = '\r\n';

/** 头部按第一个空行切开；兼容只有 LF 的邮件。 */
export function splitHeaderBody(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw ?? '');
  const match = text.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) {
    return { headerText: text, bodyText: '' };
  }
  const headerText = text.slice(0, match.index);
  const bodyText = text.slice(match.index + match[0].length);
  return { headerText, bodyText };
}

/** 解析头部为小写键对象（重复键保留最后一个；地址类头部够用）。 */
export function parseHeaders(headerText) {
  const headers = {};
  const unfolded = String(headerText || '').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!name) continue;
    headers[name] = value;
  }
  return headers;
}

function decodeCharset(buffer, charset) {
  const label = String(charset || '').trim().replace(/^["']|["']$/g, '').toLowerCase() || 'utf-8';
  const candidates = [label, 'utf-8', 'gb18030', 'big5', 'shift_jis', 'windows-1252'];
  for (const candidate of candidates) {
    try {
      return new TextDecoder(candidate).decode(buffer);
    } catch {
      // 换下一个
    }
  }
  return Buffer.from(buffer).toString('utf8');
}

/** 解 quoted-printable（返回字节，字符集稍后再解）。 */
export function decodeQuotedPrintable(text) {
  const source = Buffer.isBuffer(text) ? text.toString('latin1') : String(text ?? '');
  const bytes = [];
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '=') {
      if (source[i + 1] === '\r' && source[i + 2] === '\n') { i += 2; continue; }
      if (source[i + 1] === '\n') { i += 1; continue; }
      const hex = source.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(source.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeBase64(text) {
  const cleaned = String(text ?? '').replace(/[^A-Za-z0-9+/=]/g, '');
  try {
    return Buffer.from(cleaned, 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

/** RFC 2047 编码词解码（主题/发件人里最常见）。 */
export function decodeMimeWords(value) {
  // 相邻编码词之间的空白按 RFC 2047 应被忽略，先合并再解
  const input = String(value ?? '').replace(/(\?=)\s+(=\?)/g, '$1$2');
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, encoding, data) => {
    try {
      if (String(encoding).toUpperCase() === 'B') {
        return decodeCharset(decodeBase64(data), charset);
      }
      const bytes = decodeQuotedPrintable(String(data).replace(/_/g, ' '));
      return decodeCharset(bytes, charset);
    } catch {
      return match;
    }
  });
}

/** 解 RFC 2231 的 filename* / filename 参数。 */
function decodeParameter(value) {
  if (!value) return '';
  const star = value.match(/^([^']*)'[^']*'(.*)$/);
  if (star) {
    try {
      return decodeURIComponent(star[2]);
    } catch {
      return star[2];
    }
  }
  return value;
}

/** Content-Type / Content-Disposition 参数解析（name 原样匹配，含 `filename*`）。 */
export function parseParameter(headerValue, name) {
  const key = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i');
  const match = String(headerValue || '').match(pattern);
  if (!match) return '';
  return match[1] !== undefined ? match[1] : match[2];
}

export function contentTypeOf(headers) {
  return String(headers['content-type'] || 'text/plain').split(';')[0].trim().toLowerCase();
}

function boundaryOf(headers) {
  return parseParameter(headers['content-type'], 'boundary');
}

function filenameOf(headers) {
  const disposition = headers['content-disposition'] || '';
  const extended = parseParameter(disposition, 'filename*');
  const direct = extended
    ? decodeParameter(extended)
    : parseParameter(disposition, 'filename');
  const fromType = parseParameter(headers['content-type'], 'name');
  const raw = direct || fromType;
  return raw ? decodeMimeWords(raw).trim() : '';
}

/**
 * 把 multipart 正文切成段（Buffer 级，保留二进制）。
 * 容错：缺结束边界时把剩余内容当作最后一段。
 */
export function splitMultipart(bodyBuffer, boundary) {
  if (!boundary) return [];
  const body = Buffer.from(bodyBuffer).toString('latin1');
  const delimiter = `--${boundary}`;
  const parts = [];
  let index = body.indexOf(delimiter);
  if (index < 0) return [];
  while (index >= 0) {
    let start = index + delimiter.length;
    if (body.slice(start, start + 2) === '--') break;
    if (body.slice(start, start + 2) === '\r\n') start += 2;
    else if (body[start] === '\n') start += 1;
    let next = body.indexOf(`${delimiter}`, start);
    let end;
    if (next < 0) {
      end = body.length;
      next = -1;
    } else {
      end = next;
      // 段与分隔线之间有一个 CRLF，属于分隔线
      if (body.slice(end - 2, end) === '\r\n') end -= 2;
      else if (body[end - 1] === '\n') end -= 1;
    }
    parts.push(Buffer.from(body.slice(start, Math.max(start, end)), 'latin1'));
    index = next;
  }
  return parts;
}

function decodeBody(headers, bodyBuffer) {
  const encoding = String(headers['content-transfer-encoding'] || '').trim().toLowerCase();
  const type = contentTypeOf(headers);
  let bytes;
  if (encoding === 'base64') bytes = decodeBase64(bodyBuffer.toString('latin1'));
  else if (encoding === 'quoted-printable') bytes = decodeQuotedPrintable(bodyBuffer);
  else bytes = Buffer.from(bodyBuffer);
  if (type.startsWith('text/')) {
    const charset = parseParameter(headers['content-type'], 'charset') || 'utf-8';
    return decodeCharset(bytes, charset);
  }
  return bytes;
}

/**
 * 解析单个 MIME 实体。
 *
 * @returns {{headers:object, type:string, text:string, html:string, attachments:Array, truncated:boolean}}
 */
export function parseEntity(rawBuffer, { depth = 0, truncated = false } = {}) {
  const result = {
    headers: {}, type: 'text/plain', text: '', html: '', attachments: [], truncated, rawSize: Buffer.byteLength(rawBuffer || ''),
  };
  if (depth > 6) return result;
  const { headerText, bodyText } = splitHeaderBody(rawBuffer);
  const headers = parseHeaders(headerText);
  const bodyBuffer = Buffer.from(bodyText, 'latin1');
  result.headers = headers;
  result.type = contentTypeOf(headers);

  if (result.type.startsWith('multipart/')) {
    const boundary = boundaryOf(headers);
    const parts = splitMultipart(bodyBuffer, boundary);
    // 正文按「先出现的 text/plain / text/html」取；附件全收集
    for (const part of parts) {
      const child = parseEntity(part, { depth: depth + 1, truncated });
      if (child.type.startsWith('multipart/')) {
        if (!result.text && child.text) result.text = child.text;
        if (!result.html && child.html) result.html = child.html;
        result.attachments.push(...child.attachments);
        continue;
      }
      const disposition = String(child.headers['content-disposition'] || '').toLowerCase();
      const filename = filenameOf(child.headers);
      const isAttachment = disposition.startsWith('attachment')
        || Boolean(filename && !child.type.startsWith('text/'));
      if (isAttachment) {
        result.attachments.push({
          filename: filename || 'attachment',
          contentType: child.type,
          size: child.rawSize || 0,
        });
        continue;
      }
      if (child.type === 'text/plain' && !result.text) {
        result.text = typeof child.body === 'string' ? child.body : '';
      } else if (child.type === 'text/html' && !result.html) {
        result.html = typeof child.body === 'string' ? child.body : '';
      } else if (child.type === 'message/rfc822') {
        result.attachments.push({
          filename: filename || 'message.eml',
          contentType: 'message/rfc822',
          size: bodyBuffer.length,
        });
      }
    }
    if (!result.text && result.html) result.text = htmlToText(result.html);
    return result;
  }

  const decoded = decodeBody(headers, bodyBuffer);
  result.rawBody = bodyBuffer.toString('latin1');
  if (typeof decoded === 'string') {
    result.body = decoded;
    if (result.type === 'text/html') {
      result.html = decoded;
      result.text = htmlToText(decoded);
    } else {
      result.text = decoded;
    }
  } else {
    result.body = decoded;
    const filename = filenameOf(headers);
    if (filename || !result.type.startsWith('text/')) {
      result.attachments.push({
        filename: filename || 'attachment',
        contentType: result.type,
        size: decoded.length,
      });
    }
  }
  return result;
}

/** 解析一封完整邮件（或「头 + 部分正文」）→ 结构化摘要。 */
export function parseMail(rawBuffer) {
  const entity = parseEntity(rawBuffer);
  const headers = entity.headers || {};
  const from = decodeMimeWords(headers.from || '');
  const to = decodeMimeWords(headers.to || '');
  const cc = decodeMimeWords(headers.cc || '');
  const subject = decodeMimeWords(headers.subject || '');
  const date = headers.date || '';
  const messageId = headers['message-id'] || '';
  const references = headers.references || '';
  return {
    subject: subject || '(无主题)',
    from,
    to,
    cc,
    date,
    messageId,
    references,
    text: (entity.text || '').trim(),
    html: entity.html || '',
    attachments: entity.attachments || [],
    contentType: entity.type,
    truncated: entity.truncated === true,
  };
}

/** 把「头 + 部分正文」拼成可解析的缓冲（正文被截断时标注）。 */
export function buildPartialMessage(headerBuffer, textBuffer, { truncated = false } = {}) {
  const header = Buffer.from(headerBuffer || Buffer.alloc(0));
  const body = Buffer.from(textBuffer || Buffer.alloc(0));
  const hasSeparator = header.length >= 4 && header.subarray(-4).toString('latin1') === `${CRLF}${CRLF}`;
  const combined = Buffer.concat([header, hasSeparator ? Buffer.alloc(0) : Buffer.from(CRLF), body]);
  if (!truncated) return combined;
  return combined;
}
