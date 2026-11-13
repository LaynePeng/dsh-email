/**
 * 测试用假 OAuth 令牌服务：模拟微软设备码 + 令牌端点。
 *
 * 只实现协议里我们用到的那几条：devicecode、device_code 轮询、refresh_token。
 */

import http from 'node:http';

export async function startFakeOAuth(options = {}) {
  const {
    pollUntilSuccess = 2,
    expiresIn = 3600,
    refreshFails = false,
  } = options;
  const state = {
    requests: [],
    polls: 0,
    deviceCode: 'device-code-123',
    refreshToken: 'refresh-token-abc',
    accessToken: 'access-token-xyz',
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      state.requests.push({ url: req.url, params: Object.fromEntries(params) });
      const json = (payload, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/devicecode') {
        json({
          device_code: state.deviceCode,
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 1,
          message: 'To sign in, use a web browser',
        });
        return;
      }
      if (req.url === '/token') {
        const grant = params.get('grant_type');
        if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
          state.polls += 1;
          if (state.polls < pollUntilSuccess) {
            json({ error: 'authorization_pending' });
            return;
          }
          json({
            access_token: state.accessToken,
            refresh_token: state.refreshToken,
            expires_in: expiresIn,
            scope: params.get('scope') || 'offline_access',
            token_type: 'Bearer',
          });
          return;
        }
        if (grant === 'refresh_token') {
          if (refreshFails || params.get('refresh_token') === 'revoked') {
            json({ error: 'invalid_grant', error_description: 'AADSTS70000: token revoked' }, 400);
            return;
          }
          json({
            access_token: `${state.accessToken}-refreshed`,
            expires_in: expiresIn,
            scope: params.get('scope') || '',
          });
          return;
        }
        json({ error: 'unsupported_grant_type' }, 400);
        return;
      }
      json({ error: 'not_found' }, 404);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    state,
    base,
    deviceUrl: `${base}/devicecode`,
    tokenUrl: `${base}/token`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
