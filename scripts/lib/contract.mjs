// 共同契约 v1 的校验：注册表条目、revoked.json、插件清单 fynvra-plugin.json、index.json。
// 所有校验函数都返回错误信息数组（空数组表示通过），不抛异常，方便一次性列出全部问题。

export const REPO_URL = 'https://github.com/LAIJiangFeng/fynvra-plugins';

export const ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/;
export const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const PATH_RE = /^[A-Za-z0-9._/-]+$/;
export const ENGINE_RE = /^>=\d+\.\d+\.\d+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const CATEGORIES = ['tools', 'integration', 'productivity', 'dev', 'other'];
export const TIERS = ['official', 'reviewed'];
export const PERMISSIONS = ['network', 'filesystem', 'shell', 'env', 'model-keys'];

export const MAX_PACKAGE_SIZE = 50 * 1024 * 1024;
export const MAX_README_SIZE = 256 * 1024;
export const MAX_UNPACKED_SIZE = 200 * 1024 * 1024;
export const MAX_ENTRIES = 20000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkKeys(errs, where, obj, allowed) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errs.push(`${where}: 不认识的字段 "${k}"`);
  }
}

function checkStr(errs, where, v, min, max, re) {
  if (typeof v !== 'string') return errs.push(`${where}: 必须是字符串`);
  const n = [...v].length;
  if (n < min || n > max) return errs.push(`${where}: 长度须在 ${min}–${max} 之间（当前 ${n}）`);
  if (re && !re.test(v)) errs.push(`${where}: 格式不合法 ${JSON.stringify(v)}`);
}

function checkHttps(errs, where, v) {
  const before = errs.length;
  checkStr(errs, where, v, 1, 500);
  if (errs.length > before) return;
  let u;
  try {
    u = new URL(v);
  } catch {
    return errs.push(`${where}: 不是合法 URL ${JSON.stringify(v)}`);
  }
  if (u.protocol !== 'https:' || u.username || u.password) errs.push(`${where}: 必须是不带凭据的 https 地址`);
}

function checkIso(errs, where, v) {
  if (typeof v !== 'string' || !ISO_RE.test(v) || Number.isNaN(Date.parse(v))) errs.push(`${where}: 必须是 ISO 时间`);
}

// 相对 POSIX 路径：只含安全字符，不以 / 开头，不含 ..、. 或空段
export function isValidPath(p) {
  if (typeof p !== 'string' || !PATH_RE.test(p) || p.startsWith('/')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function checkPermissions(errs, where, v) {
  if (!Array.isArray(v)) return errs.push(`${where}: 必须是数组`);
  const seen = new Set();
  for (const p of v) {
    if (!PERMISSIONS.includes(p)) errs.push(`${where}: 未知权限 ${JSON.stringify(p)}（可选 ${PERMISSIONS.join(', ')}）`);
    else if (seen.has(p)) errs.push(`${where}: 权限 ${p} 重复`);
    seen.add(p);
  }
}

function checkEngines(errs, where, v) {
  if (v === undefined) return;
  if (!isObj(v)) return errs.push(`${where}: 必须是对象`);
  checkKeys(errs, where, v, ['fynvra']);
  checkStr(errs, `${where}.fynvra`, v.fynvra, 1, 40, ENGINE_RE);
}

function checkVersionStr(errs, where, v) {
  checkStr(errs, where, v, 1, 40, VERSION_RE);
}

// 条目与 index 共有的展示字段
function checkCommon(errs, where, o) {
  checkStr(errs, `${where}.name`, o.name, 1, 60);
  checkStr(errs, `${where}.description`, o.description, 0, 1000);
  checkStr(errs, `${where}.author`, o.author, 1, 100);
  if (o.homepage !== undefined) checkHttps(errs, `${where}.homepage`, o.homepage);
  checkHttps(errs, `${where}.repository`, o.repository);
  checkStr(errs, `${where}.license`, o.license, 1, 40);
  if (!CATEGORIES.includes(o.category)) errs.push(`${where}.category: 必须是 ${CATEGORIES.join(' / ')} 之一`);
  if (!Array.isArray(o.tags) || o.tags.length > 10) errs.push(`${where}.tags: 必须是不超过 10 项的数组`);
  else o.tags.forEach((t, i) => checkStr(errs, `${where}.tags[${i}]`, t, 1, 32));
  if (!TIERS.includes(o.tier)) errs.push(`${where}.tier: 必须是 official 或 reviewed`);
}

// 统一仓库地址的写法，用于判断是否为本仓库
export function normalizeRepo(url) {
  return String(url).trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
}

export function isSelfRepo(url) {
  return normalizeRepo(url) === normalizeRepo(REPO_URL);
}

const ENTRY_KEYS = ['id', 'name', 'description', 'author', 'homepage', 'repository', 'license', 'category', 'tags', 'tier', 'versions'];
const ENTRY_VERSION_KEYS = ['version', 'commit', 'path', 'changelog'];

// 校验 plugins/<id>.json；fileName 传入时核对文件名与 id 一致
export function validateEntry(entry, fileName) {
  const where = fileName ?? 'entry';
  const errs = [];
  if (!isObj(entry)) return [`${where}: 必须是 JSON 对象`];
  checkKeys(errs, where, entry, ENTRY_KEYS);
  checkStr(errs, `${where}.id`, entry.id, 1, 64, ID_RE);
  if (fileName !== undefined && fileName !== `${entry.id}.json`) errs.push(`${where}: 文件名必须是 "${entry.id}.json"`);
  checkCommon(errs, where, entry);

  if (!Array.isArray(entry.versions) || entry.versions.length === 0) {
    errs.push(`${where}.versions: 至少需要 1 个版本`);
    return errs;
  }
  const seen = new Set();
  entry.versions.forEach((v, i) => {
    const w = `${where}.versions[${i}]`;
    if (!isObj(v)) return errs.push(`${w}: 必须是对象`);
    checkKeys(errs, w, v, ENTRY_VERSION_KEYS);
    checkVersionStr(errs, `${w}.version`, v.version);
    if (seen.has(v.version)) errs.push(`${w}.version: 版本 ${v.version} 重复`);
    seen.add(v.version);
    if (typeof v.commit !== 'string' || !COMMIT_RE.test(v.commit)) errs.push(`${w}.commit: 必须是 40 位小写十六进制提交 SHA`);
    if (v.path !== undefined && !isValidPath(v.path)) errs.push(`${w}.path: 必须是仓库内的相对 POSIX 路径`);
    checkStr(errs, `${w}.changelog`, v.changelog, 0, 2000);
    if (entry.tier === 'official' && !(typeof v.path === 'string' && v.path.startsWith('official/'))) {
      errs.push(`${w}.path: official 插件的 path 必须以 official/ 开头`);
    }
  });

  if (entry.tier === 'official' && !isSelfRepo(entry.repository)) {
    errs.push(`${where}.repository: official 插件的 repository 必须是 ${REPO_URL}`);
  }
  if (entry.tier === 'reviewed' && typeof entry.repository === 'string' && isSelfRepo(entry.repository)) {
    errs.push(`${where}.repository: reviewed 插件不能指向本注册表仓库`);
  }
  return errs;
}

function validateRevokedItem(errs, w, r) {
  if (!isObj(r)) return errs.push(`${w}: 必须是对象`);
  checkKeys(errs, w, r, ['id', 'versions', 'reason']);
  checkStr(errs, `${w}.id`, r.id, 1, 64, ID_RE);
  if (r.versions !== 'all') {
    if (!Array.isArray(r.versions) || r.versions.length === 0) errs.push(`${w}.versions: 必须是 "all" 或非空版本数组`);
    else r.versions.forEach((v, j) => checkVersionStr(errs, `${w}.versions[${j}]`, v));
  }
  checkStr(errs, `${w}.reason`, r.reason, 0, 200);
}

export function validateRevoked(list, where = 'revoked.json') {
  if (!Array.isArray(list)) return [`${where}: 必须是数组`];
  const errs = [];
  list.forEach((r, i) => validateRevokedItem(errs, `${where}[${i}]`, r));
  return errs;
}

const MANIFEST_KEYS = ['schemaVersion', 'id', 'name', 'version', 'description', 'author', 'license', 'engines', 'permissions'];

// 校验插件根目录的 fynvra-plugin.json
export function validateManifest(m, where = 'fynvra-plugin.json') {
  const errs = [];
  if (!isObj(m)) return [`${where}: 必须是 JSON 对象`];
  checkKeys(errs, where, m, MANIFEST_KEYS);
  if (m.schemaVersion !== 1) errs.push(`${where}.schemaVersion: 必须是 1`);
  checkStr(errs, `${where}.id`, m.id, 1, 64, ID_RE);
  checkStr(errs, `${where}.name`, m.name, 1, 60);
  checkVersionStr(errs, `${where}.version`, m.version);
  checkStr(errs, `${where}.description`, m.description, 0, 1000);
  checkStr(errs, `${where}.author`, m.author, 1, 100);
  checkStr(errs, `${where}.license`, m.license, 1, 40);
  checkEngines(errs, `${where}.engines`, m.engines);
  checkPermissions(errs, `${where}.permissions`, m.permissions);
  return errs;
}

function checkFileRef(errs, where, f, max) {
  if (!isObj(f)) return errs.push(`${where}: 必须是对象`);
  checkKeys(errs, where, f, ['path', 'sha256', 'size']);
  if (!isValidPath(f.path)) errs.push(`${where}.path: 必须是相对 POSIX 路径`);
  if (typeof f.sha256 !== 'string' || !SHA256_RE.test(f.sha256)) errs.push(`${where}.sha256: 必须是 64 位小写十六进制`);
  if (!Number.isInteger(f.size) || f.size <= 0 || f.size > max) errs.push(`${where}.size: 必须是 1–${max} 的整数`);
}

const INDEX_PLUGIN_KEYS = ENTRY_KEYS;
const INDEX_VERSION_KEYS = ['version', 'engines', 'commit', 'permissions', 'changelog', 'publishedAt', 'package', 'readme'];

// 校验完整的 index.json（schemaVersion 1）
export function validateIndex(idx) {
  const errs = [];
  if (!isObj(idx)) return ['index: 必须是 JSON 对象'];
  checkKeys(errs, 'index', idx, ['schemaVersion', 'sequence', 'generatedAt', 'plugins', 'revoked']);
  if (idx.schemaVersion !== 1) errs.push('index.schemaVersion: 必须是 1');
  if (!Number.isSafeInteger(idx.sequence) || idx.sequence <= 0) errs.push('index.sequence: 必须是正整数');
  checkIso(errs, 'index.generatedAt', idx.generatedAt);
  if (!Array.isArray(idx.plugins)) errs.push('index.plugins: 必须是数组');
  else {
    const ids = new Set();
    idx.plugins.forEach((p, i) => {
      const w = `index.plugins[${i}]`;
      if (!isObj(p)) return errs.push(`${w}: 必须是对象`);
      checkKeys(errs, w, p, INDEX_PLUGIN_KEYS);
      checkStr(errs, `${w}.id`, p.id, 1, 64, ID_RE);
      if (ids.has(p.id)) errs.push(`${w}.id: ${p.id} 重复`);
      ids.add(p.id);
      checkCommon(errs, w, p);
      if (!Array.isArray(p.versions) || p.versions.length === 0) return errs.push(`${w}.versions: 至少需要 1 个版本`);
      const vs = new Set();
      p.versions.forEach((v, j) => {
        const vw = `${w}.versions[${j}]`;
        if (!isObj(v)) return errs.push(`${vw}: 必须是对象`);
        checkKeys(errs, vw, v, INDEX_VERSION_KEYS);
        checkVersionStr(errs, `${vw}.version`, v.version);
        if (vs.has(v.version)) errs.push(`${vw}.version: 重复`);
        vs.add(v.version);
        checkEngines(errs, `${vw}.engines`, v.engines);
        if (typeof v.commit !== 'string' || !COMMIT_RE.test(v.commit)) errs.push(`${vw}.commit: 必须是 40 位十六进制`);
        checkPermissions(errs, `${vw}.permissions`, v.permissions);
        checkStr(errs, `${vw}.changelog`, v.changelog, 0, 2000);
        checkIso(errs, `${vw}.publishedAt`, v.publishedAt);
        checkFileRef(errs, `${vw}.package`, v.package, MAX_PACKAGE_SIZE);
        if (v.readme !== undefined) checkFileRef(errs, `${vw}.readme`, v.readme, MAX_README_SIZE);
      });
    });
  }
  errs.push(...validateRevoked(idx.revoked, 'index.revoked'));
  return errs;
}
