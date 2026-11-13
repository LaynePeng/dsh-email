import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeConfig } from '../lib/js/config.js';
import { connectImap, resolveTimeWindow, runFolders, runList, runRead, runSearch, snippetOf } from '../lib/js/imap.js';
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

test('IMAP：993 不可用时回退 143 + STARTTLS（实测网络会封 993）', async (t) => {
  const server = await startFakeImap({ starttls: true });
  t.after(() => server.close());
  const cfg = baseConfig(server.port);
  // 主入口指向一个必然失败的端口，备用入口走 143 等价通道
  cfg.imapPort = 1;
  cfg.imapTls = 'ssl';
  cfg.imapFallbacks = [{ port: server.port, tls: 'starttls' }];
  const opened = await connectImap(cfg, tempStore(), {
    connect: ({ host, port, secure }) => {
      // 主入口不通
      if (port === 1) {
        const socket = new net.Socket();
        socket.connecting = true;
        process.nextTick(() => {
          socket.destroy();
          socket.emit('error', Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }));
        });
        return socket;
      }
      // 备用入口用明文连，STARTTLS 由客户端升级
      return net.connect({ host: '127.0.0.1', port });
    },
    rejectUnauthorized: false,
  });
  assert.equal(opened.ok, true, opened.message);
  assert.equal(opened.port, server.port);
  assert.equal(opened.tls, 'starttls');
  assert.equal(server.state.starttlsUsed, true, '应真的走了 STARTTLS');
  assert.match(opened.note || '', /改用/);
  opened.conn.close();
});

test('IMAP：默认候选里包含 143 备用（outlook 预设）', async () => {
  const cfg = normalizeConfig({ provider: 'outlook', username: 'me@hotmail.com' });
  assert.equal(cfg.imapPort, 993);
  assert.equal(cfg.imapTls, 'ssl');
  assert.deepEqual(cfg.imapFallbacks, [{ port: 143, tls: 'starttls' }]);
});

test('IMAP：不信任 SEARCH 顺序（服务器给降序时仍能列出最新邮件）', async (t) => {
  // 让假服务器把 SEARCH 结果反着吐出来（模拟实测遇到的降序服务器）
  const server = await startFakeImap({ reverseSearch: true });
  t.after(() => server.close());
  const cfg = baseConfig(server.port);
  const text = await runList(cfg, tempStore(), { max: 2 }, deps());
  const rows = text.split('\n').filter((line) => /^\| \d+ \|/.test(line));
  assert.equal(rows.length, 2);
  // 最新的是 uid 3（Plain ASCII），应排在第一行
  assert.match(rows[0], /Plain ASCII/);
  assert.match(rows[1], /Weekly report/);
});

test('email_search：中文关键词本地兜底命中（含片段）', async (t) => {
  const server = await startFakeImap();
  t.after(() => server.close());
  const cfg = baseConfig(server.port);
  const text = await runSearch(cfg, tempStore(), { query: '测试邮件' }, deps());
  assert.match(text, /搜索「测试邮件」/);
  assert.match(text, /命中 1 封/);
  assert.match(text, /命中片段/);
  assert.match(text, /这是一封测试邮件/);
});

test('email_search：英文关键词按发件人/正文匹配', async (t) => {
  const server = await startFakeImap();
  t.after(() => server.close());
  const cfg = baseConfig(server.port);
  const bySender = await runSearch(cfg, tempStore(), { query: 'Alice', in: 'from' }, deps());
  assert.match(bySender, /Weekly report/);
  const byBody = await runSearch(cfg, tempStore(), { query: 'Plain body', in: 'body' }, deps());
  assert.match(byBody, /Plain ASCII/);
  const miss = await runSearch(cfg, tempStore(), { query: '不可能存在的词xyz' }, deps());
  assert.match(miss, /没有找到/);
});

test('email_search：无关键词时报错而不是静默返回全部', async (t) => {
  const server = await startFakeImap();
  t.after(() => server.close());
  const text = await runSearch(baseConfig(server.port), tempStore(), {}, deps());
  assert.match(text, /请提供搜索关键词/);
});

test('时间窗口：since/until/days 与服务端条件、本地边界一致', () => {
  const now = new Date('2026-11-13T12:00:00+08:00').getTime();
  const w1 = resolveTimeWindow({ since: '2026-11-01', until: '2026-11-10' }, now);
  assert.equal(w1.criteria.some((c) => c.startsWith('SINCE')), true);
  // until 是「含当天」：本地边界要覆盖到 11-10 23:59:59.999
  const end = new Date(w1.untilMs);
  assert.equal(end.getDate(), 10);
  assert.equal(end.getHours(), 23);
  assert.equal(w1.label, '2026-11-01 ~ 2026-11-10');

  const w2 = resolveTimeWindow({ days: 7 }, now);
  assert.equal(w2.label, '最近 7 天（含今天）');
  assert.ok(w2.sinceMs <= now && w2.sinceMs > now - 8 * 24 * 3600 * 1000);

  const w3 = resolveTimeWindow({}, now);
  assert.equal(w3.label, '不限时间');
  assert.deepEqual(w3.criteria, []);
  // after/before 是别名
  const w4 = resolveTimeWindow({ after: '2026-11-05', before: '2026-11-06' }, now);
  assert.match(w4.label, /2026-11-05 ~ 2026-11-06/);
});

test('email_list：sort=oldest 时最旧在前，时间范围写进结果', async (t) => {
  const server = await startFakeImap();
  t.after(() => server.close());
  const cfg = baseConfig(server.port);
  const text = await runList(cfg, tempStore(), { max: 3, sort: 'oldest' }, deps());
  const rows = text.split('\n').filter((line) => /^\| \d+ \|/.test(line));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /测试邮件|Plain ASCII|Weekly report/);
  assert.match(text, /时间范围：不限时间/);
  assert.match(text, /排序：最旧在前/);
});

test('snippetOf：截取关键词上下文并压平空白', () => {
  const text = '第一行\n\n  这里有  关键词 出现在中间 \n后面还有内容';
  const out = snippetOf(text, '关键词', 10);
  assert.match(out, /关键词/);
  assert.doesNotMatch(out, /\n/);
  assert.equal(snippetOf('无关内容', '关键词'), '');
});
