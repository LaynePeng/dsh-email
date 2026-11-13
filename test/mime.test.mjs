import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeMimeWords, parseHeaders, parseMail, splitMultipart,
} from '../lib/js/mime.js';

const BOUNDARY = 'B1';

function multipartMessage() {
  return [
    'From: =?UTF-8?B?5byg5LiJ?= <zhang@example.com>',
    'To: me@example.com',
    'Subject: =?UTF-8?B?5rWL6K+V6YKu5Lu2?=',
    'Date: Wed, 11 Nov 2026 10:00:00 +0800',
    'Message-ID: <m1@example.com>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
    '',
    `--${BOUNDARY}`,
    `Content-Type: multipart/alternative; boundary="A1"`,
    '',
    '--A1',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('纯文本正文').toString('base64'),
    '',
    '--A1',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('<p>HTML 正文</p>').toString('base64'),
    '',
    '--A1--',
    '',
    `--${BOUNDARY}`,
    'Content-Type: application/pdf; name="=?UTF-8?B?5oql5ZGKLnBkZg==?="',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="=?UTF-8?B?5oql5ZGKLnBkZg==?="',
    '',
    Buffer.from('%PDF-1.4 fake').toString('base64'),
    '',
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n');
}

test('parseMail：multipart/alternative + 附件，中文主题/发件人/附件名', () => {
  const mail = parseMail(multipartMessage());
  assert.equal(mail.subject, '测试邮件');
  assert.equal(mail.from, '张三 <zhang@example.com>');
  assert.equal(mail.to, 'me@example.com');
  assert.equal(mail.text.trim(), '纯文本正文');
  assert.match(mail.html, /HTML 正文/);
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].filename, '报告.pdf');
  assert.equal(mail.attachments[0].contentType, 'application/pdf');
  assert.ok(mail.attachments[0].size > 0);
});

test('parseMail：quoted-printable 与 GBK 字符集', () => {
  const qp = [
    'Subject: qp',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '=E4=BD=A0=E5=A5=BD=0A=E7=AC=AC=E4=BA=8C=E8=A1=8C',
  ].join('\r\n');
  assert.equal(parseMail(qp).text.trim(), '你好\n第二行');

  const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // GBK 的「中文」
  const gbk = [
    'Subject: gbk',
    'Content-Type: text/plain; charset=gbk',
    'Content-Transfer-Encoding: base64',
    '',
    gbkBytes.toString('base64'),
  ].join('\r\n');
  assert.equal(parseMail(gbk).text.trim(), '中文');
});

test('decodeMimeWords：B / Q 两种编码', () => {
  assert.equal(decodeMimeWords('=?UTF-8?B?5L2g5aW9?='), '你好');
  assert.equal(decodeMimeWords('=?UTF-8?Q?=E4=BD=A0=E5=A5=BD?='), '你好');
  // 相邻编码词之间的空白应被忽略
  assert.equal(decodeMimeWords('=?UTF-8?B?5L2g?= =?UTF-8?B?5aW9?='), '你好');
});

test('parseHeaders：折行头部展开', () => {
  const headers = parseHeaders('Subject: hello\r\n world\r\nFrom: a@b.com\r\n');
  assert.equal(headers.subject, 'hello world');
  assert.equal(headers.from, 'a@b.com');
});

test('splitMultipart：缺结束边界时保留最后一段', () => {
  const body = Buffer.from([
    '--B1',
    'Content-Type: text/plain',
    '',
    'hello',
  ].join('\r\n'));
  const parts = splitMultipart(body, 'B1');
  assert.equal(parts.length, 1);
  assert.match(parts[0].toString(), /hello/);
});
