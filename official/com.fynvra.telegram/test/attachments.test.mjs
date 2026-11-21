// 附件挑选、汇总、扩展名安全化与 24 小时清理。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  addMessageAttachments,
  cleanupStaleAttachments,
  mergeAttachments,
  pickPhoto,
  rejectionSummary,
  safeExtension,
  STALE_ATTACHMENT_MS,
} from '../dist/attachments.js';

const MB = 1024 * 1024;

describe('附件挑选', () => {
  it('pickPhoto 取 ≤ 20 MB 中最大的一张；全部超限为 too-large', () => {
    assert.equal(
      pickPhoto([
        { file_id: 'a', file_size: 10 },
        { file_id: 'b', file_size: 20 * MB },
        { file_id: 'c', file_size: 20 * MB + 1 },
      ]),
      'b'
    );
    assert.equal(pickPhoto([{ file_id: 'c', file_size: 21 * MB }]), 'too-large');
    assert.equal(pickPhoto([{}, 'x']), null);
  });

  it('视频、语音、贴纸、动图记为 unsupported；只有贴纸不算附件', () => {
    const files = { refs: [], rejected: [] };
    assert.equal(addMessageAttachments(files, { message_id: 1, sticker: {} }), false);
    const counted = addMessageAttachments(files, {
      message_id: 2,
      video: {},
      voice: {},
      video_note: {},
      animation: {},
      document: { file_id: 'anim' },
    });
    assert.equal(counted, true);
    assert.deepEqual(files.refs, []);
    assert.deepEqual(
      files.rejected.map((r) => [r.name, r.reason]),
      [
        ['贴纸', 'unsupported'],
        ['视频', 'unsupported'],
        ['动图', 'unsupported'],
        ['语音', 'unsupported'],
        ['视频消息', 'unsupported'],
      ]
    );
  });

  it('合并时超过 10 张图 / 10 个文件的记为 limit', () => {
    const target = { refs: [], rejected: [] };
    const images = Array.from({ length: 11 }, (_, i) => ({ kind: 'image', fileId: `i${i}`, name: `i${i}` }));
    const docs = Array.from({ length: 12 }, (_, i) => ({ kind: 'file', fileId: `f${i}`, name: `f${i}` }));
    mergeAttachments(target, { refs: [...images, ...docs], rejected: [{ name: 'v', reason: 'unsupported' }] });
    assert.equal(target.refs.length, 20);
    assert.deepEqual(
      target.rejected.map((r) => `${r.name}:${r.reason}`),
      ['i10:limit', 'f10:limit', 'f11:limit', 'v:unsupported']
    );
  });

  it('rejectionSummary 与 safeExtension', () => {
    assert.equal(rejectionSummary([]), '');
    assert.equal(
      rejectionSummary([
        { name: 'a.mp4', reason: 'unsupported' },
        { name: 'b.zip', reason: 'unsupported' },
      ]),
      '以下附件未处理：a.mp4（不支持的格式）、b.zip（不支持的格式）'
    );
    assert.equal(safeExtension('报告.DOCX'), 'docx');
    assert.equal(safeExtension('../x.p/df'), 'bin');
    assert.equal(safeExtension('noext'), 'bin');
  });
});

describe('24 小时清理', () => {
  it('只删 attachments/ 里超过 24 小时的普通文件；目录不存在时不报错', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'fyn-tg-clean-'));
    await cleanupStaleAttachments(dataDir, Date.now());
    const dir = join(dataDir, 'attachments');
    mkdirSync(dir);
    const old = join(dir, 'old.jpg');
    const fresh = join(dir, 'fresh.jpg');
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'y');
    const now = Date.now();
    const past = (now - STALE_ATTACHMENT_MS - 60_000) / 1000;
    utimesSync(old, past, past);
    await cleanupStaleAttachments(dataDir, now);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
  });
});
