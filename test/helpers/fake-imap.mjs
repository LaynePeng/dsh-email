/**
 * 测试用本地假 IMAP 服务器：按 tag 应答，支持 literal（`{n}`）。
 *
 * 覆盖读信真正会走的命令：LOGIN / AUTHENTICATE XOAUTH2 / SELECT / UID SEARCH /
 * UID FETCH（头、全文、部分正文）/ LIST / STATUS / LOGOUT。
 */

import net from 'node:net';
import tls from 'node:tls';

const MESSAGES = [
  {
    uid: 1,
    subject: '=?UTF-8?B?5rWL6K+V6YKu5Lu2?=',
    from: '=?UTF-8?B?5byg5LiJ?= <zhang@example.com>',
    body: '这是一封测试邮件',
    seen: false,
    size: 2048,
  },
  {
    uid: 2,
    subject: 'Weekly report',
    from: 'Alice <alice@example.com>',
    body: 'Hello from Alice',
    seen: true,
    size: 1024,
  },
  {
    uid: 3,
    subject: 'Plain ASCII',
    from: 'Bob <bob@example.com>',
    body: 'Plain body',
    seen: true,
    size: 512,
  },
];

function headerOf(message, { onlyFields = false } = {}) {
  const lines = [
    `From: ${message.from}`,
    'To: me@example.com',
    `Subject: ${message.subject}`,
    'Date: Wed, 11 Nov 2026 10:00:00 +0800',
    `Message-ID: <m${message.uid}@example.com>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B1"',
  ];
  if (onlyFields) {
    // BODY[HEADER.FIELDS (...)] 只返回被请求的字段 + 空行
    return `${lines.slice(0, 5).join('\r\n')}\r\n\r\n`;
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function fullMessage(message) {
  const boundary = 'B1';
  const attachmentName = '=?UTF-8?B?5oql5ZGKLnBkZg==?=';
  return [
    headerOf(message).trimEnd(),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(message.body).toString('base64'),
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${attachmentName}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachmentName}"`,
    '',
    Buffer.from('%PDF-1.4 fake').toString('base64'),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function textPartOf(message) {
  return [
    `--B1`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(message.body).toString('base64'),
    '',
    `--B1`,
    'Content-Type: application/octet-stream',
    'Content-Transfer-Encoding: base64',
    '',
    '',
  ].join('\r\n');
}

function quoted(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export async function startFakeImap({ authFail = false, starttls = false } = {}) {
  const state = { commands: [], logins: [], authPayloads: [] };
  let secureContext = null;
  let certDir = null;
  if (starttls) {
    const { makeSelfSignedCert } = await import('./fake-smtp.mjs');
    const cert = makeSelfSignedCert();
    secureContext = tls.createSecureContext({ key: cert.key, cert: cert.cert });
    certDir = cert.dir;
  }
  const server = net.createServer((rawSocket) => {
    let socket = rawSocket;
    let buffer = '';
    const waiters = [];
    const attach = () => {
      socket.on('data', onData);
      socket.on('error', () => {});
    };
    const detach = () => {
      socket.removeListener('data', onData);
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        index = buffer.indexOf('\r\n');
      }
    };
    const readLine = () => new Promise((resolve) => waiters.push(resolve));
    const write = (text) => socket.write(text);
    attach();

    (async () => {
      write('* OK [CAPABILITY IMAP4rev1 AUTH=XOAUTH2] fake IMAP ready\r\n');
      for (;;) {
        const line = await readLine();
        if (line === undefined) return;
        state.commands.push(line);
        const [tag, commandRaw] = line.split(' ');
        const command = (commandRaw || '').toUpperCase();
        const rest = line.slice((tag || '').length + (commandRaw || '').length + 2);

        if (command === 'STARTTLS') {
          write(`${tag} OK Begin TLS negotiation now\r\n`);
          detach();
          socket = new tls.TLSSocket(rawSocket, { isServer: true, secureContext });
          buffer = '';
          attach();
          state.starttlsUsed = true;
          continue;
        }
        if (command === 'CAPABILITY') {
          write(`* CAPABILITY IMAP4rev1 AUTH=XOAUTH2\r\n${tag} OK done\r\n`);
          continue;
        }
        if (command === 'LOGIN') {
          state.logins.push(rest);
          if (authFail) {
            write(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials\r\n`);
          } else {
            write(`${tag} OK LOGIN completed\r\n`);
          }
          continue;
        }
        if (command === 'AUTHENTICATE') {
          write('+ \r\n');
          const payload = await readLine();
          state.authPayloads.push(payload);
          if (authFail) write(`${tag} NO [AUTHENTICATIONFAILED] bad token\r\n`);
          else write(`${tag} OK AUTHENTICATE completed\r\n`);
          continue;
        }
        if (command === 'SELECT') {
          write('* 3 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 777] UIDs valid\r\n');
          write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
          continue;
        }
        if (command === 'UID' && /^SEARCH\b/i.test(rest)) {
          write(`* SEARCH ${MESSAGES.map((item) => item.uid).join(' ')}\r\n${tag} OK SEARCH completed\r\n`);
          continue;
        }
        if (command === 'UID' && /^FETCH\b/i.test(rest)) {
          const uidSet = rest.split(' ')[1] || '';
          const requested = uidSet.split(',').map(Number);
          const targets = MESSAGES.filter((item) => requested.includes(item.uid));
          const wantsFull = /BODY\.PEEK\[\]/i.test(rest);
          const wantsPartial = /BODY\.PEEK\[HEADER\]/i.test(rest) && /BODY\.PEEK\[TEXT\]/i.test(rest);
          for (const message of targets) {
            const flags = message.seen ? '\\Seen' : '';
            if (wantsFull) {
              const raw = fullMessage(message);
              write(`* 1 FETCH (UID ${message.uid} FLAGS (${flags}) RFC822.SIZE ${Buffer.byteLength(raw)} BODY[] {${Buffer.byteLength(raw)}}\r\n`);
              write(raw);
              write(')\r\n');
            } else if (wantsPartial) {
              const header = headerOf(message);
              const text = textPartOf(message);
              write(`* 1 FETCH (UID ${message.uid} FLAGS (${flags}) RFC822.SIZE ${message.size} BODY[HEADER] {${Buffer.byteLength(header)}}\r\n`);
              write(header);
              write(` BODY[TEXT]<0> {${Buffer.byteLength(text)}}\r\n`);
              write(text);
              write(')\r\n');
            } else {
              const header = headerOf(message, { onlyFields: true });
              write(`* 1 FETCH (UID ${message.uid} FLAGS (${flags}) RFC822.SIZE ${message.size} BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES)] {${Buffer.byteLength(header)}}\r\n`);
              write(header);
              write(')\r\n');
            }
          }
          write(`${tag} OK FETCH completed\r\n`);
          continue;
        }
        if (command === 'LIST') {
          write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
          write('* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n');
          write(`* LIST (\\HasNoChildren) "/" ${quoted('&ZTZO9nux-')}\r\n`);
          write(`${tag} OK LIST completed\r\n`);
          continue;
        }
        if (command === 'STATUS') {
          write('* STATUS "INBOX" (MESSAGES 3 UNSEEN 1)\r\n');
          write(`${tag} OK STATUS completed\r\n`);
          continue;
        }
        if (command === 'LOGOUT') {
          write('* BYE logging out\r\n');
          write(`${tag} OK LOGOUT completed\r\n`);
          socket.end();
          return;
        }
        write(`${tag} BAD unsupported ${command}\r\n`);
      }
    })().catch(() => {
      try { socket.destroy(); } catch { /* 忽略 */ }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    state,
    certDir,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
