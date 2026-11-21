// 插件源码检查：fynvra-plugin.json 与条目一致、是合法 pi 包；以及已发布版本的不可变检查。
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest } from './contract.mjs';

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${label} 读取失败：${e.message}`);
  }
}

// 校验 fynvra-plugin.json 内容并核对 id/version；返回清单对象
export function checkManifest(manifest, entryId, version) {
  const errs = validateManifest(manifest);
  if (manifest && manifest.id !== entryId) errs.push(`fynvra-plugin.json.id 是 "${manifest.id}"，与条目 id "${entryId}" 不一致`);
  if (manifest && manifest.version !== version) errs.push(`fynvra-plugin.json.version 是 "${manifest.version}"，与条目版本 "${version}" 不一致`);
  if (errs.length) throw new Error(errs.join('\n'));
  return manifest;
}

// 检查插件根目录：清单合法且一致、package.json 存在、是 pi 包（pi.extensions 或 extensions/ 目录）
export function checkPluginRoot(root, entryId, version) {
  const mf = join(root, 'fynvra-plugin.json');
  if (!existsSync(mf)) throw new Error('插件根目录缺少 fynvra-plugin.json');
  const manifest = checkManifest(readJson(mf, 'fynvra-plugin.json'), entryId, version);
  const pf = join(root, 'package.json');
  if (!existsSync(pf)) throw new Error('插件根目录缺少 package.json');
  const pkg = readJson(pf, 'package.json');
  const exts = pkg?.pi?.extensions;
  const hasPiExts = Array.isArray(exts) && exts.length > 0 && exts.every((e) => typeof e === 'string');
  const extDir = join(root, 'extensions');
  const hasExtDir = existsSync(extDir) && lstatSync(extDir).isDirectory();
  if (!hasPiExts && !hasExtDir) throw new Error('不是合法的 pi 包：package.json 需要 pi.extensions，或提供 extensions/ 目录');
  return { manifest, pkg };
}

export function hasDependencies(pkg) {
  const d = pkg?.dependencies;
  return d !== null && typeof d === 'object' && Object.keys(d).length > 0;
}

// 不可变检查：返回 'new'（未发布）或 'reuse'（已发布且提交相同）；提交不同则抛错
export function checkPublished(published, id, version, commit) {
  const rec = published?.[`${id}@${version}`];
  if (!rec) return 'new';
  if (rec.commit !== commit) {
    throw new Error(`${id}@${version} 已用提交 ${rec.commit} 发布，不能改为 ${commit}；请发布新版本号`);
  }
  return 'reuse';
}
