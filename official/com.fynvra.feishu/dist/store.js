// 插件数据（结构同 Telegram 插件的 store.ts）：存进 api.storage（≤ 5 MB，原子写）。
// App Secret 不进 storage，放在 api.secrets 的 appSecret；App ID 不是密钥，存在 storage。
// 字段非法时只丢弃那个字段或那条记录。
import { APP_ID_PATTERN, APP_SECRET_PATTERN, isFeishuId } from './feishuApi.js';
import { FOLLOW_MINUTES_DEFAULT, isFollowMinutes, isRateLimit, isThinkingLevel, RATE_LIMIT_DEFAULT, } from './model.js';
import { asRecord } from './util.js';
export const MAX_CANDIDATES = 20;
export const MAX_CARDS = 500;
/** 记住机器人发过的消息 id（判断「回复机器人」用）的条数 */
export const MAX_BOT_MESSAGES = 500;
const TEXT_MAX = 4_000;
/** api.secrets 里存 App Secret 的键 */
export const SECRET_KEY = 'appSecret';
export const PROJECT_NOTE_MAX = 200;
export function emptyFeishuData() {
    return {
        candidates: [],
        chats: [],
        workspaces: {},
        cards: [],
        botMessageIds: [],
        rateLimitPerHour: RATE_LIMIT_DEFAULT,
        followMinutes: FOLLOW_MINUTES_DEFAULT,
    };
}
const CARD_KINDS = ['bug', 'feature', 'question', 'invalid'];
const CARD_STATUSES = [
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
const isInt = (value) => Number.isSafeInteger(value);
const isNonNegative = (value) => isInt(value) && value >= 0;
const isId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const isChatType = (value) => value === 'group' || value === 'p2p';
const text = (value, max = TEXT_MAX) => typeof value === 'string' ? value.slice(0, max) : undefined;
function parseCandidate(raw) {
    const r = asRecord(raw);
    if (!r || !isFeishuId(r.chatId) || !isChatType(r.chatType) || !isNonNegative(r.seenAt))
        return null;
    return { chatId: r.chatId, chatType: r.chatType, title: text(r.title, 256) ?? '', seenAt: r.seenAt };
}
/** 会话：坏的项目或会话条目单独丢掉，一个项目都没有时才丢掉这个会话 */
function parseChat(raw) {
    const r = asRecord(raw);
    if (!r || !isFeishuId(r.chatId) || !isChatType(r.chatType))
        return null;
    const projects = [];
    const triageSessions = {};
    for (const item of Array.isArray(r.projects) ? r.projects : []) {
        const p = asRecord(item);
        if (!p || !isId(p.workspaceId) || projects.some((x) => x.workspaceId === p.workspaceId))
            continue;
        projects.push({ workspaceId: p.workspaceId, note: text(p.note, PROJECT_NOTE_MAX)?.trim() ?? '' });
    }
    for (const [id, session] of Object.entries(asRecord(r.triageSessions) ?? {})) {
        if (isId(session) && projects.some((p) => p.workspaceId === id))
            triageSessions[id] = session;
    }
    if (projects.length === 0)
        return null;
    return {
        chatId: r.chatId,
        chatType: r.chatType,
        title: text(r.title, 256) ?? '',
        projects,
        triageSessions,
        active: r.active !== false,
    };
}
function parseWorkspaceEntry(raw) {
    const r = asRecord(raw);
    if (!r)
        return null;
    return isId(r.dutySessionId) ? { dutySessionId: r.dutySessionId } : {};
}
function parseCard(raw) {
    const r = asRecord(raw);
    if (!r ||
        !isNonNegative(r.id) ||
        !isFeishuId(r.chatId) ||
        !isId(r.workspaceId) ||
        typeof r.status !== 'string' ||
        !CARD_STATUSES.includes(r.status) ||
        !isFeishuId(r.messageId) ||
        !isNonNegative(r.createdAt)) {
        return null;
    }
    const card = {
        id: r.id,
        chatId: r.chatId,
        chatType: isChatType(r.chatType) ? r.chatType : 'group',
        workspaceId: r.workspaceId,
        status: r.status,
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
    if (typeof r.kind === 'string' && CARD_KINDS.includes(r.kind))
        card.kind = r.kind;
    const evidence = text(r.evidence);
    if (evidence !== undefined)
        card.evidence = evidence;
    const assessment = text(r.assessment);
    if (assessment !== undefined)
        card.assessment = assessment;
    if (r.assessmentIncomplete === true)
        card.assessmentIncomplete = true;
    const lastReply = text(r.lastReply);
    if (lastReply !== undefined)
        card.lastReply = lastReply;
    if (isNonNegative(r.askedAt))
        card.askedAt = r.askedAt;
    if (r.duty === 'queued' || r.duty === 'sent')
        card.duty = r.duty;
    if (isNonNegative(r.deliveredAt))
        card.deliveredAt = r.deliveredAt;
    if (typeof r.prUrl === 'string' && /^https:\/\/\S+$/.test(r.prUrl))
        card.prUrl = r.prUrl;
    return card;
}
const isModelId = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 200;
/** 模型引用：服务 id 与模型 id 各 1–200 字符，不合法时当作没选；档位不合法时当作没选档位，保留模型 */
export function parseModelRef(raw) {
    const r = asRecord(raw);
    if (!r || !isModelId(r.providerId) || !isModelId(r.modelId))
        return undefined;
    return {
        providerId: r.providerId,
        modelId: r.modelId,
        ...(isThinkingLevel(r.thinking) ? { thinking: r.thinking } : {}),
    };
}
function list(raw, parse) {
    return Array.isArray(raw) ? raw.flatMap((item) => parse(item) ?? []) : [];
}
/** 宽松收窄：每个字段、每条记录各自校验，坏的丢掉 */
export function parseFeishuData(raw) {
    const r = asRecord(raw) ?? {};
    const data = emptyFeishuData();
    if (typeof r.appId === 'string' && APP_ID_PATTERN.test(r.appId))
        data.appId = r.appId;
    const bot = asRecord(r.bot);
    if (bot && isFeishuId(bot.openId)) {
        data.bot = { openId: bot.openId, name: text(bot.name, 128) ?? '' };
    }
    data.candidates = list(r.candidates, parseCandidate).slice(-MAX_CANDIDATES);
    const seenChats = new Set();
    data.chats = list(r.chats, parseChat).filter((chat) => {
        if (seenChats.has(chat.chatId))
            return false;
        seenChats.add(chat.chatId);
        return true;
    });
    for (const [id, entry] of Object.entries(asRecord(r.workspaces) ?? {})) {
        const parsed = isId(id) ? parseWorkspaceEntry(entry) : null;
        if (parsed)
            data.workspaces[id] = parsed;
    }
    const seenCards = new Set();
    data.cards = list(r.cards, parseCard)
        .filter((card) => {
        if (seenCards.has(card.id))
            return false;
        seenCards.add(card.id);
        return true;
    })
        .slice(-MAX_CARDS);
    if (Array.isArray(r.botMessageIds)) {
        data.botMessageIds = r.botMessageIds.filter(isFeishuId).slice(-MAX_BOT_MESSAGES);
    }
    if (isRateLimit(r.rateLimitPerHour))
        data.rateLimitPerHour = r.rateLimitPerHour;
    if (isFollowMinutes(r.followMinutes))
        data.followMinutes = r.followMinutes;
    const triageModel = parseModelRef(r.triageModel);
    if (triageModel)
        data.triageModel = triageModel;
    const dutyModel = parseModelRef(r.dutyModel);
    if (dutyModel)
        data.dutyModel = dutyModel;
    return data;
}
export function createFeishuStore(api) {
    let tail = Promise.resolve();
    return {
        async load() {
            const data = parseFeishuData(await api.storage.read());
            const secret = await api.secrets.get(SECRET_KEY);
            if (typeof secret === 'string' && APP_SECRET_PATTERN.test(secret))
                data.appSecret = secret;
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
