import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeConfig } from '../lib/js/config.js';
import { connectImap, runFolders, runList, runRead } from '../lib/js/imap.js';
import { EmailStore } from '../lib/js/store.js';
import { startFakeImap } from './helpers/fake-imap.mjs';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-email-imap-'));
  const store = new EmailStore(dir);
  store.load();
  return store;
}

function baseConfig(port, extra = {}) {
  return normalizeConfig({
    provider: 'custom',
    auth: 'basic',
    username: 'me@example.com',
    password: 'app-password',
    smtpHost: 'smtp.example.com',
    imapHost: '127.0.0.1',
    imapPort: port,
    ...extra,
  });
}

const deps = () => ({
  connect: ({ host, port }) => net.connect({ host, port }),
});

test('IMAP：LOGIN + SELECT + SEARCH + FETCH 头部', async (t) => {
  const server = await startFakeImap();
  t.after(() => server.close());
  const cfg = baseConfig(server.port);
  const text = await runList(cfg, tempStore(), { max: 10 }, deps());
  assert.match(text, /共 3 封/);
  assert.match(text, /测试邮件/);
  assert.match(text, /张三/);
  assert.match(text, /Weekly report/);
  assert.match(text, /\| UID \|/);
  assert.ok(server.state.commands.some((line) => /^A\d+ LOGIN "me@example\.com"/.test(line)));
  assert.ok(server.state.commands.some((line) => /UID SEARCH ALL/.test(line)));
});

test('IMAP：读单封完整正文与附件清单', async (t) => {
  const server = await startFakeImap();
  t.after(() => server.close());
  const cfg = baseConfig(server.port);
  const text = await runRead(cfg, tempStore(), { uid: '1', folder: 'INBOX' }, deps());
  assert.match(text, /# 测试邮件/);
  assert.match(text, /发件人：张三 <zhang@example\.com>/);
  assert.match(text, /这是一封测试邮件/);
  assert.match(text, /报告\.pdf/);
  assert.match(text, /application\/pdf/);
  assert.match(text, /Message-ID：<m1@example\.com>/);
});

test('IMAP：列文件夹（含 UTF-7 解码的中文名）与未读数', async (t) => {
  const server = await startFakeImap();
  t.after(() => server.close());
  const cfg = baseConfig(server.port);
  const text = await runFolders(cfg, tempStore(), {}, deps());
  assert.match(text, /INBOX/);
  assert.match(text, /Sent/);
  assert.match(text, /收件箱/);
  assert.match(text, /未读/);
});

test('IMAP：XOAUTH2 登录走 access_token', async (t) => {
  const server = await startFakeImap();
  t.after(() => server.close());
  const { startFakeOAuth } = await import('./helpers/fake-oauth.mjs');
  const oauthServer = await startFakeOAuth();
  t.after(() => oauthServer.close());

  const cfg = baseConfig(server.port, {
    provider: 'outlook',
    auth: 'oauth2',
    imapHost: '127.0.0.1',
    imapPort: server.port,
    transport: 'smtp',
    oauthTokenUrl: oauthServer.tokenUrl,
  });
  const store = tempStore();
  // 记录里的 scope 必须与当前 transport 一致，否则会先被判定为「需要重新授权」
  const { oauthConfig } = await import('../lib/js/oauth.js');
  store.setAccount('me@example.com', {
    refreshToken: 'refresh-token-abc',
    scope: oauthConfig(cfg).scope,
    tenant: 'common',
    transport: 'smtp',
  });
  const opened = await connectImap(cfg, store, deps());
  assert.equal(opened.ok, true, opened.message);
  opened.conn.close();
  const payload = Buffer.from(server.state.authPayloads[0], 'base64').toString('utf8');
  assert.match(payload, /^user=me@example\.com\x01auth=Bearer /);
});

test('IMAP：认证失败给出授权码提示', async (t) => {
  const server = await startFakeImap({ authFail: true });
  t.after(() => server.close());
  const cfg = baseConfig(server.port);
  const text = await runList(cfg, tempStore(), {}, deps());
  assert.match(text, /IMAP 登录失败/);
  assert.match(text, /授权码|OAuth2/);
});

test('IMAP：未配置 imapHost 时明确提示（发信不受影响）', async () => {
  const cfg = normalizeConfig({
    provider: 'custom', auth: 'basic', username: 'me@example.com', password: 'x', smtpHost: 'smtp.example.com',
  });
  const text = await runList(cfg, tempStore(), {}, {});
  assert.match(text, /未配置 IMAP 服务器/);
});
