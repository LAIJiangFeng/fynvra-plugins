import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scanDir } from '../lib/scan.mjs';
import { nextSequence, signBytes, verifyBytes } from '../lib/sign.mjs';

// 测试密钥只在内存中生成，不落盘
const keys = () =>
  generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

test('签名后验签通过，篡改一个字节后失败', () => {
  const { privateKey, publicKey } = keys();
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, sequence: 1 }) + '\n');
  const sig = signBytes(bytes, privateKey);
  assert.ok(verifyBytes(bytes, sig + '\n', publicKey));
  const tampered = Buffer.from(bytes);
  tampered[5] ^= 1;
  assert.equal(verifyBytes(tampered, sig, publicKey), false);
  assert.equal(verifyBytes(bytes, sig, keys().publicKey), false);
  assert.equal(verifyBytes(bytes, 'not base64!', publicKey), false);
});

test('非 Ed25519 私钥被拒', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  assert.throws(() => signBytes(Buffer.from('x'), privateKey), /Ed25519/);
});

test('sequence 单调递增', () => {
  assert.equal(nextSequence(undefined, 1000), 1000);
  assert.equal(nextSequence(500, 1000), 1000);
  assert.equal(nextSequence(1000, 1000), 1001);
  assert.equal(nextSequence(5000, 1000), 5001);
  let prev;
  for (let i = 0; i < 5; i++) {
    const s = nextSequence(prev, 1000);
    if (prev !== undefined) assert.ok(s > prev);
    prev = s;
  }
});

test('scan 检出 child_process 和 eval，并单独汇总 node_modules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fynvra-scan-'));
  try {
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'index.js'), "const cp = require('child_process');\nconst x = 1;\neval('1+1');\n");
    writeFileSync(join(dir, 'node_modules', 'dep', 'a.js'), 'eval("2");\n');
    const r = scanDir(dir);
    assert.deepEqual(r.own['child_process'], ['index.js:1']);
    assert.deepEqual(r.own['eval('], ['index.js:3']);
    assert.equal(r.nodeModules['eval('], 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
