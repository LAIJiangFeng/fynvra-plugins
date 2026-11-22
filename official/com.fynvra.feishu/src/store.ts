// 插件数据（结构同 Telegram 插件的 store.ts）：存进 api.storage（≤ 5 MB，原子写）。
// App Secret 不进 storage，放在 api.secrets 的 appSecret；App ID 不是密钥，存在 storage。
// 字段非法时只丢弃那个字段或那条记录。
import { APP_ID_PATTERN, APP_SECRET_PATTERN, isFeishuId } from './feishuApi.js';
import {
  type FeishuCardKind,
  type FeishuCardStatus,
  type FeishuChatType,
  isRateLimit,
  isThinkingLevel,
  RATE_LIMIT_DEFAULT,
} from './model.js';
import type { ChannelModelRef, FynvraPluginApi } from './types/appPluginApi.js';
import { asRecord } from './util.js';

export const MAX_CANDIDATES = 20;
export const MAX_CARDS = 500;
/** 记住机器人发过的消息 id（判断「回复机器人」用）的条数 */
export const MAX_BOT_MESSAGES = 500;
const TEXT_MAX = 4_000;
/** api.secrets 里存 App Secret 的键 */
export const SECRET_KEY = 'appSecret';

export interface StoredCandidate {
  chatId: string;
  chatType: FeishuChatType;
  title: string;
  seenAt: number;
}

/** 会话绑定的项目：note 是维护者写的一句说明（≤ 200 字，可为空） */
export interface StoredProject {
  workspaceId: string;
  note: string;
}

/** 已允许的会话（群聊或私聊） */
export interface StoredChat {
  chatId: string;
  chatType: FeishuChatType;
  title: string;
  /** 按顺序排，第一个是主项目；至少一个 */
  projects: StoredProject[];
  /** 每个「会话 × 项目」的分诊会话：workspaceId → sessionId（用到时再创建） */
  triageSessions: Record<string, string>;
  active: boolean;
}

export const PROJECT_NOTE_MAX = 200;

export interface StoredWorkspace {
  dutySessionId?: string;
}

export interface StoredCard {
  id: number;
  chatId: string;
  chatType: FeishuChatType;
  workspaceId: string;
  kind?: FeishuCardKind;
  status: FeishuCardStatus;
  title: string;
  summary: string;
  evidence?: string;
  assessment?: string;
  assessmentIncomplete?: boolean;
  /** 反馈者的原始内容（追问时带给分诊） */
  content: string;
  /** 分诊上一次发出的回复（追问时带给分诊） */
  lastReply?: string;
  /** 触发这张卡片的原消息 id（PR 通知等模板回复它） */
  messageId: string;
  /** 机器人为这张卡片发出的消息 id */
  botMessageIds: string[];
  followUps: number;
  /** 最近一次追问的时间（24 小时超时用） */
  askedAt?: number;
  /** 投给值班会话：queued 待投，sent 已投 */
  duty?: 'queued' | 'sent';
  deliveredAt?: number;
  taskIds: string[];
  prUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FeishuData {
  appId?: string;
  /** 只在内存里；落盘时去掉 */
  appSecret?: string;
  bot?: { openId: string; name: string };
  candidates: StoredCandidate[];
  chats: StoredChat[];
  workspaces: Record<string, StoredWorkspace>;
  cards: StoredCard[];
  /** 机器人发过的消息 id（新的在后） */
  botMessageIds: string[];
  /** 每人每小时最多处理几条（1–1000） */
  rateLimitPerHour: number;
  /** 分诊 / 值班会话用的模型；缺省为默认 */
  triageModel?: ChannelModelRef;
  dutyModel?: ChannelModelRef;
}

export function emptyFeishuData(): FeishuData {
  return {
    candidates: [],
    chats: [],
    workspaces: {},
    cards: [],
    botMessageIds: [],
    rateLimitPerHour: RATE_LIMIT_DEFAULT,
  };
}

const CARD_KINDS: readonly string[] = ['bug', 'feature', 'question', 'invalid'];
const CARD_STATUSES: readonly string[] = [
  'asking',
  'answered',
  'invalid',
  'fixing',
  'pending-approval',
  'declined',
  'rejected',
  'unconfirmed',
  'pr-opened',
  'needs-maintainer',
  'unreported',
];

const isInt = (value: unknown): value is number => Number.isSafeInteger(value);
const isNonNegative = (value: unknown): value is number => isInt(value) && value >= 0;
const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const isChatType = (value: unknown): value is FeishuChatType => value === 'group' || value === 'p2p';
const text = (value: unknown, max = TEXT_MAX): string | undefined =>
  typeof value === 'string' ? value.slice(0, max) : undefined;

function parseCandidate(raw: unknown): StoredCandidate | null {
  const r = asRecord(raw);
  if (!r || !isFeishuId(r.chatId) || !isChatType(r.chatType) || !isNonNegative(r.seenAt)) return null;
  return { chatId: r.chatId, chatType: r.chatType, title: text(r.title, 256) ?? '', seenAt: r.seenAt };
}

/** 会话：坏的项目或会话条目单独丢掉，一个项目都没有时才丢掉这个会话 */
function parseChat(raw: unknown): StoredChat | null {
  const r = asRecord(raw);
  if (!r || !isFeishuId(r.chatId) || !isChatType(r.chatType)) return null;
  const projects: StoredProject[] = [];
  const triageSessions: Record<string, string> = {};
  for (const item of Array.isArray(r.projects) ? r.projects : []) {
    const p = asRecord(item);
    if (!p || !isId(p.workspaceId) || projects.some((x) => x.workspaceId === p.workspaceId)) continue;
    projects.push({ workspaceId: p.workspaceId, note: text(p.note, PROJECT_NOTE_MAX)?.trim() ?? '' });
  }
  for (const [id, session] of Object.entries(asRecord(r.triageSessions) ?? {})) {
    if (isId(session) && projects.some((p) => p.workspaceId === id)) triageSessions[id] = session;
  }
  if (projects.length === 0) return null;
  return {
    chatId: r.chatId,
    chatType: r.chatType,
    title: text(r.title, 256) ?? '',
    projects,
    triageSessions,
    active: r.active !== false,
  };
}

function parseWorkspaceEntry(raw: unknown): StoredWorkspace | null {
  const r = asRecord(raw);
  if (!r) return null;
  return isId(r.dutySessionId) ? { dutySessionId: r.dutySessionId } : {};
}

function parseCard(raw: unknown): StoredCard | null {
  const r = asRecord(raw);
  if (
    !r ||
    !isNonNegative(r.id) ||
    !isFeishuId(r.chatId) ||
    !isId(r.workspaceId) ||
    typeof r.status !== 'string' ||
    !CARD_STATUSES.includes(r.status) ||
    !isFeishuId(r.messageId) ||
    !isNonNegative(r.createdAt)
  ) {
    return null;
  }
  const card: StoredCard = {
    id: r.id,
    chatId: r.chatId,
    chatType: isChatType(r.chatType) ? r.chatType : 'group',
    workspaceId: r.workspaceId,
    status: r.status as FeishuCardStatus,
    title: text(r.title, 200) ?? '',
    summary: text(r.summary) ?? '',
    content: text(r.content) ?? '',
    messageId: r.messageId,
    botMessageIds: Array.isArray(r.botMessageIds) ? r.botMessageIds.filter(isFeishuId).slice(-20) : [],
    followUps: isNonNegative(r.followUps) ? Math.min(r.followUps, 2) : 0,
    taskIds: Array.isArray(r.taskIds) ? r.taskIds.filter(isId).slice(0, 50) : [],
    createdAt: r.createdAt,
    updatedAt: isNonNegative(r.updatedAt) ? r.updatedAt : r.createdAt,
  };
  if (typeof r.kind === 'string' && CARD_KINDS.includes(r.kind)) card.kind = r.kind as FeishuCardKind;
  const evidence = text(r.evidence);
  if (evidence !== undefined) card.evidence = evidence;
  const assessment = text(r.assessment);
  if (assessment !== undefined) card.assessment = assessment;
  if (r.assessmentIncomplete === true) card.assessmentIncomplete = true;
  const lastReply = text(r.lastReply);
  if (lastReply !== undefined) card.lastReply = lastReply;
  if (isNonNegative(r.askedAt)) card.askedAt = r.askedAt;
  if (r.duty === 'queued' || r.duty === 'sent') card.duty = r.duty;
  if (isNonNegative(r.deliveredAt)) card.deliveredAt = r.deliveredAt;
  if (typeof r.prUrl === 'string' && /^https:\/\/\S+$/.test(r.prUrl)) card.prUrl = r.prUrl;
  return card;
}

const isModelId = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= 200;

/** 模型引用：服务 id 与模型 id 各 1–200 字符，不合法时当作没选；档位不合法时当作没选档位，保留模型 */
export function parseModelRef(raw: unknown): ChannelModelRef | undefined {
  const r = asRecord(raw);
  if (!r || !isModelId(r.providerId) || !isModelId(r.modelId)) return undefined;
  return {
    providerId: r.providerId,
    modelId: r.modelId,
    ...(isThinkingLevel(r.thinking) ? { thinking: r.thinking } : {}),
  };
}

function list<T>(raw: unknown, parse: (item: unknown) => T | null): T[] {
  return Array.isArray(raw) ? raw.flatMap((item) => parse(item) ?? []) : [];
}

/** 宽松收窄：每个字段、每条记录各自校验，坏的丢掉 */
export function parseFeishuData(raw: unknown): FeishuData {
  const r = asRecord(raw) ?? {};
  const data = emptyFeishuData();
  if (typeof r.appId === 'string' && APP_ID_PATTERN.test(r.appId)) data.appId = r.appId;
  const bot = asRecord(r.bot);
  if (bot && isFeishuId(bot.openId)) {
    data.bot = { openId: bot.openId, name: text(bot.name, 128) ?? '' };
  }
  data.candidates = list(r.candidates, parseCandidate).slice(-MAX_CANDIDATES);
  const seenChats = new Set<string>();
  data.chats = list(r.chats, parseChat).filter((chat) => {
    if (seenChats.has(chat.chatId)) return false;
    seenChats.add(chat.chatId);
    return true;
  });
  for (const [id, entry] of Object.entries(asRecord(r.workspaces) ?? {})) {
    const parsed = isId(id) ? parseWorkspaceEntry(entry) : null;
    if (parsed) data.workspaces[id] = parsed;
  }
  const seenCards = new Set<number>();
  data.cards = list(r.cards, parseCard)
    .filter((card) => {
      if (seenCards.has(card.id)) return false;
      seenCards.add(card.id);
      return true;
    })
    .slice(-MAX_CARDS);
  if (Array.isArray(r.botMessageIds)) {
    data.botMessageIds = r.botMessageIds.filter(isFeishuId).slice(-MAX_BOT_MESSAGES);
  }
  if (isRateLimit(r.rateLimitPerHour)) data.rateLimitPerHour = r.rateLimitPerHour;
  const triageModel = parseModelRef(r.triageModel);
  if (triageModel) data.triageModel = triageModel;
  const dutyModel = parseModelRef(r.dutyModel);
  if (dutyModel) data.dutyModel = dutyModel;
  return data;
}

export interface FeishuStore {
  /** 没写过时为空数据；App Secret 从 secrets 取 */
  load(): Promise<FeishuData>;
  /** 串行写；写失败时 reject。App Secret 不写进 storage */
  save(data: FeishuData): Promise<void>;
}

export function createFeishuStore(api: Pick<FynvraPluginApi, 'storage' | 'secrets'>): FeishuStore {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    async load() {
      const data = parseFeishuData(await api.storage.read());
      const secret = await api.secrets.get(SECRET_KEY);
      if (typeof secret === 'string' && APP_SECRET_PATTERN.test(secret)) data.appSecret = secret;
      return data;
    },
    save(data) {
      // 先拍快照：排队期间内存里的数据还会变
      const { appSecret: _secret, ...rest } = data;
      const snapshot = structuredClone(rest);
      const run = tail.then(() => api.storage.write(snapshot));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
