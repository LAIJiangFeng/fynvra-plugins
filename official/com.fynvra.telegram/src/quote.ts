// 引用的消息：从 reply_to_message / quote / external_reply 读出被引用的文字和附件（都是外部数据，逐项收窄）。
import { addMessageAttachments, type ItemAttachments } from './attachments.js';
import type { TgMessage } from './telegramApi.js';
import { asRecord } from './util.js';

/** 引用文字的上限（与飞书插件一致） */
export const QUOTE_TEXT_MAX = 2_000;
/** 部分引用片段的上限 */
export const QUOTE_FRAGMENT_MAX = 500;
/** 话题名的上限 */
export const TOPIC_NAME_MAX = 100;
export const FORWARDED_MARK = '（转发的消息）';
const QUOTE_CUT_MARK = '…（引用内容过长，已截断）';
const QUOTED_PREFIX = '引用的消息里的';

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** 发送者显示名（first + last，其次 username），限 128 字 */
export function displayName(user: { first_name?: unknown; last_name?: unknown; username?: unknown }): string {
  const name = [str(user.first_name), str(user.last_name)].filter(Boolean).join(' ').trim();
  return (name || str(user.username) || '匿名').slice(0, 128);
}

/** 消息带 forward_origin：是转发来的 */
export const isForwarded = (message: { forward_origin?: unknown }) =>
  message.forward_origin !== undefined && message.forward_origin !== null;

export interface QuotedMessage {
  /** 被引用消息的 id（同一会话里的；引用其他会话时没有） */
  messageId?: number;
  /** 被引用的是本机器人发的消息 */
  fromBot: boolean;
  /** 被引用消息的发送者 id（引用其他会话或没有发送者时缺省） */
  fromId?: number;
  /** 插件生成的引用段（作者标签 + 文字 + 引用片段），外部文字在里面，投递时整段转义 */
  segment: string;
  /** 被引用消息里的图片、文件与未处理项 */
  files: ItemAttachments;
}

export interface ReplyInfo {
  /** 论坛话题名（reply_to_message 是话题创建的服务消息时） */
  topic?: string;
  quoted?: QuotedMessage;
}

function quoteText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '（没有文字，只有附件）';
  return trimmed.length > QUOTE_TEXT_MAX ? `${trimmed.slice(0, QUOTE_TEXT_MAX)}${QUOTE_CUT_MARK}` : trimmed;
}

const segmentOf = (author: string, text: string, fragment?: string) =>
  [
    `引用的消息（来自 ${author}）：`,
    text,
    ...(fragment ? [`引用片段：${fragment.slice(0, QUOTE_FRAGMENT_MAX)}`] : []),
  ].join('\n');

/** 读出这条消息引用了什么；没有引用返回 {} */
export function readReply(message: Pick<TgMessage, 'reply_to_message' | 'quote' | 'external_reply'>, botId: number): ReplyInfo {
  const reply = asRecord(message.reply_to_message);
  const fragment = str(asRecord(message.quote)?.text)?.trim() || undefined;
  if (reply) {
    // 话题里的普通消息都「回复」话题创建消息：不算引用，只记下话题名
    const created = asRecord(reply.forum_topic_created);
    if (created) {
      const name = str(created.name)?.replace(/\s+/g, ' ').trim().slice(0, TOPIC_NAME_MAX);
      return name ? { topic: name } : {};
    }
    const from = asRecord(reply.from);
    const fromBot = typeof from?.id === 'number' && from.id === botId;
    const author = fromBot
      ? '机器人（你之前发的回复）'
      : from?.is_bot === true
        ? '其他机器人'
        : displayName(from ?? {});
    const files: ItemAttachments = { refs: [], rejected: [] };
    addMessageAttachments(files, reply, QUOTED_PREFIX);
    const text = str(reply.text) ?? str(reply.caption) ?? '';
    return {
      quoted: {
        ...(typeof reply.message_id === 'number' ? { messageId: reply.message_id } : {}),
        fromBot,
        ...(typeof from?.id === 'number' ? { fromId: from.id } : {}),
        segment: segmentOf(`${author}${isForwarded(reply) ? FORWARDED_MARK : ''}`, quoteText(text), fragment),
        files,
      },
    };
  }
  const external = asRecord(message.external_reply);
  if (!external) return {};
  // 引用其他会话：不用 origin 里的任何名字，文字只取 quote.text
  const files: ItemAttachments = { refs: [], rejected: [] };
  addMessageAttachments(files, external, QUOTED_PREFIX);
  const text = fragment ? quoteText(fragment) : '（没有文字）';
  return { quoted: { fromBot: false, segment: segmentOf('其他会话', text), files } };
}
