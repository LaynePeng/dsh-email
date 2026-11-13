/**
 * 本地状态：OAuth 令牌、进行中的设备码、发信审计。
 *
 * 为什么令牌不存插件配置里：
 *   · refresh_token 是长期凭据，写进 cordis.patch.yml 会被顺手提交/截图；
 *   · 设备码轮询需要跨工具调用保存中间态（甚至跨应用重启）；
 *   · 发信审计要能独立清理，不该和配置混在一起。
 *
 * 落盘约定：
 *   $DSH_HOME/email-data/oauth.json   0600，目录 0700
 *   $DSH_HOME/email-data/sends.jsonl  发信审计（不含正文），超过 1MB 轮转
 *
 * 文件坏了**绝不抛**：重命名成 .broken-<时间戳> 后从空状态继续——令牌丢了
 * 重新授权即可，不能让插件因为一个 JSON 读不出来就整个失效。
 */

import fs from 'node:fs';
import path from 'node:path';

const STORE_VERSION = 1;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // 某些平台/文件系统不支持 chmod，忽略
  }
}

function writePrivate(file, data) {
  ensureDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, data, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(temp, 0o600);
  } catch {
    // 忽略
  }
  fs.renameSync(temp, file);
}

function emptyState() {
  return { version: STORE_VERSION, accounts: {}, pending: null };
}

/** 邮箱账号做键：大小写不敏感。 */
export function accountKey(email) {
  return String(email || '').trim().toLowerCase();
}

export class EmailStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.oauthPath = path.join(dataDir, 'oauth.json');
    this.logPath = path.join(dataDir, 'sends.jsonl');
    this.state = emptyState();
    this.loaded = false;
    this.warnings = [];
    this.lastSaveError = '';
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      ensureDir(this.dataDir);
    } catch (error) {
      // 目录不可写（沙箱/权限）：插件仍可跑，只是令牌无法持久化——状态里会显示
      this.warnings.push(`数据目录不可用：${this.dataDir}（${error?.message ?? error}）`);
      return this;
    }
    if (!fs.existsSync(this.oauthPath)) return this;
    try {
      const raw = JSON.parse(fs.readFileSync(this.oauthPath, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.state = {
          version: STORE_VERSION,
          accounts: raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {},
          pending: raw.pending && typeof raw.pending === 'object' ? raw.pending : null,
        };
      }
    } catch (error) {
      const backup = `${this.oauthPath}.broken-${Date.now()}`;
      try {
        fs.renameSync(this.oauthPath, backup);
        this.warnings.push(`令牌文件损坏，已备份到 ${backup}，需要重新授权`);
      } catch {
        this.warnings.push(`令牌文件损坏且无法备份：${error?.message ?? error}`);
      }
      this.state = emptyState();
    }
    return this;
  }

  save() {
    this.load();
    try {
      writePrivate(this.oauthPath, `${JSON.stringify(this.state, null, 2)}\n`);
      this.lastSaveError = '';
      return true;
    } catch (error) {
      this.lastSaveError = String(error?.message ?? error);
      this.warnings.push(`令牌保存失败：${this.lastSaveError}`);
      return false;
    }
  }

  account(email) {
    this.load();
    return this.state.accounts[accountKey(email)] || null;
  }

  /** 保存授权结果（覆盖同账号旧记录）。 */
  setAccount(email, record = {}) {
    this.load();
    const key = accountKey(email);
    if (!key) throw new Error('保存令牌时缺少账号');
    this.state.accounts[key] = {
      ...this.state.accounts[key],
      ...record,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.accounts[key];
  }

  clearAccount(email) {
    this.load();
    const key = accountKey(email);
    const existed = Boolean(this.state.accounts[key]);
    delete this.state.accounts[key];
    this.save();
    return existed;
  }

  pending() {
    this.load();
    const pending = this.state.pending;
    if (!pending) return null;
    if (Number(pending.expiresAt) && Number(pending.expiresAt) < Date.now()) {
      return { ...pending, expired: true };
    }
    return { ...pending, expired: false };
  }

  setPending(pending) {
    this.load();
    this.state.pending = pending || null;
    this.save();
  }

  clearPending() {
    this.load();
    this.state.pending = null;
    this.save();
  }

  /** 发信审计：不含正文，只记录「谁在什么时候发给谁、走哪条通道、结果」。 */
  appendSend(entry = {}) {
    try {
      ensureDir(this.dataDir);
      try {
        const stat = fs.statSync(this.logPath);
        if (stat.size > 1024 * 1024) {
          fs.renameSync(this.logPath, `${this.logPath}.1`);
        }
      } catch {
        // 文件还不存在
      }
      const line = {
        at: new Date().toISOString(),
        to: entry.to || [],
        cc: entry.cc || [],
        subject: String(entry.subject ?? '').slice(0, 200),
        transport: entry.transport || '',
        ok: entry.ok === true,
        messageId: entry.messageId || '',
        detail: String(entry.detail ?? '').slice(0, 300),
      };
      fs.appendFileSync(this.logPath, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch {
      // 审计失败不影响发信结果
      return false;
    }
  }

  recentSends(limit = 10) {
    try {
      const lines = fs.readFileSync(this.logPath, 'utf8').trim().split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Number(limit) || 10))) {
        try {
          parsed.push(JSON.parse(line));
        } catch {
          // 跳过坏行
        }
      }
      return parsed.reverse();
    } catch {
      return [];
    }
  }
}
