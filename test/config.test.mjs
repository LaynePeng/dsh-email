import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FIELD_SPECS, SETTINGS_KEYS } from '../lib/config-schema.js';
import { normalizeConfig, sendReadiness, splitAddresses, sanitizeAddress } from '../lib/js/config.js';

test('预设：Outlook 默认 OAuth2 + Graph，QQ 默认授权码 + SSL', () => {
  const outlook = normalizeConfig({ provider: 'outlook', username: 'me@hotmail.com' });
  assert.equal(outlook.auth, 'oauth2');
  assert.equal(outlook.transport, 'graph');
  // 实测 smtp-mail.outlook.com 在 STARTTLS 阶段会被网络重置，主用 office365
  assert.equal(outlook.smtpHost, 'smtp.office365.com');
  assert.equal(outlook.smtpTls, 'starttls');
  assert.deepEqual(outlook.smtpFallbackHosts, ['smtp-mail.outlook.com']);
  assert.equal(outlook.imapHost, 'outlook.office365.com');

  const qq = normalizeConfig({ provider: 'qq', username: 'me@qq.com' });
  assert.equal(qq.auth, 'basic');
  assert.equal(qq.transport, 'smtp');
  assert.equal(qq.smtpHost, 'smtp.qq.com');
  assert.equal(qq.smtpPort, 465);
  assert.equal(qq.smtpTls, 'ssl');
  assert.equal(qq.imapHost, 'imap.qq.com');
});

test('端口与加密方式矛盾时按端口纠正', () => {
  const cfg = normalizeConfig({ provider: 'custom', smtpHost: 'smtp.example.com', smtpPort: 465, smtpTls: 'starttls' });
  assert.equal(cfg.smtpTls, 'ssl');
  assert.ok(cfg.warnings.some((item) => item.includes('465')));
  const cfg2 = normalizeConfig({ provider: 'custom', smtpHost: 'smtp.example.com', smtpPort: 587, smtpTls: 'ssl' });
  assert.equal(cfg2.smtpTls, 'starttls');
});

test('认证/通道冲突会被纠正而不是静默失效', () => {
  const qqOauth = normalizeConfig({ provider: 'qq', auth: 'oauth2' });
  assert.equal(qqOauth.auth, 'basic');
  assert.ok(qqOauth.warnings.some((item) => item.includes('不支持')));

  const graphBasic = normalizeConfig({ provider: 'outlook', auth: 'basic', transport: 'graph' });
  assert.equal(graphBasic.transport, 'smtp');
  assert.ok(graphBasic.warnings.some((item) => item.includes('Graph')));
});

test('环境变量兜底（不覆盖显式配置）', () => {
  const cfg = normalizeConfig({}, {
    env: { DSH_EMAIL_USERNAME: 'env@example.com', DSH_EMAIL_PASSWORD: 'secret' },
  });
  assert.equal(cfg.username, 'env@example.com');
  assert.equal(cfg.password, 'secret');

  const explicit = normalizeConfig({ username: 'ui@example.com', password: 'ui-pass' }, {
    env: { DSH_EMAIL_USERNAME: 'env@example.com', DSH_EMAIL_PASSWORD: 'secret' },
  });
  assert.equal(explicit.username, 'ui@example.com');
  assert.equal(explicit.password, 'ui-pass');
});

test('sendReadiness：缺什么说清楚，不假装已就绪', () => {
  const empty = normalizeConfig({ provider: 'qq' });
  const check = sendReadiness(empty);
  assert.equal(check.ready, false);
  assert.match(check.reason, /邮箱账号/);

  const wrong = normalizeConfig({ provider: 'qq', username: '全角＠qq.com', password: 'x' });
  assert.equal(sendReadiness(wrong).ready, false);

  const ready = normalizeConfig({ provider: 'qq', username: 'me@qq.com', password: 'auth-code' });
  assert.equal(sendReadiness(ready).ready, true);

  const oauth = normalizeConfig({ provider: 'outlook', username: 'me@hotmail.com' });
  assert.equal(sendReadiness(oauth).ready, true);
});

test('地址解析：中英文逗号/分号、数组、全角字符清洗', () => {
  assert.deepEqual(splitAddresses('a@x.com, b@y.com；c@z.com'), ['a@x.com', 'b@y.com', 'c@z.com']);
  assert.deepEqual(splitAddresses(['a@x.com', ' b@y.com ']), ['a@x.com', 'b@y.com']);
  assert.equal(sanitizeAddress('张三 <Zhang@Example.COM>'), 'Zhang@example.com');
  assert.equal(sanitizeAddress('ｍｅ＠ｅｘａｍｐｌｅ．ｃｏｍ'), 'me@example.com');
});

test('设置页字段名与读取层一一对应（防止「能改但不生效」）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-email-cfg-'));
  const cfg = normalizeConfig({
    provider: 'custom',
    auth: 'basic',
    username: 'me@example.com',
    password: 'pw',
    fromName: '助手',
    fromAddress: 'me@example.com',
    transport: 'smtp',
    smtpHost: 'smtp.example.com',
    smtpPort: 2525,
    smtpTls: 'none',
    imapHost: 'imap.example.com',
    imapPort: 1993,
    oauthTenant: 'contoso.onmicrosoft.com',
    oauthClientId: 'client-123',
    oauthScope: 'scope-a scope-b',
    dataDir: tmp,
    maxAttachmentMb: 7,
    allowAttachmentDirs: '/tmp/a;/tmp/b',
    signature: '签名',
    allowInsecure: true,
  });
  assert.equal(cfg.provider, 'custom');
  assert.equal(cfg.password, 'pw');
  assert.equal(cfg.fromName, '助手');
  assert.equal(cfg.smtpHost, 'smtp.example.com');
  assert.equal(cfg.smtpPort, 2525);
  assert.equal(cfg.smtpTls, 'none');
  assert.equal(cfg.imapHost, 'imap.example.com');
  assert.equal(cfg.imapPort, 1993);
  assert.equal(cfg.tenant, 'contoso.onmicrosoft.com');
  assert.equal(cfg.clientId, 'client-123');
  assert.equal(cfg.scope, 'scope-a scope-b');
  assert.equal(cfg.dataDir, tmp);
  assert.equal(cfg.maxAttachmentMb, 7);
  assert.deepEqual(cfg.allowAttachmentDirs, ['/tmp/a', '/tmp/b']);
  assert.equal(cfg.signature, '签名');
  assert.equal(cfg.allowInsecure, true);

  // 每个表单字段都必须出现在 FIELD_SPECS 里（反向：没有多余字段）
  for (const key of SETTINGS_KEYS) {
    assert.ok(FIELD_SPECS.some(([name]) => name === key), `FIELD_SPECS 缺少 ${key}`);
  }
  assert.equal(new Set(SETTINGS_KEYS).size, SETTINGS_KEYS.length);
});

test('惰性配置值（{get}）会被拆开，不会变成 [object Object]', () => {
  const cfg = normalizeConfig({
    provider: { get: () => 'qq' },
    username: { get: () => 'me@qq.com' },
    password: { get: () => 'pw' },
  });
  assert.equal(cfg.provider, 'qq');
  assert.equal(cfg.username, 'me@qq.com');
  assert.equal(cfg.password, 'pw');
});
