import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildMimeMessage, dotStuff, encodeHeaderValue, htmlToText, prepareAttachments,
  rfc2822Date,
} from '../lib/js/message.js';

test('MIME：中文主题/发件人编码，Bcc 不进头部', () => {
  const built = buildMimeMessage({
    from: { name: '邮件助手', address: 'me@outlook.com' },
    to: [{ name: '张三', address: 'zhang@example.com' }],
    cc: [{ address: 'cc@example.com' }],
    bcc: [{ address: 'secret@example.com' }],
    subject: ' Quarterly Report 报表 ',
    text: '纯文本正文',
    html: '<p>HTML <b>正文</b></p>',
  });
  const raw = built.raw;
  assert.match(raw, /^From: =\?UTF-8\?B\?/m);
  assert.match(raw, /^Subject: .*=\?UTF-8\?B\?/m);
  assert.match(raw, /^To: .*zhang@example\.com/m);
  assert.match(raw, /^Cc: cc@example\.com/m);
  assert.doesNotMatch(raw, /secret@example\.com/, 'Bcc 不能出现在头部');
  assert.match(raw, /multipart\/alternative/);
  assert.match(raw, /Content-Type: text\/html; charset=UTF-8/);
  // 正文 base64 必须能还原
  const textPart = raw.match(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n\r\n--/);
  assert.ok(textPart);
  assert.equal(Buffer.from(textPart[1].replace(/\r\n/g, ''), 'base64').toString('utf8'), '纯文本正文');
  assert.ok(built.size > 0);
  assert.match(built.messageId, /^<[0-9a-f]+@outlook\.com>$/);
});

test('MIME：附件用 multipart/mixed 包裹，文件名 RFC 2231 + ASCII 兜底', () => {
  const built = buildMimeMessage({
    from: { address: 'me@qq.com' },
    to: [{ address: 'a@b.com' }],
    subject: 'attachment',
    text: 'see attached',
    attachments: [{
      filename: '季度报告.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('PDFDATA'),
    }],
  });
  const raw = built.raw;
  assert.match(raw, /Content-Type: multipart\/mixed; boundary=/);
  assert.match(raw, /Content-Type: application\/pdf; name="____\.pdf"/);
  assert.match(raw, /filename\*=UTF-8''%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A\.pdf/);
  assert.match(raw, /\r\n\r\nUERGREFUQQ==/);
  // 嵌套的 alternative 要在 mixed 的第一段里
  assert.match(raw, /--=_mix_[\s\S]*Content-Type: text\/plain; charset=UTF-8/);
});

test('MIME：只有 HTML 时自动补纯文本兜底', () => {
  const built = buildMimeMessage({
    from: { address: 'me@163.com' },
    to: [{ address: 'a@b.com' }],
    subject: 'html only',
    html: '<h1>标题</h1><p>第一段</p>',
  });
  const raw = built.raw;
  assert.match(raw, /multipart\/alternative/);
  assert.ok(raw.includes(Buffer.from('标题\n第一段').toString('base64').slice(0, 8)));
});

test('头部注入会被拒绝（主题里的 CRLF）', () => {
  assert.throws(() => buildMimeMessage({
    from: { address: 'a@b.com' },
    to: [{ address: 'c@d.com' }],
    subject: 'hello\r\nBcc: evil@x.com',
    text: 'x',
  }), /换行符/);
  assert.throws(() => encodeHeaderValue('a\nb'), /换行符/);
});

test('dotStuff：只给行首的点再加一个点', () => {
  const input = 'line1\r\n.hidden\r\n..two\r\nend';
  const output = dotStuff(input);
  assert.equal(output, 'line1\r\n..hidden\r\n...two\r\nend');
});

test('htmlToText：去脚本、块级换行、实体解码', () => {
  const text = htmlToText('<style>p{}</style><p>你好&nbsp;<b>世界</b></p><script>x</script><div>下一行</div>');
  assert.equal(text, '你好 世界\n下一行');
});

test('prepareAttachments：工作区内的文件允许，工作区外拒绝', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-email-ws-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-email-out-'));
  fs.writeFileSync(path.join(workspace, 'report.txt'), 'hello');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');

  const prepared = prepareAttachments(['report.txt'], { workspace });
  assert.equal(prepared.attachments.length, 1);
  assert.equal(prepared.attachments[0].filename, 'report.txt');
  assert.equal(prepared.attachments[0].content.toString(), 'hello');

  assert.throws(() => prepareAttachments([path.join(outside, 'secret.txt')], { workspace }), /不在允许的目录内/);
  assert.throws(() => prepareAttachments(['nope.txt'], { workspace }), /不存在或不可读/);

  // 显式允许额外目录后才可读
  const allowed = prepareAttachments([path.join(outside, 'secret.txt')], {
    workspace, allowDirs: [outside],
  });
  assert.equal(allowed.attachments[0].content.toString(), 'secret');
});

test('rfc2822Date 形如 RFC 2822', () => {
  const text = rfc2822Date(new Date('2026-11-11T08:30:00Z'));
  assert.match(text, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
});

test('长中文主题会折成多段编码词，且能完整还原（回归：曾被误判成头部注入）', async () => {
  const { decodeMimeWords } = await import('../lib/js/mime.js');
  const subject = 'DSH 邮件助手实测（自动回落链路）这是一段更长的中文主题用来触发折行';
  const built = buildMimeMessage({
    from: { name: '邮件助手', address: 'appamail@hotmail.com' },
    to: [{ address: 'appamail@hotmail.com' }],
    subject,
    text: 'body',
  });
  // 主题头应是「Subject: …」+ 合法折行（CRLF + 空格）
  const headerBlock = built.raw.split('\r\n\r\n')[0];
  const headerLines = headerBlock.split('\r\n');
  const start = headerLines.findIndex((line) => line.startsWith('Subject:'));
  assert.ok(start >= 0, '缺少 Subject 头');
  // 从 Subject: 起，连续以空格开头的行都是它的折行续行
  const subjectLines = [headerLines[start]];
  for (const line of headerLines.slice(start + 1)) {
    if (!line.startsWith(' ') && !line.startsWith('\t')) break;
    subjectLines.push(line);
  }
  assert.ok(subjectLines.length >= 2, `长主题应折行，实际：${JSON.stringify(subjectLines)}`);
  const encoded = subjectLines[0].replace(/^Subject:\s*/, '') + subjectLines.slice(1).join('');
  assert.equal(decodeMimeWords(encoded), subject, '折行后的编码词必须能还原成原文');
});

test('长收件人列表折行后依然合法（回归：多个收件人曾被误判）', () => {
  const recipients = Array.from({ length: 8 }, (_, i) => ({
    name: `收件人${i + 1}`, address: `user${i + 1}@example.com`,
  }));
  const built = buildMimeMessage({
    from: { address: 'me@example.com' },
    to: recipients,
    subject: 'many recipients',
    text: 'hi',
  });
  const toHeader = built.raw.split('\r\n\r\n')[0].split('\r\n').filter((line) => line.startsWith('To:') || line.startsWith(' ')).join('\r\n');
  assert.match(toHeader, /\r\n /, '应发生折行');
  for (const recipient of recipients) {
    assert.ok(toHeader.includes(recipient.address), `缺少 ${recipient.address}`);
  }
});

test('折行校验仍拦截真正的头部注入', () => {
  assert.throws(() => buildMimeMessage({
    from: { address: 'a@b.com' },
    to: [{ address: 'c@d.com' }],
    subject: 'x\r\nBcc: evil@x.com',
    text: 'y',
  }), /换行符/);
});
