#!/usr/bin/env node
// 生成索引签名用的 Ed25519 密钥对。私钥只写入文件（0600，已存在则拒绝覆盖），绝不打印；只打印公钥。
// 用法：node scripts/gen-key.mjs [--out <私钥路径>]
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fail } from './lib/entries.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = resolve(values.out ?? join(homedir(), '.fynvra-signing', 'fynvra-index-signing-key.pem'));

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
try {
  writeFileSync(out, privateKey, { flag: 'wx', mode: 0o600 });
} catch (e) {
  if (e.code === 'EEXIST') fail(`${out} 已存在，拒绝覆盖。请换一个 --out 路径或先手动处理旧私钥`);
  throw e;
}

console.log(`私钥已写入：${out}（不要提交到任何仓库）\n`);
console.log('公钥（SPKI PEM）：\n');
console.log(publicKey);
console.log('下一步：');
console.log(`  1. 把私钥存入 GitHub Actions secret（在 bash 中执行）：`);
console.log(`     gh secret set FYNVRA_INDEX_SIGNING_KEY --repo LAIJiangFeng/fynvra-plugins < ${out}`);
console.log('  2. 把上面的公钥保存为本仓库的 keys/index-public.pem 并提交，CI 会用它验证 dist。');
console.log('  3. 把公钥发给 Fynvra 维护者，内置到客户端中。');
