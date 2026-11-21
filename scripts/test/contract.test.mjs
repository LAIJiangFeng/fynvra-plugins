import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPO_URL, validateEntry, validateIndex, validateManifest, validateRevoked } from '../lib/contract.mjs';
import { compareVersions } from '../lib/semver.mjs';

const SHA = 'a'.repeat(40);

const reviewed = () => ({
  id: 'com.example.demo',
  name: 'Demo',
  description: '示例',
  author: 'Someone',
  repository: 'https://github.com/someone/demo',
  license: 'MIT',
  category: 'tools',
  tags: ['demo'],
  tier: 'reviewed',
  versions: [{ version: '1.0.0', commit: SHA, changelog: '首个版本' }],
});

const official = () => ({
  ...reviewed(),
  id: 'com.fynvra.demo',
  tier: 'official',
  repository: REPO_URL,
  versions: [{ version: '1.0.0', commit: SHA, path: 'official/com.fynvra.demo', changelog: '' }],
});

test('合法的 reviewed / official 条目通过', () => {
  assert.deepEqual(validateEntry(reviewed(), 'com.example.demo.json'), []);
  assert.deepEqual(validateEntry(official(), 'com.fynvra.demo.json'), []);
});

test('文件名与 id 不一致被拒', () => {
  assert.match(validateEntry(reviewed(), 'other.json').join('\n'), /文件名/);
});

test('字段不合法被拒', () => {
  const cases = [
    (e) => (e.id = 'Demo'),
    (e) => (e.category = 'games'),
    (e) => (e.repository = 'http://github.com/x/y'),
    (e) => (e.tags = Array(11).fill('t')),
    (e) => (e.versions[0].commit = 'abc'),
    (e) => (e.versions[0].commit = 'A'.repeat(40)),
    (e) => (e.versions[0].version = '1.0'),
    (e) => (e.versions[0].path = '../x'),
    (e) => (e.versions = []),
    (e) => e.versions.push({ ...e.versions[0] }),
    (e) => (e.extra = 1),
    (e) => (e.name = 'x'.repeat(61)),
  ];
  for (const mutate of cases) {
    const e = reviewed();
    mutate(e);
    assert.ok(validateEntry(e, `${e.id}.json`).length > 0, `应拒绝：${mutate}`);
  }
});

test('official 必须指向本仓库且 path 以 official/ 开头', () => {
  const a = official();
  a.repository = 'https://github.com/someone/demo';
  assert.match(validateEntry(a).join('\n'), /official 插件的 repository/);
  const b = official();
  b.versions[0].path = 'plugins/demo';
  assert.match(validateEntry(b).join('\n'), /official\//);
  const c = official();
  delete c.versions[0].path;
  assert.ok(validateEntry(c).length > 0);
});

test('reviewed 不能指向本仓库', () => {
  const e = reviewed();
  e.repository = REPO_URL + '.git';
  assert.match(validateEntry(e).join('\n'), /reviewed/);
});

test('revoked.json 校验', () => {
  assert.deepEqual(validateRevoked([]), []);
  assert.deepEqual(validateRevoked([{ id: 'com.example.demo', versions: 'all', reason: '恶意' }]), []);
  assert.ok(validateRevoked([{ id: 'com.example.demo', versions: ['1'], reason: 'x' }]).length > 0);
  assert.ok(validateRevoked([{ id: 'com.example.demo', versions: 'all', reason: 'x'.repeat(201) }]).length > 0);
  assert.ok(validateRevoked({}).length > 0);
});

test('插件清单校验', () => {
  const m = { schemaVersion: 1, id: 'com.example.demo', name: 'Demo', version: '1.0.0', description: '', author: 'a', license: 'MIT', engines: { fynvra: '>=0.1.0' }, permissions: ['network'] };
  assert.deepEqual(validateManifest(m), []);
  assert.ok(validateManifest({ ...m, permissions: ['root'] }).length > 0);
  assert.ok(validateManifest({ ...m, engines: { fynvra: '^1.0.0' } }).length > 0);
  assert.ok(validateManifest({ ...m, schemaVersion: 2 }).length > 0);
});

test('版本比较遵循 semver 优先级', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
});

// ---- 契约 v1.1：kind / host.main / 按 kind 的权限词表 / 索引 kind ----

const baseManifest = () => ({ schemaVersion: 1, id: 'com.fynvra.bot', name: 'Bot', version: '1.0.0', description: '', author: 'a', license: 'MIT', permissions: [] });
const fynvraManifest = () => ({ ...baseManifest(), kind: 'fynvra', host: { main: 'dist/main.mjs' }, permissions: ['notifications', 'channel'] });

test('kind 缺省按 pi，fynvra 类需要合法 host.main', () => {
  assert.deepEqual(validateManifest(baseManifest()), []);
  assert.deepEqual(validateManifest({ ...baseManifest(), kind: 'pi' }), []);
  assert.deepEqual(validateManifest(fynvraManifest()), []);
  assert.deepEqual(validateManifest({ ...fynvraManifest(), host: { main: 'main.js' } }), []);
  assert.ok(validateManifest({ ...baseManifest(), kind: 'other' }).length > 0);
  // pi 类不能声明 host
  assert.ok(validateManifest({ ...baseManifest(), host: { main: 'main.js' } }).length > 0);
  const bad = [undefined, {}, { main: 'main.js', extra: 1 }, { main: '../main.js' }, { main: 'a/../main.js' }, { main: 'dist\\main.js' }, { main: 'C:/main.js' }, { main: '/main.js' }, { main: 'main.ts' }, { main: 'main.cjs' }, { main: 'main' }, { main: '' }];
  for (const host of bad) {
    const m = fynvraManifest();
    if (host === undefined) delete m.host;
    else m.host = host;
    assert.match(validateManifest(m).join('\n'), /host/, `应拒绝 host=${JSON.stringify(host)}`);
  }
});

test('权限词表按 kind 校验', () => {
  for (const p of ['network', 'filesystem', 'shell', 'env', 'model-keys']) assert.deepEqual(validateManifest({ ...baseManifest(), permissions: [p] }), []);
  for (const p of ['notifications', 'workspaces', 'channel', 'ui']) assert.ok(validateManifest({ ...baseManifest(), permissions: [p] }).length > 0, `pi 不应接受 ${p}`);
  for (const p of ['notifications', 'network', 'workspaces', 'channel', 'ui']) assert.deepEqual(validateManifest({ ...fynvraManifest(), permissions: [p] }), []);
  for (const p of ['filesystem', 'shell', 'env', 'model-keys', 'root']) assert.ok(validateManifest({ ...fynvraManifest(), permissions: [p] }).length > 0, `fynvra 不应接受 ${p}`);
});

const indexOf = (plugin) => ({
  schemaVersion: 1,
  sequence: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  revoked: [],
  plugins: [
    {
      ...official(),
      kind: 'pi',
      versions: [
        {
          version: '1.0.0',
          commit: SHA,
          permissions: ['shell'],
          changelog: '',
          publishedAt: '2026-01-01T00:00:00.000Z',
          package: { path: 'packages/com.fynvra.demo/1.0.0.zip', sha256: 'b'.repeat(64), size: 10 },
        },
      ],
      ...plugin,
    },
  ],
});

test('索引插件级 kind 必填，权限按 kind 校验，fynvra 只接受 official', () => {
  assert.deepEqual(validateIndex(indexOf({})), []);
  const noKind = indexOf({});
  delete noKind.plugins[0].kind;
  assert.match(validateIndex(noKind).join('\n'), /kind/);
  assert.match(validateIndex(indexOf({ kind: 'x' })).join('\n'), /kind/);
  // fynvra 类的版本权限用 fynvra 词表
  assert.match(validateIndex(indexOf({ kind: 'fynvra' })).join('\n'), /未知权限/);
  const ok = indexOf({ kind: 'fynvra' });
  ok.plugins[0].versions[0].permissions = ['notifications'];
  assert.deepEqual(validateIndex(ok), []);
  ok.plugins[0].tier = 'reviewed';
  assert.match(validateIndex(ok).join('\n'), /Fynvra 插件目前只接受官方插件/);
});
