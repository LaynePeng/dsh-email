#!/usr/bin/env node
/**
 * 插件自检：不需要 DSH 宿主、不需要联网即可运行。
 *
 *   node scripts/selftest.mjs
 *   DSH_EMAIL_USERNAME=me@outlook.com node scripts/selftest.mjs
 */

import { selftest } from '../lib/plugin.js';

const info = await selftest({});
console.log(JSON.stringify(info, null, 2));
