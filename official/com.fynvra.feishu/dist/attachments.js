// 消息附件（结构同 Telegram 插件）：从飞书消息里挑出的图片与文件，下载到 `<dataDir>/attachments/` 交给核心 channel.prompt；
// 格式判断与输入框上限由核心负责，这里只做下载大小上限（图片 20 MiB、文件 32 MiB）、每条 10 图 10 文件的数量上限和落盘清理。
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FeishuApiError } from './feishuApi.js';
import { errorMessage } from './util.js';
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
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
    'too-large': '图片最大 20 MB，文件最大 32 MB',
    limit: '每条最多 10 张图、10 个文件',
    'download-failed': '下载失败',
};
/** 显示用文件名：去掉控制字符与换行，限长 */
export function displayName(raw, fallback) {
    const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
    return (name || fallback).slice(0, NAME_MAX);
}
/** 加一个待下载的附件；超出数量上限的记为 limit */
export function addRef(target, ref) {
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
/** 图片按下载到的 Content-Type 定扩展名（飞书图片没有文件名） */
const IMAGE_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
};
export const attachmentsDir = (dataDir) => join(dataDir, 'attachments');
/** 逐个下载并写到 `<dataDir>/attachments/<uuid>.<ext>`；失败的记为 rejected（错误已打码，只写日志） */
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
            const { data, contentType } = await input.feishu.download(input.creds, {
                messageId: ref.messageId,
                fileKey: ref.fileKey,
                type: ref.kind,
                maxBytes: ref.kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES,
            });
            const imageExt = ref.kind === 'image' ? IMAGE_EXT[contentType.split(';')[0]?.trim().toLowerCase() ?? ''] : undefined;
            const name = imageExt ? ref.name.replace(/\.[A-Za-z0-9]{1,10}$/, '') + `.${imageExt}` : ref.name;
            const file = `${randomUUID()}.${safeExtension(name)}`;
            const path = join(dir, file);
            await writeFile(path, data, { flag: 'wx' });
            result.paths.push(path);
            result.attachments.push({ file, name });
        }
        catch (error) {
            if (error instanceof FeishuApiError && error.kind === 'too-large') {
                result.rejected.push({ name: ref.name, reason: 'too-large' });
                continue;
            }
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
