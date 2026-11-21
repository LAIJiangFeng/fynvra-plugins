// 读取并校验注册表条目（plugins/*.json）与 revoked.json
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEntry, validateRevoked } from './contract.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parse(file, label, errors) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${label}: JSON 解析失败：${e.message}`);
    return undefined;
  }
}

// 返回 { entries: [entry], errors: [string] }
export function loadEntries(root = REPO_ROOT) {
  const dir = join(root, 'plugins');
  const errors = [];
  const entries = [];
  const ids = new Set();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.')).sort() : [];
  for (const f of files) {
    if (!f.endsWith('.json')) {
      errors.push(`plugins/${f}: 只允许 <id>.json 条目文件`);
      continue;
    }
    const entry = parse(join(dir, f), `plugins/${f}`, errors);
    if (entry === undefined) continue;
    const errs = validateEntry(entry, f);
    if (errs.length) errors.push(...errs.map((e) => `plugins/${e}`));
    else if (ids.has(entry.id)) errors.push(`plugins/${f}: id ${entry.id} 重复`);
    else {
      ids.add(entry.id);
      entries.push(entry);
    }
  }
  return { entries, errors };
}

export function loadRevoked(root = REPO_ROOT) {
  const errors = [];
  const file = join(root, 'revoked.json');
  if (!existsSync(file)) return { revoked: [], errors: ['缺少 revoked.json'] };
  const revoked = parse(file, 'revoked.json', errors);
  if (revoked !== undefined) errors.push(...validateRevoked(revoked));
  return { revoked: revoked ?? [], errors };
}

export function fail(msg) {
  console.error(`错误：${msg}`);
  process.exit(1);
}
