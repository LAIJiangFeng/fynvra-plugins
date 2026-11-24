// 插件数据（移植自 Fynvra 内置 telegram/store.ts）：存进 api.storage（≤ 5 MB，原子写）。
// token 不进 storage，放在 api.secrets 的 botToken；旧 telegram.json 迁移时也用这里的收窄逻辑。
// 字段非法时只丢弃那个字段或那条记录。
import type { ChannelModelRef, FynvraPluginApi } from './types/appPluginApi.js';
import {
  FOLLOW_MINUTES_DEFAULT,
  isFollowMinutes,
  isTelegramRateLimit,
  isThinkingLevel,
  TELEGRAM_RATE_LIMIT_DEFAULT,
  type TelegramCardKind,
  type TelegramCardStatus,
} from './model.js';
import { TELEGRAM_TOKEN_PATTERN } from './telegramApi.js';
import { asRecord } from './util.js';

export const MAX_CANDIDATES = 20;
export const MAX_CARDS = 500;
const TEXT_MAX = 4_000;
/** api.secrets 里存 token 的键 */
export const TOKEN_SECRET_KEY = 'botToken';

export interface StoredCandidate {
  chatId: number;
  title: string;
  seenAt: number;
}

/** 群绑定的项目：note 是维护者写的一句说明（≤ 200 字，可为空） */
export interface StoredProject {
  workspaceId: string;
  note: string;
}

export interface StoredGroup {
  chatId: number;
  title: string;
  /** 按顺序排，第一个是主项目；至少一个 */
  projects: StoredProject[];
  /** 每个「群 × 项目」的分诊会话：workspaceId → sessionId（用到时再创建） */
  triageSessions: Record<string, string>;
  active: boolean;
}

export const PROJECT_NOTE_MAX = 200;

/** 插件拿不到路径，内置版的 cleanCheckoutPath 不再保存 */
export interface StoredWorkspace {
  dutySessionId?: string;
}

export interface StoredCard {
  id: number;
  chatId: number;
  workspaceId: string;
  kind?: TelegramCardKind;
  status: TelegramCardStatus;
  title: string;
  summary: string;
  evidence?: string;
  assessment?: string;
  assessmentIncomplete?: boolean;
  /** 反馈者的原始内容（追问时带给分诊） */
  content: string;
  /** 分诊上一次发到群里的回复（追问时带给分诊） */
  lastReply?: string;
  /** 触发这张卡片的原消息 id（PR 通知等模板回复它） */
  messageId: number;
  /** 机器人在群里为这张卡片发出的消息 id */
  botMessageIds: number[];
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

export interface TelegramData {
  /** 只在内存里；落盘时去掉 */
  token?: string;
  bot?: { id: number; username: string; canReadAll?: boolean };
  candidates: StoredCandidate[];
  groups: StoredGroup[];
  workspaces: Record<string, StoredWorkspace>;
  cards: StoredCard[];
  pollOffset: number;
  /** 每人每小时最多处理几条（1–1000） */
  rateLimitPerHour: number;
  /** 连续对话的分钟数（0–60，0 关闭）；旧数据没有时按默认 */
  followMinutes: number;
  /** 旧 telegram.json 已经处理过（迁移成功或没有旧数据） */
  legacyMigrated: boolean;
  /** 分诊 / 值班会话用的模型；缺省为默认 */
  triageModel?: ChannelModelRef;
  dutyModel?: ChannelModelRef;
  /** 绑定的维护者（Telegram 用户 id，由服务器填写、不能伪造）；只能绑定一个人 */
  maintainer?: { userId: number; label: string; boundAt: number };
}

/** 维护者名称上限 */
export const MAINTAINER_LABEL_MAX = 128;

export function emptyTelegramData(): TelegramData {
  return {
    candidates: [],
    groups: [],
    workspaces: {},
    cards: [],
    pollOffset: 0,
    rateLimitPerHour: TELEGRAM_RATE_LIMIT_DEFAULT,
    followMinutes: FOLLOW_MINUTES_DEFAULT,
    legacyMigrated: false,
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
const text = (value: unknown, max = TEXT_MAX): string | undefined =>
  typeof value === 'string' ? value.slice(0, max) : undefined;

function parseCandidate(raw: unknown): StoredCandidate | null {
  const r = asRecord(raw);
  if (!r || !isInt(r.chatId) || !isNonNegative(r.seenAt)) return null;
  return { chatId: r.chatId, title: text(r.title, 256) ?? '', seenAt: r.seenAt };
}

/**
 * 群：新结构是 projects + triageSessions；旧结构（0.1.3 及以前）的 workspaceId + triageSessionId
 * 迁成单个项目。坏的项目或会话条目单独丢掉，一个项目都没有时才丢掉这个群。
 */
function parseGroup(raw: unknown): StoredGroup | null {
  const r = asRecord(raw);
  if (!r || !isInt(r.chatId)) return null;
  const projects: StoredProject[] = [];
  const triageSessions: Record<string, string> = {};
  const addProject = (workspaceId: unknown, note: unknown) => {
    if (!isId(workspaceId) || projects.some((p) => p.workspaceId === workspaceId)) return;
    projects.push({ workspaceId, note: text(note, PROJECT_NOTE_MAX)?.trim() ?? '' });
  };
  if (Array.isArray(r.projects)) {
    for (const item of r.projects) {
      const p = asRecord(item);
      if (p) addProject(p.workspaceId, p.note);
    }
    for (const [id, session] of Object.entries(asRecord(r.triageSessions) ?? {})) {
      if (isId(session) && projects.some((p) => p.workspaceId === id)) triageSessions[id] = session;
    }
  } else {
    addProject(r.workspaceId, '');
    if (isId(r.workspaceId) && isId(r.triageSessionId)) {
      triageSessions[r.workspaceId] = r.triageSessionId;
    }
  }
  if (projects.length === 0) return null;
  return {
    chatId: r.chatId,
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
    !isInt(r.chatId) ||
    !isId(r.workspaceId) ||
    typeof r.status !== 'string' ||
    !CARD_STATUSES.includes(r.status) ||
    !isInt(r.messageId) ||
    !isNonNegative(r.createdAt)
  ) {
    return null;
  }
  const card: StoredCard = {
    id: r.id,
    chatId: r.chatId,
    workspaceId: r.workspaceId,
    status: r.status as TelegramCardStatus,
    title: text(r.title, 200) ?? '',
    summary: text(r.summary) ?? '',
    content: text(r.content) ?? '',
    messageId: r.messageId,
    botMessageIds: Array.isArray(r.botMessageIds) ? r.botMessageIds.filter(isInt).slice(-20) : [],
    followUps: isNonNegative(r.followUps) ? Math.min(r.followUps, 2) : 0,
    taskIds: Array.isArray(r.taskIds) ? r.taskIds.filter(isId).slice(0, 50) : [],
    createdAt: r.createdAt,
    updatedAt: isNonNegative(r.updatedAt) ? r.updatedAt : r.createdAt,
  };
  if (typeof r.kind === 'string' && CARD_KINDS.includes(r.kind))
    card.kind = r.kind as TelegramCardKind;
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

/** 宽松收窄：每个字段、每条记录各自校验，坏的丢掉。storage 与旧 telegram.json 共用。 */
export function parseTelegramData(raw: unknown): TelegramData {
  const r = asRecord(raw) ?? {};
  const data = emptyTelegramData();
  if (typeof r.token === 'string' && TELEGRAM_TOKEN_PATTERN.test(r.token)) data.token = r.token;
  const bot = asRecord(r.bot);
  if (bot && isInt(bot.id) && typeof bot.username === 'string') {
    data.bot = {
      id: bot.id,
      username: bot.username,
      ...(typeof bot.canReadAll === 'boolean' ? { canReadAll: bot.canReadAll } : {}),
    };
  }
  data.candidates = list(r.candidates, parseCandidate).slice(-MAX_CANDIDATES);
  const seenGroups = new Set<number>();
  data.groups = list(r.groups, parseGroup).filter((group) => {
    if (seenGroups.has(group.chatId)) return false;
    seenGroups.add(group.chatId);
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
  if (isNonNegative(r.pollOffset)) data.pollOffset = r.pollOffset;
  if (isTelegramRateLimit(r.rateLimitPerHour)) data.rateLimitPerHour = r.rateLimitPerHour;
  if (isFollowMinutes(r.followMinutes)) data.followMinutes = r.followMinutes;
  data.legacyMigrated = r.legacyMigrated === true;
  const triageModel = parseModelRef(r.triageModel);
  if (triageModel) data.triageModel = triageModel;
  const dutyModel = parseModelRef(r.dutyModel);
  if (dutyModel) data.dutyModel = dutyModel;
  const maintainer = asRecord(r.maintainer);
  if (
    maintainer &&
    isInt(maintainer.userId) &&
    maintainer.userId > 0 &&
    typeof maintainer.label === 'string' &&
    maintainer.label.length >= 1 &&
    maintainer.label.length <= MAINTAINER_LABEL_MAX &&
    isNonNegative(maintainer.boundAt)
  ) {
    data.maintainer = {
      userId: maintainer.userId,
      label: maintainer.label,
      boundAt: maintainer.boundAt,
    };
  }
  return data;
}

export interface TelegramStore {
  /** 没写过时为空数据；token 从 secrets 取 */
  load(): Promise<TelegramData>;
  /** 串行写；写失败时 reject。token 不写进 storage */
  save(data: TelegramData): Promise<void>;
}

export function createTelegramStore(api: Pick<FynvraPluginApi, 'storage' | 'secrets'>): TelegramStore {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    async load() {
      const data = parseTelegramData(await api.storage.read());
      delete data.token;
      const token = await api.secrets.get(TOKEN_SECRET_KEY);
      if (typeof token === 'string' && TELEGRAM_TOKEN_PATTERN.test(token)) data.token = token;
      return data;
    },
    save(data) {
      // 先拍快照：排队期间内存里的数据还会变
      const { token: _token, ...rest } = data;
      const snapshot = structuredClone(rest);
      const run = tail.then(() => api.storage.write(snapshot));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
