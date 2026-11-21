#!/usr/bin/env node
// 校验所有注册表条目（plugins/*.json）和 revoked.json；有错误时列出并以非 0 退出。
import { loadEntries, loadRevoked } from './lib/entries.mjs';

const { entries, errors } = loadEntries();
const revoked = loadRevoked();
const all = [...errors, ...revoked.errors];

if (all.length) {
  console.error(`校验失败，共 ${all.length} 个问题：`);
  for (const e of all) console.error(`  - ${e}`);
  process.exit(1);
}
const versions = entries.reduce((n, e) => n + e.versions.length, 0);
console.log(`校验通过：${entries.length} 个插件，${versions} 个版本，${revoked.revoked.length} 条撤回记录。`);
