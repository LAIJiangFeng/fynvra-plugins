// Ed25519 签名：对 index.json 原始字节签名，签名以 base64 单行保存。
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export function loadPrivateKey(pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`私钥类型是 ${key.asymmetricKeyType}，需要 Ed25519`);
  return key;
}

export function signBytes(bytes, privatePem) {
  return sign(null, bytes, loadPrivateKey(privatePem)).toString('base64');
}

export function verifyBytes(bytes, sigText, publicPem) {
  const key = createPublicKey(publicPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('公钥不是 Ed25519');
  const text = String(sigText).replace(/\r?\n$/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return false;
  const sig = Buffer.from(text, 'base64');
  if (sig.length !== 64) return false;
  return verify(null, bytes, key, sig);
}

// sequence 取发布时的 Unix 秒，且必须严格大于上一份索引
export function nextSequence(prev, nowSec = Math.floor(Date.now() / 1000)) {
  return Math.max((Number.isSafeInteger(prev) ? prev : 0) + 1, nowSec);
}
