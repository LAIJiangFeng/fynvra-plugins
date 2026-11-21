#!/usr/bin/env node
// 对构建出的源码做静态扫描，Markdown 报告输出到 stdout。只作审核提示，总是以 0 退出。
// 用法：node scripts/scan.mjs <build-out>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from './lib/entries.mjs';
import { renderReport, scanDir } from './lib/scan.mjs';

const out = process.argv[2];
if (!out) fail('用法：node scripts/scan.mjs <build-out>');

const lines = ['## Fynvra 插件扫描报告', '', '> 静态扫描只作提示，命中不代表恶意，未命中也不代表安全；请结合权限声明人工审核。', ''];
const manifestFile = join(out, 'build-manifest.json');
const results = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')).results : [];
const srcRoot = join(out, 'src');
let count = 0;
if (existsSync(srcRoot)) {
  for (const id of readdirSync(srcRoot).sort()) {
    for (const version of readdirSync(join(srcRoot, id)).sort()) {
      const r = results.find((x) => x.id === id && x.version === version);
      lines.push(renderReport(`${id}@${version}`, scanDir(join(srcRoot, id, version)), r?.permissions));
      count++;
    }
  }
}
if (!count) lines.push('本次没有需要扫描的新构建。', '');
console.log(lines.join('\n'));
