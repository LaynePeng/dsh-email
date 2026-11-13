import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * 客户端半侧测试：不跑浏览器，用最小 React/loader 桩验证
 * 「注册 keyed toolview + 从参数渲染预览 + HTML 只进 sandbox iframe」。
 */

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
let definition;
globalThis.window = {
  __ModuleLoader__: {
    load(value) { definition = value; },
  },
};

await import('../lib/client.js');

function makeReact({ open = [] } = {}) {
  let stateIndex = 0;
  return {
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(Infinity).filter((item) => item !== null && item !== undefined && item !== false),
      };
    },
    useState(initial) {
      const value = open[stateIndex] !== undefined ? open[stateIndex] : initial;
      stateIndex += 1;
      return [value, () => {}];
    },
  };
}

function loadComponent(options = {}) {
  const react = makeReact(options);
  const fakeRequire = (specifier) => {
    if (specifier === 'react') return react;
    if (specifier === 'react/jsx-runtime') {
      return { jsx: react.createElement, jsxs: react.createElement };
    }
    throw new Error(`unexpected require: ${specifier}`);
  };
  const mod = definition.factory(fakeRequire);
  let component = null;
  const ctx = {
    slots: {
      inject(_name, callback) { callback(); },
      register(_reg, comp) { component = comp; },
    },
  };
  mod.apply(ctx);
  return { component, mod };
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false) return;
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ text: String(node) });
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (node.type) {
    visit(node);
    for (const child of node.children || []) walk(child, visit);
  }
}

function textOf(tree) {
  const parts = [];
  walk(tree, (node) => {
    if (typeof node.text === 'string') parts.push(node.text);
  });
  return parts.join(' ');
}

function findNode(tree, predicate) {
  let hit = null;
  walk(tree, (node) => {
    if (!hit && node && typeof node === 'object' && node.type && predicate(node)) hit = node;
  });
  return hit;
}

function resultProps(args, { text = '', isError = false, call = true } = {}) {
  return {
    phase: 'result',
    block: {
      kind: 'tool-result',
      isError,
      call: call ? { argsRaw: JSON.stringify(args) } : null,
      content: [{ type: 'text', text }],
    },
  };
}

test('client 模块：id 是包名，注册 email_send 的 keyed toolview', () => {
  assert.equal(definition.id, pkg.name);
  const { mod } = loadComponent();
  assert.deepEqual(mod.inject, ['slots']);
  const react = makeReact();
  const fakeRequire = (name) => (name === 'react' ? react : {});
  const built = definition.factory(fakeRequire);
  let slotName = '';
  let registration = null;
  let component = null;
  built.apply({
    slots: {
      inject(name, callback) { slotName = name; callback(); },
      register(reg, comp) { registration = reg; component = comp; },
    },
  });
  assert.equal(slotName, 'tool.call.toolview');
  assert.equal(registration.key, 'email_send');
  assert.equal(typeof component, 'function');
});

test('草稿卡：收件人/抄送/密送/主题/正文/附件 + 未发送纠偏', () => {
  const { component } = loadComponent();
  const tree = component(resultProps({
    to: 'a@b.com, 张三 <z@example.com>',
    cc: 'c@d.com',
    bcc: 'secret@d.com',
    subject: '季度报告',
    body: '这是正文',
    attachments: ['/tmp/report.pdf'],
    dry_run: true,
  }, { text: '📧 邮件草稿（未发送 · dry_run）' }));
  const text = textOf(tree);
  assert.match(text, /邮件草稿预览/);
  assert.match(text, /未发送 · 草稿/);
  assert.match(text, /a@b\.com/);
  assert.match(text, /z@example\.com/);
  assert.match(text, /c@d\.com/);
  assert.match(text, /secret@d\.com/);
  assert.match(text, /季度报告/);
  assert.match(text, /这是正文/);
  assert.match(text, /report\.pdf/);
  assert.match(text, /dry_run 预览不会发出任何邮件/);
  assert.doesNotMatch(text, /已发送 · 服务器已接收/);
});

test('发送成功卡：徽标与回执来自结果，不虚构送达', () => {
  const { component } = loadComponent();
  const tree = component(resultProps({
    to: 'a@b.com', subject: 'hi', body: 'hello',
  }, { text: '✅ 邮件已被 SMTP 服务器接收\n\n收件人：a@b.com' }));
  const text = textOf(tree);
  assert.match(text, /已发送 · 服务器已接收/);
  assert.match(text, /邮件已被 SMTP 服务器接收/);
  assert.doesNotMatch(text, /已送达/);
});

test('失败卡：显示错误摘要，不显示成功徽标', () => {
  const { component } = loadComponent();
  const tree = component(resultProps({
    to: 'a@b.com', subject: 'hi', body: 'hello',
  }, { text: '[Error] SMTP 认证失败：请用授权码', isError: true }));
  const text = textOf(tree);
  assert.match(text, /发送失败/);
  assert.match(text, /SMTP 认证失败/);
  assert.doesNotMatch(text, /已发送 · 服务器已接收/);
  const error = findNode(tree, (node) => node.props.className === 'dse-error');
  assert.ok(error);
});

test('结果文本以 [Error] 开头时按失败显示（工具不抛异常也不误报成功）', () => {
  const { component } = loadComponent();
  const tree = component(resultProps({
    to: 'a@b.com', subject: 'hi', body: 'hello',
  }, { text: '[Error] 邮件配置还不完整：还缺：密码 / 授权码（password）' }));
  const text = textOf(tree);
  assert.match(text, /发送失败/);
  assert.match(text, /邮件配置还不完整/);
  assert.doesNotMatch(text, /已发送 · 服务器已接收/);
});

test('HTML 预览只进 sandbox iframe，不进主文档 innerHTML', () => {
  const { component } = loadComponent({ open: [false, true] });
  const tree = component(resultProps({
    to: 'a@b.com',
    subject: 'html',
    body: 'plain',
    html: '<p>富文本</p><script>alert(1)</script>',
  }, { text: 'ok' }));
  const iframe = findNode(tree, (node) => node.type === 'iframe');
  assert.ok(iframe, '应渲染 iframe');
  assert.equal(iframe.props.sandbox, '');
  assert.equal(iframe.props.referrerPolicy, 'no-referrer');
  assert.match(iframe.props.srcDoc, /富文本/);
  let injected = false;
  walk(tree, (node) => {
    if (node.props && node.props.dangerouslySetInnerHTML) injected = true;
  });
  assert.equal(injected, false, '不能用 dangerouslySetInnerHTML 把 HTML 注入应用文档');
});

test('参数不可用（窗口截断）时退回结果文本，不伪造预览', () => {
  const { component } = loadComponent();
  const tree = component(resultProps({}, { text: '邮件已被服务器接收', call: false }));
  const text = textOf(tree);
  assert.match(text, /参数不可用/);
  assert.match(text, /邮件已被服务器接收/);
});

test('准备中显示紧凑状态', () => {
  const { component } = loadComponent();
  const tree = component({ phase: 'preparing', block: {} });
  const text = textOf(tree);
  assert.match(text, /准备中/);
  assert.match(text, /正在组装邮件/);
});
