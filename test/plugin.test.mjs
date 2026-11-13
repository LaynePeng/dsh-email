import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply, toolNames } from '../lib/plugin.js';
import { startFakeOAuth } from './helpers/fake-oauth.mjs';
import { startFakeSmtp } from './helpers/fake-smtp.mjs';

function tempDir(prefix = 'dsh-email-plugin-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeCtx() {
  const registered = new Map();
  const prompts = [];
  const ctx = {
    tools: { register(definition) { registered.set(definition.name, definition); } },
    systemPrompt: { context(payload) { prompts.push(payload); } },
    inject() {},
  };
  return { ctx, registered, prompts };
}

async function call(registered, name, args = {}, exec = {}) {
  const tool = registered.get(name);
  assert.ok(tool, `工具 ${name} 没有注册`);
  return tool.execute(args, exec);
}

test('注册全部工具并注入用法说明', () => {
  const dir = tempDir();
  const { ctx, registered, prompts } = makeCtx();
  apply(ctx, { provider: 'qq', username: 'me@qq.com', password: 'x', dataDir: dir });
  assert.deepEqual([...registered.keys()].sort(), [...toolNames()].sort());
  // 刻意保持精简：工具越多，每轮系统提示词里要带的 schema 越多
  assert.equal(registered.size, 3);
  assert.deepEqual([...registered.keys()].sort(), ['email_account', 'email_mailbox', 'email_send']);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].text, /dry_run/);
  assert.match(prompts[0].text, /已送达/);
  // 每个工具都要有可读描述与参数 schema
  for (const tool of registered.values()) {
    assert.ok(tool.description.length > 20, `${tool.name} 描述太短`);
    assert.equal(tool.parameters.type, 'object');
  }
});

test('email_send(dry_run)：返回草稿预览，不联网', async () => {
  const dir = tempDir();
  const { ctx, registered } = makeCtx();
  apply(ctx, {
    provider: 'qq', username: 'me@qq.com', password: 'auth-code', dataDir: dir,
  });
  const text = await call(registered, 'email_send', {
    to: 'a@b.com', subject: '测试', body: '正文', dry_run: true,
  });
  assert.match(text, /邮件草稿/);
  assert.match(text, /未发送/);
  assert.match(text, /a@b\.com/);
});

test('email_account(status) 在未授权时给出明确下一步', async () => {
  const dir = tempDir();
  const { ctx, registered } = makeCtx();
  apply(ctx, { provider: 'outlook', username: 'me@hotmail.com', dataDir: dir });

  const status = await call(registered, 'email_account', { action: 'status', probe: false });
  assert.match(status, /邮件状态/);
  assert.match(status, /尚未授权/);
  assert.match(status, /email_oauth/);
  assert.doesNotMatch(status, /已送达/);

  const oauth = await call(registered, 'email_account', { action: 'status' });
  assert.match(oauth, /尚未授权/);
});

test('email_account：authorize → poll 端到端保存 refresh_token', async (t) => {
  const oauthServer = await startFakeOAuth({ pollUntilSuccess: 1 });
  t.after(() => oauthServer.close());
  const previous = {
    device: process.env.DSH_EMAIL_OAUTH_DEVICE_URL,
    token: process.env.DSH_EMAIL_OAUTH_TOKEN_URL,
  };
  process.env.DSH_EMAIL_OAUTH_DEVICE_URL = oauthServer.deviceUrl;
  process.env.DSH_EMAIL_OAUTH_TOKEN_URL = oauthServer.tokenUrl;
  t.after(() => {
    if (previous.device === undefined) delete process.env.DSH_EMAIL_OAUTH_DEVICE_URL;
    else process.env.DSH_EMAIL_OAUTH_DEVICE_URL = previous.device;
    if (previous.token === undefined) delete process.env.DSH_EMAIL_OAUTH_TOKEN_URL;
    else process.env.DSH_EMAIL_OAUTH_TOKEN_URL = previous.token;
  });

  const dir = tempDir();
  const { ctx, registered } = makeCtx();
  apply(ctx, {
    provider: 'outlook', username: 'me@hotmail.com', transport: 'graph', dataDir: dir,
  });

  const started = await call(registered, 'email_account', { action: 'authorize' });
  assert.match(started, /ABCD-EFGH/);
  assert.match(started, /microsoft\.com\/devicelogin/);

  // 再次 start 不应换码（同一设备码只能轮询）
  const again = await call(registered, 'email_account', { action: 'authorize' });
  assert.match(again, /ABCD-EFGH/);
  assert.equal(oauthServer.state.requests.filter((item) => item.url === '/devicecode').length, 1);

  const polled = await call(registered, 'email_account', { action: 'poll', wait_seconds: 5 });
  assert.match(polled, /授权成功/);

  const storeFile = path.join(dir, 'oauth.json');
  const saved = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  assert.equal(saved.accounts['me@hotmail.com'].refreshToken, 'refresh-token-abc');
  assert.equal(saved.pending, null);
  assert.equal(fs.statSync(storeFile).mode & 0o777, 0o600);

  const status = await call(registered, 'email_account', { action: 'status' });
  assert.match(status, /已授权/);

  const logout = await call(registered, 'email_account', { action: 'logout' });
  assert.match(logout, /已清除/);
  const after = await call(registered, 'email_account', { action: 'status' });
  assert.match(after, /尚未授权/);
});

test('email_account：非 Outlook 账号拒绝设备码授权', async () => {
  const dir = tempDir();
  const { ctx, registered } = makeCtx();
  apply(ctx, { provider: 'qq', username: 'me@qq.com', password: 'x', dataDir: dir });
  const text = await call(registered, 'email_account', { action: 'authorize' });
  assert.match(text, /\[Error\]/);
  assert.match(text, /Microsoft|outlook/);
});

test('email_mailbox(folders)：未配置 IMAP 时给出可操作提示', async () => {
  const dir = tempDir();
  const { ctx, registered } = makeCtx();
  // 用 custom 且不填 imapHost：避免单测真的去连邮箱服务器
  apply(ctx, {
    provider: 'custom', username: 'me@example.com', password: 'x',
    smtpHost: 'smtp.example.com', dataDir: dir,
  });
  const text = await call(registered, 'email_mailbox', { action: 'folders' });
  assert.match(text, /未配置 IMAP 服务器/);
});

test('email_send 正式发送 + email_account(probe) 走真实 SMTP 对话', async (t) => {
  const server = await startFakeSmtp({ mechanisms: ['LOGIN'] });
  t.after(() => server.close());
  const dir = tempDir();
  const { ctx, registered } = makeCtx();
  apply(ctx, {
    provider: 'custom',
    auth: 'basic',
    username: 'me@example.com',
    password: 'pw',
    smtpHost: '127.0.0.1',
    smtpPort: server.port,
    smtpTls: 'none',
    allowInsecure: true,
    dataDir: dir,
  });

  const sent = await call(registered, 'email_send', {
    to: 'a@b.com', subject: '来自插件', body: '正文',
  });
  assert.match(sent, /邮件已被/);
  assert.match(sent, /服务器应答/);
  assert.equal(server.state.data.length, 1);
  assert.match(server.state.data[0], /^Subject: =\?UTF-8\?B\?/m);

  const probe = await call(registered, 'email_account', { action: 'status', probe: true });
  assert.match(probe, /联网自检/);
  assert.match(probe, /SMTP 登录成功/);
  // probe 不会额外发信
  assert.equal(server.state.data.length, 1);
});

test('合并后的工具按 action 正确分派（不再有 7 个独立工具）', async () => {
  const dir = tempDir();
  const { ctx, registered } = makeCtx();
  apply(ctx, { provider: 'custom', username: 'me@example.com', password: 'x', smtpHost: 'smtp.example.com', dataDir: dir });

  // 未知 action 要明确报错，而不是静默当成默认动作
  const badMailbox = await call(registered, 'email_mailbox', { action: 'nope' });
  assert.match(badMailbox, /未知 action/);
  assert.match(badMailbox, /list \/ search \/ read \/ folders/);

  const badAccount = await call(registered, 'email_account', { action: 'nope' });
  assert.match(badAccount, /未知 action/);
  assert.match(badAccount, /status \/ authorize/);

  // 不传 action 时 mailbox 默认 list、account 默认 status
  const mailboxDefault = await call(registered, 'email_mailbox', {});
  assert.match(mailboxDefault, /未配置 IMAP 服务器|INBOX/);
  const accountDefault = await call(registered, 'email_account', {});
  assert.match(accountDefault, /邮件状态/);
});
