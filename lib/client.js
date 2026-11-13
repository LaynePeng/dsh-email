/**
 * dsh-email —— 浏览器半侧（Client 插件）。
 *
 * 只做一件事：在对话里把 `email_send` 的工具调用渲染成**邮件预览卡**，
 * 而不是一段通用 JSON。卡片只用调用参数（收件人/主题/正文/附件）和结果状态，
 * 不读宿主服务、不发请求，因此流式输出与会话回放都能稳定复现。
 *
 * 文件格式是 DSH 客户端模块系统的 lazy-CJS factory（与 dsh-astock 一致）：
 * 由 `window.__ModuleLoader__.load({ id, factory })` 注册，`id` 必须是 npm 包名。
 * 这样不需要额外构建步骤，`lib/client.js` 可以直接随包分发。
 */

window.__ModuleLoader__.load({
  id: '@laynepeng/dsh-email',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    /** 卡片样式：全部走宿主设计变量，深浅色主题自动跟随。 */
    const CSS = `
.dse-card{margin:2px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary);background:transparent;}
.dse-head{display:flex;align-items:center;gap:7px;padding:8px 11px;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0;flex-wrap:wrap;row-gap:4px;}
.dse-icon{font-size:14px;line-height:1;flex:none;}
.dse-title{font-weight:600;white-space:nowrap;flex:none;}
.dse-badge{font-size:11px;line-height:1.5;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;}
.dse-badge[data-state="draft"]{border-color:#c88a00;color:#a86f00;}
.dse-badge[data-state="sent"]{border-color:#0a9e6a;color:#0a7a52;}
.dse-badge[data-state="error"]{border-color:#d64545;color:#c53b3b;}
.dse-badge[data-state="sending"]{border-color:#1a73e8;color:#1a73e8;}
.dse-spacer{flex:1;min-width:4px;}
.dse-toggle{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;padding:2px 6px;border-radius:6px;cursor:pointer;white-space:nowrap;}
.dse-toggle:hover{background:var(--dsw-alias-button-secondary-fill,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary);}
.dse-body{padding:9px 11px 10px;}
.dse-line{display:flex;gap:8px;margin-bottom:5px;min-width:0;}
.dse-label{flex:none;width:46px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;}
.dse-value{min-width:0;overflow-wrap:anywhere;line-height:1.6;}
.dse-chip{display:inline-block;margin:1px 4px 1px 0;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:1.7;}
.dse-subject{font-weight:600;line-height:1.6;overflow-wrap:anywhere;}
.dse-text{margin-top:7px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l1);border-radius:8px;white-space:pre-wrap;line-height:1.65;overflow-wrap:anywhere;max-height:11.5em;overflow:hidden;position:relative;}
.dse-text[data-expanded="true"]{max-height:none;}
.dse-fade{position:absolute;left:0;right:0;bottom:0;height:2.6em;background:linear-gradient(transparent,var(--dsw-alias-bg-l1,rgba(127,127,127,.06)));pointer-events:none;}
.dse-attach{margin-top:7px;font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}
.dse-html{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;background:#fff;}
.dse-frame{display:block;width:100%;height:260px;border:none;background:#fff;}
.dse-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 11px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6;}
.dse-result{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;flex:1;min-width:0;}
.dse-error{margin:8px 11px 10px;padding:7px 9px;border-radius:7px;border:1px solid #d64545aa;color:#c53b3b;font-size:12px;line-height:1.55;overflow-wrap:anywhere;}
.dse-empty{padding:12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7;}
.dse-preparing{padding:8px 11px;color:var(--dsw-alias-label-secondary);font-size:12px;}
`;

    let cssInstalled = false;
    function ensureCss() {
      if (cssInstalled || typeof document === 'undefined') return;
      const style = document.createElement('style');
      style.setAttribute('data-dsh-email', '1');
      style.textContent = CSS;
      document.head.appendChild(style);
      cssInstalled = true;
    }

    /** 解析调用参数；流式阶段可能是截断的 JSON，解析失败返回 null。 */
    function parseArgs(raw) {
      if (!raw) return null;
      try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' ? value : null;
      } catch {
        return null;
      }
    }

    function textOf(value) {
      return typeof value === 'string' ? value : '';
    }

    /** 收件人支持字符串（逗号/分号分隔）或数组。 */
    function listOf(value) {
      if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
      return String(value || '')
        .replace(/[，;；]/g, ',')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }

    function baseName(value) {
      const text = String(value || '');
      const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
      return index >= 0 ? text.slice(index + 1) : text;
    }

    /** 从结果内容里取一段可读回执（模型看到的是纯文本）。 */
    function resultText(block) {
      if (!block || !Array.isArray(block.content)) return '';
      return block.content
        .filter((item) => item && item.type === 'text')
        .map((item) => item.text)
        .join('\n')
        .trim();
    }

    function firstLine(text, limit = 160) {
      const line = String(text || '').split('\n').map((item) => item.trim()).filter(Boolean)[0] || '';
      return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
    }

    /**
     * 生命周期 → 徽标。
     * dry_run 的结果不是「已发送」，而是「草稿」——这是最容易让用户误解的一步。
     *
     * @param {object} props toolview props
     * @returns {'preparing'|'sending'|'draft'|'sent'|'error'}
     */
    function stateOf(props) {
      if (props.phase === 'preparing') return 'preparing';
      const block = props.phase === 'result' ? props.block : null;
      if (block && (block.isError || block.error)) return 'error';
      // 本插件的工具失败时返回 "[Error] ..." 文本而不是抛异常（与 dsh-astock
      // 一致），所以结果卡必须自己识别这行前缀，不能把失败显示成「已发送」。
      if (block && /^\s*(\[Error\]|❌)/.test(resultText(block))) return 'error';
      const args = argsOf(props);
      if (args && args.dry_run === true) return 'draft';
      return props.phase === 'start' ? 'sending' : 'sent';
    }

    /** 从 start / result 阶段取完整参数。 */
    function argsOf(props) {
      if (props.phase === 'preparing') return null;
      if (props.phase === 'start') return parseArgs(props.block.argsRaw);
      return parseArgs(props.block.call ? props.block.call.argsRaw : '');
    }

    function badgeText(state) {
      switch (state) {
        case 'preparing': return '准备中';
        case 'sending': return '发送中…';
        case 'draft': return '未发送 · 草稿';
        case 'error': return '发送失败';
        default: return '已发送 · 服务器已接收';
      }
    }

    function row(label, value) {
      return h('div', { className: 'dse-line', key: label },
        h('span', { className: 'dse-label' }, label),
        h('span', { className: 'dse-value' }, value));
    }

    function chips(items) {
      return h('span', { className: 'dse-value' }, items.map((item, index) => (
        h('span', { className: 'dse-chip', key: `${item}-${index}` }, item)
      )));
    }

    /** 收件人 / 抄送 / 密送 / 主题 / 附件：都从参数推导，回放一致。 */
    function envelope(args) {
      const to = listOf(args.to);
      const cc = listOf(args.cc);
      const bcc = listOf(args.bcc);
      const attachments = Array.isArray(args.attachments) ? args.attachments : listOf(args.attachments);
      const nodes = [
        h('div', { className: 'dse-line', key: 'to' },
          h('span', { className: 'dse-label' }, '收件人'),
          to.length ? chips(to) : h('span', { className: 'dse-value' }, '（未填写）')),
      ];
      if (cc.length) nodes.push(row('抄送', chips(cc)));
      if (bcc.length) nodes.push(row('密送', chips(bcc)));
      nodes.push(h('div', { className: 'dse-line', key: 'subject' },
        h('span', { className: 'dse-label' }, '主题'),
        h('span', { className: 'dse-subject' }, textOf(args.subject) || '（无主题）')));
      if (attachments.length) {
        nodes.push(h('div', { className: 'dse-attach', key: 'attachments' },
          `📎 ${attachments.map(baseName).join('、')}`));
      }
      return nodes;
    }

    /** 把 HTML 包成可安全预览的文档：sandbox 禁脚本，样式隔离在 iframe 里。 */
    function htmlDocument(html) {
      const safe = String(html || '');
      return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">`
        + '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'; frame-src \'none\'; form-action \'none\'; base-uri \'none\'; img-src data: https: http:; style-src \'unsafe-inline\'">'
        + '<style>html,body{margin:0;padding:12px;font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;color:#202124;background:#fff;word-break:break-word}'
        + 'img{max-width:100%;height:auto}a{color:#1a73e8}table{max-width:100%;border-collapse:collapse}'
        + 'pre{white-space:pre-wrap;word-break:break-word}</style></head><body>'
        + safe
        + '</body></html>';
    }

    function EmailSendRow(props) {
      ensureCss();
      // Hooks 必须在任何提前 return 之前调用：preparing → start → result
      // 是同一个组件实例的生命周期，条件调用会让 React 报 hook 顺序错误。
      const [expanded, setExpanded] = React.useState(false);
      const [htmlOpen, setHtmlOpen] = React.useState(false);
      const state = stateOf(props);

      if (state === 'preparing') {
        return h('div', { className: 'dse-card', 'data-tool': 'email_send', 'data-state': 'preparing' },
          h('div', { className: 'dse-head' },
            h('span', { className: 'dse-icon' }, '📧'),
            h('span', { className: 'dse-title' }, '邮件'),
            h('span', { className: 'dse-spacer' }),
            h('span', { className: 'dse-badge', 'data-state': 'sending' }, '准备中')),
          h('div', { className: 'dse-preparing' }, '正在组装邮件…'));
      }

      const args = argsOf(props);
      const block = props.phase === 'result' ? props.block : null;
      const receipt = block ? resultText(block) : '';
      const errorText = state === 'error' ? firstLine(receipt, 300) : '';

      // 参数不可用（历史窗口截断/流式截断）：退回结果文本，不伪造预览。
      if (!args) {
        return h('div', { className: 'dse-card', 'data-tool': 'email_send', 'data-state': state },
          h('div', { className: 'dse-head' },
            h('span', { className: 'dse-icon' }, '📧'),
            h('span', { className: 'dse-title' }, '邮件'),
            h('span', { className: 'dse-spacer' }),
            h('span', { className: 'dse-badge', 'data-state': state }, badgeText(state))),
          h('div', { className: 'dse-empty' },
            receipt
              ? `参数不可用，无法还原预览。\n${firstLine(receipt, 400)}`
              : '参数不可用（可能是历史窗口截断）'));
      }

      const body = textOf(args.body) || textOf(args.text);
      const html = textOf(args.html);
      const canExpand = body.length > 260;

      const nodes = [
        h('div', { className: 'dse-head', key: 'head' },
          h('span', { className: 'dse-icon' }, '📧'),
          h('span', { className: 'dse-title' }, state === 'draft' ? '邮件草稿预览' : '邮件'),
          h('span', { className: 'dse-badge', 'data-state': state }, badgeText(state)),
          h('span', { className: 'dse-spacer' }),
          canExpand
            ? h('button', {
              className: 'dse-toggle',
              type: 'button',
              onClick: () => setExpanded((value) => !value),
            }, expanded ? '收起正文' : '展开全文')
            : null,
          html
            ? h('button', {
              className: 'dse-toggle',
              type: 'button',
              onClick: () => setHtmlOpen((value) => !value),
            }, htmlOpen ? '隐藏 HTML' : '查看 HTML')
            : null),
        h('div', { className: 'dse-body', key: 'body' },
          ...envelope(args),
          body
            ? h('div', { className: 'dse-text', 'data-expanded': expanded ? 'true' : 'false' },
              body,
              canExpand && !expanded ? h('span', { className: 'dse-fade' }) : null)
            : null,
          htmlOpen && html
            ? h('div', { className: 'dse-html' },
              h('iframe', {
                className: 'dse-frame',
                title: 'HTML 正文预览',
                sandbox: '',
                referrerPolicy: 'no-referrer',
                srcDoc: htmlDocument(html),
              }))
            : null),
      ];

      if (errorText) {
        nodes.push(h('div', { className: 'dse-error', key: 'error' }, errorText));
      }

      let footer = '';
      if (state === 'draft') footer = 'dry_run 预览不会发出任何邮件；确认内容后让 AI 去掉 dry_run 正式发送。';
      else if (state === 'sending') footer = '正在交给邮件服务器…';
      else if (state === 'sent') footer = receipt ? firstLine(receipt, 220) : '邮件服务器已接收（不代表已送达/已读）。';
      else footer = '这次没有发出去；展开详情看失败原因。';

      nodes.push(h('div', { className: 'dse-foot', key: 'foot' },
        h('span', { className: 'dse-result' }, footer),
        state === 'sent' && props.inspect
          ? h('button', { className: 'dse-toggle', type: 'button', onClick: props.inspect }, '查看记录')
          : null));

      return h('div', {
        className: 'dse-card',
        'data-tool': 'email_send',
        'data-state': state,
      }, nodes);
    }

    /** 客户端插件注入：只需要 slot 注册表；keyed slot 由 ui-tool 声明。 */
    const inject = ['slots'];

    function apply(ctx) {
      ensureCss();
      const register = () => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'email_send',
      }, EmailSendRow));
      // 与 dsh-astock 的客户端插件保持同一种生命周期写法：有 effect 就挂 effect，
      // 这样插件停用时 toolview 会随 fiber 一起注销。
      if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-email: email_send toolview');
      else register();
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
