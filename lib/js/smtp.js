/**
 * SMTP 客户端（零依赖，只用 node:net / node:tls）。
 *
 * 支持的范围是「个人邮箱发一封正经邮件」够用的部分：
 *   · 隐式 TLS（465）/ STARTTLS（587）/ 明文（仅本机中继，需显式允许）；
 *   · AUTH XOAUTH2（Hotmail/Outlook 的 OAuth2）、AUTH LOGIN、AUTH PLAIN；
 *   · 多收件人（含 Bcc 信封）、超时、可读的错误说明。
 *
 * 刻意不做：DKIM、PIPELINING、SMTPUTF8（地址只接受 ASCII，见 config.js）。
 *
 * 约定：`smtpSend()` **绝不抛异常**，一律返回 `{ok, message}`——发信失败应该
 * 变成一句能照着改的提示，而不是把工具调用整个炸掉。
 */

import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';

import { dotStuff } from './message.js';

export const SMTP_TIMEOUT_MS = 20_000;

function b64(text) {
  return Buffer.from(String(text ?? ''), 'utf8').toString('base64');
}

/** 端口 → 加密方式（用户只改端口不改下拉框时的兜底）。 */
export function resolveSmtpTls(port, tlsMode) {
  const mode = String(tlsMode || '').toLowerCase();
  if (['ssl', 'starttls', 'none'].includes(mode)) return mode;
  return Number(port) === 465 ? 'ssl' : 'starttls';
}

/**
 * 一条 SMTP 连接（读应答 → 发命令）。
 *
 * 单独导出是为了让单测能用本地假服务器验证协议状态机：问候语早于 `read()`
 * 到达、多行应答、点转义这些地方最容易写错。
 */
export class SmtpConnection {
  constructor(socket, { timeoutMs = SMTP_TIMEOUT_MS } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.replies = [];
    this.closed = false;
    this.error = null;
    this.capabilities = {};
    this.attach(socket);
    socket.setTimeout(timeoutMs, () => {
      this.fail(new Error(`SMTP 超时（${Math.round(timeoutMs / 1000)} 秒无响应）`));
    });
  }

  attach(socket) {
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => {
      if (!this.closed) this.fail(new Error('SMTP 连接被服务器关闭'));
    });
  }

  detach() {
    // 升级 TLS 时旧 socket 的监听要摘掉，否则它的 close 会把新连接判死
    try {
      this.socket.removeAllListeners('data');
      this.socket.removeAllListeners('error');
      this.socket.removeAllListeners('close');
      this.socket.removeAllListeners('timeout');
    } catch {
      // 忽略
    }
  }

  fail(error) {
    this.closed = true;
    this.error = error;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let index = this.buffer.indexOf('\r\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.lines.push(line);
      // 多行应答以 "250-" 续行，最后一行是 "250 "（三位码后跟空格）
      if (/^\d{3} /.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.lines.slice() };
        this.lines = [];
        const waiter = this.waiters.shift();
        // 应答可能早于 `read()` 到达（连接建立瞬间的 220 问候语就是这样）：
        // 没人等就排队，别丢掉——丢了只能等超时。
        if (waiter) waiter.resolve(reply);
        else this.replies.push(reply);
      }
      index = this.buffer.indexOf('\r\n');
    }
  }

  /** 等下一条应答（超时/断开都会 reject）。 */
  read() {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`SMTP 超时（${Math.round(this.timeoutMs / 1000)} 秒无响应）`));
      }, this.timeoutMs);
      this.waiters.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  write(text) {
    this.socket.write(`${text}\r\n`);
  }

  /** 发一条命令并校验应答码；不符合就抛带状态码的可读错误。 */
  async command(text, expected = [250]) {
    if (text) this.write(text);
    const reply = await this.read();
    if (expected.length && !expected.includes(reply.code)) {
      const detail = reply.lines.join(' / ');
      const error = new Error(`SMTP ${reply.code}：${detail}`);
      error.smtpCode = reply.code;
      error.smtpDetail = detail;
      throw error;
    }
    return reply;
  }

  /** 记录 EHLO 声明的能力（STARTTLS/AUTH/SIZE）。 */
  rememberCapabilities(reply) {
    this.capabilities = {};
    for (const line of reply.lines.slice(1)) {
      const text = line.replace(/^\d{3}[- ]/, '').trim();
      const [keyword, ...rest] = text.split(/\s+/);
      if (!keyword) continue;
      // 无值能力（STARTTLS/8BITMIME）存 true：存空串会让 `!capabilities.STARTTLS` 误判为「不支持」
      this.capabilities[keyword.toUpperCase()] = rest.length ? rest.join(' ').toUpperCase() : true;
    }
  }

  authMechanisms() {
    return String(this.capabilities.AUTH || '').split(/\s+/).filter(Boolean);
  }

  async upgradeTls(host, { rejectUnauthorized = true } = {}) {
    this.detach();
    const secure = await new Promise((resolve, reject) => {
      const socket = tls.connect({
        socket: this.socket,
        servername: host,
        rejectUnauthorized,
      }, () => resolve(socket));
      socket.once('error', reject);
    });
    this.socket = secure;
    this.buffer = '';
    this.lines = [];
    this.closed = false;
    this.attach(secure);
    secure.setTimeout(this.timeoutMs, () => {
      this.fail(new Error(`SMTP 超时（${Math.round(this.timeoutMs / 1000)} 秒无响应）`));
    });
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

/** 建立 TCP/TLS 连接（可注入 connect 供测试用本地假服务器）。 */
export function openSocket({
  host, port, secure, timeoutMs = SMTP_TIMEOUT_MS, connect, rejectUnauthorized = true,
}) {
  if (typeof connect === 'function') {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port, secure });
      if (!socket) {
        reject(new Error('测试连接工厂没有返回 socket'));
        return;
      }
      if (socket.connecting === false) resolve(socket);
      socket.once(secure ? 'secureConnect' : 'connect', () => resolve(socket));
      socket.once('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const factory = secure ? tls.connect : net.connect;
    const socket = factory(secure
      ? { host, port, servername: host, rejectUnauthorized }
      : { host, port }, () => resolve(socket));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error(`连接 ${host}:${port} 超时`));
    });
    socket.once('error', reject);
  });
}

/**
 * 完成一轮 SMTP 对话（EHLO → TLS → AUTH → MAIL FROM → RCPT TO → DATA → QUIT）。
 *
 * @param {SmtpConnection} conn
 * @param {object} options
 * @returns {Promise<{ok: boolean, message: string, stage?: string, response?: string, secure?: boolean}>}
 */
/**
 * 建连后的公共阶段：问候 → EHLO →（STARTTLS）→ AUTH。
 *
 * 抽出来是为了让「发信」和「只验证登录」共用同一套逻辑——自检如果另写一份，
 * 就会出现「自检通过、发信 535」这类最难查的偏差。
 */
async function negotiate(conn, {
  host = '',
  username = '',
  password = '',
  accessToken = '',
  auth = 'basic',
  tls: tlsMode = 'starttls',
  allowInsecure = false,
  rejectUnauthorized = true,
  hostname = os.hostname() || 'localhost',
} = {}, state = { stage: 'greeting' }) {
  let secure = tlsMode === 'ssl';
  state.stage = 'greeting';
  await conn.command('', [220]);
  state.stage = 'ehlo';
  const hello = await conn.command(`EHLO ${hostname}`, [250]);
  conn.rememberCapabilities(hello);

  if (tlsMode === 'starttls') {
    state.stage = 'starttls';
    if (!Object.hasOwn(conn.capabilities, 'STARTTLS')) {
      throw Object.assign(new Error('服务器没有声明 STARTTLS 能力'), {
        smtpCode: 0,
        smtpDetail: '服务器未在 EHLO 应答里声明 STARTTLS；465 端口请用 ssl，或换 587/SSL 端口',
      });
    }
    await conn.command('STARTTLS', [220]);
    await conn.upgradeTls(host, { rejectUnauthorized });
    secure = true;
    const afterTls = await conn.command(`EHLO ${hostname}`, [250]);
    conn.rememberCapabilities(afterTls);
  } else if (tlsMode !== 'ssl' && !allowInsecure) {
    throw new Error('拒绝在明文连接上发送账号密码：请使用 465（ssl）或 587（starttls）；本地中继需显式开启 allowInsecure');
  } else if (tlsMode === 'none') {
    secure = false;
  }

  state.stage = 'auth';
  if (auth === 'oauth2') {
    const token = String(accessToken || '');
    if (!token) {
      throw Object.assign(new Error('OAuth2 模式缺少 access_token：请先完成设备码授权'), { smtpCode: 535 });
    }
    const payload = b64(`user=${username}\x01auth=Bearer ${token}\x01\x01`);
    try {
      await conn.command(`AUTH XOAUTH2 ${payload}`, [235]);
    } catch (error) {
      // 失败时服务器会回 334 + base64 错误详情，必须先回一个空行结束
      if (error?.smtpCode === 334) {
        const detail = error.smtpDetail || '';
        const decoded = /^334\s+/.test(detail)
          ? Buffer.from(detail.replace(/^334\s+/, ''), 'base64').toString('utf8')
          : detail;
        try {
          await conn.command('', [535]);
        } catch {
          // 服务器可能直接断开
        }
        error.smtpDetail = decoded || detail;
      }
      throw error;
    }
  } else {
    const mechanisms = conn.authMechanisms();
    if (mechanisms.length && !mechanisms.includes('LOGIN') && !mechanisms.includes('PLAIN')) {
      throw Object.assign(new Error('服务器只接受其它认证方式'), {
        smtpCode: 535,
        smtpDetail: `服务器声明的认证机制：${mechanisms.join(' ')}`,
      });
    }
    const usePlainFirst = mechanisms.includes('PLAIN') && !mechanisms.includes('LOGIN');
    if (usePlainFirst) {
      await conn.command(`AUTH PLAIN ${b64(`\0${username}\0${password}`)}`, [235]);
    } else {
      try {
        await conn.command('AUTH LOGIN', [334]);
        await conn.command(b64(username), [334]);
        await conn.command(b64(password), [235]);
      } catch (error) {
        if (error?.smtpCode === 504 || error?.smtpCode === 502) {
          await conn.command(`AUTH PLAIN ${b64(`\0${username}\0${password}`)}`, [235]);
        } else {
          throw error;
        }
      }
    }
  }
  state.stage = 'ready';
  return { secure };
}

export async function runSession(conn, {
  host = '',
  username = '',
  password = '',
  accessToken = '',
  auth = 'basic',
  envelopeFrom = '',
  envelopeTo = [],
  rawMessage = '',
  tls: tlsMode = 'starttls',
  allowInsecure = false,
  rejectUnauthorized = true,
  hostname = os.hostname() || 'localhost',
} = {}) {
  const state = { stage: 'greeting' };
  let secure = tlsMode === 'ssl';
  try {
    const negotiated = await negotiate(conn, {
      host,
      username,
      password,
      accessToken,
      auth,
      tls: tlsMode,
      allowInsecure,
      rejectUnauthorized,
      hostname,
    }, state);
    secure = negotiated.secure;

    state.stage = 'mail-from';
    await conn.command(`MAIL FROM:<${envelopeFrom}>`, [250]);
    state.stage = 'rcpt-to';
    for (const recipient of envelopeTo) {
      await conn.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }
    state.stage = 'data';
    await conn.command('DATA', [354]);
    const body = String(rawMessage).endsWith('\r\n') ? String(rawMessage) : `${rawMessage}\r\n`;
    const reply = await conn.command(`${dotStuff(body)}.`, [250]);
    const response = reply.lines.map((line) => line.replace(/^\d{3}[- ]/, '')).join(' ').trim();
    state.stage = 'quit';
    try {
      await conn.command('QUIT', [221]);
    } catch {
      // QUIT 失败无所谓，信已经被接收
    }
    conn.close();
    return {
      ok: true,
      secure,
      stage: state.stage,
      response,
      message: `SMTP 已接收（${secure ? 'TLS' : '明文'}），服务器应答：${response || '250'}`,
    };
  } catch (error) {
    try { conn.close(); } catch { /* 忽略 */ }
    return {
      ok: false,
      secure,
      stage: state.stage,
      message: describeSmtpError(error, { host, envelopeFrom, envelopeTo, stage: state.stage }),
    };
  }
}

/**
 * 只验证「能连上并登录」——不发信。
 *
 * 用途：email_status 的 probe。真实 AUTH 能发现授权码过期/被停用，而
 * 「EHLO 通了」说明不了任何事。
 */
export async function smtpProbe({
  host,
  port,
  tls: tlsMode,
  allowInsecure = false,
  rejectUnauthorized = true,
  username,
  password,
  accessToken,
  auth = 'basic',
  timeoutMs = SMTP_TIMEOUT_MS,
  connect,
  hostname,
} = {}) {
  const mode = resolveSmtpTls(port, tlsMode);
  if (mode === 'none' && !allowInsecure) {
    return { ok: false, message: '探测需要 TLS：请使用 ssl/starttls，或对本地中继显式允许明文' };
  }
  let socket;
  try {
    socket = await openSocket({
      host,
      port: Number(port),
      secure: mode === 'ssl',
      timeoutMs,
      connect,
      rejectUnauthorized,
    });
  } catch (error) {
    return { ok: false, message: describeConnectError(error, host, port) };
  }
  const conn = new SmtpConnection(socket, { timeoutMs });
  const state = { stage: 'greeting' };
  try {
    const negotiated = await negotiate(conn, {
      host,
      username,
      password,
      accessToken,
      auth,
      tls: mode,
      allowInsecure,
      rejectUnauthorized,
      hostname,
    }, state);
    try {
      await conn.command('QUIT', [221]);
    } catch {
      // 忽略
    }
    conn.close();
    return {
      ok: true,
      secure: negotiated.secure,
      message: `SMTP 登录成功（${host}:${port}，${negotiated.secure ? 'TLS' : '明文'}，${auth === 'oauth2' ? 'XOAUTH2' : '密码'} 认证）`,
    };
  } catch (error) {
    try { conn.close(); } catch { /* 忽略 */ }
    return {
      ok: false,
      stage: state.stage,
      message: describeSmtpError(error, { host, envelopeFrom: username, envelopeTo: [], stage: state.stage }),
    };
  }
}

/**
 * 发一封信。**绝不抛异常**。
 *
 * @param {object} options
 * @returns {Promise<{ok: boolean, message: string, stage?: string, response?: string, secure?: boolean}>}
 */
/**
 * 网络层抖动是否值得重试。
 *
 * 实测依据：这台机器的网络对「带微软 OAuth 凭证的 TLS 连接」会间歇性重置
 * （同一令牌连 3 次，前 2 次 ECONNRESET、第 3 次成功）。因此**建连/握手
 * 阶段的失败要重试**；而认证失败（535/534）、地址被拒（501/550）、
 * 被判垃圾邮件（554）重试多少次都一样，直接返回。
 */
export function isRetryableSmtpFailure(result) {
  if (!result || result.ok) return false;
  const message = String(result.message || '');
  // 认证/权限/内容问题：重试无意义
  if (/认证失败|授权码|应用专用密码|OAuth2|InvalidAuthenticationToken|拒绝地址|垃圾邮件|超出|不在允许/.test(message)) {
    return false;
  }
  // 网络层：连接重置、超时、握手被打断
  if (/ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|超时|连接被服务器关闭|disconnected before secure|socket hang up/i.test(message)) {
    return true;
  }
  // 端口/加密方式不匹配属于配置问题，不重试
  if (/STARTTLS|端口|加密方式|明文/.test(message)) return false;
  // 其它落在连接阶段（greeting/ehlo/starttls）的失败按网络抖动处理
  return ['greeting', 'ehlo', 'starttls'].includes(String(result.stage || ''));
}

/** 发一封信（单次尝试）。**绝不抛异常**。 */
export async function smtpSendOnce({
  host,
  port,
  tls: tlsMode,
  allowInsecure = false,
  rejectUnauthorized = true,
  username,
  password,
  accessToken,
  auth = 'basic',
  envelopeFrom,
  envelopeTo,
  rawMessage,
  timeoutMs = SMTP_TIMEOUT_MS,
  connect,
  hostname,
} = {}) {
  if (!host) return { ok: false, message: '未配置 SMTP 服务器' };
  if (!envelopeFrom) return { ok: false, message: '未配置发件人地址' };
  if (!Array.isArray(envelopeTo) || !envelopeTo.length) return { ok: false, message: '没有收件人' };
  const mode = resolveSmtpTls(port, tlsMode);
  if (mode === 'none' && !allowInsecure) {
    return {
      ok: false,
      message: '拒绝用明文连接发送账号密码：请把加密方式改成 ssl（465）或 starttls（587）；'
        + '本地中继需显式设置 allowInsecure',
    };
  }
  let socket;
  try {
    socket = await openSocket({
      host,
      port: Number(port),
      secure: mode === 'ssl',
      timeoutMs,
      connect,
      rejectUnauthorized,
    });
  } catch (error) {
    return { ok: false, message: describeConnectError(error, host, port) };
  }
  const conn = new SmtpConnection(socket, { timeoutMs });
  return runSession(conn, {
    host,
    username,
    password,
    accessToken,
    auth,
    envelopeFrom,
    envelopeTo,
    rawMessage,
    tls: mode,
    allowInsecure,
    rejectUnauthorized,
    hostname,
  });
}

/**
 * 发一封信，网络抖动时自动重试。**绝不抛异常**。
 *
 * @param {object} options smtpSendOnce 的全部参数，另加：
 *   attempts（默认 3）、retryDelayMs（默认 1200）、sleepImpl（测试注入）
 * @returns {Promise<{ok:boolean, message:string, stage?:string, attempts?:number}>}
 */
export async function smtpSend(options = {}) {
  const attempts = Math.min(Math.max(Number(options.attempts) || 3, 1), 6);
  const delay = Number(options.retryDelayMs) || 1200;
  const sleep = typeof options.sleepImpl === 'function'
    ? options.sleepImpl
    : (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  let last = { ok: false, message: 'SMTP 未执行' };
  const tried = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await smtpSendOnce(options);
    if (last.ok) {
      last.attempts = attempt;
      if (attempt > 1) {
        last.message = `${last.message}（第 ${attempt} 次尝试成功，前 ${attempt - 1} 次被网络打断）`;
      }
      return last;
    }
    tried.push(`#${attempt} ${String(last.message).slice(0, 90)}`);
    if (attempt === attempts || !isRetryableSmtpFailure(last)) break;
    await sleep(delay);
  }
  last.attempts = tried.length;
  if (tried.length > 1) {
    last.attemptsDetail = tried;
    last.message = `${last.message}（尝试 ${tried.length} 次均失败）`;
  }
  return last;
}

function describeConnectError(error, host, port) {
  const reason = error?.message || String(error);
  if (/ENOTFOUND|EAI_AGAIN/i.test(reason)) {
    return `找不到 SMTP 服务器 ${host}（检查地址拼写或网络/DNS）`;
  }
  if (/ECONNREFUSED/i.test(reason)) {
    return `连接 ${host}:${port} 被拒绝：服务器/端口不对，或该端口没有开 SMTP 服务`;
  }
  if (/ETIMEDOUT|超时/i.test(reason)) {
    return `连接 ${host}:${port} 超时：网络不通，或防火墙/运营商封了该端口（465/587 常被封）`;
  }
  if (/CERT|SELF_SIGNED|ALTNAME/i.test(reason)) {
    return `TLS 证书校验失败（${host}:${port}）：${reason}。企业自建服务器请让管理员换有效证书，不要把服务商改错`;
  }
  return `连接 ${host}:${port} 失败：${reason}`;
}

/** 把 SMTP 错误翻成能直接照着改的说明。 */
export function describeSmtpError(error, { host = '', envelopeFrom = '', envelopeTo = [], stage = '' } = {}) {
  const code = error?.smtpCode;
  const detail = error?.smtpDetail || '';
  const where = stage ? `（步骤 ${stage}）` : '';
  const envelope = `信封 MAIL FROM:<${envelopeFrom}> → RCPT TO:<${(envelopeTo || []).join('>, <')}>${where}`;
  if (code === 535 || /5\.7\.139/.test(detail)) {
    if (/XOAUTH2|OAUTH/i.test(detail)) {
      return `SMTP 认证失败（535）：这个服务器只接受 OAuth2。请把认证方式改成 oauth2 并完成设备码授权。${detail}`;
    }
    return 'SMTP 认证失败：多数服务商要求「授权码 / 应用专用密码」而不是登录密码；'
      + `Outlook/Hotmail 个人版已关闭 SMTP Basic Auth，请改用 OAuth2 设备码授权。${detail ? `服务器说明：${detail}` : ''}`;
  }
  if (code === 534 || /5\.7\.9/.test(detail)) {
    return `SMTP 要求应用专用密码（${detail || '534'}）：请到邮箱设置里生成「授权码/应用专用密码」再填到 password`;
  }
  if (code === 334 || /invalid_token|InvalidAuthenticationToken|5\.7\.3/i.test(detail)) {
    return `SMTP OAuth2 认证失败：访问令牌无效、过期或权限不足。`
      + `请重新运行 email_oauth（action=start）授权一次。${detail ? `服务器说明：${detail}` : ''}`;
  }
  if (code === 501) {
    return `SMTP 拒绝地址（501）：${detail || '地址格式无效'}。${envelope}。`
      + '请检查发件人/收件人是否为纯 ASCII 邮箱地址（不要带姓名、中文或全角字符）';
  }
  if (code === 550 || code === 553) {
    return `服务器拒收了这封信（${code}）：${detail || '收件人不存在，或发件人不属于该账号'}。${envelope}`;
  }
  if (code === 554 || /spam|5\.7\.1|reputation/i.test(detail)) {
    return `服务器判定为垃圾邮件并拒收（${code}）：${detail || '内容/发信频率被拦'}。`
      + '换一个主题或正文链接密度，或让收件人先把发件人加入白名单';
  }
  if (code === 421 || code === 450 || code === 451 || code === 452) {
    return `服务器暂时不可用（${code}）：${detail || '稍后重试'}。这通常是限流，不是配置错误`;
  }
  if (code) {
    return `SMTP 错误 ${code}：${detail || '无详情'}。${envelope}`;
  }
  const reason = error?.message || String(error);
  if (detail) return `发信失败：${reason}。${detail}${host ? `（${host}）` : ''}`;
  if (/超时/.test(reason)) return `${reason}${host ? `（${host}）` : ''}：检查网络，或换 465/587 端口`;
  return `发信失败：${reason}${host ? `（${host}）` : ''}`;
}
