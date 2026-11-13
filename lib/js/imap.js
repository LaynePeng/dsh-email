/**
 * IMAP 收件（零依赖）：列文件夹、列邮件、读单封。
 *
 * 只实现读操作（SELECT/SEARCH/FETCH/LIST/STATUS），不删除、不移动、不改旗标——
 * 「AI 能读信」比「AI 能删信」重要得多，而误删一封邮件的代价远大于少一个功能。
 *
 * 认证与发信共用一套材料：basic 用密码/授权码，oauth2 用 XOAUTH2（同一个
 * refresh_token 换来的 access_token）。
 *
 * 容错：邮件服务器五花八门（UTF-7 文件夹名、缺结束边界的 multipart、声明错的
 * charset）。解析层尽量给结果，拿不到的字段留空；网络/认证错误翻成可读提示。
 */

import net from 'node:net';
import tls from 'node:tls';

import { getAccessToken, refreshAccessToken } from './oauth.js';
import { IMAP_SCOPE } from './providers.js';
import { buildPartialMessage, decodeMimeWords, parseHeaders, parseMail } from './mime.js';

export const IMAP_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 8_000;
const MAX_LIST = 50;

function b64(text) {
  return Buffer.from(String(text ?? ''), 'utf8').toString('base64');
}

/**
 * 修改版 UTF-7（RFC 3501 §5.1.3）——非 ASCII 文件夹名的唯一正确编码。
 * 直接发 UTF-8 会得到 `NO [CANNOT] Invalid mailbox name`。
 */
export function utf7Encode(value) {
  const text = String(value ?? '');
  let output = '';
  let buffer = '';
  const flush = () => {
    if (!buffer) return;
    const utf16 = Buffer.from(buffer, 'utf16le');
    // IMAP 用 UTF-16BE
    for (let i = 0; i < utf16.length; i += 2) {
      const temp = utf16[i];
      utf16[i] = utf16[i + 1];
      utf16[i + 1] = temp;
    }
    output += `&${utf16.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
    buffer = '';
  };
  for (const char of text) {
    const code = char.codePointAt(0);
    if (char === '&') {
      flush();
      output += '&-';
    } else if (code >= 0x20 && code <= 0x7e) {
      flush();
      output += char;
    } else {
      buffer += char;
    }
  }
  flush();
  return output;
}

export function utf7Decode(value) {
  return String(value ?? '').replace(/&([A-Za-z0-9+,]*)-/g, (match, chunk) => {
    if (!chunk) return '&';
    try {
      const normalized = chunk.replace(/,/g, '/');
      const bytes = Buffer.from(normalized, 'base64');
      const swapped = Buffer.alloc(bytes.length);
      for (let i = 0; i < bytes.length; i += 2) {
        swapped[i] = bytes[i + 1] ?? 0;
        swapped[i + 1] = bytes[i] ?? 0;
      }
      return swapped.toString('utf16le');
    } catch {
      return match;
    }
  });
}

/** 只接受 ASCII 的引号字符串（IMAP 命令必须是 7-bit）。 */
function quote(value, label = '参数') {
  const text = String(value ?? '');
  if (!/^[\x20-\x7e]*$/.test(text)) {
    throw new Error(`IMAP ${label}包含非 ASCII 字符（文件夹名会自动转 UTF-7，其它参数请用英文/数字）`);
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function imapDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`日期格式应为 YYYY-MM-DD：${text}`);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [, year, month, day] = match;
  const monthIndex = Number(month) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new Error(`月份不合法：${text}`);
  return `${day}-${months[monthIndex]}-${year}`;
}

/** 一条 IMAP 连接：按逻辑行读取（支持 literal `{n}`），按 tag 配对命令结果。 */
export class ImapConnection {
  constructor(socket, { timeoutMs = IMAP_TIMEOUT_MS } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.error = null;
    this.closed = false;
    this.tagSeq = 0;
    this.attach(socket);
    socket.setTimeout(timeoutMs, () => {
      this.fail(new Error(`IMAP 超时（${Math.round(timeoutMs / 1000)} 秒无响应）`));
    });
  }

  attach(socket) {
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.notify();
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => {
      if (!this.closed) this.fail(new Error('IMAP 连接被服务器关闭'));
    });
  }

  /** 升级 TLS 前摘掉旧 socket 的监听，否则它的 close 会把新连接判死。 */
  detach() {
    try {
      this.socket.removeAllListeners('data');
      this.socket.removeAllListeners('error');
      this.socket.removeAllListeners('close');
      this.socket.removeAllListeners('timeout');
    } catch {
      // 忽略
    }
  }

  /**
   * STARTTLS：在明文连接上升级为 TLS。
   *
   * 为什么需要：部分网络封了 IMAP 的 993 端口，但 143 能通。微软/多数服务商
   * 在 143 上支持 STARTTLS，升级后与 993 等价（同样加密）。
   */
  async upgradeTls(host, { rejectUnauthorized = true } = {}) {
    this.detach();
    const secure = await new Promise((resolve, reject) => {
      const socket = tls.connect({ socket: this.socket, servername: host, rejectUnauthorized }, () => resolve(socket));
      socket.once('error', reject);
    });
    this.socket = secure;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.error = null;
    this.attach(secure);
    secure.setTimeout(this.timeoutMs, () => {
      this.fail(new Error(`IMAP 超时（${Math.round(this.timeoutMs / 1000)} 秒无响应）`));
    });
  }

  fail(error) {
    this.closed = true;
    this.error = error;
    this.notify();
  }

  notify() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  waitForData() {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`IMAP 超时（${Math.round(this.timeoutMs / 1000)} 秒无响应）`));
      }, this.timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        if (this.error) reject(this.error);
        else resolve();
      });
    });
  }

  async ensureBytes(count) {
    while (this.buffer.length < count) {
      if (this.closed) throw this.error || new Error('IMAP 连接已关闭');
      await this.waitForData();
    }
  }

  /**
   * 读一条「逻辑行」：可能跨多个 literal。
   * 返回 {text, literals}，text 里的 literal 位置替换成 `\x00LIT i\x00` 便于关联。
   */
  async readLogicalLine() {
    let text = '';
    const literals = [];
    for (;;) {
      await this.ensureBytes(2);
      let index = this.buffer.indexOf('\r\n');
      while (index < 0) {
        if (this.closed) throw this.error || new Error('IMAP 连接已关闭');
        await this.waitForData();
        index = this.buffer.indexOf('\r\n');
      }
      const line = this.buffer.subarray(0, index).toString('utf8');
      this.buffer = this.buffer.subarray(index + 2);
      const literalMatch = line.match(/\{(\d+)\}$/);
      if (!literalMatch) {
        text += line;
        return { text, literals };
      }
      const size = Number(literalMatch[1]);
      await this.ensureBytes(size);
      const literal = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      text += line.replace(/\{(\d+)\}$/, `\x00LIT${literals.length}\x00`);
      literals.push(literal);
      // literal 后面紧接同一逻辑行的剩余部分（例如 ` BODY[TEXT] {n}` 或 `)`）
    }
  }

  /**
   * 带 literal 的命令（如 `UID SEARCH TEXT {12}` + CRLF + UTF-8 字节）。
   *
   * 中文关键词不能直接拼进 IMAP 命令（协议要求 7-bit），但服务端普遍接受
   * UTF-8 literal。不支持的服务器会回 BAD——调用方据此退回本地扫描。
   */
  async commandWithLiteral(prefix, literal, { suffix = '' } = {}) {
    const tag = `A${++this.tagSeq}`;
    const bytes = Buffer.isBuffer(literal) ? literal : Buffer.from(String(literal), 'utf8');
    this.socket.write(`${tag} ${prefix} {${bytes.length}}\r\n`);
    this.socket.write(bytes);
    this.socket.write(`${suffix}\r\n`);
    const records = [];
    for (;;) {
      const line = await this.readLogicalLine();
      if (line.text.startsWith(`${tag} `)) {
        const status = line.text.split(/\s+/)[1]?.toUpperCase() || '';
        return { tag, status, text: line.text, records };
      }
      if (line.text.startsWith('+')) {
        records.push(line);
        continue;
      }
      records.push(line);
    }
  }

  /** 发命令并读到对应 tag 的结果。 */
  async command(command, { onContinuation } = {}) {
    const tag = `A${++this.tagSeq}`;
    this.socket.write(`${tag} ${command}\r\n`);
    const records = [];
    for (;;) {
      const line = await this.readLogicalLine();
      if (line.text.startsWith(`${tag} `)) {
        const status = line.text.split(/\s+/)[1]?.toUpperCase() || '';
        return { tag, status, text: line.text, records };
      }
      if (line.text.startsWith('+')) {
        if (onContinuation) {
          this.socket.write(`${onContinuation(line)}\r\n`);
          continue;
        }
        records.push(line);
        continue;
      }
      if (/^\* BYE/i.test(line.text)) {
        this.fail(new Error(`IMAP 服务器断开连接：${line.text}`));
      }
      records.push(line);
    }
  }

  async authenticate(mechanism, payload) {
    const tag = `A${++this.tagSeq}`;
    this.socket.write(`${tag} AUTHENTICATE ${mechanism}\r\n`);
    let records = [];
    for (;;) {
      const line = await this.readLogicalLine();
      if (line.text.startsWith(`${tag} `)) {
        const status = line.text.split(/\s+/)[1]?.toUpperCase() || '';
        return { status, text: line.text, records };
      }
      if (line.text.startsWith('+')) {
        // 第一次续行发凭据；若服务器回 `+ <base64 错误>`，发空行结束挑战
        if (records.length === 0) {
          records.push(line);
          this.socket.write(`${payload}\r\n`);
          continue;
        }
        records.push(line);
        this.socket.write('\r\n');
        continue;
      }
      records.push(line);
    }
  }

  close() {
    try {
      this.socket.end();
      this.socket.destroy();
    } catch {
      // 忽略
    }
  }
}

function describeImapError(error, { host, port } = {}) {
  const reason = error?.message || String(error);
  if (/AUTHENTICATIONFAILED|authentication failed|LOGIN failed|invalid credential/i.test(reason)) {
    return `IMAP 登录失败：多数服务商要用「授权码/应用专用密码」；Outlook 个人版需 OAuth2。${reason}`;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(reason)) return `找不到 IMAP 服务器 ${host}`;
  if (/ECONNREFUSED/i.test(reason)) return `连接 ${host}:${port} 被拒绝：服务器/端口不对`;
  if (/ETIMEDOUT|超时/i.test(reason)) return `连接 ${host}:${port} 超时：网络不通或端口被封`;
  if (/CERT|SELF_SIGNED|ALTNAME/i.test(reason)) return `IMAP TLS 证书校验失败：${reason}`;
  return `IMAP 失败：${reason}`;
}

async function openImapSocket(host, port, {
  timeoutMs = IMAP_TIMEOUT_MS, connect, secure = true,
} = {}) {
  if (typeof connect === 'function') {
    const socket = connect({ host, port, secure });
    return new Promise((resolve, reject) => {
      if (socket.connecting === false) resolve(socket);
      else socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port: Number(port), servername: host, rejectUnauthorized: true }, () => resolve(socket))
      : net.connect({ host, port: Number(port) }, () => resolve(socket));
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`连接 ${host}:${port} 超时`)));
    socket.once('error', reject);
  });
}

/**
 * 取 IMAP 用的 access_token。
 *
 * 关键点：Graph 与 outlook.office 是**两个资源**，发信用的 Graph 令牌不能拿去
 * AUTHENTICATE XOAUTH2。但同一个 refresh_token 可以向 outlook.office 换一份
 * 读信令牌——所以「走 Graph 发信」不该成为「读不了信」的理由（早期版本确实
 * 直接拒绝，用户被迫切通道并重新授权，属于过度限制）。
 */
async function getImapToken(cfg, store, deps = {}) {
  const record = store.account(cfg.username);
  if (!record?.refreshToken) {
    return { ok: false, needsAuth: true, message: '尚未授权：请先运行 email_oauth（action=start）完成授权' };
  }
  const scope = String(cfg.imapScope || '').trim() || IMAP_SCOPE;
  const refreshed = await refreshAccessToken({ ...cfg, scope }, record.refreshToken, { fetchImpl: deps.fetchImpl });
  if (!refreshed.ok) return refreshed;
  if (refreshed.refreshToken && refreshed.refreshToken !== record.refreshToken) {
    store.setAccount(cfg.username, { refreshToken: refreshed.refreshToken });
  }
  return { ok: true, token: refreshed.token, scope };
}

/** 拿认证材料：OAuth2 → access_token，basic → 密码。 */
async function authMaterial(cfg, store, deps = {}) {
  if (cfg.auth === 'oauth2') {
    const token = await getImapToken(cfg, store, deps);
    if (!token.ok) return { ok: false, message: token.message };
    return { ok: true, secret: token.token, mechanism: 'oauth2' };
  }
  if (!cfg.password) {
    return { ok: false, message: 'IMAP 需要密码/授权码：请在设置 → 插件 → 邮件助手填写 password' };
  }
  return { ok: true, secret: cfg.password, mechanism: 'basic' };
}

/**
 * 建立已登录的 IMAP 连接（调用方负责 logout/close）。
 *
 * @returns {Promise<{ok:boolean, conn?:ImapConnection, message?:string}>}
 */
export async function connectImap(cfg, store, deps = {}) {
  if (!cfg.imapHost) return { ok: false, message: '未配置 IMAP 服务器（设置 → 插件 → 邮件助手 → imapHost）' };
  if (!cfg.username) return { ok: false, message: '未配置邮箱账号' };
  const material = await authMaterial(cfg, store, deps);
  if (!material.ok) return { ok: false, message: material.message };

  // 端口/加密候选：主用配置项，失败再试备用（993 被封时 143+STARTTLS 等价可用）
  const attempts = [
    { port: cfg.imapPort, tls: cfg.imapTls || 'ssl' },
    ...(cfg.imapFallbacks || []),
  ].filter((item, index, all) => all.findIndex((other) => other.port === item.port && other.tls === item.tls) === index);

  const tried = [];
  for (const attempt of attempts) {
    const result = await tryConnect(cfg, material, attempt, deps);
    if (result.ok) {
      if (tried.length) {
        result.host = `${cfg.imapHost}:${attempt.port}`;
        result.note = `主入口 ${cfg.imapHost}:${cfg.imapPort} 不可用，已改用 ${cfg.imapHost}:${attempt.port}（${attempt.tls}）`;
      }
      return result;
    }
    tried.push(`${attempt.port}/${attempt.tls}: ${result.message}`);
    // 认证失败换端口没用；只有网络类失败才继续试下一个入口
    if (!/超时|ECONNRESET|ETIMEDOUT|被服务器关闭|timeout|连接/i.test(result.message)) break;
  }

  return {
    ok: false,
    message: tried.length > 1
      ? `IMAP 各入口都失败：\n· ${tried.join('\n· ')}`
      : tried[0]?.replace(/^[^:]+:\s*/, '') || 'IMAP 连接失败',
  };
}

/** 单次连接尝试（指定端口与加密方式）。 */
async function tryConnect(cfg, material, { port, tls: tlsMode = 'ssl' }, deps = {}) {
  const secure = tlsMode === 'ssl';
  let socket;
  try {
    socket = await openImapSocket(cfg.imapHost, port, {
      connect: deps.connect,
      timeoutMs: deps.timeoutMs,
      secure,
    });
  } catch (error) {
    return { ok: false, message: describeImapError(error, { host: cfg.imapHost, port }) };
  }
  const conn = new ImapConnection(socket, { timeoutMs: deps.timeoutMs || IMAP_TIMEOUT_MS });
  try {
    // 明文连接（143）服务器会先发 banner，再允许 STARTTLS
    let greeting = await conn.readLogicalLine();
    if (tlsMode === 'starttls') {
      const starttls = await conn.command('STARTTLS');
      if (starttls.status !== 'OK') {
        throw new Error(`服务器不同意 STARTTLS：${starttls.text.slice(0, 120)}`);
      }
      await conn.upgradeTls(cfg.imapHost, { rejectUnauthorized: deps.rejectUnauthorized !== false });
      // RFC 3501：STARTTLS 之后服务器**不会**重发问候语。这里用一个 CAPABILITY
      // 往返确认加密通道已就绪（顺便清掉对端可能插入的未读数据）。
      // 之前这里去读第二条问候语，遇到合规服务器会一直等到 20 秒超时。
      greeting = { text: '* OK (post-STARTTLS)' };
      try {
        await conn.command('CAPABILITY');
      } catch {
        // 少数服务器不支持 CAPABILITY：不影响后续认证
      }
    }
    if (!greeting.text.startsWith('* OK') && !greeting.text.startsWith('* PREAUTH')) {
      throw new Error(`IMAP 问候异常：${greeting.text.slice(0, 160)}`);
    }

    if (material.mechanism === 'oauth2') {
      const payload = b64(`user=${cfg.username}\x01auth=Bearer ${material.secret}\x01\x01`);
      const auth = await conn.authenticate('XOAUTH2', payload);
      if (auth.status !== 'OK') throw new Error(`AUTHENTICATIONFAILED ${auth.text}`);
    } else {
      if (!/^[\x20-\x7e]*$/.test(cfg.password)) {
        throw new Error('IMAP 密码/授权码含非 ASCII 字符：请使用服务商生成的纯 ASCII 授权码');
      }
      const auth = await conn.command(`LOGIN ${quote(cfg.username, '账号')} ${quote(cfg.password, '密码')}`);
      if (auth.status !== 'OK') throw new Error(`AUTHENTICATIONFAILED ${auth.text}`);
    }
    return { ok: true, conn, port, tls: tlsMode };
  } catch (error) {
    try { conn.close(); } catch { /* 忽略 */ }
    return { ok: false, message: describeImapError(error, { host: cfg.imapHost, port }) };
  }
}

async function selectMailbox(conn, mailbox) {
  const name = utf7Encode(mailbox || 'INBOX');
  const selected = await conn.command(`SELECT ${quote(name, '文件夹名')}`);
  if (selected.status !== 'OK') {
    throw new Error(`打开文件夹失败（${mailbox}）：${selected.text}`);
  }
  let exists = 0;
  let uidValidity = '';
  for (const record of selected.records) {
    const existsMatch = record.text.match(/^\* (\d+) EXISTS/);
    if (existsMatch) exists = Number(existsMatch[1]);
    const uidMatch = record.text.match(/\[UIDVALIDITY (\d+)\]/);
    if (uidMatch) uidValidity = uidMatch[1];
  }
  return { exists, uidValidity };
}

/** 解析 FETCH 记录里的 UID/FLAGS/INTERNALDATE/RFC822.SIZE。 */
function parseFetchMeta(record) {
  const text = record.text;
  const uid = (text.match(/\bUID (\d+)/i) || [])[1] || '';
  const size = Number((text.match(/\bRFC822\.SIZE (\d+)/i) || [])[1] || 0);
  const internal = (text.match(/\bINTERNALDATE "([^"]+)"/i) || [])[1] || '';
  const flags = (text.match(/\bFLAGS \(([^)]*)\)/i) || [])[1] || '';
  return {
    uid,
    size,
    internalDate: internal,
    seen: /\\Seen/i.test(flags),
    flagged: /\\Flagged/i.test(flags),
    literal: record.literals?.[0],
    literals: record.literals || [],
  };
}

/** 批量取头部（发件人/主题/日期/UID/大小/已读）。 */
async function fetchHeaders(conn, uids) {
  if (!uids.length) return [];
  const set = uids.join(',');
  const response = await conn.command(
    `UID FETCH ${set} (UID INTERNALDATE RFC822.SIZE FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES)])`,
  );
  if (response.status !== 'OK') throw new Error(`读取邮件头失败：${response.text}`);
  const items = [];
  for (const record of response.records) {
    if (!/^\* \d+ FETCH/i.test(record.text)) continue;
    const meta = parseFetchMeta(record);
    if (!meta.uid) continue;
    const headerText = meta.literal ? meta.literal.toString('utf8') : '';
    const headers = parseHeaders(headerText);
    items.push({
      uid: meta.uid,
      size: meta.size,
      internalDate: meta.internalDate,
      seen: meta.seen,
      flagged: meta.flagged,
      subject: decodeMimeWords(headers.subject || '') || '(无主题)',
      from: decodeMimeWords(headers.from || ''),
      to: decodeMimeWords(headers.to || ''),
      date: headers.date || meta.internalDate || '',
      messageId: headers['message-id'] || '',
      rawHeaders: headers,
    });
  }
  return items;
}

/** 批量取「头 + 前 N 字节正文」，用于关键词检索与读信。 */
async function fetchPartial(conn, uids, bytes = 16384) {
  if (!uids.length) return [];
  const response = await conn.command(
    `UID FETCH ${uids.join(',')} (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.${bytes}>)`,
  );
  if (response.status !== 'OK') throw new Error(`读取邮件正文失败：${response.text}`);
  const items = [];
  for (const record of response.records) {
    if (!/^\* \d+ FETCH/i.test(record.text)) continue;
    const meta = parseFetchMeta(record);
    if (!meta.uid) continue;
    const [headerBuf, textBuf] = meta.literals;
    const raw = buildPartialMessage(headerBuf, textBuf, { truncated: true });
    items.push({ uid: meta.uid, size: meta.size, seen: meta.seen, mail: parseMail(raw), truncated: true });
  }
  return items;
}

/** 取完整邮件（小邮件）或「头 + 部分正文」（大邮件）。 */
async function fetchMessage(conn, uid, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const sizeResponse = await conn.command(`UID FETCH ${uid} (UID RFC822.SIZE FLAGS INTERNALDATE)`);
  if (sizeResponse.status !== 'OK') throw new Error(`读取邮件失败：${sizeResponse.text}`);
  let size = 0;
  let flags = '';
  for (const record of sizeResponse.records) {
    const meta = parseFetchMeta(record);
    if (meta.uid === String(uid)) {
      size = meta.size;
      flags = record.text.match(/\bFLAGS \(([^)]*)\)/i)?.[1] || '';
    }
  }
  if (!size) return null;
  if (size <= maxBytes) {
    const response = await conn.command(`UID FETCH ${uid} (UID BODY.PEEK[])`);
    if (response.status !== 'OK') throw new Error(`读取邮件失败：${response.text}`);
    for (const record of response.records) {
      const meta = parseFetchMeta(record);
      if (meta.uid !== String(uid) || !meta.literal) continue;
      return {
        uid: String(uid),
        size,
        seen: /\\Seen/i.test(flags),
        mail: parseMail(meta.literal),
        truncated: false,
      };
    }
    return null;
  }
  const partial = await fetchPartial(conn, [uid], 256 * 1024);
  const hit = partial.find((item) => item.uid === String(uid));
  if (!hit) return null;
  return {
    uid: String(uid), size, seen: /\\Seen/i.test(flags), mail: hit.mail, truncated: true,
  };
}

/** 解析 LIST 记录：`* LIST (\HasNoChildren) "/" "INBOX"`。 */
function parseListRecord(record) {
  const text = record.text;
  const match = text.match(/^\* LIST \(([^)]*)\) (NIL|"(?:[^"\\]|\\.)*") (.+)$/i);
  if (!match) return null;
  const flags = match[1];
  const delimiterRaw = match[2];
  const delimiter = delimiterRaw === 'NIL' ? '' : delimiterRaw.slice(1, -1).replace(/\\(.)/g, '$1');
  let nameRaw = match[3].trim();
  if (nameRaw.startsWith('"') && nameRaw.endsWith('"')) {
    nameRaw = nameRaw.slice(1, -1).replace(/\\(.)/g, '$1');
  } else if (/\x00LIT0\x00/.test(nameRaw) && record.literals?.[0]) {
    nameRaw = record.literals[0].toString('utf8');
  }
  const name = utf7Decode(nameRaw);
  return {
    name,
    delimiter,
    flags: flags.split(/\s+/).filter(Boolean),
    special: /\\Noselect/i.test(flags) ? '不可选' : '',
  };
}

function oneLine(value, limit = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formatDate(value) {
  const text = String(value || '');
  if (!text) return '-';
  try {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
  } catch {
    // 忽略
  }
  return oneLine(text, 31);
}

async function withImap(cfg, store, deps, run) {
  const opened = await connectImap(cfg, store, deps);
  if (!opened.ok) return { ok: false, message: opened.message };
  try {
    return await run(opened.conn);
  } catch (error) {
    return { ok: false, message: describeImapError(error, { host: cfg.imapHost, port: cfg.imapPort }) };
  } finally {
    try {
      await opened.conn.command('LOGOUT');
    } catch {
      // 忽略
    }
    opened.conn.close();
  }
}

/**
 * 列文件夹。`email_folders` 的实现。
 */
export async function runFolders(cfg, store, args = {}, deps = {}) {
  if (!cfg.imapHost) return '[Error] 未配置 IMAP 服务器：读信需要在设置里填 imapHost（发信不需要）';
  const withCounts = args.counts !== false;
  const outcome = await withImap(cfg, store, deps, async (conn) => {
    const response = await conn.command('LIST "" "*"');
    if (response.status !== 'OK') throw new Error(`列文件夹失败：${response.text}`);
    const folders = response.records.map(parseListRecord).filter(Boolean);
    if (!folders.length) return { ok: true, text: '邮箱里没有可列的文件夹（有些服务器关闭了 IMAP）。' };
    const rows = [];
    for (const folder of folders.slice(0, 60)) {
      let messages = '';
      let unseen = '';
      if (withCounts && !folder.special) {
        try {
          const status = await conn.command(
            `STATUS ${quote(utf7Encode(folder.name), '文件夹名')} (MESSAGES UNSEEN)`,
          );
          for (const record of status.records) {
            const match = record.text.match(/MESSAGES (\d+) UNSEEN (\d+)/i);
            if (match) {
              messages = match[1];
              unseen = match[2];
            }
          }
        } catch {
          // 单个文件夹统计失败不影响列表
        }
      }
      rows.push({
        name: folder.name,
        special: folder.flags.map((flag) => flag.replace(/^\\/, '')).join(' '),
        messages,
        unseen,
      });
    }
    const lines = [
      `# 文件夹（${rows.length} 个）`,
      '',
      '| 文件夹 | 邮件数 | 未读 | 属性 |',
      '|---|---|---|---|',
    ];
    for (const row of rows) {
      lines.push(`| ${row.name.replace(/\|/g, '\\|')} | ${row.messages || '-'} | ${row.unseen || '-'} | ${row.special || '-'} |`);
    }
    lines.push('', '把「文件夹」列的名字原样传给 email_list / email_read 的 folder 参数即可。');
    return { ok: true, text: lines.join('\n') };
  });
  return outcome.ok ? outcome.text : `[Error] ${outcome.message}`;
}


/** 解析 `YYYY-MM-DD`（本地时区当天 00:00）。 */
function dayStartMs(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d), 0, 0, 0, 0);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

/**
 * 解析时间范围。
 *
 * 支持三种写法（可组合，取交集）：
 *   · since=YYYY-MM-DD / until=YYYY-MM-DD：按日期（until 含当天）
 *   · days=N：最近 N 天（滚动窗口，含今天）
 *   · after/before 作为 since/until 的别名（用户口语里两种都常见）
 *
 * 返回服务端 IMAP 用的日期串 + 本地复核用的毫秒边界。
 * 为什么要本地复核：部分服务器会忽略 SINCE/BEFORE（尤其非 ASCII 检索时），
 * 只用服务端条件会出现「明明限定了 11 月，结果给了 10 月的邮件」。
 */
export function resolveTimeWindow(args = {}, now = Date.now()) {
  const sinceRaw = String(args.since || args.after || '').trim();
  const untilRaw = String(args.until || args.before || '').trim();
  const days = Number(args.days);

  let sinceMs = sinceRaw ? dayStartMs(sinceRaw) : null;
  let untilMs = null;
  if (untilRaw) {
    const start = dayStartMs(untilRaw);
    untilMs = start === null ? null : start + 24 * 60 * 60 * 1000 - 1; // 含当天
  }
  if (Number.isFinite(days) && days > 0) {
    const rolling = now - Math.trunc(days) * 24 * 60 * 60 * 1000;
    sinceMs = sinceMs === null ? rolling : Math.max(sinceMs, rolling);
  }

  const criteria = [];
  if (sinceRaw) {
    try { criteria.push(`SINCE ${imapDate(sinceRaw)}`); } catch { /* 交给调用方报错 */ }
  }
  if (untilRaw) {
    // IMAP BEFORE 是「不含该日」，所以要把 until 加一天
    try {
      const start = dayStartMs(untilRaw);
      if (start !== null) {
        const next = new Date(start + 24 * 60 * 60 * 1000);
        const iso = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
        criteria.push(`BEFORE ${imapDate(iso)}`);
      }
    } catch { /* 忽略 */ }
  }
  // days 转成服务端 SINCE（本地时区当天）
  if (Number.isFinite(days) && days > 0) {
    const start = new Date(sinceMs);
    const iso = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    try { criteria.push(`SINCE ${imapDate(iso)}`); } catch { /* 忽略 */ }
  }

  return {
    sinceMs: sinceMs ?? null,
    untilMs: untilMs ?? null,
    criteria: [...new Set(criteria)],
    label: describeWindow(sinceMs, untilMs, days),
  };
}

function describeWindow(sinceMs, untilMs, days) {
  const fmt = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  if (Number.isFinite(days) && days > 0) return `最近 ${days} 天（含今天）`;
  if (sinceMs !== null && untilMs !== null) return `${fmt(sinceMs)} ~ ${fmt(untilMs)}`;
  if (sinceMs !== null) return `${fmt(sinceMs)} 之后`;
  if (untilMs !== null) return `${fmt(untilMs)} 之前`;
  return '不限时间';
}

/** 邮件时间 → 毫秒（解析不出返回 0）。 */
function mailTimeMs(item = {}) {
  const candidates = [item.date, item.internalDate];
  for (const value of candidates) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/** 本地复核时间窗口。 */
function withinWindow(ms, window) {
  if (!ms) return true; // 时间解析不出来就不误杀
  if (window.sinceMs !== null && ms < window.sinceMs) return false;
  if (window.untilMs !== null && ms > window.untilMs) return false;
  return true;
}

/** 排序：newest（默认）| oldest。 */
function sortItems(items, sort) {
  const direction = String(sort || 'newest').toLowerCase() === 'oldest' ? 1 : -1;
  return items.slice().sort((a, b) => {
    const ta = mailTimeMs(a);
    const tb = mailTimeMs(b);
    if (ta !== tb) return (ta - tb) * direction;
    return (Number(a.uid) - Number(b.uid)) * direction;
  });
}

/** 搜索命中片段：取匹配词前后各 40 字符，压平空白。 */
export function snippetOf(text, keyword, radius = 40) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return '';
  const lower = source.toLowerCase();
  const index = lower.indexOf(String(keyword || '').toLowerCase());
  if (index < 0) return '';
  const start = Math.max(0, index - radius);
  const end = Math.min(source.length, index + String(keyword).length + radius);
  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
}

/** 解析 `* SEARCH 1 2 3` 记录里的 UID（去重 + 数值升序）。 */
function collectSearchUids(records) {
  const uids = [];
  for (const record of records || []) {
    const match = record.text.match(/^\* SEARCH(.*)$/i);
    if (!match) continue;
    for (const token of match[1].trim().split(/\s+/)) {
      if (/^\d+$/.test(token)) uids.push(Number(token));
    }
  }
  return [...new Set(uids)].sort((a, b) => a - b);
}

const SEARCH_FIELDS = {
  auto: null,
  all: null,
  subject: 'SUBJECT',
  from: 'FROM',
  to: 'TO',
  body: 'BODY',
};

/**
 * 搜索邮件。`email_search` 的实现。
 *
 * 两层策略：
 *   1. **服务端检索**：ASCII 关键词直接拼进命令；中文走 UTF-8 literal。
 *      大多数服务端认 literal，能一次在全邮箱里找。
 *   2. **本地兜底**：服务端不支持（BAD/NO）或没有命中时，按「最近 N 封」
 *      取头部 + 正文前 16KB 在本地匹配。这是有代价的取舍——扫不全历史，
 *      但不会因为服务器限制就让中文搜索完全不可用（结果里会写明扫了多少）。
 */
export async function runSearch(cfg, store, args = {}, deps = {}) {
  if (!cfg.imapHost) return '[Error] 未配置 IMAP 服务器：搜索需要在设置里填 imapHost（发信不需要）';

  const query = String(args.query ?? '').trim();
  if (!query) return '[Error] 请提供搜索关键词（query），例如「招商银行」或「invoice」';
  const max = Math.min(Math.max(Number(args.max) || 20, 1), MAX_LIST);
  const field = String(args.in || args.field || 'auto').toLowerCase();
  if (!(field in SEARCH_FIELDS)) {
    return `[Error] 搜索范围只能是 ${Object.keys(SEARCH_FIELDS).join(' / ')}（当前：${field}）`;
  }
  const scanWindow = Math.min(Math.max(Number(args.scan) || 200, 20), 500);
  const ascii = /^[\x20-\x7e]*$/.test(query);

  // 结构化条件（这些永远走服务端，且必须 ASCII）
  const baseCriteria = [];
  let window;
  try {
    window = resolveTimeWindow(args);
    baseCriteria.push(...window.criteria);
    if (args.unread === true) baseCriteria.push('UNSEEN');
    if (args.from) baseCriteria.push(`FROM ${quote(args.from, 'from')}`);
    if (args.to) baseCriteria.push(`TO ${quote(args.to, 'to')}`);
  } catch (error) {
    return `[Error] ${error.message}`;
  }
  const sort = String(args.sort || 'newest').toLowerCase();

  const folders = args.all_folders === true
    ? await listSearchableFolders(cfg, store, deps)
    : [String(args.folder || 'INBOX')];

  const outcome = await withImap(cfg, store, deps, async (conn) => {
    const hits = [];
    for (const folder of folders.slice(0, 25)) {
      let selected;
      try {
        selected = await selectMailbox(conn, folder);
      } catch {
        continue; // 个别文件夹不可选（\Noselect）就跳过
      }
      if (!selected.exists) continue;

      // ── 第一层：服务端检索 ──
      let serverUids = [];
      let serverFailed = false;
      const operator = SEARCH_FIELDS[field];
      const terms = [...baseCriteria];
      if (operator) {
        terms.push(`${operator} ${ascii ? quote(query, 'query') : '{LITERAL}'}`);
      } else {
        terms.push(`TEXT ${ascii ? quote(query, 'query') : '{LITERAL}'}`);
      }
      if (!ascii) {
        // 用 literal 形式拼：去掉占位符，交给 commandWithLiteral
        const head = terms.filter((term) => !term.includes('{LITERAL}')).join(' ');
        const tail = terms.filter((term) => term.includes('{LITERAL}'))
          .map((term) => term.replace(' {LITERAL}', '')).join(' ');
        const response = await conn.commandWithLiteral(
          `UID SEARCH${head ? ` ${head}` : ''}${tail ? ` ${tail}` : ''}`,
          query,
        );
        if (response.status !== 'OK') serverFailed = true;
        else serverUids = collectSearchUids(response.records);
      } else {
        try {
          const response = await conn.command(`UID SEARCH ${terms.join(' ')}`);
          if (response.status !== 'OK') serverFailed = true;
          else serverUids = collectSearchUids(response.records);
        } catch {
          serverFailed = true;
        }
      }

      let mode = 'server';
      let candidates = serverUids.slice(-Math.max(max * 3, 40)).reverse();

      // ── 第二层：本地兜底 ──
      if (!candidates.length) {
        mode = serverFailed ? 'local(服务端不支持)' : 'local(服务端无命中)';
        const allResponse = await conn.command(
          `UID SEARCH ${baseCriteria.length ? baseCriteria.join(' ') : 'ALL'}`,
        );
        const all = collectSearchUids(allResponse.records);
        candidates = all.slice(-scanWindow).reverse();
      }

      const previews = await fetchPartial(conn, candidates.slice(0, scanWindow), 16384);
      const lower = query.toLowerCase();
      const matched = [];
      for (const item of previews) {
        const mail = item.mail || {};
        const haystacks = {
          subject: mail.subject || '',
          from: mail.from || '',
          to: mail.to || '',
          body: mail.text || '',
        };
        const keys = (field === 'subject' || field === 'from' || field === 'to' || field === 'body')
          ? [field]
          : ['subject', 'from', 'to', 'body'];
        const matchedFields = keys.filter((key) => String(haystacks[key]).toLowerCase().includes(lower));
        if (!matchedFields.length) continue;
        // 服务端可能忽略 SINCE/BEFORE：命中后再按时间复核一次
        if (!withinWindow(mailTimeMs({ date: mail.date, internalDate: item.internalDate }), window)) continue;
        // 片段优先取正文（比「主题里也有这个词」信息量大），其次主题/发件人
        const snippetKey = ['body', 'subject', 'from', 'to'].find((key) => matchedFields.includes(key)) || matchedFields[0];
        matched.push({
          uid: String(item.uid),
          folder,
          subject: mail.subject || '(无主题)',
          from: mail.from || '',
          date: mail.date || '',
          hitField: matchedFields.join('+'),
          snippet: snippetOf(haystacks[snippetKey], query),
        });
      }
      hits.push(...matched);
      if (hits.length >= max) break;
      void mode;
    }

    const top = sortItems(hits, sort).slice(0, max);
    if (!top.length) {
      return {
        ok: true,
        text: `没有找到包含「${query}」的邮件（已检查 ${folders.length > 1 ? `${folders.length} 个文件夹` : folders[0]}，最多回溯 ${scanWindow} 封/文件夹）。\n`
          + '可以换个更短的关键词，或用 since/until 缩小时间范围，或加 all_folders=true 搜全部文件夹。',
      };
    }
    const lines = [
      `# 搜索「${query}」`,
      '',
      `命中 ${hits.length} 封${hits.length > top.length ? `（显示 ${top.length} 封）` : ''}`
        + `${folders.length > 1 ? `，范围 ${folders.length} 个文件夹` : ''}`,
      '',
      `时间范围：${window.label}　排序：${sort === 'oldest' ? '最旧在前' : '最新在前'}`,
      '',
      '| # | 时间 | 发件人 | 主题 | 命中 | UID |',
      '|---|---|---|---|---|---|',
    ];
    top.forEach((hit, index) => {
      lines.push(`| ${index + 1} | ${formatDate(hit.date)} | ${oneLine(hit.from, 30).replace(/\|/g, '\\|')} | `
        + `${oneLine(hit.subject, 46).replace(/\|/g, '\\|')} | ${hit.hitField} | ${hit.uid} |`);
    });
    const withSnippet = top.filter((hit) => hit.snippet);
    if (withSnippet.length) {
      lines.push('', '## 命中片段', '');
      for (const hit of withSnippet.slice(0, 5)) {
        lines.push(`- **${oneLine(hit.subject, 40)}**（UID ${hit.uid}）`);
        lines.push(`  > ${hit.snippet}`);
      }
    }
    lines.push('', '用 `email_read`（folder + uid）读全文。');
    return { ok: true, text: lines.join('\n') };
  });

  return outcome.ok ? outcome.text : `[Error] ${outcome.message}`;
}

/** 列出可搜索的文件夹（跳过 \Noselect）。 */
async function listSearchableFolders(cfg, store, deps = {}) {
  const outcome = await withImap(cfg, store, deps, async (conn) => {
    const response = await conn.command('LIST "" "*"');
    if (response.status !== 'OK') return { ok: true, folders: ['INBOX'] };
    const folders = (response.records || [])
      .map(parseListRecord)
      .filter((item) => item && !/Noselect/i.test(item.flags.join(' ')))
      .map((item) => item.name);
    return { ok: true, folders: folders.length ? folders : ['INBOX'] };
  });
  return outcome.ok ? outcome.folders : ['INBOX'];
}

/**
 * 列邮件。`email_list` 的实现。
 */
export async function runList(cfg, store, args = {}, deps = {}) {
  if (!cfg.imapHost) return '[Error] 未配置 IMAP 服务器：读信需要在设置里填 imapHost（发信不需要）';
  const folder = String(args.folder || 'INBOX');
  const max = Math.min(Math.max(Number(args.max) || 20, 1), MAX_LIST);
  const criteria = [];
  if (args.unread === true) criteria.push('UNSEEN');
  let window;
  try {
    window = resolveTimeWindow(args);
    criteria.push(...window.criteria);
  } catch (error) {
    return `[Error] 时间条件不合法：${error.message}`;
  }
  const sort = String(args.sort || 'newest').toLowerCase();
  const fromFilter = String(args.from || '').trim();
  const subjectFilter = String(args.subject || '').trim();
  const keywords = (Array.isArray(args.keyword) ? args.keyword : String(args.keyword || '').split(/[,，]/))
    .map((item) => String(item).trim()).filter(Boolean);
  const asciiSearch = /^[\x20-\x7e]*$/.test([fromFilter, subjectFilter, ...keywords].join(' '));
  if (asciiSearch) {
    if (fromFilter) criteria.push(`FROM ${quote(fromFilter, 'from')}`);
    if (subjectFilter) criteria.push(`SUBJECT ${quote(subjectFilter, 'subject')}`);
    for (const keyword of keywords) criteria.push(`TEXT ${quote(keyword, 'keyword')}`);
  }
  if (!criteria.length) criteria.push('ALL');

  const outcome = await withImap(cfg, store, deps, async (conn) => {
    const selected = await selectMailbox(conn, folder);
    const search = await conn.command(`UID SEARCH ${criteria.join(' ')}`);
    if (search.status !== 'OK') throw new Error(`搜索失败：${search.text}`);
    const uids = [];
    for (const record of search.records) {
      const match = record.text.match(/^\* SEARCH(.*)$/i);
      if (match) {
        for (const token of match[1].trim().split(/\s+/)) {
          if (/^\d+$/.test(token)) uids.push(token);
        }
      }
    }
    if (!uids.length) {
      return { ok: true, text: `文件夹「${folder}」里没有符合条件的邮件（共 ${selected.exists} 封）。` };
    }
    // 不信任服务端 SEARCH 的返回顺序（实测有些服务器给降序，结果就是
    // 「列表里最新的邮件是两周前」这种最难察觉的错）。自己按 UID 数值排序，
    // 取最大的若干个，再反转成「最新在前」。
    const numeric = [...new Set(uids.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
    const newest = numeric.slice(-Math.max(max * 4, 60)).reverse();
    const headers = await fetchHeaders(conn, newest);

    let items = headers;
    // 非 ASCII 的 from/subject/keyword 没走服务端搜索 → 取正文前 16KB 本地过滤
    if (!asciiSearch) {
      const candidates = items.slice(0, 40);
      const previews = await fetchPartial(conn, candidates.map((item) => item.uid), 16384);
      const byUid = new Map(previews.map((item) => [item.uid, item]));
      items = items.map((item) => {
        const preview = byUid.get(item.uid);
        return {
          ...item,
          bodyText: preview?.mail?.text || '',
          attachments: preview?.mail?.attachments || [],
        };
      });
    }
    const lower = (value) => String(value || '').toLowerCase();
    const filtered = sortItems(items.filter((item) => {
      if (args.unread === true && item.seen) return false;
      if (!withinWindow(mailTimeMs(item), window)) return false;
      if (fromFilter && !lower(item.from).includes(lower(fromFilter))) return false;
      if (subjectFilter && !lower(item.subject).includes(lower(subjectFilter))) return false;
      for (const keyword of keywords) {
        const haystack = [item.subject, item.from, item.to, item.bodyText || ''].join('\n').toLowerCase();
        if (!haystack.includes(lower(keyword))) return false;
      }
      return true;
    }), sort).slice(0, max);
    if (!filtered.length) {
      return { ok: true, text: `文件夹「${folder}」里没有符合关键词的邮件（共 ${selected.exists} 封，已检查最近 ${items.length} 封）。` };
    }
    const rows = filtered.map((item, index) => ({
      index: index + 1,
      date: formatDate(item.date || item.internalDate),
      from: oneLine(item.from, 38),
      subject: oneLine(item.subject, 56),
      uid: item.uid,
      seen: item.seen,
      size: item.size,
      attachments: item.attachments?.length || 0,
    }));
    const lines = [
      `# ${folder}（共 ${selected.exists} 封，显示 ${rows.length} 封）`,
      '',
      `时间范围：${window.label}　排序：${sort === 'oldest' ? '最旧在前' : '最新在前'}`,
      '',
      '| # | 时间 | 发件人 | 主题 | UID |',
      '|---|---|---|---|---|',
    ];
    for (const row of rows) {
      const unseen = row.seen ? '' : '🔵 ';
      const attach = row.attachments ? ` 📎${row.attachments}` : '';
      lines.push(`| ${row.index} | ${row.date} | ${row.from.replace(/\|/g, '\\|')} | ${unseen}${row.subject.replace(/\|/g, '\\|')}${attach} | ${row.uid} |`);
    }
    lines.push('', '用 `email_read`（folder + uid）读其中一封的完整正文。🔵 表示未读。');
    if (!asciiSearch) lines.push('（关键词含中文，已在本地对最近邮件的标题/发件人/正文做匹配，最多检查 40 封。）');
    return { ok: true, text: lines.join('\n') };
  });
  return outcome.ok ? outcome.text : `[Error] ${outcome.message}`;
}

/**
 * 读一封邮件。`email_read` 的实现。
 */
export async function runRead(cfg, store, args = {}, deps = {}) {
  if (!cfg.imapHost) return '[Error] 未配置 IMAP 服务器：读信需要在设置里填 imapHost（发信不需要）';
  const folder = String(args.folder || 'INBOX');
  const uid = String(args.uid || '').trim();
  if (!/^\d+$/.test(uid)) return '[Error] uid 必须是数字（从 email_list 返回的 UID 列取）';
  const maxChars = Math.min(Math.max(Number(args.max_chars) || MAX_TEXT_CHARS, 500), 30000);

  const outcome = await withImap(cfg, store, deps, async (conn) => {
    await selectMailbox(conn, folder);
    const message = await fetchMessage(conn, uid, { maxBytes: deps.maxReadBytes || 2 * 1024 * 1024 });
    if (!message) throw new Error(`没有找到 UID ${uid}（可能已被移动或删除）`);
    const mail = message.mail;
    const lines = [
      `# ${mail.subject}`,
      '',
      `- 发件人：${mail.from || '(未知)'}`,
      `- 收件人：${mail.to || '(未知)'}`,
    ];
    if (mail.cc) lines.push(`- 抄送：${mail.cc}`);
    lines.push(`- 时间：${mail.date || formatDate(message.mail.date)}`);
    lines.push(`- UID：${uid}（文件夹 ${folder}）`);
    lines.push(`- 大小：${(message.size / 1024).toFixed(1)} KB`);
    if (mail.messageId) lines.push(`- Message-ID：${mail.messageId}`);
    if (mail.attachments?.length) {
      lines.push(`- 附件：${mail.attachments.map((item) => `${item.filename}（${item.contentType}，${(item.size / 1024).toFixed(1)} KB）`).join('、')}`);
    }
    const bodyText = mail.text || '(正文为空或只有 HTML，未能提取文本)';
    lines.push('', '---', '', bodyText.slice(0, maxChars));
    if (bodyText.length > maxChars) {
      lines.push('', `（正文已截断：只显示前 ${maxChars} 字符，全文约 ${bodyText.length} 字符）`);
    }
    if (message.truncated) {
      lines.push('', '> 这封邮件较大，只读取了邮件头和部分正文；附件内容没有下载。');
    }
    return { ok: true, text: lines.join('\n') };
  });
  return outcome.ok ? outcome.text : `[Error] ${outcome.message}`;
}
