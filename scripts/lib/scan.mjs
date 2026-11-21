// 静态扫描：只做提示，不决定是否通过审核。
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RULES = [
  ['child_process', /\bchild_process\b/],
  ['exec(', /\bexec(Sync|File|FileSync)?\s*\(/],
  ['spawn(', /\bspawn(Sync)?\s*\(/],
  ['eval(', /\beval\s*\(/],
  ['new Function', /\bnew\s+Function\s*\(/],
  ['process.env', /\bprocess\.env\b/],
  ['文件写入', /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|unlink|unlinkSync|rmSync|rmdirSync)\s*\(/],
  ['网络', /\b(require\(\s*|from\s+|import\(\s*)['"](node:)?(http|https|net|tls|dgram)['"]|\bfetch\s*\(|\bWebSocket\b|\bnet\.\w/],
  ['.ssh', /\.ssh\b/],
  ['os.homedir', /\bhomedir\s*\(/],
  ["require('electron')", /\b(require\(\s*|from\s+|import\(\s*)['"]electron['"]/],
  ['疑似大段 base64', /[A-Za-z0-9+/]{400,}={0,2}/],
];
const LONG_LINE = 1000;
const TEXT_EXT = /\.(m?js|cjs|m?ts|cts|jsx|tsx|sh|py)$/i;
const MAX_SCAN_SIZE = 5 * 1024 * 1024;

// 返回 { own: { 规则: [文件:行] }, nodeModules: { 规则: 次数 }, files }
export function scanDir(root) {
  const own = {};
  const nodeModules = {};
  let files = 0;
  const hit = (rule, rel, line) => {
    if (rel.split('/').includes('node_modules')) nodeModules[rule] = (nodeModules[rule] ?? 0) + 1;
    else (own[rule] ??= []).push(`${rel}:${line}`);
  };
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink() || name === '.git') continue;
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile() && TEXT_EXT.test(name) && st.size <= MAX_SCAN_SIZE) {
        files++;
        readFileSync(abs, 'utf8').split('\n').forEach((text, i) => {
          for (const [rule, re] of RULES) if (re.test(text)) hit(rule, r, i + 1);
          if (text.length > LONG_LINE) hit(`超长行（>${LONG_LINE} 字符）`, r, i + 1);
        });
      }
    }
  };
  walk(root, '');
  return { own, nodeModules, files };
}

export function renderReport(title, result, permissions) {
  const lines = [`### ${title}`, ''];
  if (permissions) lines.push(`声明的权限：${permissions.length ? permissions.join(', ') : '（无）'}`, '');
  lines.push(`扫描了 ${result.files} 个源码文件。`, '');
  const rules = Object.keys(result.own);
  if (rules.length) {
    lines.push('| 项目 | 次数 | 示例 |', '| --- | --- | --- |');
    for (const r of rules) {
      const hits = result.own[r];
      lines.push(`| ${r} | ${hits.length} | ${hits.slice(0, 5).map((h) => `\`${h}\``).join(' ')} |`);
    }
  } else lines.push('插件自身代码未命中任何扫描项。');
  const nm = Object.entries(result.nodeModules);
  if (nm.length) {
    lines.push('', '**node_modules 汇总：** ' + nm.map(([r, n]) => `${r} × ${n}`).join('，'));
  }
  lines.push('');
  return lines.join('\n');
}
