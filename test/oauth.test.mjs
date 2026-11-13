import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeConfig } from '../lib/js/config.js';
import {
  explainOAuthError, getAccessToken, oauthConfig, pollDeviceCode, resetTokenCache, startDeviceCode,
} from '../lib/js/oauth.js';
import { GRAPH_SCOPE } from '../lib/js/providers.js';
import { EmailStore } from '../lib/js/store.js';
import { startFakeOAuth } from './helpers/fake-oauth.mjs';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-email-oauth-'));
  const store = new EmailStore(dir);
  store.load();
  return store;
}

test('oauthConfig：transport 决定 scope，租户误填邮箱会被纠正', () => {
  const graph = normalizeConfig({ provider: 'outlook', username: 'me@hotmail.com', transport: 'graph' });
  const conf = oauthConfig(graph);
  assert.equal(conf.tenant, 'common');
  assert.match(conf.scope, /graph\.microsoft\.com\/Mail\.Send/);
  assert.match(conf.deviceUrl, /login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/devicecode/);

  const smtp = normalizeConfig({ provider: 'outlook', username: 'me@hotmail.com', transport: 'smtp' });
  assert.match(oauthConfig(smtp).scope, /outlook\.office\.com\/SMTP\.Send/);
  assert.doesNotMatch(oauthConfig(smtp).scope, /graph\.microsoft\.com/);

  const wrongTenant = normalizeConfig({ provider: 'outlook', oauthTenant: 'me@hotmail.com' });
  assert.equal(wrongTenant.tenant, 'common');
  assert.ok(wrongTenant.warnings.some((item) => item.includes('租户')));
});

test('设备码：申请 → 轮询 pending → done → 保存令牌', async (t) => {
  const oauthServer = await startFakeOAuth({ pollUntilSuccess: 2 });
  t.after(() => oauthServer.close());
  const cfg = normalizeConfig({ provider: 'outlook', username: 'me@hotmail.com' });
  const started = await startDeviceCode(cfg, { deviceUrl: oauthServer.deviceUrl });
  assert.equal(started.ok, true);
  assert.equal(started.userCode, 'ABCD-EFGH');
  assert.equal(started.deviceCode, 'device-code-123');
  assert.match(started.scope, /graph\.microsoft\.com/);

  const pending = await pollDeviceCode(cfg, started.deviceCode, { tokenUrl: oauthServer.tokenUrl });
  assert.equal(pending.status, 'pending');
  const done = await pollDeviceCode(cfg, started.deviceCode, { tokenUrl: oauthServer.tokenUrl });
  assert.equal(done.status, 'done');
  assert.equal(done.refreshToken, 'refresh-token-abc');
  assert.equal(done.accessToken, 'access-token-xyz');

  const store = tempStore();
  store.setAccount('me@hotmail.com', {
    refreshToken: done.refreshToken,
    scope: done.scope,
    tenant: done.tenant,
    transport: done.transport,
  });
  assert.equal(store.account('me@hotmail.com').refreshToken, 'refresh-token-abc');
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.dataDir, 'oauth.json'), 'utf8')).accounts['me@hotmail.com'].refreshToken, 'refresh-token-abc');
  const mode = fs.statSync(path.join(store.dataDir, 'oauth.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('refresh_token 换 access_token 会走内存缓存（不重复请求）', async (t) => {
  resetTokenCache();
  const oauthServer = await startFakeOAuth();
  t.after(() => oauthServer.close());
  const cfg = normalizeConfig({ provider: 'outlook', username: 'me@hotmail.com' });
  const store = tempStore();
  store.setAccount('me@hotmail.com', {
    refreshToken: 'refresh-token-abc',
    scope: oauthConfig(cfg).scope,
    tenant: 'common',
    transport: 'graph',
  });
  // 用本地假端点：把 cfg 的 token 端点改成假服务
  const cfgWithEndpoint = { ...cfg, oauthTokenUrl: oauthServer.tokenUrl };
  resetTokenCache();
  const a = await getAccessToken(cfgWithEndpoint, store);
  assert.equal(a.ok, true, a.message);
  const b = await getAccessToken(cfgWithEndpoint, store);
  assert.equal(b.ok, true);
  assert.equal(oauthServer.state.requests.filter((item) => item.url === '/token').length, 1);
  assert.equal(a.token, 'access-token-xyz-refreshed');
});

test('getAccessToken：scope 与当前通道不一致时要求重新授权', async () => {
  resetTokenCache();
  const cfg = normalizeConfig({ provider: 'outlook', username: 'me@hotmail.com', transport: 'smtp' });
  const store = tempStore();
  store.setAccount('me@hotmail.com', {
    refreshToken: 'refresh-token-abc',
    scope: GRAPH_SCOPE,
    tenant: 'common',
    transport: 'graph',
  });
  const result = await getAccessToken(cfg, store);
  assert.equal(result.ok, false);
  assert.equal(result.needsAuth, true);
  assert.match(result.message, /重新.*授权/);
});

test('scopeSatisfies：offline_access 不算 access_token 必需项，多授权也不拦', async () => {
  const { scopeSatisfies } = await import('../lib/js/oauth.js');
  assert.equal(scopeSatisfies(
    'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read',
    'offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read',
  ), true);
  assert.equal(scopeSatisfies(
    'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/SMTP.Send',
    'offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read',
  ), true);
  assert.equal(scopeSatisfies(
    'https://graph.microsoft.com/Mail.Send',
    'offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read',
  ), false);
});

test('getAccessToken：多授权的 scope 不应阻止使用（只缺必需项才拦）', async (t) => {
  resetTokenCache();
  const oauthServer = await startFakeOAuth();
  t.after(() => oauthServer.close());
  const cfg = normalizeConfig({ provider: 'outlook', username: 'me@hotmail.com', transport: 'graph' });
  const store = tempStore();
  store.setAccount('me@hotmail.com', {
    refreshToken: 'refresh-token-abc',
    // 微软会返回应用已获同意的其它权限，多出来的不该导致拦截
    scope: `${oauthConfig(cfg).scope} https://graph.microsoft.com/SMTP.Send https://graph.microsoft.com/IMAP.AccessAsUser.All`,
    tenant: 'common',
    transport: 'graph',
  });
  const result = await getAccessToken({ ...cfg, oauthTokenUrl: oauthServer.tokenUrl }, store);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.token, 'access-token-xyz-refreshed');
});

test('getAccessToken：refresh_token 被吊销时提示重新授权', async (t) => {
  resetTokenCache();
  const oauthServer = await startFakeOAuth();
  t.after(() => oauthServer.close());
  const cfg = normalizeConfig({ provider: 'outlook', username: 'me@hotmail.com' });
  const store = tempStore();
  store.setAccount('me@hotmail.com', {
    refreshToken: 'revoked',
    scope: oauthConfig(cfg).scope,
    tenant: 'common',
    transport: 'graph',
  });
  const result = await getAccessToken({ ...cfg, oauthTokenUrl: oauthServer.tokenUrl }, store);
  assert.equal(result.ok, false);
  assert.match(result.message, /重新授权/);
});

test('explainOAuthError：常见 AADSTS 码有可读说明', () => {
  assert.match(explainOAuthError({ error: 'invalid_grant', error_description: 'AADSTS70000' }), /重新授权/);
  assert.match(explainOAuthError({ error: 'interaction_required', error_description: 'AADSTS70000' }), /授权被拒/);
  assert.match(explainOAuthError({ error: 'invalid_client' }), /客户端/);
  assert.match(explainOAuthError({ error: 'authorization_pending' }), /等待/);
});
