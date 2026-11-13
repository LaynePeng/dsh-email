#!/usr/bin/env node
/**
 * 校验 lib/tools.json 的完整性。
 *
 * 工具名、描述、参数是模型据以调用的「行为契约」，手改一次就可能让模型调用方式
 * 变掉。这里做几条硬校验，跑在测试与发版前：
 *
 *   · 工具唯一，名字以 email_ 开头；
 *   · 每个都有非空 description；
 *   · parameters 是 type:object，每个参数都有类型或 enum；
 *   · 与 lib/plugin.js 注册的工具名逐一对应（多一个少一个都算错）。
 *
 *   node scripts/check-tools.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const tools = JSON.parse(readFileSync(join(ROOT, 'lib', 'tools.json'), 'utf8'));

const problems = [];
if (!Array.isArray(tools)) problems.push('tools.json 必须是数组');
const expectedNames = [
  'email_send', 'email_status', 'email_list', 'email_search', 'email_read', 'email_folders', 'email_oauth',
];
const seen = new Set();
for (const tool of tools) {
  const name = String(tool?.name || '');
  if (!name.startsWith('email_')) problems.push(`${name || '(空)'} 名字必须以 email_ 开头`);
  if (seen.has(name)) problems.push(`${name} 重复`);
  seen.add(name);
  if (!String(tool?.description || '').trim()) problems.push(`${name} 缺 description`);
  const params = tool?.parameters;
  if (!params || params.type !== 'object') {
    problems.push(`${name} 的 parameters 必须是 type:object`);
    continue;
  }
  for (const [key, spec] of Object.entries(params.properties || {})) {
    if (!spec || (!spec.type && !spec.enum && !spec.anyOf && !spec.oneOf)) {
      problems.push(`${name}.${key} 缺类型声明`);
    }
  }
}
for (const name of expectedNames) {
  if (!seen.has(name)) problems.push(`缺少工具 ${name}`);
}
const pluginSource = readFileSync(join(ROOT, 'lib', 'plugin.js'), 'utf8');
for (const name of seen) {
  if (!pluginSource.includes(`'${name}'`) && !pluginSource.includes(`"${name}"`)) {
    problems.push(`lib/plugin.js 没有处理 ${name}`);
  }
}

if (problems.length) {
  console.error('tools.json 校验失败：');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log(`tools.json OK：${tools.length} 个工具`);
for (const tool of tools) console.log(`  · ${tool.name}`);
