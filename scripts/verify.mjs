#!/usr/bin/env node
// 校验 dist：验签、按契约校验 index.json、逐个核对包与 readme 的 sha256 和大小、核对 published.json。
// 用法：node scripts/verify.mjs --dist <dir> --public-key <pem 文件>
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { validateIndex } from './lib/contract.mjs';
import { fail } from './lib/entries.mjs';
import { sha256 } from './lib/hash.mjs';
import { verifyBytes } from './lib/sign.mjs';

const { values } = parseArgs({ options: { dist: { type: 'string' }, 'public-key': { type: 'string' } } });
if (!values.dist || !values['public-key']) fail('用法：node scripts/verify.mjs --dist <dir> --public-key <pem>');

const dist = values.dist;
const idxFile = join(dist, 'index.json');
const sigFile = join(dist, 'index.json.sig');
if (!existsSync(idxFile) || !existsSync(sigFile)) fail('dist 中缺少 index.json 或 index.json.sig');

const bytes = readFileSync(idxFile);
if (!verifyBytes(bytes, readFileSync(sigFile, 'utf8'), readFileSync(values['public-key'], 'utf8'))) fail('签名无效：index.json 与 index.json.sig 不匹配');

const index = JSON.parse(bytes.toString('utf8'));
const errs = validateIndex(index);
const published = existsSync(join(dist, 'published.json')) ? JSON.parse(readFileSync(join(dist, 'published.json'), 'utf8')) : {};

function checkFile(where, ref) {
  const file = join(dist, ref.path);
  if (!existsSync(file)) return errs.push(`${where}: 缺少文件 ${ref.path}`);
  const buf = readFileSync(file);
  if (buf.length !== ref.size) errs.push(`${where}: ${ref.path} 大小 ${buf.length}，索引记录 ${ref.size}`);
  if (sha256(buf) !== ref.sha256) errs.push(`${where}: ${ref.path} sha256 不符`);
}

let files = 0;
if (!errs.length) {
  for (const p of index.plugins) {
    for (const v of p.versions) {
      const key = `${p.id}@${v.version}`;
      checkFile(key, v.package);
      files++;
      if (v.readme) checkFile(key, v.readme), files++;
      const pub = published[key];
      if (!pub || pub.commit !== v.commit || pub.sha256 !== v.package.sha256 || pub.size !== v.package.size) {
        errs.push(`${key}: 与 published.json 记录不一致`);
      }
    }
  }
}
if (errs.length) fail(`dist 校验失败：\n  ${errs.join('\n  ')}`);
console.log(`验签通过：sequence ${index.sequence}，${index.plugins.length} 个插件，核对了 ${files} 个文件。`);
