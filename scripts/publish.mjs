#!/usr/bin/env node
// 合并条目、构建结果和 revoked.json，生成 index.json 并签名，更新 published.json。
// 用法：node scripts/publish.mjs --dist <dist 目录> --build <构建输出> [--key <私钥 pem>]
// 不带 --key 时从环境变量 FYNVRA_INDEX_SIGNING_KEY 读取私钥；没有私钥直接报错，绝不生成未签名的索引。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { validateIndex } from './lib/contract.mjs';
import { fail, loadEntries, loadRevoked } from './lib/entries.mjs';
import { sha256 } from './lib/hash.mjs';
import { compareVersions } from './lib/semver.mjs';
import { loadPrivateKey, nextSequence, signBytes } from './lib/sign.mjs';

const { values } = parseArgs({ options: { dist: { type: 'string' }, build: { type: 'string' }, key: { type: 'string' } } });
if (!values.dist || !values.build) fail('用法：node scripts/publish.mjs --dist <dir> --build <dir> [--key <pem>]');

const keyPem = values.key ? readFileSync(values.key, 'utf8') : process.env.FYNVRA_INDEX_SIGNING_KEY;
if (!keyPem || !keyPem.trim()) fail('缺少签名私钥：请用 --key 指定，或设置环境变量 FYNVRA_INDEX_SIGNING_KEY');
try {
  loadPrivateKey(keyPem);
} catch (e) {
  fail(`私钥无效：${e.message}`);
}

const { entries, errors } = loadEntries();
const { revoked, errors: revErrors } = loadRevoked();
if (errors.length || revErrors.length) fail(`条目校验失败：\n  ${[...errors, ...revErrors].join('\n  ')}`);

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const dist = values.dist;
const build = readJson(join(values.build, 'build-manifest.json'), null);
if (!build) fail(`${values.build} 中没有 build-manifest.json，请先运行 build.mjs`);
const built = new Map(build.results.map((r) => [`${r.id}@${r.version}`, r]));
const prevIndex = readJson(join(dist, 'index.json'), null);
const published = readJson(join(dist, 'published.json'), {});

const prevPublishedAt = new Map();
for (const p of prevIndex?.plugins ?? []) for (const v of p.versions) prevPublishedAt.set(`${p.id}@${v.version}`, v.publishedAt);

const now = new Date();
const generatedAt = now.toISOString();
const problems = [];

const plugins = [...entries]
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  .map((e) => {
    const versions = e.versions.map((v) => {
      const key = `${e.id}@${v.version}`;
      const r = built.get(key);
      if (!r) return problems.push(`${key}: 构建结果中没有该版本（请用 build.mjs --all 构建）`), null;
      if (r.commit !== v.commit) return problems.push(`${key}: 构建用的提交 ${r.commit} 与条目 ${v.commit} 不一致`), null;
      const pub = published[key];
      if (pub && (pub.commit !== r.commit || pub.sha256 !== r.package.sha256 || pub.size !== r.package.size)) {
        return problems.push(`${key}: 已发布版本不可变，构建结果与 published.json 不一致`), null;
      }
      return {
        version: v.version,
        ...(r.engines ? { engines: r.engines } : {}),
        commit: v.commit,
        permissions: r.permissions,
        changelog: v.changelog,
        publishedAt: prevPublishedAt.get(key) ?? generatedAt,
        package: r.package,
        ...(r.readme ? { readme: r.readme } : {}),
      };
    });
    return {
      id: e.id,
      name: e.name,
      description: e.description,
      author: e.author,
      ...(e.homepage ? { homepage: e.homepage } : {}),
      repository: e.repository,
      license: e.license,
      category: e.category,
      tags: e.tags,
      tier: e.tier,
      versions: versions.filter(Boolean).sort((a, b) => compareVersions(b.version, a.version)),
    };
  });
if (problems.length) fail(`无法发布：\n  ${problems.join('\n  ')}`);

const index = {
  schemaVersion: 1,
  sequence: nextSequence(prevIndex?.sequence, Math.floor(now.getTime() / 1000)),
  generatedAt,
  plugins,
  revoked,
};
const idxErrors = validateIndex(index);
if (idxErrors.length) fail(`生成的索引不符合契约：\n  ${idxErrors.join('\n  ')}`);

// 把新构建的包和 readme 拷进 dist，并逐个核对哈希
function place(ref) {
  const target = join(dist, ref.path);
  const source = join(values.build, ref.path);
  if (!existsSync(target) || sha256(readFileSync(target)) !== ref.sha256) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  const buf = readFileSync(target);
  if (sha256(buf) !== ref.sha256 || buf.length !== ref.size) fail(`${ref.path} 哈希或大小不符`);
}
for (const p of plugins) {
  for (const v of p.versions) {
    place(v.package);
    if (v.readme) place(v.readme);
    published[`${p.id}@${v.version}`] = { commit: v.commit, sha256: v.package.sha256, size: v.package.size };
  }
}

const sortedPublished = Object.fromEntries(Object.keys(published).sort().map((k) => [k, published[k]]));
const bytes = Buffer.from(JSON.stringify(index, null, 2) + '\n', 'utf8');
const sig = signBytes(bytes, keyPem);
writeFileSync(join(dist, 'index.json'), bytes);
writeFileSync(join(dist, 'index.json.sig'), sig + '\n');
writeFileSync(join(dist, 'published.json'), JSON.stringify(sortedPublished, null, 2) + '\n');
console.log(`已发布并签名：sequence ${index.sequence}，${plugins.length} 个插件，${revoked.length} 条撤回记录。`);
