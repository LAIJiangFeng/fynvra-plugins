#!/usr/bin/env node
// 构建插件包：取源码 → 校验清单 → 安装依赖（--ignore-scripts）→ 收集文件 → 确定性 zip → 写出 build-manifest.json。
// 用法：node scripts/build.mjs (--all | --changed <base-ref>) [--out <dir>] [--published <dist>/published.json]
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { isSelfRepo, isValidPath, manifestKind, MAX_PACKAGE_SIZE, MAX_README_SIZE } from './lib/contract.mjs';
import { fail, loadEntries, REPO_ROOT } from './lib/entries.mjs';
import { collectFiles, copyTree } from './lib/files.mjs';
import { sha256 } from './lib/hash.mjs';
import { checkHostMain, checkManifest, checkPluginRoot, checkPublished, hasDependencies, pluginKind } from './lib/plugin.mjs';
import { createZip, readZip } from './lib/zip.mjs';

const { values } = parseArgs({
  options: {
    all: { type: 'boolean' },
    changed: { type: 'string' },
    out: { type: 'string', default: '.build' },
    published: { type: 'string' },
  },
});
if (Boolean(values.all) === Boolean(values.changed)) fail('需要且只能指定 --all 或 --changed <base-ref> 之一');

const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: REPO_ROOT, maxBuffer: 1 << 30, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts });

const { entries, errors } = loadEntries();
if (errors.length) fail(`条目校验失败，请先运行 node scripts/validate.mjs：\n  ${errors.join('\n  ')}`);

// 选出要构建的版本
const targets = [];
if (values.all) {
  for (const entry of entries) for (const v of entry.versions) targets.push({ entry, v });
} else {
  const base = values.changed;
  const changed = git(['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`, '--', 'plugins/'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => /^plugins\/[^/]+\.json$/.test(f));
  for (const file of changed) {
    const entry = entries.find((e) => `plugins/${e.id}.json` === file);
    if (!entry) continue;
    let old = null;
    try {
      old = JSON.parse(git(['show', `${base}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
      // base 中没有这个条目：新插件
    }
    for (const v of entry.versions) {
      const same = old?.versions?.some?.((o) => o.version === v.version && o.commit === v.commit);
      if (!same) targets.push({ entry, v });
    }
  }
}

// 已发布记录（不可变检查用）
let published = {};
let distDir = null;
if (values.published) {
  distDir = dirname(resolve(values.published));
  if (existsSync(values.published)) published = JSON.parse(readFileSync(values.published, 'utf8'));
}

// 准备输出目录：只清理之前的构建输出，避免误删其他目录
const out = resolve(values.out);
if (existsSync(out)) {
  const items = readdirSync(out);
  if (items.length && !items.includes('build-manifest.json')) fail(`输出目录 ${out} 非空且不是构建输出目录，拒绝覆盖`);
  rmSync(out, { recursive: true, force: true });
}
mkdirSync(out, { recursive: true });

function writeOut(rel, data) {
  const file = join(out, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

// 取源码到 dest（插件根目录内容直接位于 dest 下）
function fetchSource(entry, v, dest) {
  const sub = v.path ?? '';
  if (sub && !isValidPath(sub)) throw new Error(`path 不合法：${sub}`);
  mkdirSync(dest, { recursive: true });
  if (isSelfRepo(entry.repository)) {
    const buf = git(['archive', '--format=zip', v.commit, ...(sub ? ['--', sub] : [])]);
    const prefix = sub ? `${sub}/` : '';
    let n = 0;
    for (const e of readZip(buf)) {
      if (e.isDir || e.isSymlink || !e.path.startsWith(prefix)) continue;
      const rel = e.path.slice(prefix.length);
      if (/[\\:]/.test(rel) || !rel.split('/').every((s) => s && s !== '.' && s !== '..')) throw new Error(`归档中有不安全的路径：${e.path}`);
      const file = join(dest, ...rel.split('/'));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, e.data);
      n++;
    }
    if (!n) throw new Error(`提交 ${v.commit} 的 ${sub || '根目录'} 下没有文件`);
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'fynvra-src-'));
  try {
    git(['clone', '--filter=blob:none', '--no-checkout', '--quiet', '--', entry.repository, tmp], { stdio: 'inherit' });
    git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', v.commit], { cwd: tmp, stdio: 'inherit' });
    const root = resolve(tmp, ...sub.split('/').filter(Boolean));
    if (root !== tmp && !root.startsWith(tmp + sep)) throw new Error(`path 越出仓库：${sub}`);
    if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`提交 ${v.commit} 中没有目录 ${sub || '/'}`);
    copyTree(root, dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 只在有运行时依赖时安装，并且绝不执行安装脚本
function installDeps(root, pkg) {
  if (!hasDependencies(pkg)) return;
  const lock = existsSync(join(root, 'package-lock.json')) || existsSync(join(root, 'npm-shrinkwrap.json'));
  const args = lock
    ? ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']
    : ['install', '--omit=dev', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund'];
  const r = spawnSync('npm', args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  });
  if (r.status !== 0) throw new Error(`npm ${args[0]} 失败（退出码 ${r.status}）`);
}

function buildOne(entry, v) {
  const { id } = entry;
  const { version, commit } = v;
  const pkgRel = `packages/${id}/${version}.zip`;
  const readmeRel = `readme/${id}/${version}.md`;

  if (checkPublished(published, id, version, commit) === 'reuse') {
    // 已发布且提交相同：直接复用已发布的包，不重新打
    const rec = published[`${id}@${version}`];
    const zip = readFileSync(join(distDir, pkgRel));
    if (sha256(zip) !== rec.sha256 || zip.length !== rec.size) throw new Error(`dist 中的 ${pkgRel} 与 published.json 记录不符`);
    const zipEntries = readZip(zip);
    const mf = zipEntries.find((e) => e.path === 'fynvra-plugin.json');
    if (!mf) throw new Error(`已发布包 ${pkgRel} 缺少 fynvra-plugin.json`);
    const manifest = checkManifest(JSON.parse(mf.data.toString('utf8')), id, version, entry.tier);
    checkHostMain(manifest, zipEntries.filter((e) => !e.isDir && !e.isSymlink).map((e) => e.path));
    writeOut(pkgRel, zip);
    let readme = null;
    const distReadme = join(distDir, readmeRel);
    if (existsSync(distReadme)) {
      const buf = readFileSync(distReadme);
      writeOut(readmeRel, buf);
      readme = { path: readmeRel, sha256: sha256(buf), size: buf.length };
    }
    return result(manifest, { path: pkgRel, sha256: rec.sha256, size: rec.size }, readme, true);
  }

  const src = join(out, 'src', id, version);
  fetchSource(entry, v, src);
  const { manifest, pkg } = checkPluginRoot(src, id, version, entry.tier);
  installDeps(src, pkg);
  const { files, skipped } = collectFiles(src);
  for (const s of skipped) console.warn(`  [${id}@${version}] 跳过符号链接或特殊文件：${s}`);
  checkHostMain(manifest, files.map((f) => f.path));
  const zip = createZip(files.map((f) => ({ path: f.path, data: readFileSync(f.abs) })));
  if (zip.length > MAX_PACKAGE_SIZE) throw new Error(`插件包 ${zip.length} 字节，超过上限 ${MAX_PACKAGE_SIZE}`);
  writeOut(pkgRel, zip);

  let readme = null;
  const rf = files.find((f) => f.path === 'README.md');
  if (rf && rf.size > 0 && rf.size <= MAX_README_SIZE) {
    const buf = readFileSync(rf.abs);
    writeOut(readmeRel, buf);
    readme = { path: readmeRel, sha256: sha256(buf), size: buf.length };
  } else if (rf) console.warn(`  [${id}@${version}] README.md 为空或超过 ${MAX_README_SIZE} 字节，未单独输出`);
  return result(manifest, { path: pkgRel, sha256: sha256(zip), size: zip.length }, readme, false);

  function result(m, pkgRef, readmeRef, reused) {
    return {
      id,
      version,
      commit,
      kind: manifestKind(m),
      permissions: m.permissions,
      engines: m.engines ?? null,
      package: pkgRef,
      readme: readmeRef,
      reused,
    };
  }
}

const results = [];
const failures = [];
for (const { entry, v } of targets) {
  const key = `${entry.id}@${v.version}`;
  try {
    const r = buildOne(entry, v);
    results.push(r);
    console.log(`${r.reused ? '复用' : '构建'} ${key}  ${r.package.sha256}  ${r.package.size} 字节`);
  } catch (e) {
    failures.push(`${key}: ${e.message}`);
  }
}
// 本次构建中同一插件的各版本 kind 必须一致（完整检查在 publish.mjs）
for (const id of new Set(results.map((r) => r.id))) {
  try {
    pluginKind(id, results.filter((r) => r.id === id).map((r) => r.kind));
  } catch (e) {
    failures.push(e.message);
  }
}
writeFileSync(join(out, 'build-manifest.json'), JSON.stringify({ schemaVersion: 1, results }, null, 2) + '\n');

if (failures.length) {
  console.error(`构建失败，共 ${failures.length} 个版本：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`完成：${results.length} 个版本，输出在 ${relative(process.cwd(), out) || '.'}`);
