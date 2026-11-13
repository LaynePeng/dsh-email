import assert from 'node:assert/strict';
import test from 'node:test';

import { GRAPH_BASE, graphProbe, graphSend } from '../lib/js/graph.js';

function jsonResponse(payload, status = 200) {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
    async json() { return payload; },
  };
}

function emptyResponse(status = 202) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return ''; },
    async json() { return {}; },
  };
}

function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return handler(url, options, calls.length);
  };
  return { calls, fetchImpl };
}

test('Graph 小附件：一次 sendMail，收件人/抄送/密送与 HTML 正确', async () => {
  const { calls, fetchImpl } = makeFetch(() => emptyResponse(202));
  const result = await graphSend({ username: 'me@hotmail.com' }, {
    to: [{ address: 'a@b.com', name: '张三' }],
    cc: ['c@d.com'],
    bcc: ['secret@d.com'],
    subject: '报表',
    text: 'plain',
    html: '<p>html</p>',
    attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('hi') }],
  }, { accessToken: 'token', fetchImpl });

  assert.equal(result.ok, true, result.message);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${GRAPH_BASE}/me/sendMail`);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.saveToSentItems, true);
  assert.equal(body.message.body.contentType, 'HTML');
  assert.equal(body.message.body.content, '<p>html</p>');
  assert.deepEqual(body.message.toRecipients, [{ emailAddress: { address: 'a@b.com', name: '张三' } }]);
  assert.deepEqual(body.message.ccRecipients, [{ emailAddress: { address: 'c@d.com' } }]);
  assert.deepEqual(body.message.bccRecipients, [{ emailAddress: { address: 'secret@d.com' } }]);
  assert.equal(body.message.attachments[0].name, 'a.txt');
  assert.equal(body.message.attachments[0].contentBytes, Buffer.from('hi').toString('base64'));
  assert.equal(calls[0].options.headers.authorization, 'Bearer token');
});

test('Graph：401/403 有可照着改的说明', async () => {
  const unauthorized = await graphSend({}, {
    to: ['a@b.com'], subject: 'x', text: 'y',
  }, {
    accessToken: 'bad',
    fetchImpl: async () => jsonResponse({ error: { code: 'InvalidAuthenticationToken' } }, 401),
  });
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.message, /email_account（action=authorize）/);

  const forbidden = await graphSend({}, {
    to: ['a@b.com'], subject: 'x', text: 'y',
  }, {
    accessToken: 'bad',
    fetchImpl: async () => jsonResponse({ error: { message: 'Access is denied' } }, 403),
  });
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.message, /权限不足/);
});

test('Graph 大附件：草稿 → 上传会话分片 → 发送（不再走 sendMail）', async () => {
  const big = Buffer.alloc(7 * 1024 * 1024 + 100, 0x41);
  const { calls, fetchImpl } = makeFetch((url, options) => {
    if (url.endsWith('/me/messages')) return jsonResponse({ id: 'draft-1' }, 201);
    if (url.endsWith('/attachments/createUploadSession')) {
      return jsonResponse({ uploadUrl: 'https://upload.example/session-1' });
    }
    if (url === 'https://upload.example/session-1') return emptyResponse(201);
    if (url.endsWith('/me/messages/draft-1/send')) return emptyResponse(202);
    return emptyResponse(201);
  });

  const result = await graphSend({}, {
    to: ['a@b.com'],
    subject: 'big',
    text: 'see attached',
    attachments: [{ filename: 'big.bin', contentType: 'application/octet-stream', content: big }],
  }, { accessToken: 'token', fetchImpl });

  assert.equal(result.ok, true, result.message);
  assert.ok(calls.some((call) => call.url.endsWith('/me/sendMail')) === false);
  const session = calls.find((call) => call.url.endsWith('/attachments/createUploadSession'));
  assert.equal(JSON.parse(session.options.body).AttachmentItem.size, big.length);
  const puts = calls.filter((call) => call.url === 'https://upload.example/session-1');
  assert.ok(puts.length >= 2);
  let total = 0;
  for (const put of puts) {
    const range = put.options.headers['content-range'];
    const match = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    assert.ok(match, `content-range 格式错误：${range}`);
    assert.equal(Number(match[3]), big.length);
    total += Number(match[2]) - Number(match[1]) + 1;
    assert.equal(put.options.body.length, Number(match[2]) - Number(match[1]) + 1);
  }
  assert.equal(total, big.length);
  assert.ok(calls.some((call) => call.url.endsWith('/me/messages/draft-1/send')));
});

test('Graph 大附件：上传失败会清理草稿', async () => {
  const big = Buffer.alloc(3 * 1024 * 1024 + 100, 0x42);
  const deleted = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/me/messages')) return jsonResponse({ id: 'draft-2' }, 201);
    if (url.endsWith('/attachments/createUploadSession')) {
      return jsonResponse({ uploadUrl: 'https://upload.example/session-2' });
    }
    if (url === 'https://upload.example/session-2') {
      return jsonResponse({ error: { message: 'upload failed' } }, 500);
    }
    if (options?.method === 'DELETE') {
      deleted.push(url);
      return emptyResponse(204);
    }
    return emptyResponse(202);
  };
  const result = await graphSend({}, {
    to: ['a@b.com'], subject: 'big', text: 'x',
    attachments: [{ filename: 'big.bin', content: big }],
  }, { accessToken: 'token', fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.message, /上传附件/);
  assert.deepEqual(deleted, [`${GRAPH_BASE}/me/messages/draft-2`]);
});

test('Graph 探针：能区分「令牌有效」与「网络到不了 Graph」', async () => {
  const ok = await graphProbe({}, 'token', {
    fetchImpl: async () => jsonResponse({ value: [{ id: 'inbox', displayName: 'Inbox' }] }),
  });
  assert.equal(ok.ok, true);
  assert.match(ok.message, /只读访问成功/);

  const down = await graphProbe({}, 'token', {
    fetchImpl: async () => jsonResponse({ error: { code: 'UnknownError', message: '' } }, 502),
  });
  assert.equal(down.ok, false);
  assert.equal(down.status, 502);
  assert.match(down.message, /网关错误/);
  assert.match(down.message, /graph\.microsoft\.com/);
});

test('Graph 发信：502 给出网络/代理提示，而不是只说 UnknownError', async () => {
  const result = await graphSend({}, { to: ['a@b.com'], subject: 'x', text: 'y' }, {
    accessToken: 'token',
    fetchImpl: async () => jsonResponse({ error: { code: 'UnknownError', message: '' } }, 502),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /网络\/代理|网关错误/);
});
