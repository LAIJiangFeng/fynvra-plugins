// 确定性 zip：条目按路径（UTF-8 字节序）排序，时间固定 1980-01-01 00:00:00，DEFLATE，无额外字段与属性。
// 同样的输入（路径 + 内容）总是得到同样的字节，从而 sha256 相同。
import zlib from 'node:zlib';

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980 年 1 月 1 日
const FLAG_UTF8 = 0x0800;

const byPath = (a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8'));

// entries: [{ path: 'a/b.js', data: Buffer }]，只放文件，不放目录条目
export function createZip(entries) {
  const sorted = [...entries].sort(byPath);
  const locals = [];
  const centrals = [];
  let offset = 0;
  let prev = null;
  for (const e of sorted) {
    if (e.path === prev) throw new Error(`zip 条目重复：${e.path}`);
    prev = e.path;
    const name = Buffer.from(e.path, 'utf8');
    const crc = zlib.crc32(e.data) >>> 0;
    const comp = zlib.deflateRawSync(e.data, { level: 9 });

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(FLAG_UTF8, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(FLAG_UTF8, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);

    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// 读取 zip（供测试、复用已发布包、解开 git archive 输出）。
// shortcut: 不支持 zip64，超过 65535 个条目或 4 GB 的归档会报错；需要时再补。
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 zip 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const madeBy = buf.readUInt16LE(p + 4);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38);
    const lho = buf.readUInt32LE(p + 42);
    const path = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;

    const mode = madeBy >> 8 === 3 ? ext >>> 16 : 0;
    const isDir = path.endsWith('/');
    const isSymlink = (mode & 0o170000) === 0o120000;
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method}：${path}`);
    if ((zlib.crc32(data) >>> 0) !== crc) throw new Error(`CRC 校验失败：${path}`);
    out.push({ path, data, isDir, isSymlink });
  }
  return out;
}
