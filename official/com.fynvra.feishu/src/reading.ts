// 像人一样读消息（纯函数）：引用的消息、话题第一条、合并转发的聊天记录，以及条目正文的拼装与截断。
// 读接口、下载在 service.ts 的投递阶段做，这里只管格式；上限与文案和 Telegram 插件一致。
import { createHash } from 'node:crypto';
import type { ItemAttachments } from './attachments.js';
import { FeishuApiError, type FeishuFetchedMessage } from './feishuApi.js';
import { parseMessage } from './message.js';

/** 引用的消息：文字最多这么多字 */
export const QUOTE_TEXT_MAX = 2_000;
/** @ 之前的消息：文字合计最多这么多字（超出丢最早的） */
export const PRE_TEXT_MAX = 2_000;
/** 话题第一条：只读文字，最多这么多字 */
export const ROOT_TEXT_MAX = 500;
/** 合并转发：最多显示的条数与字数 */
export const RECORD_ITEMS_MAX = 30;
export const RECORD_TEXT_MAX = 4_000;
/** 核心 channel.prompt 的 text 上限（UTF-8 字节） */
export const PROMPT_BYTES_MAX = 64 * 1024;
/** 投递前读消息的超时 */
export const READ_TIMEOUT_MS = 5_000;
/** 从条目创建算起，最多等这么久就投递（Q3） */
export const MAX_GATHER_MS = 30_000;

/** 被识别为反馈但只有附件、没有文字时的正文 */
export const ATTACHMENT_ONLY_TEXT = '（只发了附件，没有文字）';
/** 只 @ 了机器人、前后都没有内容时的正文 */
export const EMPTY_MENTION_TEXT = '（只 @ 了机器人，没有写内容）';
/** 只引用 + @、自己没写字时的正文 */
export const QUOTE_ONLY_TEXT = '（只 @ 了机器人，并引用了一条消息）';
const QUOTE_CUT_MARK = '…（引用内容过长，已截断）';
const CUT_MARK = '（过长，已截断）';
const NO_TEXT = '（没有文字，只有附件）';

/** 发送者的匿名短标签：只用 open_id 的哈希，不取姓名 */
export function memberLabel(openId: string): string {
  return `成员 ${createHash('sha256').update(openId).digest('hex').slice(0, 4)}`;
}

/** 超过 max 字截断并加标记 */
const clip = (text: string, max: number, mark: string) =>
  text.length > max ? `${text.slice(0, max)}${mark}` : text;

/** 读消息失败的原因（给人看，不带错误原文） */
export function readFailure(error: unknown): string {
  const code = error instanceof FeishuApiError ? error.code : undefined;
  if (code === 230110) return '消息已删除';
  if (code === 230050 || code === 230002) return '机器人看不到这条消息';
  if (code === 230027 || code === 99991672 || code === 99991679) return '缺少读取群消息的权限';
  return '读取失败';
}

/** 一条子消息在聊天记录里的写法：文字加附件占位 */
function recordLine(m: FeishuFetchedMessage, botOpenId: string): string {
  const parsed = parseMessage(m, botOpenId);
  if (!parsed) return '';
  // shortcut: 合并转发里的图片和文件只写占位，不下载；需要时再按子消息 id 走 resources 接口
  const marks = parsed.forward
    ? ['[合并转发]']
    : [
        ...parsed.files.refs.map((r) => (r.kind === 'image' ? '[图片]' : `[文件 ${r.name}]`)),
        ...parsed.files.rejected.map((r) => (r.name.startsWith('image-') ? '[图片]' : `[${r.name}]`)),
      ];
  return [parsed.text, ...marks].filter(Boolean).join(' ');
}

/** 合并转发的子消息（upper_message_id 等于它的）按时间排成聊天记录；作者只写匿名标签 */
export function forwardRecord(
  items: readonly FeishuFetchedMessage[],
  messageId: string,
  botOpenId: string
): string {
  const children = items
    .filter((m) => m.upperMessageId === messageId)
    .sort((a, b) => a.createTime - b.createTime);
  const lines: string[] = [];
  let size = 0;
  for (const m of children.slice(0, RECORD_ITEMS_MAX)) {
    const author = m.senderType === 'app' ? '机器人' : memberLabel(m.senderId || m.messageId);
    const line = `${author}：${recordLine(m, botOpenId) || '[消息]'}`;
    if (lines.length > 0 && size + line.length > RECORD_TEXT_MAX) break;
    lines.push(clip(line, RECORD_TEXT_MAX, '…'));
    size += line.length + 1;
  }
  const more = lines.length < children.length ? `，只显示前 ${lines.length} 条` : '';
  return [`合并转发的聊天记录（共 ${children.length} 条${more}）：`, ...lines].join('\n');
}

/** 条目里的一条消息贡献的内容（撤回时按消息去掉） */
export interface ItemPart {
  messageId: string;
  /** 已加标注的文字 */
  text: string;
  files: ItemAttachments;
  /** 带了图片或文件 */
  hasFiles: boolean;
  /** @ 之前缓冲里的消息（Q2，单独成段） */
  pre?: boolean;
  /** 合并转发：聊天记录投递前读 */
  forward?: boolean;
  /** 引用的消息与话题第一条：投递前读 */
  parentId?: string;
  rootId?: string;
}

/** 投递前读到的内容；error 是给人看的原因 */
export interface ReadMessage {
  author?: string;
  text?: string;
  /** 文字是合并转发的聊天记录（按聊天记录的上限截断） */
  record?: boolean;
  error?: string;
}
export interface ReadContext {
  roots: ReadMessage[];
  quotes: ReadMessage[];
  /** 条目里自己的合并转发消息：消息 id → 聊天记录 */
  records: Record<string, string>;
}

/** Q4：整体超出 64 KiB 时各部分再截到的字数 */
export interface BodyCut {
  record: number;
  quote: number;
  pre: number;
  main: number;
}
export const NO_CUT: BodyCut = { record: Infinity, quote: Infinity, pre: Infinity, main: Infinity };

/**
 * 条目正文：head 是 @ 前的消息、本条与并入的消息；tail 是话题第一条与引用的消息。
 * 本条没有文字时，@ 前的消息充当正文；都没有时按引用 / 附件 / 空 @ 写占位。
 */
export function renderBody(
  parts: readonly ItemPart[],
  read: ReadContext | undefined,
  cut: BodyCut = NO_CUT
): { head: string; tail: string } {
  const record = (p: ItemPart) =>
    p.forward
      ? clip(read?.records[p.messageId] ?? '（合并转发的聊天记录没能读取（读取失败））', cut.record, CUT_MARK)
      : '';
  const partText = (p: ItemPart) => [p.text, record(p)].filter(Boolean).join('\n');
  const pre = parts.filter((p) => p.pre);
  const own = parts.filter((p) => !p.pre);
  const preTexts = pre.map(partText).filter(Boolean);
  let preBlock = '';
  if (preTexts.length > 0) {
    const max = Math.min(PRE_TEXT_MAX, cut.pre);
    let joined = preTexts.join('\n');
    // 保留最近的，丢掉最早的
    if (joined.length > max) joined = `${max < PRE_TEXT_MAX ? CUT_MARK : '…'}${joined.slice(-max)}`;
    preBlock = `（以下是该用户在 @ 前 1 分钟内发的 ${preTexts.length} 条消息，可能是这条反馈的上下文）\n${joined}`;
  }
  const preFiles = pre.filter((p) => p.hasFiles).length;
  const filesNote = preFiles > 0 ? `（该用户在 @ 前 1 分钟内发的 ${preFiles} 条图片/文件消息已并入本条）` : '';
  let main = clip(own.map(partText).filter(Boolean).join('\n'), cut.main, CUT_MARK);
  if (!main && !preBlock) {
    main = own.some((p) => p.hasFiles)
      ? ATTACHMENT_ONLY_TEXT
      : own.some((p) => p.parentId)
        ? QUOTE_ONLY_TEXT
        : EMPTY_MENTION_TEXT;
  }
  const section = (title: string, m: ReadMessage, max: number, mark: string) =>
    m.error !== undefined
      ? `${title}没能读取（${m.error}）`
      : `${title}（来自 ${m.author ?? '未知'}）：\n${m.text ? clip(m.text, max, mark) : NO_TEXT}`;
  const quoteMax = (m: ReadMessage) =>
    m.record ? cut.record : Math.min(QUOTE_TEXT_MAX, cut.quote);
  const tail = [
    ...(read?.roots ?? []).map((m) =>
      section('所在话题的第一条消息', m, Math.min(ROOT_TEXT_MAX, cut.quote), '…')
    ),
    ...(read?.quotes ?? []).map((m) =>
      section('引用的消息', m, quoteMax(m), m.record || cut.quote < QUOTE_TEXT_MAX ? CUT_MARK : QUOTE_CUT_MARK)
    ),
  ].join('\n\n');
  return { head: [preBlock, main, filesNote].filter(Boolean).join('\n'), tail };
}

export const joinBody = (body: { head: string; tail: string }) =>
  body.tail ? `${body.head}\n\n${body.tail}` : body.head;

/** Q4 各部分截到的字数；正文（本条与 @ 后并入的）最后才截，保留得多一些 */
const CUT_TO: BodyCut = { record: 200, quote: 200, pre: 200, main: 10_000 };

/** Q4：按「合并转发 → 引用 → @ 之前 → 正文」依次截短，直到 build 出来的文字小于 64 KiB */
export function fitBytes<T extends { text: string }>(build: (cut: BodyCut) => T): T {
  let cut = NO_CUT;
  let result = build(cut);
  for (const key of ['record', 'quote', 'pre', 'main'] as const) {
    if (Buffer.byteLength(result.text, 'utf8') < PROMPT_BYTES_MAX) break;
    cut = { ...cut, [key]: CUT_TO[key] };
    result = build(cut);
  }
  return result;
}
