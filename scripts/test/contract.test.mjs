import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPO_URL, validateEntry, validateManifest, validateRevoked } from '../lib/contract.mjs';
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
