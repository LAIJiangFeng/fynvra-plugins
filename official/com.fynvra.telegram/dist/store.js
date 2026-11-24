import { FOLLOW_MINUTES_DEFAULT, isFollowMinutes, isTelegramRateLimit, isThinkingLevel, TELEGRAM_RATE_LIMIT_DEFAULT, } from './model.js';
import { TELEGRAM_TOKEN_PATTERN } from './telegramApi.js';
import { asRecord } from './util.js';
export const MAX_CANDIDATES = 20;
export const MAX_CARDS = 500;
const TEXT_MAX = 4_000;
/** api.secrets 里存 token 的键 */
export const TOKEN_SECRET_KEY = 'botToken';
export const PROJECT_NOTE_MAX = 200;
export function emptyTelegramData() {
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
const text = (value, max = TEXT_MAX) => typeof value === 'string' ? value.slice(0, max) : undefined;
function parseCandidate(raw) {
    const r = asRecord(raw);
    if (!r || !isInt(r.chatId) || !isNonNegative(r.seenAt))
        return null;
    return { chatId: r.chatId, title: text(r.title, 256) ?? '', seenAt: r.seenAt };
}
/**
 * 群：新结构是 projects + triageSessions；旧结构（0.1.3 及以前）的 workspaceId + triageSessionId
 * 迁成单个项目。坏的项目或会话条目单独丢掉，一个项目都没有时才丢掉这个群。
 */
function parseGroup(raw) {
    const r = asRecord(raw);
    if (!r || !isInt(r.chatId))
        return null;
    const projects = [];
    const triageSessions = {};
    const addProject = (workspaceId, note) => {
        if (!isId(workspaceId) || projects.some((p) => p.workspaceId === workspaceId))
            return;
        projects.push({ workspaceId, note: text(note, PROJECT_NOTE_MAX)?.trim() ?? '' });
    };
    if (Array.isArray(r.projects)) {
        for (const item of r.projects) {
            const p = asRecord(item);
            if (p)
                addProject(p.workspaceId, p.note);
        }
        for (const [id, session] of Object.entries(asRecord(r.triageSessions) ?? {})) {
            if (isId(session) && projects.some((p) => p.workspaceId === id))
                triageSessions[id] = session;
        }
    }
    else {
        addProject(r.workspaceId, '');
        if (isId(r.workspaceId) && isId(r.triageSessionId)) {
            triageSessions[r.workspaceId] = r.triageSessionId;
        }
    }
    if (projects.length === 0)
        return null;
    return {
        chatId: r.chatId,
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
        !isInt(r.chatId) ||
        !isId(r.workspaceId) ||
        typeof r.status !== 'string' ||
        !CARD_STATUSES.includes(r.status) ||
        !isInt(r.messageId) ||
        !isNonNegative(r.createdAt)) {
        return null;
    }
    const card = {
        id: r.id,
        chatId: r.chatId,
        workspaceId: r.workspaceId,
        status: r.status,
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
/** 宽松收窄：每个字段、每条记录各自校验，坏的丢掉。storage 与旧 telegram.json 共用。 */
export function parseTelegramData(raw) {
    const r = asRecord(raw) ?? {};
    const data = emptyTelegramData();
    if (typeof r.token === 'string' && TELEGRAM_TOKEN_PATTERN.test(r.token))
        data.token = r.token;
    const bot = asRecord(r.bot);
    if (bot && isInt(bot.id) && typeof bot.username === 'string') {
        data.bot = {
            id: bot.id,
            username: bot.username,
            ...(typeof bot.canReadAll === 'boolean' ? { canReadAll: bot.canReadAll } : {}),
        };
    }
    data.candidates = list(r.candidates, parseCandidate).slice(-MAX_CANDIDATES);
    const seenGroups = new Set();
    data.groups = list(r.groups, parseGroup).filter((group) => {
        if (seenGroups.has(group.chatId))
            return false;
        seenGroups.add(group.chatId);
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
    if (isNonNegative(r.pollOffset))
        data.pollOffset = r.pollOffset;
    if (isTelegramRateLimit(r.rateLimitPerHour))
        data.rateLimitPerHour = r.rateLimitPerHour;
    if (isFollowMinutes(r.followMinutes))
        data.followMinutes = r.followMinutes;
    data.legacyMigrated = r.legacyMigrated === true;
    const triageModel = parseModelRef(r.triageModel);
    if (triageModel)
        data.triageModel = triageModel;
    const dutyModel = parseModelRef(r.dutyModel);
    if (dutyModel)
        data.dutyModel = dutyModel;
    return data;
}
export function createTelegramStore(api) {
    let tail = Promise.resolve();
    return {
        async load() {
            const data = parseTelegramData(await api.storage.read());
            delete data.token;
            const token = await api.secrets.get(TOKEN_SECRET_KEY);
            if (typeof token === 'string' && TELEGRAM_TOKEN_PATTERN.test(token))
                data.token = token;
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
