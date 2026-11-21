import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { collectFiles } from '../lib/files.mjs';
import { sha256 } from '../lib/hash.mjs';
import { checkPluginRoot, checkPublished } from '../lib/plugin.mjs';
import { createZip, readZip } from '../lib/zip.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'fynvra-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function makePlugin(dir, manifest = {}) {
  mkdirSync(join(dir, 'extensions'), { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref');
  writeFileSync(join(dir, 'node_modules', '.bin', 'dep'), '#!/bin/sh');
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');
  writeFileSync(join(dir, 'extensions', 'index.ts'), 'export default function () {}\n');
  writeFileSync(join(dir, 'README.md'), '# 你好\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', pi: { extensions: ['./extensions/index.ts'] } }));
  writeFileSync(
    join(dir, 'fynvra-plugin.json'),
    JSON.stringify({ schemaVersion: 1, id: 'com.example.demo', name: 'Demo', version: '1.0.0', description: '', author: 'a', license: 'MIT', permissions: [], ...manifest }),
  );
}

const zipOf = (dir) => createZip(collectFiles(dir).files.map((f) => ({ path: f.path, data: readFileSync(f.abs) })));

test('确定性 zip：两次打包 sha256 相同，解压内容一致', () => {
  const dir = join(tmp, 'det');
  makePlugin(dir);
  const a = zipOf(dir);
  const b = zipOf(dir);
  assert.equal(sha256(a), sha256(b));
  const files = collectFiles(dir).files;
  const unpacked = readZip(a);
  assert.deepEqual(
    unpacked.map((e) => e.path),
    files.map((f) => f.path),
  );
  for (const f of files) assert.deepEqual(unpacked.find((e) => e.path === f.path).data, readFileSync(f.abs));
  // 排除 .git 和 node_modules/.bin，保留其他依赖
  assert.ok(!unpacked.some((e) => e.path.startsWith('.git/') || e.path.includes('node_modules/.bin')));
  assert.ok(unpacked.some((e) => e.path === 'node_modules/dep/index.js'));
  // 输入顺序不影响结果
  const entries = files.map((f) => ({ path: f.path, data: readFileSync(f.abs) }));
  assert.equal(sha256(createZip([...entries].reverse())), sha256(a));
});

test('符号链接被跳过', (t) => {
  const dir = join(tmp, 'link');
  makePlugin(dir);
  try {
    symlinkSync(join(dir, 'README.md'), join(dir, 'link.md'), 'file');
  } catch {
    // Windows 未开启开发者模式时不能建文件符号链接，改用不需要权限的目录联接
    symlinkSync(join(dir, 'extensions'), join(dir, 'link.md'), 'junction');
  }
  const { files, skipped } = collectFiles(dir);
  assert.deepEqual(skipped, ['link.md']);
  assert.ok(!files.some((f) => f.path.startsWith('link.md')));
});

test('.node 原生模块被拒', () => {
  const dir = join(tmp, 'native');
  makePlugin(dir);
  writeFileSync(join(dir, 'node_modules', 'dep', 'binding.node'), 'x');
  assert.throws(() => collectFiles(dir), /\.node/);
});

test('超出条目数上限被拒', () => {
  const dir = join(tmp, 'limit');
  makePlugin(dir);
  assert.throws(() => collectFiles(dir, { maxEntries: 2 }), /上限/);
});

test('清单与条目不一致被拒', () => {
  const dir = join(tmp, 'mismatch');
  makePlugin(dir);
  assert.equal(checkPluginRoot(dir, 'com.example.demo', '1.0.0').manifest.id, 'com.example.demo');
  assert.throws(() => checkPluginRoot(dir, 'com.example.other', '1.0.0'), /不一致/);
  assert.throws(() => checkPluginRoot(dir, 'com.example.demo', '1.0.1'), /不一致/);
});

test('不是 pi 包被拒', () => {
  const dir = join(tmp, 'notpi');
  makePlugin(dir);
  rmSync(join(dir, 'extensions'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
  assert.throws(() => checkPluginRoot(dir, 'com.example.demo', '1.0.0'), /pi 包/);
});

test('不可变检查', () => {
  const published = { 'com.example.demo@1.0.0': { commit: 'a'.repeat(40), sha256: 'b'.repeat(64), size: 1 } };
  assert.equal(checkPublished(published, 'com.example.demo', '1.0.1', 'c'.repeat(40)), 'new');
  assert.equal(checkPublished(published, 'com.example.demo', '1.0.0', 'a'.repeat(40)), 'reuse');
  assert.throws(() => checkPublished(published, 'com.example.demo', '1.0.0', 'c'.repeat(40)), /不能改为/);
});
