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

import { getAccessToken } from './oauth.js';
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

/** 拿认证材料：OAuth2 → access_token，basic → 密码。 */
async function authMaterial(cfg, store, deps = {}) {
  if (cfg.auth === 'oauth2') {
    const token = await getAccessToken(cfg, store, { fetchImpl: deps.fetchImpl });
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
  // Graph 令牌只有 Graph 资源权限，拿去 AUTHENTICATE XOAUTH2 只会得到 401。
  // 与其让用户对着「认证失败」猜，不如直接说清楚该改哪一项。
  if (cfg.auth === 'oauth2' && cfg.transport === 'graph') {
    return {
      ok: false,
      message: '当前 Outlook 走 Graph 发信通道，令牌不含 IMAP 权限，无法读信。'
        + '要读收件箱：把「发信通道」改成 smtp，重新运行 email_oauth（action=start）授权一次；'
        + '只看信不授权也可以直接去网页版邮箱。发信不受影响。',
    };
  }
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

/**
 * 列邮件。`email_list` 的实现。
 */
export async function runList(cfg, store, args = {}, deps = {}) {
  if (!cfg.imapHost) return '[Error] 未配置 IMAP 服务器：读信需要在设置里填 imapHost（发信不需要）';
  const folder = String(args.folder || 'INBOX');
  const max = Math.min(Math.max(Number(args.max) || 20, 1), MAX_LIST);
  const criteria = [];
  if (args.unread === true) criteria.push('UNSEEN');
  try {
    if (args.since) criteria.push(`SINCE ${imapDate(args.since)}`);
    if (args.until) criteria.push(`BEFORE ${imapDate(args.until)}`);
  } catch (error) {
    return `[Error] ${error.message}`;
  }
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
    // 服务端 SEARCH 返回升序；列表要「最新在前」
    const newest = uids.slice(-Math.max(max * 4, 60)).reverse();
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
    const filtered = items.filter((item) => {
      if (args.unread === true && item.seen) return false;
      if (fromFilter && !lower(item.from).includes(lower(fromFilter))) return false;
      if (subjectFilter && !lower(item.subject).includes(lower(subjectFilter))) return false;
      for (const keyword of keywords) {
        const haystack = [item.subject, item.from, item.to, item.bodyText || ''].join('\n').toLowerCase();
        if (!haystack.includes(lower(keyword))) return false;
      }
      return true;
    }).slice(0, max);
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
