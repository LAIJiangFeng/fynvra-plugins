// 让 `node --test scripts/test` 可用：Node 22+ 不再展开目录参数，会把目录解析成这个入口；这里加载同目录全部 *.test.mjs。
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
for (const f of readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()) {
  await import(pathToFileURL(`${dir}/${f}`).href);
}
