import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeConfig } from '../lib/js/config.js';
import { oauthConfig } from '../lib/js/oauth.js';
import { renderReceipt, resetGraphCooldown, sendEmail } from '../lib/js/send.js';
import { EmailStore } from '../lib/js/store.js';
import { startFakeOAuth } from './helpers/fake-oauth.mjs';
import { startFakeSmtp } from './helpers/fake-smtp.mjs';

function tempDir(prefix = 'dsh-email-send-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freshStore(dir) {
  resetGraphCooldown();
  const store = new EmailStore(dir);
  store.load();
  return store;
}

function makeStore(dir) {
  const store = new EmailStore(dir);
  store.load();
  return store;
}

test('dry_run：无凭据也能预览，且明确标注未发送', async () => {
  const dir = tempDir();
  const cfg = normalizeConfig({ provider: 'qq', dataDir: dir });
  const result = await sendEmail(cfg, makeStore(dir), {
    to: 'a@b.com', subject: '你好', body: '正文', dry_run: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.match(result.message, /未发送/);
  assert.match(result.message, /a@b\.com/);
  assert.match(result.message, /配置尚不完整/);
});

test('SMTP 发信：附件、Bcc 只进信封、审计落盘', async (t) => {
  const server = await startFakeSmtp({ mechanisms: ['LOGIN'] });
  t.after(() => server.close());
  const workspace = tempDir('dsh-email-ws-');
  fs.writeFileSync(path.join(workspace, '报告.txt'), 'attachment-body');
  const dir = tempDir();
  const cfg = normalizeConfig({
    provider: 'custom',
    auth: 'basic',
    username: 'me@example.com',
    password: 'pw',
    fromName: '邮件助手',
    smtpHost: '127.0.0.1',
    smtpPort: server.port,
    smtpTls: 'none',
    allowInsecure: true,
    dataDir: dir,
    signature: '—— 由 DSH 发送',
  });
  const store = makeStore(dir);
  const result = await sendEmail(cfg, store, {
    to: 'a@b.com',
    bcc: 'secret@b.com',
    subject: '带附件的邮件',
    body: '正文',
    html: '<p>正文</p>',
    attachments: ['报告.txt'],
  }, {
    workspace,
    deps: { connect: ({ host, port }) => net.connect({ host, port }) },
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.transport, 'smtp');
  assert.match(result.messageId, /@example\.com>$/);
  assert.match(result.message, /SMTP 已接收/);
  assert.doesNotMatch(result.message, /已送达/);

  const raw = server.state.data[0];
  assert.doesNotMatch(raw, /^Bcc:/m);
  assert.doesNotMatch(raw, /secret@b\.com/, 'Bcc 地址不能出现在邮件头里');
  assert.match(raw, /^To: a@b\.com/m);
  assert.match(raw, /multipart\/mixed/);
  assert.ok(raw.includes(Buffer.from('attachment-body').toString('base64')));
  // 正文是 base64，解出来再确认签名确实附上了
  const textBlock = raw.match(/Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n\r\n--/);
  assert.ok(textBlock);
  const decodedText = Buffer.from(textBlock[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.match(decodedText, /由 DSH 发送/);

  const rcpt = server.state.commands.filter((line) => line.startsWith('RCPT TO'));
  assert.equal(rcpt.length, 2);
  assert.ok(rcpt.some((line) => line.includes('secret@b.com')));

  const recent = store.recentSends(5);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].ok, true);
  assert.equal(recent[0].subject, '带附件的邮件');
});

test('Graph 发信：令牌续期 + sendMail，审计记录通道', async (t) => {
  const oauthServer = await startFakeOAuth();
  t.after(() => oauthServer.close());
  const dir = tempDir();
  const cfg = normalizeConfig({
    provider: 'outlook',
    username: 'me@hotmail.com',
    transport: 'graph',
    dataDir: dir,
  });
  cfg.oauthTokenUrl = oauthServer.tokenUrl;
  const store = freshStore(dir);
  store.setAccount('me@hotmail.com', {
    refreshToken: 'refresh-token-abc',
    scope: oauthConfig(cfg).scope,
    tenant: 'common',
    transport: 'graph',
  });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (String(url).includes('/token')) return fetch(url, options);
    return {
      ok: true,
      status: 202,
      async text() { return ''; },
      async json() { return {}; },
    };
  };
  const result = await sendEmail(cfg, store, {
    to: 'a@b.com',
    subject: 'Graph 发信',
    body: 'plain',
    html: '<p>html</p>',
  }, { deps: { fetchImpl } });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.transport, 'graph');
  assert.match(result.message, /Microsoft Graph/);
  const sendCall = calls.find((call) => String(call.url).includes('/me/sendMail'));
  assert.ok(sendCall);
  const payload = JSON.parse(sendCall.options.body);
  assert.equal(payload.message.subject, 'Graph 发信');
  assert.equal(payload.message.body.contentType, 'HTML');
  assert.equal(store.recentSends(1)[0].transport, 'graph');
});

test('发信失败会落审计（ok=false），并给出可读原因', async (t) => {
  const server = await startFakeSmtp({ mechanisms: ['LOGIN'], authFail: true });
  t.after(() => server.close());
  const dir = tempDir();
  const cfg = normalizeConfig({
    provider: 'custom',
    auth: 'basic',
    username: 'me@example.com',
    password: 'wrong',
    smtpHost: '127.0.0.1',
    smtpPort: server.port,
    smtpTls: 'none',
    allowInsecure: true,
    dataDir: dir,
  });
  const store = makeStore(dir);
  const result = await sendEmail(cfg, store, {
    to: 'a@b.com', subject: 'x', body: 'y',
  }, { deps: { connect: ({ host, port }) => net.connect({ host, port }) } });
  assert.equal(result.ok, false);
  assert.match(result.message, /认证失败/);
  const recent = store.recentSends(1);
  assert.equal(recent[0].ok, false);
  assert.match(recent[0].detail, /认证失败/);
});

test('附件越界/收件人非法/空主题都会在发送前被拦下', async () => {
  const workspace = tempDir('dsh-email-ws-');
  const outside = tempDir('dsh-email-out-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const dir = tempDir();
  const cfg = normalizeConfig({
    provider: 'custom', auth: 'basic', username: 'me@example.com', password: 'pw',
    smtpHost: 'smtp.example.com', dataDir: dir,
  });
  const store = makeStore(dir);

  const outsideFile = await sendEmail(cfg, store, {
    to: 'a@b.com', subject: 'x', body: 'y', attachments: [path.join(outside, 'secret.txt')],
  }, { workspace });
  assert.equal(outsideFile.ok, false);
  assert.match(outsideFile.message, /不在允许的目录内/);

  const badAddress = await sendEmail(cfg, store, {
    to: '张三 <not-an-email>', subject: 'x', body: 'y',
  }, { workspace });
  assert.equal(badAddress.ok, false);
  assert.match(badAddress.message, /无效邮箱地址/);

  const noSubject = await sendEmail(cfg, store, { to: 'a@b.com', subject: '  ', body: 'y' }, { workspace });
  assert.equal(noSubject.ok, false);
  assert.match(noSubject.message, /主题/);

  const noBody = await sendEmail(cfg, store, { to: 'a@b.com', subject: 'x', body: '' }, { workspace });
  assert.equal(noBody.ok, false);
  assert.match(noBody.message, /正文/);
});

test('Graph 被网络拦（502）时自动回落 SMTP 完成 发送', async (t) => {
  const server = await startFakeSmtp({ mechanisms: ['LOGIN'] });
  t.after(() => server.close());
  const { startFakeOAuth } = await import('./helpers/fake-oauth.mjs');
  const oauthServer = await startFakeOAuth();
  t.after(() => oauthServer.close());

  const dir = tempDir('dsh-email-fb-');
  const cfg = normalizeConfig({
    provider: 'outlook',
    username: 'me@hotmail.com',
    transport: 'graph',
    smtpHost: '127.0.0.1',
    smtpPort: server.port,
    smtpTls: 'none',
    allowInsecure: true,
    dataDir: dir,
  });
  cfg.oauthTokenUrl = oauthServer.tokenUrl;
  const store = freshStore(dir);
  store.setAccount('me@hotmail.com', {
    refreshToken: 'refresh-token-abc',
    scope: 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/SMTP.Send',
    tenant: 'common',
    transport: 'graph',
  });

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).includes('/token')) return fetch(url, options);
    // graph sendMail → 502（网关错误）
    return {
      ok: false,
      status: 502,
      async text() { return JSON.stringify({ error: { code: 'UnknownError', message: '' } }); },
      async json() { return { error: { code: 'UnknownError' } }; },
    };
  };
  const result = await sendEmail(cfg, store, {
    to: 'a@b.com', subject: 'fallback test', body: 'hello',
  }, { deps: { fetchImpl, connect: ({ host, port }) => net.connect({ host, port }) } });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.transport, 'smtp');
  assert.equal(result.summary.fallbackFrom, 'graph');
  assert.equal(server.state.data.length, 1);
  assert.match(result.message, /SMTP 已接收/);
  assert.match(renderReceipt(result), /已自动改走 SMTP/);
});

test('Graph 401（令牌问题）不回落 SMTP：直接报告原因', async (t) => {
  const server = await startFakeSmtp({ mechanisms: ['LOGIN'] });
  t.after(() => server.close());
  const { startFakeOAuth } = await import('./helpers/fake-oauth.mjs');
  const oauthServer = await startFakeOAuth();
  t.after(() => oauthServer.close());

  const dir = tempDir('dsh-email-fb2-');
  const cfg = normalizeConfig({
    provider: 'outlook', username: 'me@hotmail.com', transport: 'graph',
    smtpHost: '127.0.0.1', smtpPort: server.port, smtpTls: 'none', allowInsecure: true, dataDir: dir,
  });
  cfg.oauthTokenUrl = oauthServer.tokenUrl;
  const store = freshStore(dir);
  store.setAccount('me@hotmail.com', {
    refreshToken: 'refresh-token-abc',
    scope: 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/SMTP.Send',
    tenant: 'common', transport: 'graph',
  });
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('/token')) return fetch(url, options);
    return {
      ok: false, status: 401,
      async text() { return JSON.stringify({ error: { code: 'InvalidAuthenticationToken' } }); },
      async json() { return { error: { code: 'InvalidAuthenticationToken' } }; },
    };
  };
  const result = await sendEmail(cfg, store, {
    to: 'a@b.com', subject: 'x', body: 'y',
  }, { deps: { fetchImpl, connect: ({ host, port }) => net.connect({ host, port }) } });
  assert.equal(result.ok, false);
  assert.match(result.message, /401/);
  assert.equal(server.state.data.length, 0, '401 不应触发 SMTP 回落');
});

test('SMTP 主入口握手失败时自动换备用入口（实测 smtp-mail 会被重置）', async (t) => {
  const server = await startFakeSmtp({ mechanisms: ['LOGIN'] });
  t.after(() => server.close());
  const dir = tempDir('dsh-email-host-');
  const cfg = normalizeConfig({
    provider: 'custom', auth: 'basic', username: 'me@example.com', password: 'pw',
    smtpHost: '127.0.0.1', smtpPort: server.port, smtpTls: 'none', allowInsecure: true, dataDir: dir,
  });
  // 模拟「主入口线路不通、备用入口可用」：按 host 区分连接工厂
  cfg.smtpFallbackHosts = ['127.0.0.2'];
  const store = makeStore(dir);
  const result = await sendEmail(cfg, store, {
    to: 'a@b.com', subject: 'host fallback', body: 'hi',
  }, {
    deps: {
      retryDelayMs: 10,
      sleepImpl: async () => {},
      connect: ({ host, port }) => {
        if (host === '127.0.0.1') {
          const socket = new net.Socket();
          socket.connecting = true;
          process.nextTick(() => {
            socket.destroy();
            socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
          });
          return socket;
        }
        return net.connect({ host: '127.0.0.1', port });
      },
    },
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.summary.transport, 'smtp');
  assert.equal(server.state.data.length, 1);
});

test('Graph 失败后进入熔断：下一封直接走 SMTP，不再等 Graph 超时', async (t) => {
  const server = await startFakeSmtp({ mechanisms: ['LOGIN'] });
  t.after(() => server.close());
  const { startFakeOAuth } = await import('./helpers/fake-oauth.mjs');
  const oauthServer = await startFakeOAuth();
  t.after(() => oauthServer.close());
  const dir = tempDir('dsh-email-cb-');
  const cfg = normalizeConfig({
    provider: 'outlook', username: 'me@hotmail.com', transport: 'graph',
    smtpHost: '127.0.0.1', smtpPort: server.port, smtpTls: 'none', allowInsecure: true, dataDir: dir,
  });
  cfg.oauthTokenUrl = oauthServer.tokenUrl;
  const store = freshStore(dir);
  store.setAccount('me@hotmail.com', {
    refreshToken: 'refresh-token-abc',
    scope: 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/SMTP.Send',
    tenant: 'common', transport: 'graph',
  });
  const graphCalls = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('/token')) return fetch(url, options);
    if (String(url).includes('/me/sendMail')) {
      graphCalls.push(url);
      return { ok: false, status: 502, async text() { return '{"error":{"code":"UnknownError"}}'; }, async json() { return {}; } };
    }
    return { ok: true, status: 202, async text() { return ''; }, async json() { return {}; } };
  };
  const deps = { fetchImpl, connect: ({ host, port }) => net.connect({ host, port }) };
  const first = await sendEmail(cfg, store, { to: 'a@b.com', subject: 's1', body: 'x' }, { deps });
  assert.equal(first.ok, true, first.message);
  assert.equal(first.summary.fallbackFrom, 'graph');
  assert.equal(graphCalls.length, 1);

  const second = await sendEmail(cfg, store, { to: 'a@b.com', subject: 's2', body: 'y' }, { deps });
  assert.equal(second.ok, true, second.message);
  assert.equal(graphCalls.length, 1, '熔断期间不应再打 Graph');
  assert.match(second.message, /SMTP/);
  assert.equal(server.state.data.length, 2);
});
