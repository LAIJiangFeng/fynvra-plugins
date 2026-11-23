// 群消息附件：从 Telegram 消息里挑出要处理的图片与文档，下载到 `<dataDir>/attachments/` 交给核心 channel.prompt；
// 格式判断与输入框上限由核心负责，这里只做 Bot API 的 20 MB 下载上限、每条 10 图 10 文件的数量上限和落盘清理。
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asRecord, errorMessage } from './util.js';
/** Bot API 只能下载 20 MB 以内的文件 */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** 同输入框：每条最多 10 张图、10 个文件 */
export const MAX_IMAGES = 10;
export const MAX_FILES = 10;
/** 启动时清理超过这么久的残留文件 */
export const STALE_ATTACHMENT_MS = 24 * 60 * 60_000;
const NAME_MAX = 200;
const REASON_TEXT = {
    unsupported: '不支持的格式',
    empty: '没有文字内容',
    unreadable: '读取失败',
    size: '超出输入框的大小或数量上限',
    'too-large': '机器人只能下载 20 MB 以内的文件',
    limit: '每条最多 10 张图、10 个文件',
    'download-failed': '下载失败',
};
/** 显示用文件名：去掉控制字符与换行，限长 */
function displayName(raw, fallback) {
    const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
    return (name || fallback).slice(0, NAME_MAX);
}
const fileSize = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
/** photo 数组里取 file_size ≤ 20 MB 的最大一张；没有可用的返回 'too-large'，数组无效返回 null */
export function pickPhoto(photo) {
    let best = null;
    let any = false;
    for (const entry of photo) {
        const record = asRecord(entry);
        if (typeof record?.file_id !== 'string')
            continue;
        any = true;
        const size = fileSize(record.file_size) ?? 0;
        if (size > MAX_DOWNLOAD_BYTES)
            continue;
        // 同样大小取后面的（Telegram 按尺寸从小到大排）
        if (!best || size >= best.size)
            best = { fileId: record.file_id, size };
    }
    if (best)
        return best.fileId;
    return any ? 'too-large' : null;
}
/**
 * 把一条消息的附件加进条目（超出数量上限的记为 limit）；返回这条消息是否带了附件（贴纸不算）。
 * prefix 加在未处理附件的名称前（被引用的消息用「引用的消息里的」）。
 */
export function addMessageAttachments(target, message, prefix = '') {
    const reject = (name, reason) => target.rejected.push({ name: `${prefix}${name}`, reason });
    const add = (kind, fileId, name) => addRef(target, { kind, fileId, name });
    const id = typeof message.message_id === 'number' ? message.message_id : 'quote';
    const before = target.refs.length + target.rejected.length;
    const unsupported = [
        [message.video, '视频'],
        // 动图消息同时带 document 字段，只按动图处理
        [message.animation, '动图'],
        [message.voice, '语音'],
        [message.video_note, '视频消息'],
        [message.audio, '音频'],
    ];
    for (const [value, label] of unsupported) {
        if (value !== undefined && value !== null) {
            reject(displayName(asRecord(value)?.file_name, label), 'unsupported');
        }
    }
    if (Array.isArray(message.photo) && message.photo.length > 0) {
        const name = `photo-${id}.jpg`;
        const picked = pickPhoto(message.photo);
        if (picked === 'too-large')
            reject(name, 'too-large');
        else if (picked)
            add('image', picked, name);
    }
    const document = asRecord(message.document);
    if (document && (message.animation === undefined || message.animation === null)) {
        const name = displayName(document.file_name, `file-${id}`);
        if (typeof document.file_id !== 'string')
            reject(name, 'unreadable');
        else if ((fileSize(document.file_size) ?? 0) > MAX_DOWNLOAD_BYTES)
            reject(name, 'too-large');
        else {
            const mime = typeof document.mime_type === 'string' ? document.mime_type : '';
            add(mime.startsWith('image/') ? 'image' : 'file', document.file_id, name);
        }
    }
    const counted = target.refs.length + target.rejected.length > before;
    // 贴纸不支持；只发贴纸（例如回复机器人一个表情）不算反馈
    if (message.sticker !== undefined && message.sticker !== null)
        reject('贴纸', 'unsupported');
    return counted;
}
function addRef(target, ref) {
    const count = target.refs.filter((r) => r.kind === ref.kind).length;
    if (count >= (ref.kind === 'image' ? MAX_IMAGES : MAX_FILES)) {
        target.rejected.push({ name: ref.name, reason: 'limit' });
    }
    else {
        target.refs.push(ref);
    }
}
/** 合并多条消息的附件：超出 10 图 / 10 文件的记为 limit */
export function mergeAttachments(target, extra) {
    for (const ref of extra.refs)
        addRef(target, ref);
    target.rejected.push(...extra.rejected);
}
/** 「以下附件未处理：a.mp4（不支持的格式）、…」；没有被拒的返回空串 */
export function rejectionSummary(rejected) {
    if (rejected.length === 0)
        return '';
    return `以下附件未处理：${rejected.map((r) => `${r.name}（${REASON_TEXT[r.reason] ?? r.reason}）`).join('、')}`;
}
/** 落盘用的扩展名：只取 [A-Za-z0-9]，没有时用 bin */
export function safeExtension(name) {
    const match = /\.([A-Za-z0-9]{1,10})$/.exec(name);
    return match?.[1]?.toLowerCase() ?? 'bin';
}
export const attachmentsDir = (dataDir) => join(dataDir, 'attachments');
/** 逐个 getFile + 下载并写到 `<dataDir>/attachments/<uuid>.<ext>`；失败的记为 rejected（错误已打码，只写日志） */
export async function downloadAttachments(input) {
    const result = { attachments: [], paths: [], rejected: [] };
    if (input.refs.length === 0)
        return result;
    const dir = attachmentsDir(input.dataDir);
    try {
        await mkdir(dir, { recursive: true });
    }
    catch (error) {
        input.warn(`创建附件目录失败：${errorMessage(error)}`);
    }
    for (const ref of input.refs) {
        try {
            const info = await input.telegram.getFile(input.token, ref.fileId, input.signal);
            if ((info.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
                result.rejected.push({ name: ref.name, reason: 'too-large' });
                continue;
            }
            const data = await input.telegram.downloadFile(input.token, info.file_path, MAX_DOWNLOAD_BYTES, input.signal);
            const file = `${randomUUID()}.${safeExtension(ref.name)}`;
            const path = join(dir, file);
            await writeFile(path, data, { flag: 'wx' });
            result.paths.push(path);
            result.attachments.push({ file, name: ref.name });
        }
        catch (error) {
            input.warn(`下载附件失败（${ref.name}）：${errorMessage(error)}`);
            result.rejected.push({ name: ref.name, reason: 'download-failed' });
        }
    }
    return result;
}
/** 删除附件文件；不存在或删不掉只忽略（启动清理会兜底） */
export async function removeFiles(paths) {
    await Promise.all(paths.map((path) => unlink(path).catch(() => undefined)));
}
/** 启动时清理 attachments/ 里超过 24 小时的残留普通文件 */
export async function cleanupStaleAttachments(dataDir, now) {
    const dir = attachmentsDir(dataDir);
    let names;
    try {
        names = await readdir(dir);
    }
    catch {
        return;
    }
    for (const name of names) {
        const path = join(dir, name);
        try {
            const info = await lstat(path);
            if (info.isFile() && now - info.mtimeMs > STALE_ATTACHMENT_MS)
                await unlink(path);
        }
        catch {
            // 并发删除等：忽略
        }
    }
}
