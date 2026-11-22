// 插件源码检查：fynvra-plugin.json 与条目一致、按 kind 检查（pi 包 / host.main）；以及已发布版本的不可变检查。
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESERVED_ID_MSG, isReservedId, manifestKind, validateManifest } from './contract.mjs';

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${label} 读取失败：${e.message}`);
  }
}

// 校验 fynvra-plugin.json 内容并核对 id/version；com.fynvra.* 还要求条目 tier 为 official；返回清单对象
export function checkManifest(manifest, entryId, version, tier) {
  const errs = validateManifest(manifest);
  if (isReservedId(entryId) && tier !== 'official') errs.push(`${entryId}: ${RESERVED_ID_MSG}（条目 tier 是 ${tier}）`);
  if (manifest && manifest.id !== entryId) errs.push(`fynvra-plugin.json.id 是 "${manifest.id}"，与条目 id "${entryId}" 不一致`);
  if (manifest && manifest.version !== version) errs.push(`fynvra-plugin.json.version 是 "${manifest.version}"，与条目版本 "${version}" 不一致`);
  if (errs.length) throw new Error(errs.join('\n'));
  return manifest;
}

// 检查插件根目录：清单合法且一致；pi 类还要求 package.json 存在且是 pi 包（pi.extensions 或 extensions/ 目录）；
// fynvra 类不要求是 pi 包，package.json 可选（有则用于安装依赖），host.main 是否在包内由 checkHostMain 检查
export function checkPluginRoot(root, entryId, version, tier) {
  const mf = join(root, 'fynvra-plugin.json');
  if (!existsSync(mf)) throw new Error('插件根目录缺少 fynvra-plugin.json');
  const manifest = checkManifest(readJson(mf, 'fynvra-plugin.json'), entryId, version, tier);
  const pf = join(root, 'package.json');
  if (manifestKind(manifest) === 'fynvra') return { manifest, pkg: existsSync(pf) ? readJson(pf, 'package.json') : null };
  if (!existsSync(pf)) throw new Error('插件根目录缺少 package.json');
  const pkg = readJson(pf, 'package.json');
  const exts = pkg?.pi?.extensions;
  const hasPiExts = Array.isArray(exts) && exts.length > 0 && exts.every((e) => typeof e === 'string');
  const extDir = join(root, 'extensions');
  const hasExtDir = existsSync(extDir) && lstatSync(extDir).isDirectory();
  if (!hasPiExts && !hasExtDir) throw new Error('不是合法的 pi 包：package.json 需要 pi.extensions，或提供 extensions/ 目录');
  return { manifest, pkg };
}

// fynvra 类：host.main 必须是打进包里的普通文件；paths 为包内文件的相对路径
export function checkHostMain(manifest, paths) {
  if (manifestKind(manifest) !== 'fynvra') return;
  if (!paths.includes(manifest.host.main)) throw new Error(`host.main 指向的 ${manifest.host.main} 不在插件包里`);
}

// 同一插件各版本的 kind 必须一致；返回该 kind
export function pluginKind(id, kinds) {
  const set = [...new Set(kinds)];
  if (set.length !== 1) throw new Error(`${id}: 各版本的 kind 不一致（${set.join(', ')}）`);
  return set[0];
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
