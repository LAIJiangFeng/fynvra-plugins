// 收集要打包的文件：跳过符号链接，排除 .git/.github/node_modules/.bin，遇到 .node 原生模块直接失败，并检查上限。
import { copyFileSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ENTRIES, MAX_UNPACKED_SIZE } from './contract.mjs';

const EXCLUDED_NAMES = new Set(['.git', '.github']);

function isExcluded(rel) {
  const segs = rel.split('/');
  if (segs.some((s) => EXCLUDED_NAMES.has(s))) return true;
  return segs.at(-1) === '.bin' && segs.at(-2) === 'node_modules';
}

const sortedNames = (dir) => readdirSync(dir).sort();

// 返回 { files: [{ path, abs, size }], skipped: [相对路径], totalSize }
export function collectFiles(root, limits = {}) {
  const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
  const maxTotal = limits.maxTotal ?? MAX_UNPACKED_SIZE;
  const files = [];
  const skipped = [];
  let totalSize = 0;

  const walk = (dir, rel) => {
    for (const name of sortedNames(dir)) {
      const r = rel ? `${rel}/${name}` : name;
      const abs = join(dir, name);
      const st = lstatSync(abs);
      // Windows 上的目录联接（junction）也会被 lstat 识别为符号链接
      if (st.isSymbolicLink()) {
        skipped.push(r);
        continue;
      }
      if (isExcluded(r)) continue;
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) {
        if (name.toLowerCase().endsWith('.node')) throw new Error(`包含原生模块 ${r}，插件包不允许 .node 文件`);
        files.push({ path: r, abs, size: st.size });
        totalSize += st.size;
        if (files.length > maxEntries) throw new Error(`文件数超过上限 ${maxEntries}`);
        if (totalSize > maxTotal) throw new Error(`解压后总大小超过上限 ${maxTotal} 字节`);
      } else skipped.push(r);
    }
  };
  walk(root, '');
  return { files, skipped, totalSize };
}

// 复制目录树：跳过符号链接和 .git/.github，用于把外部仓库的插件目录拷到构建目录
export function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of sortedNames(src)) {
    if (EXCLUDED_NAMES.has(name)) continue;
    const s = join(src, name);
    const st = lstatSync(s);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) copyTree(s, join(dest, name));
    else if (st.isFile()) copyFileSync(s, join(dest, name));
  }
}
