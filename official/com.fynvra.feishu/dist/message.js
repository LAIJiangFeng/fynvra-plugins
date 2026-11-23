// 飞书消息内容解析（纯函数），格式以飞书「接收消息内容」文档为准：
// text 取 text 并按 mentions 处理 @；post 按段取文字、@、链接、图片；image / file 当附件；
// merge_forward 只标记（子消息要另外调接口读）；其余类型列为未处理。
import { addRef, displayName } from './attachments.js';
import { isFeishuId } from './feishuApi.js';
import { asRecord } from './util.js';
/** 不支持的消息类型的显示名 */
const UNSUPPORTED = {
    audio: '语音',
    media: '视频',
    interactive: '卡片消息',
    share_chat: '群名片',
    share_user: '个人名片',
    location: '位置',
    todo: '任务',
    calendar: '日程',
    share_calendar_event: '日程',
    general_calendar: '日程',
    vote: '投票',
    folder: '文件夹',
    hongbao: '红包',
    video_chat: '视频会议',
};
const ALL_KEY = '@_all';
const mentionName = (name) => `@${name?.trim() || '成员'}`;
function parseJson(content) {
    try {
        return asRecord(JSON.parse(content));
    }
    catch {
        return null;
    }
}
/** text 消息：去掉 @机器人 的占位符，其他占位符换成 @名字 */
function textWithMentions(text, mentions, botOpenId) {
    let out = text;
    // 长的 key 先换，@_user_1 不会误伤 @_user_10
    for (const m of [...mentions].sort((a, b) => b.key.length - a.key.length)) {
        out = out.split(m.key).join(m.openId === botOpenId ? '' : m.key === ALL_KEY ? '@所有人' : mentionName(m.name));
    }
    return out.split(ALL_KEY).join('@所有人');
}
/** 去掉 @ 留下的多余空格，按行 trim */
const tidy = (text) => text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
/** post 的正文：直接是 {title, content}，或按语言包一层（zh_cn 等） */
function postBody(raw) {
    if (Array.isArray(raw?.content))
        return raw;
    for (const value of Object.values(raw ?? {})) {
        const record = asRecord(value);
        if (Array.isArray(record?.content))
            return record;
    }
    return null;
}
/** 解析一条消息；系统消息等不处理的返回 null */
export function parseMessage(event, botOpenId) {
    const files = { refs: [], rejected: [] };
    const mentioned = event.mentions.some((m) => m.openId === botOpenId);
    const content = parseJson(event.content);
    let text = '';
    let hasFiles = false;
    const image = (key, index) => {
        hasFiles = true;
        const name = `image-${index}.jpg`;
        if (isFeishuId(key))
            addRef(files, { kind: 'image', messageId: event.messageId, fileKey: key, name });
        else
            files.rejected.push({ name, reason: 'unreadable' });
    };
    switch (event.msgType) {
        case 'text':
            text = textWithMentions(typeof content?.text === 'string' ? content.text : '', event.mentions, botOpenId);
            break;
        case 'post': {
            const body = postBody(content);
            const lines = [];
            if (typeof body?.title === 'string' && body.title.trim())
                lines.push(body.title.trim());
            let images = 0;
            for (const paragraph of Array.isArray(body?.content) ? body.content : []) {
                let line = '';
                for (const raw of Array.isArray(paragraph) ? paragraph : []) {
                    const el = asRecord(raw);
                    const str = (key) => (typeof el?.[key] === 'string' ? el[key] : '');
                    switch (el?.tag) {
                        case 'text':
                        case 'md':
                            line += str('text');
                            break;
                        case 'code_block':
                            line += `\n${str('text')}\n`;
                            break;
                        case 'a': {
                            const label = str('text');
                            const href = str('href');
                            line += label && label !== href ? `${label}（${href}）` : href;
                            break;
                        }
                        case 'at': {
                            const key = str('user_id');
                            const mention = event.mentions.find((m) => m.key === key);
                            if (key === botOpenId || (mention && mention.openId === botOpenId))
                                break;
                            line += key === ALL_KEY || key === 'all' ? '@所有人' : mentionName(str('user_name') || mention?.name);
                            break;
                        }
                        case 'img':
                            images += 1;
                            image(el.image_key, images);
                            break;
                        case 'media':
                            hasFiles = true;
                            files.rejected.push({ name: '视频', reason: 'unsupported' });
                            break;
                        case 'emotion':
                            line += str('emoji_type') ? `[${str('emoji_type')}]` : '';
                            break;
                        case 'hr':
                            line += '---';
                            break;
                        default:
                            break;
                    }
                }
                lines.push(line);
            }
            text = lines.join('\n');
            break;
        }
        case 'image':
            image(content?.image_key, 1);
            break;
        case 'file': {
            hasFiles = true;
            const name = displayName(content?.file_name, '文件');
            if (isFeishuId(content?.file_key)) {
                addRef(files, { kind: 'file', messageId: event.messageId, fileKey: content.file_key, name });
            }
            else
                files.rejected.push({ name, reason: 'unreadable' });
            break;
        }
        case 'sticker':
            // 表情包不支持，也不算反馈（例如回复机器人一个表情）
            files.rejected.push({ name: '表情包', reason: 'unsupported' });
            break;
        case 'merge_forward':
            return { text: '', mentioned, files, hasFiles: false, forward: true };
        case 'system':
            return null;
        default:
            hasFiles = true;
            files.rejected.push({
                name: UNSUPPORTED[event.msgType] ?? `${event.msgType.slice(0, 32) || '未知'}消息`,
                reason: 'unsupported',
            });
            break;
    }
    return { text: tidy(text), mentioned, files, hasFiles };
}
