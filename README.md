# dsh-email —— 让 AI 真正把邮件发出去

DeepSeek Harness（DSH）邮件插件。**Hotmail / Outlook 走微软设备码 OAuth2，其它邮箱走普通 SMTP**，附带只读收件箱，让 AI 能「看信 → 写 → 发」走完一条完整链路。

- 零运行时依赖：SMTP、MIME、OAuth2、Graph、IMAP 全部用 Node 标准库实现，不装 nodemailer/imapflow。
- 参考实现：`lite-work-plugins/plugins/email-plugin` 的 OAuth/收发思路 + `dsh-astock` 已在真实邮箱上跑过的 SMTP 状态机与设备码流程。补上了附件、Graph 大附件上传会话、纯文本兜底、发信审计、SMTP 自检与更明确的错误说明。
- 安全默认：发信前强制 `dry_run` 预览；附件默认只允许工作区；密码不回显；读信工具不会标记已读或删除邮件。

> 版本 0.1.0，未发布到 npm。用 `dsh plugin add github:LaynePeng/dsh-email` 安装。

---

## 目录

- [能做什么](#features)
- [安装](#install)
- [配置](#config)
- [Hotmail / Outlook 授权](#oauth)
- [QQ / 163 / Gmail 等授权码邮箱](#basic)
- [工具与用法](#tools)
- [安全边界](#security)
- [故障排查](#troubleshoot)
- [设计说明：这些决定是怎么来的](#design)
- [开发与测试](#develop)
- [已知限制](#limits)

<a id="features"></a>
## 能做什么

| 能力 | 说明 |
|---|---|
| 发信 | SMTP（465 隐式 TLS / 587 STARTTLS）、Microsoft Graph（HTTPS 443） |
| 自动容错 | Graph 被网络拦（5xx/超时）→ 自动切 SMTP 并**熔断 10 分钟**（期间不再每封等超时）；SMTP 主入口握手失败 → 自动换备用入口；网络抖动自动重试（认证/地址类错误不重试） |
| OAuth2 | 微软设备码流程，一次授权长期有效；refresh_token 自动续期 |
| 普通密码 | QQ / 163 / 126 / 新浪 / 阿里云 / iCloud / Zoho / Fastmail / 自定义 SMTP，用授权码或应用专用密码 |
| 正文 | 纯文本 + HTML；只给 HTML 时自动生成纯文本兜底 |
| 附件 | 单封总大小默认 20MB；Graph 超过 3MB 自动走上传会话分片 |
| 收件（只读） | `email_mailbox`：列文件夹、列邮件、搜索、读单封 |
| 搜索 | `email_mailbox(action=search)`：关键词（中文走 UTF-8 literal 由服务端检索，失败自动本地兜底）+ 范围限定（主题/发件人/收件人/正文）+ 时间窗口（since/until/days，服务端筛完再本地复核）+ 跨文件夹 + 新旧排序，返回命中表格与**命中片段** |
| 审计 | `sends.jsonl` 记录发件时间/收件人/主题/通道/结果，不含正文 |
| 预览 | `dry_run=true` 不联网、不读令牌，只返回草稿 |
| 对话内预览卡 | 浏览器半侧把 `email_send` 调用渲染成邮件卡：收件人/抄送/密送、主题、正文、附件、HTML 预览（sandbox iframe），并区分草稿/发送中/已发送/失败 |
| 自检 | `email_account(action=status, probe=true)` 真实登录一次（不发信） |

**它不是**：群发工具、营销邮件系统、邮件客户端替代品；没有删除/移动/标记已读的能力，也不保存已发送副本到服务器（Graph 会保存到「已发送」，SMTP 不会）。

<a id="install"></a>
## 安装

### 前置条件

| 项 | 要求 |
|---|---|
| DSH | `>= 0.2.0-rc.2`（桌面版 0.2.2 已验证） |
| Node.js | `>= 22.13.0`（随 DSH 桌面版自带，不用单独装） |
| 网络 | 能访问 `login.microsoftonline.com`（授权）与 `smtp.office365.com:587` 或 `graph.microsoft.com:443`（发信） |

> **不需要**安装 nodemailer / imapflow 等依赖，也不需要 Python。插件零运行时依赖。

### 安装命令

```sh
dsh plugin --profile desktop add github:LaynePeng/dsh-email
```

仓库地址：https://github.com/LaynePeng/dsh-email

**如果终端里没有 `dsh` 命令**（DSH 桌面版默认不写进 PATH），用完整路径：

```sh
# macOS
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add github:LaynePeng/dsh-email

# Windows（PowerShell）
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add github:LaynePeng/dsh-email
```

装完 pnpm 会把仓库克隆到 profile 的 `node_modules` 下（实体目录，不是软链）。

### 升级

```sh
dsh plugin --profile desktop add github:LaynePeng/dsh-email
```

重复执行同一条命令即可拉到最新提交——`add` 对已存在的依赖就是更新。
然后重启 DSH（或到「设置 → 插件」把「邮件助手」停用再启用）。

> **注意**：`github:` 安装装的是**某个提交的快照**，不会跟着仓库实时变化。
> 更新了插件代码并推到 GitHub 后，必须再跑一次上面的命令才会生效。

### 卸载

```sh
dsh plugin --profile desktop remove @laynepeng/dsh-email
```

卸载只移除插件本身。OAuth 令牌与发信审计留在 `$DSH_HOME/email-data/`，
要彻底清除需手动删（`oauth.json` 里存着 refresh_token）。

### 只有改插件代码时，才用 link

如果你要修改插件本身，`github:` 每次改完都要重装，很麻烦。这时临时换成软链安装：

```sh
dsh plugin --profile desktop remove @laynepeng/dsh-email
dsh plugin --profile desktop add link:/绝对路径/to/dsh-email
```

- 用 `link:` 不要用 `file:` —— 前者是软链，改完源码在插件页停用/启用一次就生效；后者是复制，改完要重装。
- 改完、测完，记得换回 `github:` 安装（见上）。

### 装完确认

1. **重启 DSH**（或到「设置 → 插件」把「邮件助手」关掉再打开一次）。
2. 打开 **设置 → 插件**，应该能看到 **邮件助手**，并且有配置表单（服务商/账号/密码等 20 个字段）。
3. 在任意对话里问 AI「邮件配好了吗」，它应该能调用 `email_account` 并返回一张状态表。

> 如果「设置 → 插件」里**看不到表单**：说明宿主没把 `@deepseek-ai/schemastery` 暴露给插件（它是 peerDependency，由宿主提供）。此时工具仍可用，只是没有图形化配置——可以把配置写进 profile 的 `cordis.patch.yml`（见 [配置](#config) 末尾的等价写法）。

### 升级

```sh
# GitHub 安装的
dsh plugin --profile desktop add github:LaynePeng/dsh-email

# link 安装的：拉一下源码，再在插件页停用/启用
cd /绝对路径/to/dsh-email && git pull
```

### 卸载

```sh
dsh plugin --profile desktop remove @laynepeng/dsh-email
```

卸载只移除插件本身；OAuth 令牌与发信审计留在 `$DSH_HOME/email-data/`，手动删掉才是真正清除（`oauth.json` 里有 refresh_token）。

### 三分钟跑通

1. 安装并重启 DSH（见上）。
2. **设置 → 插件 → 邮件助手**：
   - Hotmail/Outlook：服务商选 `outlook`，认证方式 `auto`（走 OAuth2），填邮箱账号。
   - QQ/163/Gmail 等：服务商选对应项，填邮箱账号 + **授权码**（不是登录密码）。
   - 保存。
3. 对 AI 说「**授权邮件**」→ 按返回的网址和 8 位代码在浏览器完成授权（仅 Hotmail/Outlook）。
4. 对 AI 说：「**给 xxx@example.com 发一封测试邮件，主题『测试』，正文『你好』，先预览**」。
5. 对话里出现邮件预览卡，确认无误后说「**发送**」。

<a id="config"></a>
## 配置

位置：**设置 → 插件 → 邮件助手**。字段都声明为 `volatile`，保存后立即生效，不用重启。

| 字段 | 说明 | 默认 |
|---|---|---|
| `provider` | 服务商：`outlook`（Hotmail/Outlook）/ `qq` / `163` / `126` / `gmail` / `sina` / `aliyun` / `icloud` / `zoho` / `fastmail` / `custom` | `outlook` |
| `auth` | `auto` / `oauth2`（微软设备码）/ `basic`（密码/授权码）；auto 按服务商选。选错会自动纠正 | `auto` |
| `username` | 完整邮箱地址 | — |
| `password` | basic 模式的密码/授权码（secret，不回显） | — |
| `fromName` | 发件人显示名 | 空 |
| `fromAddress` | 发件人地址，留空＝`username` | 空 |
| `transport` | `auto` / `graph` / `smtp`；auto＝Outlook 走 Graph、其它走 SMTP | `auto` |
| `smtpHost` / `smtpPort` / `smtpTls` | 全部留空＝用服务商预设；`ssl`=465，`starttls`=587。显式填了才覆盖预设 | 空 |
| `imapHost` / `imapPort` | 只影响收件；留空用服务商预设 | 按预设 |
| `oauthTenant` | 个人账号**留空**；组织账号填租户域名/ID；不能填邮箱 | 空 |
| `oauthClientId` | 留空＝内置公共客户端；用自己 Azure 应用时填（需允许公共客户端流） | 空 |
| `oauthScope` | 高级：覆盖默认 scope（必须同一资源） | 按通道 |
| `dataDir` | 令牌与审计目录 | `$DSH_HOME/email-data` |
| `maxAttachmentMb` | 单封附件总上限 | `20` |
| `allowAttachmentDirs` | 额外允许读附件的目录（分号分隔） | 空＝只允许工作区 |
| `signature` | 默认签名（纯文本） | 空 |
| `allowInsecure` | 允许明文 SMTP（仅本机中继/测试） | `false` |

也可以用环境变量兜底（显式配置优先）：`DSH_EMAIL_USERNAME`、`DSH_EMAIL_PASSWORD`、`DSH_EMAIL_OAUTH_TENANT`、`DSH_EMAIL_OAUTH_CLIENT_ID`。

### 没有配置表单时：直接写配置文件

设置页是首选，但宿主没暴露表单时（见 [装完确认](#install)）可以直接改 profile 的配置文件 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，追加：

```yaml
- id: dsh-email
  name: "@laynepeng/dsh-email"
  config:
    provider: outlook
    auth: auto
    username: "you@hotmail.com"
    fromName: "你的名字"
    # basic（授权码）邮箱才需要：
    # password: "授权码"
    # transport: smtp
    # 其它可选键与上表同名，camelCase
```

> 改完重启 DSH 生效。**不要把 `oauth.json` 的内容抄进来**——令牌由插件自己管（0600），配置里只放账号。


<a id="oauth"></a>
## Hotmail / Outlook 授权（OAuth2）

Outlook 个人版已关闭 SMTP Basic Auth（`535 5.7.139`），必须用 OAuth2。本插件用**设备码流程**，不需要回调端口、不需要客户端密钥。

1. 设置里选 `provider=outlook`、`auth=oauth2`，填 `username`（如 `me@hotmail.com`），保存。
2. 对 AI 说「授权邮件」或直接让它调用 `email_account(action=authorize)`。
3. 它会返回一个网址（`https://microsoft.com/devicelogin`）和 8 位代码：
   - 打开网址 → 输入代码 → 用要发信的微软账号登录 → 同意「发送邮件 / 读取邮件」权限。
4. 完成浏览器操作后，让它调用 `email_account(action=poll)`（可带 `wait_seconds` 等待）。成功后 refresh_token 落到本机 `oauth.json`（0600），之后自动续期。

细节：

- **默认走 Graph（HTTPS 443）**，Graph 不可用时**自动回落 SMTP**（同一 refresh_token 换 `outlook.office.com/SMTP.Send` 的令牌，不需要重新授权）。想固定走 SMTP 就把 `transport` 改成 `smtp`。
- **Outlook 的 SMTP 主入口是 `smtp.office365.com:587`**，备用 `smtp-mail.outlook.com`。实测（2026-11）`smtp-mail.outlook.com` 在 STARTTLS 升级阶段会被部分网络重置（4/4 失败），而 `smtp.office365.com` 稳定成功；两者是同一套后端，只是入口不同。
- 内置公共客户端是 lite-work 在 Azure 注册的多租户公共客户端。如果它将来不可用，或你有自己的 Azure 应用：在 `oauthClientId` 填应用 ID，并在 Azure 里允许「公共客户端流」。
- 组织账号（M365）把 `oauthTenant` 填成租户域名或 GUID；个人账号留空（会按 `common` 处理）。填邮箱会报 `AADSTS900023`，插件会提前纠正并提示。
- 换账号、撤销授权、改密码后：先 `email_account(action=logout)`，再重新 `authorize`。

<a id="basic"></a>
## QQ / 163 / Gmail 等授权码邮箱

1. 到邮箱网页版设置里开启 **SMTP/IMAP 服务**，生成「授权码 / 应用专用密码」。
2. 设置里选对应 `provider`，填 `username` 与 `password`（填授权码，不是登录密码），保存。
3. 调用 `email_account(action=status, probe=true)`：它会真实连一次 SMTP 并登录，但**不发信**。

服务商预设（服务器/端口/TLS 自动带出）：

| 服务商 | SMTP | 方式 | IMAP |
|---|---|---|---|
| QQ | smtp.qq.com:465 | ssl | imap.qq.com:993 |
| 163 | smtp.163.com:465 | ssl | imap.163.com:993 |
| 126 | smtp.126.com:465 | ssl | imap.126.com:993 |
| Gmail | smtp.gmail.com:465 | ssl | imap.gmail.com:993 |
| 新浪 | smtp.sina.com:465 | ssl | imap.sina.com:993 |
| 阿里云 | smtp.aliyun.com:465 | ssl | imap.aliyun.com:993 |
| iCloud | smtp.mail.me.com:587 | starttls | imap.mail.me.com:993 |
| Zoho | smtp.zoho.com:465 | ssl | imap.zoho.com:993 |
| Fastmail | smtp.fastmail.com:465 | ssl | imap.fastmail.com:993 |

自建/企业邮箱选 `custom`，手填服务器、端口、加密方式（465=ssl，587=starttls）。IMAP 只支持 993 隐式 TLS；143+STARTTLS 暂不支持。

<a id="tools"></a>
## 工具与用法

插件注册 6 个工具：

### `email_send`

发送一封邮件。参数：`to`、`cc`、`bcc`（逗号分隔）、`subject`、`body`、`html`、`attachments`（工作区内路径数组）、`reply_to`、`in_reply_to`、`references`、`dry_run`。

推荐流程（插件会在系统提示里要求模型遵守）：

```text
1. email_send(dry_run=true)          ← 只预览，不联网
2. 把收件人/主题/正文给用户确认
3. email_send(dry_run 不传)          ← 正式发送
```

写邮件示例：

> 用邮件助手给 zhang@example.com 发一封周报，主题「本周进展」，正文列出三点，附件用 workspace 里的 weekly.pdf。先预览给我看。

**对话里的邮件卡**：`email_send` 调用会显示一张预览卡（浏览器半侧 `lib/client.js`），从调用参数渲染，不额外请求宿主：

![邮件预览卡（dry_run 草稿 + HTML 渲染）](docs/preview.png)

- 浅色 / 深色主题自动跟随，窄侧栏下收件人标签自动折行；
- 徽标明确区分 **未发送 · 草稿**（`dry_run`）、**发送中…**、**已发送 · 服务器已接收**、**发送失败**；
- 正文默认展示前约 11 行，长正文可「展开全文」；
- 有 `html` 时出现「查看 HTML」，在 **sandbox iframe** 里渲染（禁脚本、禁表单、禁嵌套框架），不会把邮件 HTML 注入 DSH 页面；
- 失败时即使工具按约定返回 `[Error]` 文本而不是抛异常，卡片也会识别为失败，不会误报「已发送」；
- 卡片只做展示，**发送动作仍要用户对 AI 说「发送」**，避免在 UI 里绕过对话确认。

### `email_account`

`action=status` 看配置/授权/通道/还缺什么/最近发信；`probe=true` 会真实登录一次（Graph 只读探针或 SMTP 登录），不发信。

`action=authorize | poll | cancel | logout` 处理设备码授权，`wait_seconds` 用于 poll 等待（上限 120 秒）。适合「授权邮件」「重新授权」「退出登录」这类对话。

### `email_mailbox`

`action` 决定做什么（默认 `list`）：

- **`search`：找邮件用这个**。
  - `query` 关键词；`in` 限定范围（`auto`/`subject`/`from`/`to`/`body`）
  - 时间：`since` / `until`（`YYYY-MM-DD`，含当天）、`days=N`（最近 N 天）、`after`/`before` 别名
  - `from`/`to` 结构化过滤、`unread`、`all_folders=true` 跨文件夹（≤25 个）、`scan` 本地兜底回溯量（默认 200，≤500）、`sort`（`newest`/`oldest`）、`max`（≤50）
  - 返回命中表格（时间/发件人/主题/**命中字段**/UID）+ **命中片段**（优先展示正文上下文）
  - 中文关键词：先按 UTF-8 literal 交给服务端 `SEARCH`；服务器不支持（BAD/NO）时自动退回本地扫描，结果里会写明范围
- **`list`**：`folder`、`from`、`subject`、`keyword`、`unread`、`since`/`until`/`days`、`sort`、`max`（≤50）。返回 UID/时间/发件人/主题，🔵 未读、📎 有附件。
- **`read`**：`uid`（+ `folder`），返回头部、正文（HTML 自动转纯文本）、附件清单；不下载附件内容。大于 2MB 只读头和部分正文并标注。
- **`folders`**：列文件夹与未读数（中文文件夹名自动 UTF-7 编解码）。

`keyword` 含中文时，服务器 SEARCH 只支持 ASCII，所以插件会取最近 40 封的正文前 16KB 在本地匹配——这是**有意的取舍**，结果里会写明。

> 发信不依赖 IMAP。`imapHost` 没填时，收件工具会明确提示，不影响发信。

<a id="security"></a>
## 安全边界

- **附件只允许工作区**：模型不能把 `~/.ssh/id_rsa` 当附件发出去。需要额外目录时由用户显式配置 `allowAttachmentDirs`。
- **密码是 secret 字段**：设置页不回显；`email_account(action=status)` 只说明「填了没」；发信审计不含密码和令牌。
- **令牌文件 0600、目录 0700**；不存在配置里，不会被顺手提交到 git。
- **发信前预览**：工具描述与系统提示都要求先 `dry_run`、等用户确认。这不是「审批弹窗」，而是对话里的确认——DSH 的工具权限门禁属于宿主策略，本插件没有内建弹窗。
- **只读收件**：没有删除/移动/标记已读工具。`BODY.PEEK` 不会把邮件标成已读。
- **不虚报结果**：成功只说「服务器已接收」，不说「已送达」；`email_account(action=status)` 不写「已验证」。
- **拒绝明文**：`smtpTls=none` 默认被拒绝，除非显式 `allowInsecure`（给本机中继/测试）。

<a id="troubleshoot"></a>
## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `SMTP 认证失败（535）` | QQ/163/Gmail 要用**授权码**；Outlook 个人版必须 OAuth2。 |
| `535 5.7.139` | 微软关闭了 Basic Auth：把 `auth` 改成 `oauth2` 并完成设备码授权。 |
| `501 5.1.7 Invalid address` | 地址里混了中文/全角字符。插件会清洗，但仍请检查 `fromAddress` 与收件人。 |
| `550/553` | 收件人不存在，或发件人不属于登录账号（多数服务商要求 `fromAddress` = `username`）。 |
| `554` / 被判垃圾邮件 | 降低链接密度、换主题；让收件人先把发件人加白名单。 |
| 连接超时 / 被拒绝 | 网络或防火墙封了 465/587。Outlook 把 `transport` 改成 `graph`；其它邮箱换 465/587 试试。 |
| `STARTTLS` 未声明 | 端口与加密方式不匹配：465 用 `ssl`，587 用 `starttls`。插件会按端口自动纠正。 |
| 令牌权限与通道不一致 | 只有**缺少**必需权限才要求重新授权；多授权其它权限不会被拦（`offline_access` 不算必需项）。 |
| `Graph 与 SMTP 两条通道都失败` | 报错会同时给两条原因。常见是网络同时拦了 graph 与 smtp-mail 入口；插件已默认用 `smtp.office365.com` 并自动换入口，仍失败再换网络。 |
| 授权页报 `AADSTS900023` | 租户里填了邮箱：清空 `oauthTenant`（个人账号）或填租户域名/ID。 |
| `AADSTS65001` | 用户/管理员未同意：重新授权并在浏览器点同意；组织账号可能需要管理员批准。 |
| 收件提示 IMAP 登录失败 | 服务商要求授权码；Outlook 需要 OAuth2。先确认网页版已开启 IMAP。 |
| 收件报「993 超时」 | 该网络封了 993。插件会自动回退 143 + STARTTLS，两者都失败说明整条 IMAP 被拦，换网络（如手机热点）即可，发信不受影响。 |
| 发送时报「主题里不能包含换行符」 | 这是旧版本把 RFC 2047 合法折行误判成注入的 bug（0.1.0 已修）。确认版本是最新的；若仍出现，说明主题原文真的含 CR/LF。 |
| 收件列表里"最新"却是很久以前的 | 旧版本信任了服务端 SEARCH 顺序（0.1.0 已修，改为按 UID 数值排序）。 |
| 设置页没有表单 | 确认安装的是 bundle（`dsh.bundle.patch`），并在「设置 → 插件」里找到「邮件助手」；`Config` 依赖宿主提供的 `@deepseek-ai/schemastery`。 |
| 沙箱里 selftest 报目录不可写 | DSH 文件沙箱只允许工作区；真实应用里 `$DSH_HOME` 可写。 |

**额外诊断**：插件在宿主 Web 服务上挂了一个只读端点 `GET /api/dsh-email/status`（不含密码/令牌），浏览器打开当前 DSH 地址 + 该路径即可看到与 `email_account(action=status)` 同源的状态。

<a id="develop"></a>
## 开发与测试

### 本地开发循环

`github:` 安装装的是提交快照，所以改代码时要临时切到软链模式：

```sh
# 1) 换成软链安装（只做一次）
dsh plugin --profile desktop remove @laynepeng/dsh-email
dsh plugin --profile desktop add link:$(pwd)

# 2) 改代码 → 在「设置 → 插件」把「邮件助手」停用再启用（不用重启 DSH）
#    boot.js 带版本号+时间戳缓存键，宿主会重新解析整条模块链

# 3) 测完、推上去，换回正常安装
dsh plugin --profile desktop remove @laynepeng/dsh-email
dsh plugin --profile desktop add github:LaynePeng/dsh-email
```

### 跑测试

```sh
cd /Users/layne/codes/dsh-email

node --test test/*.test.mjs     # 89 个测试（假 SMTP/OAuth/Graph/IMAP + MIME + 客户端预览卡）
node scripts/check-tools.mjs    # 工具契约校验（3 个工具、参数必带类型）
node scripts/selftest.mjs       # 无需 DSH 宿主的环境自检（打印当前配置与就绪状态）
```

测试不是 mock 到「函数被调用」为止：

- `test/helpers/fake-smtp.mjs`：真实 SMTP 状态机，含 EHLO、AUTH LOGIN/PLAIN/XOAUTH2、DATA 点转义、STARTTLS 升级（openssl 自签证书）。
- `test/helpers/fake-oauth.mjs`：设备码 + 轮询 + refresh_token 端点。
- `test/helpers/fake-imap.mjs`：LOGIN/XOAUTH2、SELECT、UID SEARCH/FETCH（支持 literal）、LIST/STATUS。
- `test/graph.test.mjs`：小附件一次 sendMail；大附件草稿→上传会话分片→发送；失败清理草稿。

代码结构：

```text
lib/
  entry.js / boot.js        稳定入口 + 缓存键热重载（link 安装时改子模块后启停即可）
  plugin.js                 注册工具、系统提示、只读状态端点
  client.js                 浏览器半侧：email_send 的邮件预览卡（tool.call.toolview）
  config-schema.js          设置页 schema（volatile 字段 + secret）
  tools.json                工具契约（唯一事实源）
  js/
    config.js               配置归一化、预设推导、地址清洗、就绪检查
    providers.js            服务商预设、scope（Graph/SMTP/IMAP）、租户规范化
    message.js              MIME 组装、RFC 2047/2231、折行安全校验、附件路径守卫
    smtp.js                 SMTP 状态机（TLS/STARTTLS/XOAUTH2）、重试策略、自检
    oauth.js                设备码、令牌续期、scope 子集判断、错误翻译
    graph.js                Graph 发信（大附件上传会话）+ 只读探针
    mime.js                 收件解析（multipart/字符集/RFC2047/2231）
    imap.js                 IMAP 只读（UTF-7、literal 检索、993/143 回退）
    store.js                oauth.json / sends.jsonl（0600）
    send.js                 发信编排 + Graph→SMTP 回落 + 熔断 + dry_run 预览 + 审计
    status.js               状态与联网自检
```

修完子模块后，在「设置 → 插件」里把邮件助手关掉再打开即可重新加载；`boot.js` 用版本号+时间戳做缓存键，Node 不会继续跑旧模块。

<a id="design"></a>
## 设计说明：这些决定是怎么来的

这一节记录**每一条看起来"多余"的代码背后踩过的坑**。都是在本机真实邮箱上撞出来的，
不是推演出来的。留着是为了以后改这块代码的人（包括我自己）别再撞一遍。

### 总览

| # | 现象 | 根因 | 现在的做法 |
|---|---|---|---|
| 1 | 长中文主题报「Subject 含换行符」 | RFC 2047 长主题会折成多段编码词，折行被头部注入检查误判 | 区分「原始输入」与「已编码值」两套校验 |
| 2 | 回落失败时只看到 Graph 的错 | SMTP 的真实原因被吞 | 两条通道都失败时同时报两边 |
| 3 | 回落只试一次就放弃 | 网络会间歇重置，实测第 3 次才成功 | 网络类失败重试 3 次，认证类不重试 |
| 4 | `smtp-mail.outlook.com` 一直连不上 | STARTTLS 阶段被网络重置（4/4） | 主用 `smtp.office365.com`，失败换入口 |
| 5 | 每封都等 Graph 超时一分钟 | 无状态，每次都想先试 Graph | 失败后熔断 10 分钟 |
| 6 | 刚授权成功却报「权限不足」 | 用集合相等比较 scope，且把 `offline_access` 当必需项 | 子集判断 + 忽略 `offline_access` |
| 7 | 邮件列表里"最新"是两周前 | 信任了服务端 `UID SEARCH` 的返回顺序 | 自己按 UID 数值排序 |
| 8 | STARTTLS 之后卡 20 秒超时 | 按"会再发一次问候语"去读（RFC 3501 不会） | 改用 CAPABILITY 往返同步 |
| 9 | 993 被封就完全读不了信 | 只支持 993 隐式 TLS | 加 143 + STARTTLS 备用通路 |
| 10 | 走 Graph 发信就读不了信 | 误以为两个资源的令牌不能共存 | 读信自己换 `outlook.office` 令牌 |
| 11 | 工具太多，schema 每轮都塞给模型 | 7 个工具参数高度重复 | 合并成 3 个，`action` 分派 |

### 1. 头部注入检查不能用在已编码的值上

`encodeHeaderValue()` 对超过 45 字节的中文主题会折成多段：

```
Subject: =?UTF-8?B?RFNIIOmCruS7tuWKqeaJi+Wunua1iw==?=
 =?UTF-8?B?77yI6Ieq5Yqo5Zue6JC96ZO+6Lev77yJ?=
```

段间是 `CRLF + 空格`，这是 **RFC 5322 合法折行**。原来 `headerBlock()` 对所有头部值
统一调用 `assertNoHeaderInjection()`，结果把合法折行当成注入，用户看到的就是
「主题里不能包含换行符」——而主题里根本没有换行。

现在的分工：

- `assertNoHeaderInjection()` —— 只校验**用户原始输入**（主题、显示名、地址），
  出现 CR/LF 立刻拒绝，这是真注入；
- `assertSafeFoldedHeader()` —— 校验**已编码/已折行**的值，先把合法的
  `CRLF + 空白` 折行去掉，剩下的 CR/LF 才拒绝。

长收件人列表（`formatMailboxList()` 按逗号折行）走同一条路径。

### 2. 失败原因必须成对出现

回落逻辑最初写成了「Graph 失败 → 试 SMTP → 不行就保留 Graph 的错误」。结果用户
看到的是「Graph 502」，而真正让它发不出去的是 SMTP 那边的 `ECONNRESET`。
两条通道都失败时现在这样报：

```
Graph 与 SMTP 两条通道都失败：
· Graph：连接 Microsoft Graph 失败：The operation was aborted due to timeout
· SMTP：发信失败：read ECONNRESET（smtp.office365.com）（尝试 3 次均失败）
```

### 3. 重试只对网络层有意义

`isRetryableSmtpFailure()` 分两类：

- **重试**：`ECONNRESET` / `ETIMEDOUT` / `EPIPE` / 超时 / 连接被关闭，以及落在
  `greeting`/`ehlo`/`starttls` 阶段的失败——这些是线路抖动；
- **不重试**：535 认证失败、534 需要应用专用密码、501 地址非法、550/553 拒收、
  554 判垃圾——换多少次结果都一样，重试只是让用户多等。

实测依据：本机网络对带 OAuth 凭证的 TLS 连接会间歇重置，同一令牌连 3 次
（前两次 reset、第三次成功）才发出去。所以默认 3 次、间隔 1.2 秒。

### 4. 同一套后端有多个入口，某个入口被拦就换

微软的 SMTP 有 `smtp.office365.com` 和 `smtp-mail.outlook.com` 两个域名入口，
后端是同一套。实测：

```
smtp-mail.outlook.com:587 (starttls) → ECONNRESET | 220 OK | 220 OK | 220 OK
smtp.office365.com:587  (starttls) → 220 OK | 220 OK | 220 OK | 220 OK
```

所以预设改成主用 `office365`，`smtp-mail` 降为备用入口；`sendViaSmtpChannel()`
按候选列表尝试，**只在握手阶段失败时换入口**（认证失败换域名没意义）。
用户手填了 `smtpHost` 就不启用备用列表——那代表他明确要用哪个。

### 5. 不要每封都为「可能失败」付超时

Graph 被拦时每次要等 30–60 秒超时。`sendEmail()` 里加了一个进程内熔断：
网关/网络类失败后记 10 分钟，期间直接走 SMTP，并在回执里写明
「约 N 分钟后会再试 Graph」。成功一次就清空熔断，网络恢复能自动回到主通道。

> 熔断是**进程内**状态，重启 DSH 会清空——这是有意的：重启往往意味着网络环境
> 变了，应该重新试一次主通道。

### 6. scope 是"包含"不是"相等"

微软返回的 `scope` 常常比你要的多（应用在 Azure 里已获同意的其它权限）。
早期实现用集合相等比较，导致刚授权成功就报「权限与通道不一致」，用户被迫
反复授权。现在的 `scopeSatisfies()`：

- 只要求**必需项是已授权项的子集**，多出来的权限不影响；
- `offline_access` 只用于申请 refresh_token，**不会出现在 access_token 的 scope 里**，
  所以不能当必需项——这条是踩出来的，修之前每次授权完都会被判缺权限。

### 7. 服务端的 SEARCH 顺序不可信

`UID SEARCH` 的返回顺序协议没保证。原来写 `uids.slice(-N).reverse()` 取"最新 N 封"，
在返回**降序**的服务器上就变成了取最老的那批——用户看到的第一封是两周前的邮件，
而列表本身"看起来完全正常"，这种错最难发现。

现在先 `map(Number)` 去重排序，再取尾部；`FETCH` 结果也统一按 UID 降序整理。
回归用例 `reverseSearch` 专门模拟降序服务器。

### 8. STARTTLS 之后没有第二次问候语

RFC 3501：`STARTTLS` 成功后服务器**不会**重发 `* OK` 问候语。第一版按"等服务端
再发一次 banner"写，遇到合规服务器就一直等到 20 秒超时。现在升级后直接发
`CAPABILITY` 往返一次确认加密通道可用——顺便清掉对端可能插入的数据。

### 9. 993 被封时 143 + STARTTLS 是等价通路

部分网络封 IMAP 的 993 但放行 143。两者升级完成后是同样的加密通道。所以
`connectImap()` 改成按候选列表尝试：

- 主：`imapPort`（默认 993，`ssl`）
- 备：`imapFallbacks`（outlook 预设自带 `143/starttls`）

同样只在网络类失败时换入口。用户手填 `imapHost` 时不启用备用（避免把自建服务器
的流量导向意料之外的端口）。

### 10. 读信的令牌和发信的令牌是两回事

Graph 与 `outlook.office.com` 是**两个资源**，Graph 令牌不能拿去 `AUTHENTICATE XOAUTH2`。
早期实现据此直接拒绝"走 Graph 时读信"，让用户切通道并重新授权——这是过度限制：
**同一个 refresh_token 可以向 outlook.office 换一份读信令牌**，不需要重新授权。

现在读信走 `getImapToken()`（`IMAP_SCOPE`），与发信通道完全解耦。

### 11. 工具要给模型"少而准"的接口

7 个工具里，`folder`/`since`/`until`/`unread`/`max` 这些参数重复出现在 4 个只读工具上。
合并成 `email_mailbox(action)` 后，schema 从 8490 bytes 降到 5841 bytes（-31%）。

不是单纯为了省 token：**拆开会让模型在"该用 list 还是 search"上犹豫**，而这两件事
本来就是同一条命令的不同参数组合。合并后用 `action` 明确表态，参数只有一份。

保留的约束：未知 `action` 明确报错并列出可用值（不静默落到默认动作，否则模型传错
了也发现不了）；不传 `action` 时给合理默认（`mailbox` → `list`，`account` → `status`）。

### 一些刻意保守的选择

| 决定 | 理由 |
|---|---|
| 发信前强制 `dry_run` 预览 | 邮件发出去无法撤回；预览让用户在**发送前**看到收件人和正文，比事后道歉便宜 |
| 附件默认只能读工作区 | 模型不该能把 `~/.ssh/id_rsa` 当附件发出去；需要额外目录得用户显式配置 |
| 成功只说「服务器已接收」 | 服务器接收 ≠ 对方看到。说"已送达"是编造事实 |
| 读信工具没有删除/移动/标记 | 误删一封的代价远大于少一个功能 |
| 明文 SMTP 默认拒绝 | 除非本机中继，否则账号密码在明文连接里裸奔 |
| 令牌单独存 `oauth.json`（0600） | 配置会被顺手截图/提交；令牌不该混在里面 |
| 审计只记头部不记正文 | 排查"发没发出去"不需要正文内容 |

<a id="limits"></a>
## 已知限制

- **单账号**：一次只配置一个邮箱。多账号需要多套配置（可后续加 accounts 数组）。
- **没有回复/转发专用工具**：可以 `email_mailbox(action=read)` 拿到原文后用 `email_send` 手工带 `in_reply_to` / `references` 回复（不会自动引用原文、不会自动抄送）。Graph 通道会忽略这两个头（Graph 用自己的会话机制），SMTP 通道会正常带上。
- **不下载附件**：只列附件名/类型/大小。需要附件内容时请用户自己从客户端取。
- **SMTP 发信不自动存「已发送」**：Graph 会存；SMTP 需要 IMAP APPEND，暂未实现。
- **IMAP 只支持 993 隐式 TLS**，不支持 143 + STARTTLS。
- **Graph 通道只解决发信**：Graph 令牌不含 IMAP 权限，所以默认 `transport=graph` 时收件工具会明确提示；要读收件箱需切到 `smtp` 并重新授权（如果网络允许 SMTP）。
- **内置 OAuth 客户端**依赖第三方 Azure 公共客户端；组织策略可能要求管理员同意，或需要你填自己的 `oauthClientId`。
- **没有 DKIM 签名**；大附件走服务器限制（Graph 150MB，普通 SMTP 通常 25MB）。
- **平面文本里的中文关键词搜索在本地区域完成**，只扫最近 40 封；要全量搜索需要服务器支持 UTF-8 SEARCH（未实现）。
- 未做「发信审批弹窗」：确认发生在对话里（`dry_run` → 用户点头 → 正式发）。如果你需要强制门禁，用 DSH 的 `tools/pre-execute` 策略挂在本插件上。

## 致谢

SMTP 状态机、微软设备码 OAuth2 与 Graph 发信思路参考/改编自：

- [dsh-astock](https://github.com/LaynePeng/dsh-astock)（Apache-2.0）
- [lite-work-plugins / email-plugin](https://github.com/LaynePeng/lite-work-plugins)（Apache-2.0）

MIME 组装/解析、IMAP 只读、附件路径守卫、发信审计与测试假服务器为本项目实现。详见 [NOTICE](NOTICE) 与 [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)。

## License

MIT
