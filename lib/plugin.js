/**
 * dsh-email —— 邮件助手（DeepSeek Harness 插件，宿主侧）。
 *
 * 设计目标只有一个：**让 AI 把邮件真正发出去，而且发得对**。
 *   · Hotmail/Outlook 用微软设备码 OAuth2（个人版已关闭 SMTP Basic Auth），
 *     默认走 Graph（HTTPS 443），也能切 SMTP XOAUTH2；
 *   · QQ/163/Gmail 等用普通 SMTP（授权码/应用专用密码）；
 *   · 发信前强制「dry_run 预览 → 用户确认 → 正式发送」；
 *   · 附件只允许工作区（或用户显式配置的目录），防止误发密钥文件；
 *   · 不记录正文，只记发信审计；令牌文件 0600；状态里绝不回显密码。
 *
 * 与参考实现的关系：SMTP 状态机与 OAuth 设备码流程参考 dsh-astock 的
 * lib/js/smtp.js / oauth.js（已在真实邮箱上跑过），这里补上附件、Graph
 * 大附件上传会话、发信审计、SMTP 自检与更明确的错误说明。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = JSON.parse(readFileSync(join(HERE, 'tools.json'), 'utf8'));

// 静态依赖也带着 boot 的缓存键加载：改完子模块「启停插件」就能生效，
// 不必重启整个 DSH（Node 按 URL 缓存模块，不带键会一直跑旧代码）。
const KEY = globalThis.__DSH_EMAIL_BOOT_KEY__ || String(Date.now());
const withKey = (spec) => new URL(`${spec}?${KEY}`, import.meta.url).href;

const configMod = await import(withKey('./js/config.js'));
const { normalizeConfig } = configMod;
const storeMod = await import(withKey('./js/store.js'));
const { EmailStore } = storeMod;
const oauthMod = await import(withKey('./js/oauth.js'));
const sendMod = await import(withKey('./js/send.js'));
const statusMod = await import(withKey('./js/status.js'));
const imapMod = await import(withKey('./js/imap.js')).catch((error) => ({
  __error: error?.message ?? String(error),
}));

/** Cordis 插件名（与 package.json 的 name 一致）。 */
export const name = 'dsh-email';

/** 依赖的工具注册表与系统提示服务。 */
export const inject = ['tools', 'systemPrompt'];

/** 只读状态端点（给浏览器/排障用；不含密码与令牌）。 */
export const STATUS_ENDPOINT = '/api/dsh-email/status';

/** 注入模型的用法说明：只讲边界与流程，字段细节由工具 schema 负责。 */
export const USAGE_GUIDANCE = [
  '本会话装有邮件助手工具：email_send（发信）、email_status（配置/授权自检）、email_oauth（Hotmail/Outlook 设备码授权）。',
  '发邮件的固定流程：先 email_send(dry_run=true) 预览草稿 → 把收件人/主题/正文给用户确认 → 用户明确同意后再用相同参数正式发送。'
    + '用户没有明确同意时不要直接发送；不要把「预览」说成「已发送」。',
  '收件人地址必须是用户提供的真实地址，不要猜测、补全或编造邮箱；未经用户明确要求，不要给多个人群发。',
  '发信成功后只能说「邮件服务器已接收」，不要说「已送达」「对方已读」；退信会回到发件箱。',
  'Hotmail/Outlook 的 OAuth 授权一次长期有效；用户说「收不到邮件/发不出去」时先用 email_status 看状态，再决定是否重新授权。',
  '账号与密码在「设置 → 插件 → 邮件助手」里配置（密码是 secret，不会回显）；不要在对话里让用户粘贴密码。',
].join('\n');

/** 读 package.json 版本（读不到返回空串）。 */
function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version ?? '';
  } catch {
    return '';
  }
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function oauthInstruction(pending, username = '') {
  const uri = pending.verificationUri || 'https://microsoft.com/devicelogin';
  const minutes = Math.max(1, Math.ceil((Number(pending.expiresAt) - Date.now()) / 60000));
  return [
    '🔐 需要你在浏览器完成一次授权（本机不会保存密码）',
    '',
    `1. 打开：${uri}`,
    `2. 输入代码：**${pending.userCode}**`,
    `3. 用${username ? ` **${username}** ` : '要发信的微软账号'}登录，并同意「发送邮件 / 读取邮件」权限`,
    '',
    '> 授权账号必须与设置里的邮箱账号一致，否则第一次发信会被服务器拒收。',
    '',
    `设备码约 ${minutes} 分钟后过期。完成第 3 步后回来告诉我，我再运行 email_oauth（action=poll）确认。`,
    '如果浏览器打不开，把上面的网址和代码复制到手机/另一台电脑也一样。',
  ].join('\n');
}

function oauthConfigForPending(cfg, pending) {
  return {
    ...cfg,
    tenant: pending.tenant || cfg.tenant,
    clientId: pending.clientId || cfg.clientId,
    scope: pending.scope || cfg.scope,
    transport: pending.transport || cfg.transport,
  };
}

/**
 * 装进 DSH。
 *
 * 注意：**不要返回任何值**。Cordis 把 apply 的返回值当作 disposer/effect，
 * 返回普通对象会直接让插件激活失败。
 */
export function apply(ctx, config = {}) {
  const runtimeConfig = () => normalizeConfig(config);
  let store = null;
  let storeDir = '';

  const getStore = (cfg) => {
    if (!store || storeDir !== cfg.dataDir) {
      store = new EmailStore(cfg.dataDir);
      store.load();
      storeDir = cfg.dataDir;
    }
    return store;
  };

  const workspaceOf = (exec) => {
    const fromExec = exec?.agent?.session?.header?.cwd
      || exec?.agent?.session?.cwd
      || exec?.cwd;
    return typeof fromExec === 'string' && fromExec.trim() ? fromExec : process.cwd();
  };

  // ── 工具实现 ──────────────────────────────────────────────────────
  async function handleSend(args, exec) {
    const cfg = runtimeConfig();
    const result = await sendMod.sendEmail(cfg, getStore(cfg), args || {}, {
      workspace: workspaceOf(exec),
    });
    if (!result.ok) return `[Error] ${result.message}`;
    if (result.dryRun) return result.message;
    return sendMod.renderReceipt(result);
  }

  async function handleStatus(args) {
    const cfg = runtimeConfig();
    const status = statusMod.buildStatus(cfg, getStore(cfg));
    let text = statusMod.renderStatus(status);
    if (args?.probe === true) {
      const probe = await statusMod.probeStatus(cfg, getStore(cfg));
      text += [
        '',
        '## 联网自检',
        '',
        probe.ok ? probe.message : `❌ 自检失败：${probe.message}`,
        '',
        '> 自检只验证登录/令牌，不发送邮件，也不验证收件人地址；发信前仍建议先 dry_run 预览。',
      ].join('\n');
    }
    return text;
  }

  async function handleOauth(args) {
    const action = String(args?.action || 'status').trim().toLowerCase();
    const cfg = runtimeConfig();
    const localStore = getStore(cfg);

    if (action === 'status') {
      const record = cfg.username ? localStore.account(cfg.username) : null;
      const pending = localStore.pending();
      const lines = ['# 邮件 OAuth 授权状态', ''];
      lines.push(`账号：${cfg.username || '未配置'}`);
      lines.push(`认证方式：${cfg.auth === 'oauth2' ? 'OAuth2（设备码）' : '密码 / 授权码（不需要 OAuth）'}`);
      lines.push(`发信通道：${cfg.transport === 'graph' ? 'Microsoft Graph（HTTPS）' : 'SMTP'}`);
      lines.push('');
      if (cfg.auth !== 'oauth2') {
        lines.push('当前是密码/授权码模式，不需要设备码授权。要改用微软 OAuth，请到设置里把「认证方式」改成 oauth2、服务商选 outlook。');
        return lines.join('\n');
      }
      if (record?.refreshToken) {
        lines.push(`✅ 已授权（租户 ${record.tenant || 'common'}，${record.transport || '?'} 通道）`);
        if (record.obtainedAt) lines.push(`授权时间：${record.obtainedAt.replace('T', ' ').slice(0, 19)}`);
        lines.push(`已授权 scope：${record.scope || '未知'}`);
        lines.push('');
        lines.push('刷新令牌已保存在本机（oauth.json，权限 0600）。只有你主动撤销、改密码，或切换发信通道导致权限不一致时才需要重新授权。');
      } else {
        lines.push('❌ 尚未授权。运行 email_oauth（action=start）开始设备码登录。');
      }
      if (pending) {
        lines.push('');
        lines.push('## 进行中的授权');
        lines.push(pending.expired
          ? '设备码已过期：重新运行 email_oauth（action=start）拿新码。'
          : `打开 ${pending.verificationUri || 'https://microsoft.com/devicelogin'} 输入代码 **${pending.userCode}**，然后运行 email_oauth（action=poll）。`);
      }
      return lines.join('\n');
    }

    if (action === 'start') {
      if (cfg.provider !== 'outlook' || cfg.auth !== 'oauth2') {
        return '[Error] 设备码授权只适用于 Microsoft 账号（服务商选 outlook、认证方式选 oauth2）。'
          + 'QQ/163/Gmail 等请用密码/授权码模式。';
      }
      if (!cfg.username) {
        return '[Error] 请先在「设置 → 插件 → 邮件助手」填写邮箱账号，再发起授权。';
      }
      const existing = localStore.pending();
      if (existing && !existing.expired) {
        // 同一设备码只能轮询，重复申请会让用户手里那个码作废——直接把原码再说一遍
        return `已经有一个进行中的授权，继续用这组码：\n\n${oauthInstruction(existing, cfg.username)}`;
      }
      const started = await oauthMod.startDeviceCode(cfg);
      if (!started.ok) return `[Error] ${started.message}`;
      const pending = {
        deviceCode: started.deviceCode,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        expiresAt: Date.now() + started.expiresIn * 1000,
        interval: started.interval,
        clientId: started.clientId,
        tenant: started.tenant,
        scope: started.scope,
        transport: started.transport,
        startedAt: new Date().toISOString(),
      };
      localStore.setPending(pending);
      const hint = started.hint ? `\n\n> ${started.hint}` : '';
      const saveWarning = localStore.lastSaveError
        ? `\n\n> ⚠️ 设备码没能写入本机（${localStore.lastSaveError}）：请让 DSH 有权限写 ${cfg.dataDir}，否则重启后要重新授权。`
        : '';
      return `${oauthInstruction(pending, cfg.username)}${hint}${saveWarning}`;
    }

    if (action === 'cancel') {
      localStore.clearPending();
      return '已取消进行中的设备码授权（设备码作废）。要重新授权就再运行 email_oauth（action=start）。';
    }

    if (action === 'logout') {
      if (!cfg.username) return '[Error] 没有配置邮箱账号，不知道要清除哪个账号的令牌。';
      const existed = localStore.clearAccount(cfg.username);
      oauthMod.resetTokenCache();
      return existed
        ? `已清除 ${cfg.username} 的本机令牌。之后要发信需要重新运行 email_oauth（action=start）授权。`
        : `${cfg.username} 本机没有保存的令牌，无需清除。`;
    }

    if (action === 'poll') {
      const pending = localStore.pending();
      const deviceCode = String(args?.device_code || pending?.deviceCode || '');
      if (!deviceCode) return '[Error] 没有进行中的设备码：先运行 email_oauth（action=start）。';
      if (pending?.expired) {
        localStore.clearPending();
        return '[Error] 设备码已过期：重新运行 email_oauth（action=start）拿新码。';
      }
      const waitSeconds = Math.min(Math.max(Number(args?.wait_seconds) || 0, 0), 120);
      const deadline = Date.now() + waitSeconds * 1000;
      const pollCfg = pending ? oauthConfigForPending(cfg, pending) : cfg;
      let interval = Math.max(Number(pending?.interval) || 5, 3);
      let last = null;
      for (;;) {
        last = await oauthMod.pollDeviceCode(pollCfg, deviceCode);
        if (last.status === 'done' || last.status === 'error') break;
        if (last.slowDown) interval += 5;
        if (Date.now() + interval * 1000 > deadline) break;
        await sleep(interval * 1000);
      }

      if (last?.status === 'done') {
        localStore.setAccount(cfg.username, {
          refreshToken: last.refreshToken,
          clientId: last.clientId,
          tenant: last.tenant,
          scope: last.scope,
          transport: last.transport,
          obtainedAt: new Date().toISOString(),
        });
        localStore.clearPending();
        oauthMod.resetTokenCache();
        const saved = !localStore.lastSaveError;
        return [
          saved
            ? '✅ 授权成功，令牌已保存到本机（0600）。'
            : `⚠️ 授权成功，但令牌写入失败（${localStore.lastSaveError}）：本次能发信，重启后需要重新授权。`,
          '',
          `账号：${cfg.username}`,
          `通道：${last.transport === 'graph' ? 'Microsoft Graph（HTTPS）' : 'SMTP XOAUTH2'}`,
          '',
          saved ? '之后长期有效、会自动续期；只有你主动撤销或改密码才需要重新授权。' : '',
          '现在可以用 email_send（先 dry_run=true）写第一封信了。',
        ].join('\n');
      }
      if (last?.status === 'error') {
        if (/过期|拒绝|失效|declined|expired/i.test(last.message || '')) localStore.clearPending();
        return `[Error] 授权失败：${last?.message || '未知错误'}`;
      }
      const still = localStore.pending();
      if (!still) return '授权状态异常：设备码已不在本机记录里，请重新运行 email_oauth（action=start）。';
      return [
        '⏳ 还在等你完成浏览器授权。',
        '',
        `打开 ${still.verificationUri || 'https://microsoft.com/devicelogin'}，输入代码 **${still.userCode}** 并同意权限。`,
        '完成后告诉我，我再查一次。',
      ].join('\n');
    }

    return `[Error] 未知 action：${action}（可用：status / start / poll / cancel / logout）`;
  }

  async function handleMailboxTool(toolName, args) {
    if (!imapMod || imapMod.__error) {
      return `[Error] 收件箱功能不可用：${imapMod?.__error || 'IMAP 模块加载失败'}`;
    }
    const cfg = runtimeConfig();
    const localStore = getStore(cfg);
    if (toolName === 'email_list') return imapMod.runList(cfg, localStore, args || {});
    if (toolName === 'email_read') return imapMod.runRead(cfg, localStore, args || {});
    if (toolName === 'email_folders') return imapMod.runFolders(cfg, localStore, args || {});
    return `[Error] 未知工具 ${toolName}`;
  }

  const handlers = {
    'email_send': handleSend,
    'email_status': handleStatus,
    'email_oauth': handleOauth,
    'email_list': (args) => handleMailboxTool('email_list', args),
    'email_read': (args) => handleMailboxTool('email_read', args),
    'email_folders': (args) => handleMailboxTool('email_folders', args),
  };

  // 逐个注册：一个工具的 schema 被宿主拒绝，不能把其它工具一起拖死。
  const registered = [];
  for (const tool of TOOLS) {
    try {
      ctx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
        },
        async execute(args, exec) {
          const handler = handlers[tool.name];
          if (!handler) return `[Error] 工具 ${tool.name} 没有实现`;
          try {
            return await handler(args || {}, exec);
          } catch (error) {
            return `[Error] 工具 ${tool.name} 执行失败：${error?.name ?? 'Error'}: ${error?.message ?? error}`;
          }
        },
      });
      registered.push(tool.name);
    } catch (error) {
      try {
        console.warn(`[dsh-email] 工具 ${tool.name} 注册失败（其余继续）：${error?.message ?? error}`);
      } catch { /* 宿主没有 console */ }
    }
  }
  if (registered.length !== TOOLS.length) {
    try {
      console.warn(`[dsh-email] 已注册 ${registered.length}/${TOOLS.length} 个工具，失败项见上一行`);
    } catch { /* 宿主没有 console */ }
  }

  try {
    ctx.systemPrompt?.context?.({
      name: 'dsh-email:usage',
      order: 120,
      text: USAGE_GUIDANCE,
    });
  } catch (error) {
    try {
      console.warn(`[dsh-email] 系统提示注入失败（工具照常可用）：${error?.message ?? error}`);
    } catch { /* 宿主没有 console */ }
  }

  // 只读状态端点：浏览器打开可直接看「配好了没」，不返回密码/令牌。
  const safeInject = (services, callback) => {
    try {
      ctx.inject?.(services, callback);
    } catch (error) {
      try {
        console.warn(`[dsh-email] 可选服务 ${services.join('/')} 装配失败：${error?.message ?? error}`);
      } catch { /* 宿主没有 console */ }
    }
  };

  safeInject(['webServer'], (host) => {
    const server = host?.webServer;
    if (!server || typeof server.register !== 'function') return;
    try {
      host.effect(() => server.register({
        kind: 'exact',
        path: STATUS_ENDPOINT,
        handler: (req, res) => {
          const send = (payload) => {
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload));
          };
          try {
            const cfg = runtimeConfig();
            const status = statusMod.buildStatus(cfg, getStore(cfg));
            send({
              ok: true,
              version: packageVersion(),
              status: {
                ready: status.ready,
                provider: status.provider,
                providerLabel: status.providerLabel,
                username: status.username,
                auth: status.auth,
                transport: status.transport,
                checks: status.checks,
                pending: status.pending,
                limits: status.limits,
                warnings: status.warnings,
              },
              tools: registered,
            });
          } catch (error) {
            send({ ok: false, error: `${error?.name ?? 'Error'}: ${error?.message ?? error}` });
          }
        },
      }), 'dsh-email: status endpoint');
    } catch (error) {
      try {
        console.warn(`[dsh-email] 状态端点注册失败：${error?.message ?? error}`);
      } catch { /* 宿主没有 console */ }
    }
  });
}

/** 已注册的工具名（自检脚本用）。 */
export function toolNames() {
  return TOOLS.map((tool) => tool.name);
}

/** 自检：不需要 DSH 宿主即可运行（scripts/selftest.mjs）。 */
export function selftest(config = {}) {
  const cfg = normalizeConfig(config);
  const localStore = new EmailStore(cfg.dataDir);
  localStore.load();
  const status = statusMod.buildStatus(cfg, localStore);
  return {
    version: packageVersion(),
    provider: cfg.provider,
    auth: cfg.auth,
    transport: cfg.transport,
    username: cfg.username || '',
    ready: status.ready,
    checks: status.checks,
    dataDir: cfg.dataDir,
    warnings: [...(cfg.warnings || []), ...(localStore.warnings || [])],
    tools: TOOLS.map((tool) => tool.name),
  };
}
