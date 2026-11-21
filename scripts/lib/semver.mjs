// 契约里的版本号：x.y.z 加可选预发布标识（不支持 +build）。按 semver 优先级比较。
import { VERSION_RE } from './contract.mjs';

export function parseVersion(v) {
  if (typeof v !== 'string' || !VERSION_RE.test(v)) return null;
  const [core, ...rest] = v.split('-');
  const pre = rest.length ? rest.join('-').split('.') : [];
  return { nums: core.split('.').map(Number), pre };
}

function comparePre(a, b) {
  if (!a.length || !b.length) return a.length ? -1 : b.length ? 1 : 0; // 无预发布的版本更高
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i]);
      if (d) return Math.sign(d);
    } else if (an !== bn) return an ? -1 : 1;
    else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`无法比较版本号 ${a} / ${b}`);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return Math.sign(pa.nums[i] - pb.nums[i]);
  }
  return comparePre(pa.pre, pb.pre);
}
