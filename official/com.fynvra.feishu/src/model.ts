// 飞书反馈值班的视图类型（结构同 Telegram 插件的 model.ts）；不含 App Secret 明文。
// 插件的启用和停用由 Fynvra 的插件卡片负责，这里没有开关。
import type { ChannelModelRef, ChannelThinkingLevel } from './types/appPluginApi.js';

/** 思考档位，顺序同 Fynvra 输入框 */
export const THINKING_LEVELS: readonly ChannelThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export const isThinkingLevel = (value: unknown): value is ChannelThinkingLevel =>
  THINKING_LEVELS.includes(value as ChannelThinkingLevel);

/**
 * 连接状态：没填凭证 / 连接中 / 已连接 / 连不上飞书 / App ID 或 App Secret 不对 /
 * 应用还没发布（或没开机器人能力）/ 其他接口错误
 */
export type FeishuConnection =
  | 'no-credentials'
  | 'connecting'
  | 'connected'
  | 'network-error'
  | 'unauthorized'
  | 'not-ready'
  | 'api-error';

/** 会话类型：群聊或私聊 */
export type FeishuChatType = 'group' | 'p2p';

export const CHAT_TYPE_TEXT: Record<FeishuChatType, string> = { group: '群聊', p2p: '私聊' };

/** 没有群名时的显示：「群聊 · 短 id」 */
export function chatFallbackTitle(type: FeishuChatType, chatId: string): string {
  return `${CHAT_TYPE_TEXT[type]} · ${chatId.slice(-6)}`;
}

export type FeishuCardKind = 'bug' | 'feature' | 'question' | 'invalid';

/**
 * 卡片状态（同 Telegram 插件）：
 * asking 追问中；answered 已回答的提问；invalid 无效；fixing 已投给值班会话修复；
 * pending-approval 待确认需求；declined 三问未过；rejected 用户拒绝；unconfirmed 未确认（问满或超时）；
 * pr-opened PR 已开；needs-maintainer 需要维护者处理；unreported 分诊这一轮没有调用 triage_report。
 */
export type FeishuCardStatus =
  | 'asking'
  | 'answered'
  | 'invalid'
  | 'fixing'
  | 'pending-approval'
  | 'declined'
  | 'rejected'
  | 'unconfirmed'
  | 'pr-opened'
  | 'needs-maintainer'
  | 'unreported';

export interface FeishuCardView {
  id: number;
  chatId: string;
  /** 来源会话名（只在电脑上显示，PR 说明里不写） */
  chatTitle: string;
  chatType: FeishuChatType;
  /** 最终处理这条反馈的项目（转交后是目标项目） */
  workspaceId: string;
  kind?: FeishuCardKind;
  status: FeishuCardStatus;
  title: string;
  summary: string;
  evidence?: string;
  assessment?: string;
  /** 新功能的三问评估格式不完整 */
  assessmentIncomplete?: boolean;
  /** 已追问轮数（上限 2） */
  followUps: number;
  /** 关联的编排任务 id */
  taskIds: string[];
  prUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FeishuCandidateView {
  chatId: string;
  chatType: FeishuChatType;
  title: string;
  seenAt: number;
}

export interface FeishuChatView {
  chatId: string;
  chatType: FeishuChatType;
  title: string;
  /** 绑定的项目，第一个是主项目 */
  projects: { workspaceId: string; note: string }[];
  /** 机器人被移出群后为 false，停止投递 */
  active: boolean;
}

export interface FeishuStateView {
  connection: FeishuConnection;
  /** 最近一次连接失败的说明（已去掉密钥） */
  connectionError?: string;
  appId?: string;
  /** App Secret 的掩码（如 `ab…yz`）；没有时缺省 */
  secretMasked?: string;
  bot?: { openId: string; name: string };
  candidates: FeishuCandidateView[];
  chats: FeishuChatView[];
  /** 新的在前 */
  cards: FeishuCardView[];
  /** 每人每小时最多处理几条 */
  rateLimitPerHour: number;
  /** 分诊 / 值班会话用的模型（可带思考档位）；缺省为默认 */
  triageModel?: ChannelModelRef;
  dutyModel?: ChannelModelRef;
  /** 带所选模型建会话或换模型失败过（已改用默认）；用户改选后清除 */
  modelFallback: boolean;
}

/** 每人每小时限额：默认 5，可配 1–1000 */
export const RATE_LIMIT_DEFAULT = 5;
export const RATE_LIMIT_MAX = 1000;

export function isRateLimit(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= RATE_LIMIT_MAX
  );
}

export type FeishuCardAction = 'approve' | 'reject';

/** App Secret 只给首尾各两位 */
export function maskSecret(secret: string): string {
  return secret.length < 8 ? '…' : `${secret.slice(0, 2)}…${secret.slice(-2)}`;
}
