import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { isRetryableSmtpFailure, smtpProbe, smtpSend } from '../lib/js/smtp.js';
import { startFakeSmtp } from './helpers/fake-smtp.mjs';

const RAW = [
  'From: me@example.com',
  'To: a@b.com',
  'Subject: hi',
  '',
  'line1',
  '.leading dot',
  'end',
].join('\r\n');

test('SMTP：密码登录 + DATA + 点转义 + 多收件人', async (t) => {
  const server = await startFakeSmtp({ mechanisms: ['LOGIN', 'PLAIN'] });
  t.after(() => server.close());
  const result = await smtpSend({
    host: '127.0.0.1',
    port: server.port,
    tls: 'none',
    allowInsecure: true,
    auth: 'basic',
    username: 'me@example.com',
    password: 'app-password',
    envelopeFrom: 'me@example.com',
    envelopeTo: ['a@b.com', 'secret@b.com'],
    rawMessage: RAW,
  });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /SMTP 已接收/);
  assert.equal(server.state.commands.filter((line) => line.startsWith('RCPT TO')).length, 2);
  assert.ok(server.state.commands.includes('MAIL FROM:<me@example.com>'));
  const received = server.state.data[0];
  assert.match(received, /^From: me@example\.com/m);
  // 点转义：客户端发 `..leading dot`，服务器还原成 `.leading dot`
  assert.match(received, /^\.leading dot$/m);
  // 密码以 base64 传输，不在命令里明文出现
  assert.ok(!server.state.commands.join('\n').includes('app-password'));
});

test('SMTP：XOAUTH2 载荷格式与成功应答', async (t) => {
  const server = await startFakeSmtp({ mechanisms: ['XOAUTH2'] });
  t.after(() => server.close());
  const result = await smtpSend({
    host: '127.0.0.1',
    port: server.port,
    tls: 'none',
    allowInsecure: true,
    auth: 'oauth2',
    username: 'me@outlook.com',
    accessToken: 'token-123',
    envelopeFrom: 'me@outlook.com',
    envelopeTo: ['a@b.com'],
    rawMessage: RAW,
  });
  assert.equal(result.ok, true, result.message);
  const payload = Buffer.from(server.state.authPayloads[0], 'base64').toString('utf8');
  assert.equal(payload, 'user=me@outlook.com\x01auth=Bearer token-123\x01\x01');
});

test('SMTP：认证失败给出授权码/OAuth 提示', async (t) => {
  const server = await startFakeSmtp({ mechanisms: ['LOGIN'], authFail: true });
  t.after(() => server.close());
  const result = await smtpSend({
    host: '127.0.0.1',
    port: server.port,
    tls: 'none',
    allowInsecure: true,
    auth: 'basic',
    username: 'me@qq.com',
    password: 'wrong',
    envelopeFrom: 'me@qq.com',
    envelopeTo: ['a@b.com'],
    rawMessage: RAW,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /认证失败/);
  assert.match(result.message, /授权码|应用专用密码|OAuth2/);
});

test('SMTP：STARTTLS 未被声明时明确报错（而不是静默明文）', async (t) => {
  const server = await startFakeSmtp({ mechanisms: ['LOGIN'] });
  t.after(() => server.close());
  const result = await smtpSend({
    host: '127.0.0.1',
    port: server.port,
    tls: 'starttls',
    auth: 'basic',
    username: 'me@qq.com',
    password: 'x',
    envelopeFrom: 'me@qq.com',
    envelopeTo: ['a@b.com'],
    rawMessage: RAW,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /STARTTLS/);
});

test('SMTP：拒绝在没有 TLS 的连接上发密码', async () => {
  const result = await smtpSend({
    host: '127.0.0.1',
    port: 1,
    tls: 'none',
    auth: 'basic',
    username: 'me@qq.com',
    password: 'x',
    envelopeFrom: 'me@qq.com',
    envelopeTo: ['a@b.com'],
    rawMessage: RAW,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /明文/);
});

test('SMTP：STARTTLS 升级后重新 EHLO 并完成认证（自签证书）', async (t) => {
  let server;
  try {
    server = await startFakeSmtp({ starttls: true, mechanisms: ['LOGIN'] });
  } catch (error) {
    t.skip(`openssl 不可用，跳过 STARTTLS 实测：${error.message}`);
    return;
  }
  t.after(() => server.close());
  const result = await smtpSend({
    host: '127.0.0.1',
    port: server.port,
    tls: 'starttls',
    rejectUnauthorized: false,
    auth: 'basic',
    username: 'me@qq.com',
    password: 'auth-code',
    envelopeFrom: 'me@qq.com',
    envelopeTo: ['a@b.com'],
    rawMessage: RAW,
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(server.state.secure, true);
  assert.ok(server.state.commands.filter((line) => line.startsWith('EHLO')).length >= 2);
});

test('SMTP：隐式 TLS（465）连接与认证', async (t) => {
  let server;
  try {
    server = await startFakeSmtp({ tls: true, mechanisms: ['LOGIN'] });
  } catch (error) {
    t.skip(`openssl 不可用，跳过 TLS 实测：${error.message}`);
    return;
  }
  t.after(() => server.close());
  const result = await smtpSend({
    host: '127.0.0.1',
    port: server.port,
    tls: 'ssl',
    rejectUnauthorized: false,
    auth: 'basic',
    username: 'me@qq.com',
    password: 'auth-code',
    envelopeFrom: 'me@qq.com',
    envelopeTo: ['a@b.com'],
    rawMessage: RAW,
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.secure, true);
});

test('SMTP：probe 只验证登录，不发信', async (t) => {
  const server = await startFakeSmtp({ mechanisms: ['LOGIN'] });
  t.after(() => server.close());
  const result = await smtpProbe({
    host: '127.0.0.1',
    port: server.port,
    tls: 'none',
    allowInsecure: true,
    auth: 'basic',
    username: 'me@example.com',
    password: 'x',
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(server.state.data.length, 0);
  assert.ok(server.state.commands.some((line) => line.startsWith('AUTH LOGIN')));
});

test('SMTP 重试：网络断开时重试到成功（实测网络会间歇重置）', async (t) => {
  const server = await startFakeSmtp({ mechanisms: ['LOGIN'] });
  t.after(() => server.close());

  let calls = 0;
  // 前两次建连就失败（模拟 ECONNRESET），第三次走真实服务器
  const connect = ({ host, port }) => {
    calls += 1;
    if (calls <= 2) {
      const socket = new net.Socket();
      socket.connecting = true;
      process.nextTick(() => {
        socket.destroy();
        socket.emit('error', Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' }));
      });
      return socket;
    }
    return net.connect({ host, port });
  };

  const result = await smtpSend({
    host: '127.0.0.1', port: server.port, tls: 'none', allowInsecure: true,
    auth: 'basic', username: 'me@example.com', password: 'pw',
    envelopeFrom: 'me@example.com', envelopeTo: ['a@b.com'],
    rawMessage: RAW, connect, retryDelayMs: 10, sleepImpl: async () => {},
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.attempts, 3);
  assert.match(result.message, /第 3 次尝试成功/);
  assert.equal(server.state.data.length, 1);
});

test('SMTP 重试：认证失败不重试（省时间）', async (t) => {
  const server = await startFakeSmtp({ mechanisms: ['LOGIN'], authFail: true });
  t.after(() => server.close());
  let attempts = 0;
  const result = await smtpSend({
    host: '127.0.0.1', port: server.port, tls: 'none', allowInsecure: true,
    auth: 'basic', username: 'me@example.com', password: 'wrong',
    envelopeFrom: 'me@example.com', envelopeTo: ['a@b.com'],
    rawMessage: RAW,
    connect: ({ host, port }) => { attempts += 1; return net.connect({ host, port }); },
    retryDelayMs: 10, sleepImpl: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(attempts, 1, '认证失败只应尝试一次');
  assert.match(result.message, /认证失败/);
});

test('isRetryableSmtpFailure：只对网络层失败返回 true', () => {
  assert.equal(isRetryableSmtpFailure({ ok: false, message: 'ECONNRESET', stage: 'ehlo' }), true);
  assert.equal(isRetryableSmtpFailure({ ok: false, message: '发信失败：连接被服务器关闭', stage: 'greeting' }), true);
  assert.equal(isRetryableSmtpFailure({ ok: false, message: 'SMTP 认证失败：请用授权码', stage: 'auth' }), false);
  assert.equal(isRetryableSmtpFailure({ ok: false, message: 'STARTTLS 未声明', stage: 'starttls' }), false);
  assert.equal(isRetryableSmtpFailure({ ok: true }), false);
});
