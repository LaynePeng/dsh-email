/**
 * 插件入口（**极薄的一层转发**）。
 *
 * 存在理由：Cordis 重新启用插件时，宿主进程里 Node 的 ESM 缓存会按**文件路径**
 * 命中旧模块——改完源码点启停，跑的还是上一版。
 *
 * 所以入口文件名保持稳定、内容只有一行转发；真正的实现放在 `boot.js`，由它带着
 * 唯一查询串动态 import `plugin.js`。需要强制刷新时，把 `package.json` 的 `main`
 * 指向新的转发文件名即可（`entry.js` → `entry2.js` → …）。
 */
export * from './boot.js';
