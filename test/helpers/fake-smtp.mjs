/**
 * 测试用本地假 SMTP 服务器：验证真实协议状态机（EHLO/STARTTLS/AUTH/DATA）。
 *
 * 不是 mock：它按行应答、收集 DATA、支持 STARTTLS 升级，只有这样才测得出
 * 「点转义漏了」「QUIT 前就关连接」「AUTH 用了 PLAIN 但服务器只认 LOGIN」。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

export function makeSelfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-email-cert-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), dir };
}

/**
 * @param {{tls?:boolean, starttls?:boolean, mechanisms?:string[], authFail?:boolean, dataReply?:string}} options
 */
export async function startFakeSmtp(options = {}) {
  const {
    tls: implicitTls = false,
    starttls = false,
    mechanisms = ['LOGIN', 'PLAIN'],
    authFail = false,
    dataReply = '250 2.0.0 Ok: queued as ABC123',
  } = options;
  const state = {
    commands: [],
    authPayloads: [],
    data: [],
    received: [],
    secure: false,
  };
  let secureContext = null;
  if (implicitTls || starttls) {
    const cert = makeSelfSignedCert();
    secureContext = tls.createSecureContext({ key: cert.key, cert: cert.cert });
  }

  const server = net.createServer((rawSocket) => {
    let socket = rawSocket;
    let buffer = '';
    let dataMode = false;
    let dataLines = [];
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
        if (dataMode) {
          if (line === '.') {
            dataMode = false;
            const body = dataLines.join('\r\n');
            state.data.push(body);
            state.received.push(body);
            socket.write(`${dataReply}\r\n`);
            dataLines = [];
          } else {
            dataLines.push(line.startsWith('..') ? line.slice(1) : line);
          }
        } else {
          const waiter = waiters.shift();
          if (waiter) waiter(line);
        }
        index = buffer.indexOf('\r\n');
      }
    };

    const readLine = () => new Promise((resolve) => {
      waiters.push(resolve);
    });

    const writeLine = (line) => {
      socket.write(`${line}\r\n`);
    };

    const run = async () => {
      if (implicitTls) {
        detach();
        socket = new tls.TLSSocket(rawSocket, { isServer: true, secureContext });
        buffer = '';
        state.secure = true;
        attach();
      } else {
        attach();
      }
      writeLine('220 localhost ESMTP fake');
      for (;;) {
        const line = await readLine();
        if (line === undefined) return;
        state.commands.push(line);
        const [commandRaw, ...rest] = line.split(' ');
        const command = commandRaw.toUpperCase();

        if (command === 'EHLO' || command === 'HELO') {
          const features = ['250-localhost', '250-SIZE 52428800', `250-AUTH ${mechanisms.join(' ')}`];
          if (starttls && !state.secure) features.push('250-STARTTLS');
          features.push('250 8BITMIME');
          socket.write(`${features.join('\r\n')}\r\n`);
          continue;
        }
        if (command === 'STARTTLS') {
          writeLine('220 2.0.0 Ready to start TLS');
          detach();
          socket = new tls.TLSSocket(rawSocket, { isServer: true, secureContext });
          buffer = '';
          state.secure = true;
          attach();
          continue;
        }
        if (command === 'AUTH') {
          const mechanism = (rest[0] || '').toUpperCase();
          if (mechanism === 'LOGIN') {
            writeLine('334 VXNlcm5hbWU6');
            state.authPayloads.push(await readLine());
            writeLine('334 UGFzc3dvcmQ6');
            state.authPayloads.push(await readLine());
            writeLine(authFail ? '535 5.7.8 Authentication failed' : '235 2.7.0 Accepted');
            continue;
          }
          if (mechanism === 'PLAIN') {
            state.authPayloads.push(rest[1] || (await readLine()));
            writeLine(authFail ? '535 5.7.8 Authentication failed' : '235 2.7.0 Accepted');
            continue;
          }
          if (mechanism === 'XOAUTH2') {
            state.authPayloads.push(rest[1] || '');
            if (authFail) {
              writeLine('334 eyJzdGF0dXMiOiI0MDEifQ==');
              await readLine(); // 客户端必须回空行结束挑战
              writeLine('535 5.7.3 Authentication unsuccessful');
            } else {
              writeLine('235 2.7.0 Accepted');
            }
            continue;
          }
          writeLine('504 5.5.4 Unrecognized authentication type');
          continue;
        }
        if (command === 'MAIL' || command === 'RCPT') {
          writeLine('250 2.1.0 Ok');
          continue;
        }
        if (command === 'DATA') {
          dataMode = true;
          writeLine('354 End data with <CR><LF>.<CR><LF>');
          continue;
        }
        if (command === 'QUIT') {
          writeLine('221 2.0.0 Bye');
          socket.end();
          return;
        }
        writeLine('250 2.0.0 Ok');
      }
    };

    run().catch(() => {
      try { socket.destroy(); } catch { /* 忽略 */ }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
