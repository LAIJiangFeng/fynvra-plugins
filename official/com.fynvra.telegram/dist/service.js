// Telegram 群反馈值班服务（移植自 Fynvra 内置 telegram/service.ts，ARCHITECTURE §7.14）：
// 轮询、群发现与准入、分诊投递、triage_report 处理、追问、值班投递、卡片与任务关联、PR 结果通知。
// 群里只会收到经 api.channel.filterOutbound 过滤后的 triage 回复与固定模板。
// 与内置版的差别只在依赖：会话、干净检出、编排快照、出站过滤、通知都走宿主 API（见 README「与内置版的差异」）。
import { randomBytes } from 'node:crypto';
import { isFollowMinutes, isTelegramRateLimit, maskTelegramToken, } from './model.js';
import { addMessageAttachments, cleanupStaleAttachments, downloadAttachments, mergeAttachments, rejectionSummary, removeFiles, } from './attachments.js';
import { dutyPrompt, MAX_FOLLOW_UPS, mentionsOthers, parseAssessment, parseBotMention, parseBugCommand, parseDecision, parseTriageInput, prOpenedMessage, pullRequestSection, TEMPLATES, triagePrompt, } from './content.js';
import { displayName, FORWARDED_MARK, isForwarded, readReply } from './quote.js';
import { createTelegramStore, emptyTelegramData, MAINTAINER_LABEL_MAX, MAX_CANDIDATES, MAX_CARDS, parseModelRef, parseTelegramData, PROJECT_NOTE_MAX, TOKEN_SECRET_KEY, } from './store.js';
import { redactToken, TELEGRAM_TOKEN_PATTERN, TelegramApiError, } from './telegramApi.js';
import { asRecord, errorMessage } from './util.js';
export const DEBOUNCE_MS = 3_000;
export const MAX_QUEUE_PER_GROUP = 50;
export const FOLLOW_UP_TIMEOUT_MS = 24 * 60 * 60_000;
export const DUTY_IDLE_MS = 30 * 60_000;
export const MAINTENANCE_INTERVAL_MS = 10 * 60_000;
const BACKOFF_START_MS = 3_000;
const BACKOFF_MAX_MS = 60_000;
const HOUR_MS = 60 * 60_000;
const ITEM_TEXT_MAX = 4_000;
/** 被识别为反馈但只有附件、没有文字时的正文 */
const ATTACHMENT_ONLY_TEXT = '（只发了附件，没有文字）';
/** 宿主 channel.createSession 的标题上限 */
const SESSION_TITLE_MAX = 200;
/** 只 @ 了机器人、前后都没有内容时的正文 */
const EMPTY_MENTION_TEXT = '（只 @ 了机器人，没有写内容）';
/** 反馈投递后又发了附件（R5）时的正文开头 */
const SUPPLEMENT_TEXT = '（补充了附件）';
/** 普通消息缓冲窗口：只在内存里，用来拼接同一人的 @ 或回复 */
export const CONTEXT_WINDOW_MS = 60_000;
/** 有正文、没有附件的条目投递前等图的时间（R4） */
export const ATTACH_WAIT_MS = 8_000;
/** 条目创建后连续并入消息时最多等这么久就投递（Q3） */
export const MAX_GATHER_MS = 30_000;
/** @ 前缓冲文字合计上限（Q2，与飞书插件一致） */
export const PRE_TEXT_MAX = 2_000;
/** 核心 channel.prompt 的 text 上限（UTF-8 字节），投递正文必须小于它 */
const MAX_PROMPT_BYTES = 64 * 1024;
const TRUNCATED_MARK = '（过长，已截断）';
/** 只引用了一条消息并 @、自己没写字时的正文 */
const QUOTE_ONLY_TEXT = '（只 @ 了机器人，并引用了一条消息）';
const BUFFER_PER_SENDER = 10;
const BUFFER_SENDERS_PER_GROUP = 200;
/** 记住最近多少条已开始投递的消息 id（TG-E：再编辑时忽略） */
const DELIVERED_MAX = 2_000;
/** 维护者绑定码的有效期 */
export const BIND_CODE_MS = 10 * 60_000;
/** 维护者没指明卡片地说「确认 / 算了」时，只看这段时间内更新过的待确认卡片 */
const DECISION_CARD_MS = 24 * 60 * 60_000;
/** 还在分诊阶段、回复它就是对这张卡片的追问回复的状态；其余状态的卡片被回复时按新反馈处理 */
const RETRIAGE_STATUSES = new Set([
    'asking',
    'answered',
    'invalid',
    'declined',
    'unconfirmed',
    'unreported',
]);
const OPEN_TASK_STATUSES = new Set(['todo', 'in-progress', 'in-review']);
const CHANNEL_STATUSES = [
    'idle',
    'running',
    'waiting-approval',
    'error',
    'archived',
    'missing',
];
const isBusy = (status) => status === 'running' || status === 'waiting-approval';
/** 条目正文：所在话题、@ 前的消息、正文（含并入的后续消息）、引用段 */
function itemText(item) {
    return [
        item.topic ? `所在话题：${item.topic}` : '',
        item.pre ?? '',
        ...item.texts,
        ...(item.quotes ?? []),
    ]
        .filter(Boolean)
        .join('\n');
}
/** 卡片保存的原始内容：限 ITEM_TEXT_MAX，引用段留一半位置，追问时也看得到 */
function cardContent(item) {
    const quotes = (item.quotes ?? []).join('\n').slice(0, ITEM_TEXT_MAX / 2);
    const head = itemText({ ...item, quotes: [] }).slice(0, ITEM_TEXT_MAX - quotes.length - 1);
    return [head, quotes].filter(Boolean).join('\n');
}
/** 按 UTF-8 字节截取前面不超过 max 字节（不切开字符） */
function cutBytes(text, max) {
    let size = 0;
    let out = '';
    for (const ch of text) {
        size += Buffer.byteLength(ch);
        if (size > max)
            break;
        out += ch;
    }
    return out;
}
/**
 * Q4：投递正文超过核心上限时依次截短引用文字、@ 前的消息，最后是正文本身，直到小于上限。
 * build 把各部分拼成完整正文（含转义）。
 */
export function fitPrompt(parts, build) {
    let current = parts;
    let prompt = build(current);
    for (const key of ['quotes', 'pre', 'texts']) {
        const over = Buffer.byteLength(prompt) - (MAX_PROMPT_BYTES - 1);
        if (over <= 0)
            break;
        const value = current[key];
        const text = Array.isArray(value) ? value.join('\n') : (value ?? '');
        if (!text)
            continue;
        // 多留 256 字节余量给截断标注；截掉的原文字节不少于转义后减少的字节
        const cut = `${cutBytes(text, Buffer.byteLength(text) - over - 256)}${TRUNCATED_MARK}`;
        current = { ...current, [key]: key === 'pre' ? cut : [cut] };
        prompt = build(current);
    }
    return prompt;
}
/** Q2：@ 前缓冲里的文字，按时间顺序，合计最多 PRE_TEXT_MAX 字；超出时保留最近的 */
function preText(list) {
    const kept = [];
    let size = 0;
    for (const { text } of [...list].reverse()) {
        if (!text)
            continue;
        if (size + text.length > PRE_TEXT_MAX) {
            // 最近的一条就超长：截断它；否则丢掉更早的
            if (kept.length === 0)
                kept.push(`${text.slice(0, PRE_TEXT_MAX)}${TRUNCATED_MARK}`);
            break;
        }
        kept.push(text);
        size += text.length;
    }
    if (kept.length === 0)
        return undefined;
    return [
        `（以下是该用户在 @ 前 1 分钟内发的 ${kept.length} 条消息，可能是这条反馈的上下文）`,
        ...kept.reverse(),
    ].join('\n');
}
function isGroupChat(chat) {
    return chat?.type === 'group' || chat?.type === 'supergroup';
}
const sessionTitle = (title) => title.slice(0, SESSION_TITLE_MAX);
export function createTelegramService(deps) {
    const { api } = deps;
    const store = createTelegramStore(api);
    const now = deps.now ?? Date.now;
    const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
    const orchestrationDelayMs = deps.orchestrationDelayMs ?? 300;
    const attachWaitMs = deps.attachWaitMs ?? ATTACH_WAIT_MS;
    const wait = deps.sleep ??
        ((ms, signal) => new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
        }));
    let data = emptyTelegramData();
    let connection = 'no-token';
    let poll;
    let maintenanceTimer;
    let stopped = false;
    const unsubscribes = [];
    let lastWrite = Promise.resolve();
    const listeners = new Set();
    const queues = new Map();
    const chatTimers = new Map();
    const pumping = new Set();
    const inflight = new Map();
    /** 每个群、每个发送者最近 60 秒的普通消息（只在内存里；Map 的顺序即最近活跃顺序） */
    const buffers = new Map();
    /** 每个群、每个发送者最近一次开始投递的反馈条目（R5） */
    const recent = new Map();
    const rate = new Map();
    /** 连续对话窗口（F1）：群 → 成员 → 到期时间（本机时间）与机器人回复所属的卡片；只在内存里 */
    const follows = new Map();
    /** 已开始投递的消息（`群:消息 id`，按插入顺序保留最近 DELIVERED_MAX 条） */
    const deliveredIds = new Set();
    /** 每人上一次收到限流提示的消息时间；一个限流窗口内只提示一次 */
    const rateNoticed = new Map();
    const dutyRounds = new Map();
    const dutyBusy = new Set();
    const dutySettledAt = new Map();
    const prChecks = new Map();
    /** 每个会话最近一次已知的状态（来自 channel.session 事件与 sessionStatus 查询） */
    const statuses = new Map();
    /** 已写过 PR 说明的任务（进程内；重启后再写一次无害） */
    const notedTasks = new Set();
    /**
     * 换模型时正在运行的会话，下一次投递前补上。
     * shortcut: 只在内存里，重启后丢失（会话继续用旧模型，用户重选一次即可），有人反馈再落盘
     */
    const pendingModel = new Set();
    /** 所选模型不可用、已改用默认（设置页提示用） */
    let modelFallback = false;
    /** 维护者绑定码：只在内存里，同时只有一个；到期时刷新设置页 */
    let bindCode;
    let bindTimer;
    const isMaintainer = (userId) => data.maintainer?.userId === userId;
    const validBindCode = () => (bindCode && now() < bindCode.expiresAt ? bindCode : undefined);
    const safe = (text) => redactToken(text, data.token);
    const warn = (message) => api.log('warn', safe(message));
    const notify = (title, body) => {
        api.notify({ title, body }).catch((error) => warn(`发送通知失败：${errorMessage(error)}`));
    };
    /** 条目被丢弃：删掉已下载的附件文件 */
    const discardFiles = (items) => {
        for (const item of items) {
            if (!item.downloaded)
                continue;
            void removeFiles(item.downloaded.paths);
            delete item.downloaded;
        }
    };
    const dropQueue = (chatId) => {
        discardFiles(queues.get(chatId) ?? []);
        queues.delete(chatId);
        buffers.delete(chatId);
        recent.delete(chatId);
        follows.delete(chatId);
    };
    /** 机器人在群里回复了成员：打开或续上连续对话窗口（F1） */
    const openFollow = (chatId, fromId, cardId) => {
        if (data.followMinutes <= 0)
            return;
        const windows = follows.get(chatId) ?? new Map();
        windows.set(fromId, { until: now() + data.followMinutes * 60_000, cardId });
        follows.set(chatId, windows);
    };
    /** 跟随条目被判 invalid：退回它占用的限流次数 */
    const refundRate = (item) => {
        const list = rate.get(item.fromId);
        const at = item.rateAt === undefined ? -1 : (list?.lastIndexOf(item.rateAt) ?? -1);
        if (at >= 0)
            list?.splice(at, 1);
    };
    const markDelivered = (chatId, ids) => {
        for (const id of ids)
            deliveredIds.add(`${chatId}:${id}`);
        for (const key of deliveredIds) {
            if (deliveredIds.size <= DELIVERED_MAX)
                break;
            deliveredIds.delete(key);
        }
    };
    /** 丢掉超过 60 秒的缓冲与 R5 记录（缓冲按消息时间，R5 按本机时间）和到期的连续对话窗口 */
    const pruneContext = (chatId, messageTime) => {
        const senders = buffers.get(chatId);
        for (const [fromId, list] of senders ?? []) {
            const kept = list.filter((m) => messageTime - m.date <= CONTEXT_WINDOW_MS);
            if (kept.length === 0)
                senders?.delete(fromId);
            else
                senders?.set(fromId, kept);
        }
        if (senders?.size === 0)
            buffers.delete(chatId);
        const records = recent.get(chatId);
        for (const [fromId, record] of records ?? []) {
            if (now() - record.at > CONTEXT_WINDOW_MS)
                records?.delete(fromId);
        }
        if (records?.size === 0)
            recent.delete(chatId);
        const windows = follows.get(chatId);
        for (const [fromId, window] of windows ?? []) {
            if (now() >= window.until)
                windows?.delete(fromId);
        }
        if (windows?.size === 0)
            follows.delete(chatId);
    };
    const bufferMessage = (chatId, fromId, entry) => {
        const senders = buffers.get(chatId) ?? new Map();
        const list = senders.get(fromId) ?? [];
        list.push(entry);
        if (list.length > BUFFER_PER_SENDER)
            list.splice(0, list.length - BUFFER_PER_SENDER);
        // 重新插入：最近活跃的发送者排在最后，超出时丢最久没说话的
        senders.delete(fromId);
        senders.set(fromId, list);
        for (const oldest of senders.keys()) {
            if (senders.size <= BUFFER_SENDERS_PER_GROUP)
                break;
            senders.delete(oldest);
        }
        buffers.set(chatId, senders);
    };
    /** 取出同一发送者在 time 之前 60 秒内的缓冲（按时间顺序），不移除 */
    const bufferedBefore = (chatId, fromId, time) => (buffers.get(chatId)?.get(fromId) ?? []).filter((m) => m.date <= time && time - m.date <= CONTEXT_WINDOW_MS);
    const unbuffer = (chatId, fromId, used) => {
        const senders = buffers.get(chatId);
        const left = (senders?.get(fromId) ?? []).filter((m) => !used.includes(m));
        if (left.length > 0)
            senders?.set(fromId, left);
        else
            senders?.delete(fromId);
    };
    const hasFiles = (item) => item.files.refs.length + item.files.rejected.length > 0;
    /** 投递前等多久：已带附件的 3 秒，只有文字的多等一会儿图（R4） */
    const readyDelay = (item) => (hasFiles(item) ? debounceMs : attachWaitMs);
    // ---------- 状态与落盘 ----------
    const persist = () => {
        const write = store.save(data);
        lastWrite = write.catch((error) => warn(`保存插件数据失败：${errorMessage(error)}`));
        return write;
    };
    const emit = () => {
        for (const listener of listeners) {
            try {
                listener();
            }
            catch (error) {
                warn(`变更监听失败：${errorMessage(error)}`);
            }
        }
    };
    /** 改了数据：落盘（失败只记日志）并通知 */
    const commit = () => {
        void persist().catch(() => undefined);
        emit();
    };
    const setConnection = (next) => {
        if (connection === next)
            return;
        connection = next;
        emit();
    };
    const idleConnection = () => (data.token ? 'connecting' : 'no-token');
    // ---------- 查找 ----------
    const cardById = (id) => data.cards.find((card) => card.id === id);
    const groupOf = (chatId) => data.groups.find((group) => group.chatId === chatId);
    /** 回复了某张卡片：还在分诊阶段的算追问回复，其余按新反馈并把它作背景 */
    const routeOf = (card) => RETRIAGE_STATUSES.has(card.status) ? { cardId: card.id } : { contextCardId: card.id };
    /** 分诊会话属于哪个群的哪个项目（项目已从群里移除的不算） */
    const groupOfSession = (sessionId) => {
        for (const group of data.groups) {
            for (const { workspaceId } of group.projects) {
                if (group.triageSessions[workspaceId] === sessionId)
                    return { group, workspaceId };
            }
        }
        return undefined;
    };
    const primaryOf = (group) => group.projects[0]?.workspaceId ?? '';
    /** 条目该投给哪个项目：转交目标 > 所回复卡片的项目 > 主项目；不再绑定的项目回落到主项目 */
    const targetOf = (group, item) => {
        const cardId = item.cardId ?? item.contextCardId;
        const wanted = item.forward?.workspaceId ?? (cardId === undefined ? undefined : cardById(cardId)?.workspaceId);
        return wanted && group.projects.some((p) => p.workspaceId === wanted)
            ? wanted
            : primaryOf(group);
    };
    /** 群里各项目给 AI 看的名称：工作区名；同名（trim 后不区分大小写）时后面加 id */
    const projectLabels = (group, workspaces) => {
        const names = group.projects.map(({ workspaceId }) => workspaces.find((w) => w.id === workspaceId)?.name.trim() || workspaceId);
        const key = (name) => name.trim().toLowerCase();
        return new Map(group.projects.map(({ workspaceId }, index) => {
            const name = names[index] ?? workspaceId;
            const dup = names.filter((other) => key(other) === key(name)).length > 1;
            return [workspaceId, dup ? `${name}（${workspaceId}）` : name];
        }));
    };
    const workspaceOfDuty = (sessionId) => Object.entries(data.workspaces).find(([, entry]) => entry.dutySessionId === sessionId)?.[0];
    const findWorkspace = async (id) => (await api.workspaces.list()).find((workspace) => workspace.id === id);
    // ---------- 会话状态 ----------
    /**
     * 记下会话状态。内置版靠 agent_settled 事件判断「这一轮结束」，插件只有状态：
     * 从 running / waiting-approval 变成别的状态即视为这一轮结束；事件里变成 idle 时再试着投递排队的条目。
     */
    const track = (sessionId, status, fromEvent) => {
        const prev = statuses.get(sessionId);
        statuses.set(sessionId, status);
        if (isBusy(prev) && !isBusy(status))
            onSettled(sessionId);
        else if (fromEvent && status === 'idle')
            onSessionIdle(sessionId);
    };
    /** 查询会话状态；别的插件的会话（例如内置版留下的旧会话）按 missing 处理 */
    const statusOf = async (sessionId) => {
        let status;
        try {
            status = (await api.channel.sessionStatus({ sessionId })).status;
        }
        catch (error) {
            if (!/session not found/.test(errorMessage(error)))
                throw error;
            status = 'missing';
        }
        track(sessionId, status, false);
        return status;
    };
    const sessionAlive = async (sessionId) => {
        if (!sessionId)
            return false;
        const status = await statusOf(sessionId);
        return status !== 'archived' && status !== 'missing';
    };
    /** 本工作区的档位会话（分诊与值班）是否有正在跑的（按最近已知状态） */
    const profileSessionRunning = (workspaceId) => {
        const ids = [
            ...data.groups.map((g) => g.triageSessions[workspaceId]),
            data.workspaces[workspaceId]?.dutySessionId,
        ];
        return ids.some((id) => id !== undefined && isBusy(statuses.get(id)));
    };
    const refreshCheckout = async (workspaceId) => {
        if (profileSessionRunning(workspaceId))
            return;
        try {
            await api.channel.refreshCheckout({ workspaceId });
        }
        catch (error) {
            warn(`刷新干净检出失败（${workspaceId}）：${errorMessage(error)}`);
        }
    };
    // ---------- 群消息发送（只接受过滤后的 triage 回复与固定模板） ----------
    const sendToGroup = async (card, text, replyTo) => {
        const group = groupOf(card.chatId);
        const token = data.token;
        if (!token || !group?.active || text.trim() === '')
            return;
        try {
            const sent = await deps.telegram.sendMessage(token, { chatId: card.chatId, text, replyTo });
            card.botMessageIds = [...card.botMessageIds, sent.messageId].slice(-20);
        }
        catch (error) {
            warn(`发送群消息失败（卡片 #${card.id}）：${errorMessage(error)}`);
        }
    };
    /** 限流提示：固定模板，不关联卡片、不调用模型 */
    const notifyRateLimited = async (chatId, replyTo) => {
        const token = data.token;
        if (!token)
            return;
        try {
            await deps.telegram.sendMessage(token, { chatId, text: TEMPLATES.rateLimited, replyTo });
        }
        catch (error) {
            warn(`发送限流提示失败：${errorMessage(error)}`);
        }
    };
    /** 外发过滤：本机信息已替换；命中密钥返回 null（过滤失败也按命中处理，宁可不发） */
    const filterOutbound = async (text) => {
        try {
            const result = await api.channel.filterOutbound({ text });
            return result.ok ? result.text : null;
        }
        catch (error) {
            warn(`出站过滤失败：${errorMessage(error)}`);
            return null;
        }
    };
    const sendTriageReply = async (card, reply, replyTo) => {
        const filtered = await filterOutbound(reply);
        // 插件自己的 token 也不许发（宿主的已知密钥里已有它，这里再兜一层）
        if (filtered === null || (data.token !== undefined && filtered.includes(data.token))) {
            card.lastReply = TEMPLATES.blocked;
            notify('Telegram 群回复已拦下', `卡片 #${card.id} 的回复疑似含密钥，已改发中性提示。`);
            await sendToGroup(card, TEMPLATES.blocked, replyTo);
            return;
        }
        card.lastReply = filtered;
        await sendToGroup(card, filtered, replyTo);
    };
    // ---------- 会话 ----------
    const createSession = async (workspaceId, profile, title) => {
        const base = { workspaceId, profile, title: sessionTitle(title) };
        const model = modelOf(profile);
        let sessionId;
        if (!model) {
            // 没选模型时不带 model：旧版 Fynvra 不认这个参数
            ({ sessionId } = await api.channel.createSession(base));
        }
        else {
            try {
                ({ sessionId } = await api.channel.createSession({ ...base, model }));
            }
            catch (error) {
                warn(`所选模型不可用（${model.providerId} / ${model.modelId}${model.thinking ? ` · ${model.thinking}` : ''}），改用默认模型和档位建会话：${errorMessage(error)}`);
                ({ sessionId } = await api.channel.createSession(base));
                modelFallback = true;
                emit();
            }
        }
        statuses.set(sessionId, 'idle');
        return sessionId;
    };
    const modelOf = (profile) => profile === 'triage' ? data.triageModel : data.dutyModel;
    /** 给已有会话换成当前选择的模型；运行中的记成待应用 */
    const applyModel = async (sessionId, profile) => {
        pendingModel.delete(sessionId);
        // 旧版 Fynvra 没有这个方法
        if (typeof api.channel.setSessionModel !== 'function')
            return;
        const model = modelOf(profile) ?? null;
        try {
            await api.channel.setSessionModel({ sessionId, model });
        }
        catch (error) {
            const status = await statusOf(sessionId).catch(() => undefined);
            if (isBusy(status)) {
                pendingModel.add(sessionId);
                return;
            }
            if (status === 'archived' || status === 'missing')
                return;
            warn(`给会话 ${sessionId} 换模型失败：${errorMessage(error)}`);
            if (model) {
                modelFallback = true;
                emit();
            }
        }
    };
    /** 投递前补上换模型时因运行中没换成的 */
    const applyPendingModel = async (sessionId, profile) => {
        if (pendingModel.has(sessionId))
            await applyModel(sessionId, profile);
    };
    /** 「群 × 项目」的分诊会话：没有或已失效时创建 */
    const ensureTriageSession = async (group, workspaceId) => {
        const existing = group.triageSessions[workspaceId];
        if (await sessionAlive(existing))
            return existing;
        let sessionId;
        try {
            sessionId = await createSession(workspaceId, 'triage', `Telegram 分诊 · ${group.title}`);
        }
        catch (error) {
            warn(`创建分诊会话失败（${workspaceId}）：${errorMessage(error)}`);
            return undefined;
        }
        group.triageSessions[workspaceId] = sessionId;
        commit();
        return sessionId;
    };
    const ensureDutySession = async (workspaceId) => {
        const entry = data.workspaces[workspaceId];
        if (entry && (await sessionAlive(entry.dutySessionId)))
            return entry.dutySessionId;
        let sessionId;
        try {
            sessionId = await createSession(workspaceId, 'restricted', 'Telegram 值班');
        }
        catch (error) {
            warn(`创建值班会话失败（${workspaceId}）：${errorMessage(error)}`);
            return undefined;
        }
        data.workspaces[workspaceId] = { dutySessionId: sessionId };
        commit();
        return sessionId;
    };
    // ---------- 分诊投递 ----------
    const scheduleChat = (chatId, delay) => {
        clearTimeout(chatTimers.get(chatId));
        if (stopped)
            return;
        chatTimers.set(chatId, setTimeout(() => {
            chatTimers.delete(chatId);
            void pumpChat(chatId);
        }, delay));
    };
    /**
     * 下一个可以投递的条目：每个发送者只看他最早的一条（保持同一人内的顺序），
     * 未就绪的不挡住别人已就绪的；都没就绪时返回最早的就绪时间。
     */
    const pickReady = (queue) => {
        const seen = new Set();
        let wake = Number.POSITIVE_INFINITY;
        for (const item of queue) {
            if (seen.has(item.fromId))
                continue;
            seen.add(item.fromId);
            if (item.readyAt <= now())
                return { item, wake: 0 };
            wake = Math.min(wake, item.readyAt);
        }
        return { wake };
    };
    const pumpChat = async (chatId) => {
        if (pumping.has(chatId) || stopped)
            return;
        const queue = queues.get(chatId);
        if (!queue || queue.length === 0)
            return;
        const group = groupOf(chatId);
        if (!group?.active) {
            dropQueue(chatId);
            return;
        }
        const next = pickReady(queue);
        if (!next.item) {
            scheduleChat(chatId, next.wake - now());
            return;
        }
        const item = next.item;
        if (item.supplementOf) {
            const source = item.supplementOf;
            // 来源条目还在分诊或等转交：等它的卡片定下来（那一轮结束后会再触发投递）
            if (source.cardId === undefined &&
                ([...inflight.values()].some((i) => i.outcome === source) ||
                    queue.some((q) => q !== item && q.outcome === source))) {
                return;
            }
            // 卡片已定：按回复该卡片路由（投到卡片所属项目）
            const card = source.cardId === undefined ? undefined : cardById(source.cardId);
            if (card)
                Object.assign(item, routeOf(card));
            delete item.supplementOf;
        }
        const workspaceId = targetOf(group, item);
        if (inflight.has(group.triageSessions[workspaceId] ?? ''))
            return;
        pumping.add(chatId);
        try {
            const workspaces = await api.workspaces.list();
            if (!workspaces.some((w) => w.id === workspaceId)) {
                warn(`群绑定的工作区不存在：${workspaceId}`);
                return;
            }
            const sessionId = await ensureTriageSession(group, workspaceId);
            if (!sessionId)
                return;
            if ((await statusOf(sessionId)) !== 'idle')
                return; // 忙：结束或 idle 事件后再投
            await refreshCheckout(workspaceId);
            if (!queue.includes(item) || inflight.has(sessionId))
                return;
            if (item.awaiting) {
                // 60 秒没等到后一条：用占位正文投递，让 AI 追问
                item.awaiting = false;
                item.texts = [EMPTY_MENTION_TEXT];
            }
            if (!item.started) {
                item.started = true;
                const records = recent.get(chatId) ?? new Map();
                records.set(item.fromId, { outcome: item.outcome, at: now() });
                recent.set(chatId, records);
                markDelivered(chatId, item.messageIds);
            }
            if (!item.downloaded) {
                const token = data.token;
                item.downloaded = token
                    ? await downloadAttachments({
                        dataDir: api.dataDir,
                        token,
                        telegram: deps.telegram,
                        refs: item.files.refs,
                        warn,
                    })
                    : {
                        attachments: [],
                        paths: [],
                        rejected: item.files.refs.map((ref) => ({ name: ref.name, reason: 'download-failed' })),
                    };
                // 下载期间条目被丢弃（群被移除、服务停止等）：文件随之删除
                if (stopped || !queues.get(chatId)?.includes(item)) {
                    discardFiles([item]);
                    return;
                }
            }
            const downloaded = item.downloaded;
            const card = item.cardId === undefined ? undefined : cardById(item.cardId);
            const context = item.contextCardId === undefined ? undefined : cardById(item.contextCardId);
            const labels = projectLabels(group, workspaces);
            // 新反馈且没转过的才列其他项目；追问回复留在卡片所属项目
            const otherProjects = item.forward || item.cardId !== undefined
                ? []
                : group.projects
                    .filter((p) => p.workspaceId !== workspaceId)
                    .map((p) => ({ name: labels.get(p.workspaceId) ?? p.workspaceId, note: p.note }));
            const prompt = fitPrompt(item, (parts) => triagePrompt({
                groupTitle: group.title,
                ...(otherProjects.length > 0 ? { otherProjects } : {}),
                ...(item.forward ? { forwardedFrom: item.forward.from } : {}),
                ...(item.follow ? { follow: data.followMinutes } : {}),
                ...(isMaintainer(item.fromId) ? { maintainer: true } : {}),
                ...(card
                    ? {
                        card: {
                            id: card.id,
                            followUps: card.followUps,
                            content: card.content,
                            ...(card.lastReply ? { lastReply: card.lastReply } : {}),
                        },
                    }
                    : {}),
                ...(context
                    ? {
                        context: {
                            id: context.id,
                            content: context.content,
                            ...(context.lastReply ? { lastReply: context.lastReply } : {}),
                        },
                    }
                    : {}),
                sender: item.sender,
                messageIds: item.messageIds,
                text: itemText(parts),
                attachments: downloaded.attachments.length,
                rejected: rejectionSummary([...item.files.rejected, ...downloaded.rejected]),
            }));
            // 先登记在途条目：triage_report 可能在 prompt 返回前就到
            await applyPendingModel(sessionId, 'triage');
            const pending = { ...item, workspaceId, reported: false };
            inflight.set(sessionId, pending);
            let delivered = false;
            try {
                const result = await api.channel.prompt({
                    sessionId,
                    text: prompt,
                    ...(downloaded.attachments.length > 0 ? { attachments: downloaded.attachments } : {}),
                });
                delivered = result.delivered;
                const late = rejectionSummary(result.rejected ?? []);
                if (delivered && late)
                    pending.lateRejected = late;
            }
            catch (error) {
                inflight.delete(sessionId);
                warn(`投递分诊会话失败：${errorMessage(error)}`);
                scheduleChat(chatId, 30_000);
                return;
            }
            if (delivered) {
                // 已投出即在跑；之后变成非忙状态就是这一轮结束（状态事件被合并时也不会漏）
                if (!isBusy(statuses.get(sessionId)))
                    statuses.set(sessionId, 'running');
                // 附件先不删：转交时还要再投一次，等这条反馈得到最终报告后由 onSettled 删
                const at = queue.indexOf(item);
                if (at >= 0)
                    queue.splice(at, 1);
                if (queue.length === 0 && queues.get(chatId) === queue)
                    queues.delete(chatId);
                return;
            }
            inflight.delete(sessionId);
        }
        catch (error) {
            warn(`投递分诊会话失败：${errorMessage(error)}`);
        }
        finally {
            pumping.delete(chatId);
        }
    };
    const nextCardId = () => data.cards.reduce((max, card) => Math.max(max, card.id), 0) + 1;
    const addCard = (card) => {
        data.cards.push(card);
        if (data.cards.length > MAX_CARDS)
            data.cards.splice(0, data.cards.length - MAX_CARDS);
    };
    /** 整轮没有调用 triage_report：电脑上记一笔，群里用固定模板回复原消息 */
    const recordUnreported = (item) => {
        const text = cardContent(item);
        warn(`分诊会话这一轮没有调用 triage_report（群 ${item.chatId}）`);
        const group = groupOf(item.chatId);
        if (!group)
            return;
        const reply = (card) => void sendToGroup(card, TEMPLATES.unreported, item.replyTo).then(commit);
        if (item.cardId !== undefined) {
            // 追问回复：卡片状态不变，只发兜底
            const existing = cardById(item.cardId);
            item.outcome.cardId = item.cardId;
            if (existing)
                reply(existing);
            return;
        }
        const time = now();
        const card = {
            id: nextCardId(),
            chatId: item.chatId,
            workspaceId: item.workspaceId,
            status: 'unreported',
            title: text.replace(/\s+/g, ' ').slice(0, 80),
            summary: '',
            content: text,
            messageId: item.replyTo,
            botMessageIds: [],
            followUps: 0,
            taskIds: [],
            createdAt: time,
            updatedAt: time,
        };
        addCard(card);
        item.outcome.cardId = card.id;
        commit();
        reply(card);
    };
    const addCandidate = (chat) => {
        const title = (chat.title ?? '').slice(0, 256);
        const existing = data.candidates.find((candidate) => candidate.chatId === chat.id);
        if (existing) {
            existing.title = title;
            existing.seenAt = now();
        }
        else {
            data.candidates.push({ chatId: chat.id, title, seenAt: now() });
            data.candidates.sort((a, b) => a.seenAt - b.seenAt);
            if (data.candidates.length > MAX_CANDIDATES) {
                data.candidates.splice(0, data.candidates.length - MAX_CANDIDATES);
            }
        }
        commit();
    };
    const migrateChat = (from, to) => {
        if (from === to)
            return;
        for (const group of data.groups)
            if (group.chatId === from)
                group.chatId = to;
        for (const candidate of data.candidates)
            if (candidate.chatId === from)
                candidate.chatId = to;
        for (const card of data.cards)
            if (card.chatId === from)
                card.chatId = to;
        const queue = queues.get(from);
        if (queue) {
            queues.delete(from);
            for (const item of queue)
                item.chatId = to;
            queues.set(to, queue);
        }
        for (const item of inflight.values())
            if (item.chatId === from)
                item.chatId = to;
        for (const map of [buffers, recent, follows]) {
            const entry = map.get(from);
            map.delete(from);
            if (entry)
                map.set(to, entry);
        }
        commit();
    };
    const rateLimited = (userId, time) => {
        const recent = (rate.get(userId) ?? []).filter((t) => t > time - HOUR_MS);
        if (recent.length >= data.rateLimitPerHour) {
            rate.set(userId, recent);
            return true;
        }
        recent.push(time);
        rate.set(userId, recent);
        return false;
    };
    /** 采纳需求：交给值班会话（设置页「采纳」与维护者「确认」共用） */
    const approveCard = (card) => {
        card.updatedAt = now();
        card.status = 'fixing';
        card.duty = 'queued';
        commit();
        void pumpDuty(card.workspaceId);
    };
    /**
     * M1：私聊里只认「/start <有效的绑定码>」，把发送者绑定为维护者；
     * 形如绑定码（16 位 base64url）但无效 / 过期 / 已用过的，回复「链接已失效」
     * （码是 96 位随机数，回复不会被用来试探）；其余私聊一律忽略、不回复。
     */
    const handlePrivate = (message) => {
        const from = message.from;
        if (!from || from.is_bot || !Number.isSafeInteger(from.id))
            return;
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        const match = /^\/start ([A-Za-z0-9_-]{16})$/.exec(text);
        if (!match)
            return;
        const code = validBindCode();
        if (!code || match[1] !== code.code) {
            const token = data.token;
            if (!token)
                return;
            deps.telegram
                .sendMessage(token, { chatId: message.chat.id, text: TEMPLATES.bindLinkExpired })
                .catch((error) => warn(`发送绑定回复失败：${errorMessage(error)}`));
            return;
        }
        bindCode = undefined;
        clearTimeout(bindTimer);
        const name = displayName(from);
        const username = typeof from.username === 'string' && from.username ? ` (@${from.username})` : '';
        const label = `${name}${username}`.slice(0, MAINTAINER_LABEL_MAX);
        data.maintainer = { userId: from.id, label, boundAt: now() };
        commit();
        notify('Telegram 维护者', `已绑定维护者：${label}`);
        const token = data.token;
        if (!token)
            return;
        deps.telegram
            .sendMessage(token, { chatId: message.chat.id, text: TEMPLATES.maintainerBound })
            .catch((error) => warn(`发送绑定回复失败：${errorMessage(error)}`));
    };
    const handleMessage = (message) => {
        const chat = message.chat;
        if (chat?.type === 'private') {
            handlePrivate(message);
            return;
        }
        if (!isGroupChat(chat))
            return; // 其余私聊与频道一律忽略，不回复
        if (message.migrate_to_chat_id !== undefined) {
            migrateChat(chat.id, message.migrate_to_chat_id);
            return;
        }
        if (message.migrate_from_chat_id !== undefined) {
            migrateChat(message.migrate_from_chat_id, chat.id);
            return;
        }
        const bot = data.bot;
        if (!bot)
            return;
        const group = groupOf(chat.id);
        if (!group) {
            // 未允许的群：只记为候选，消息丢弃
            addCandidate(chat);
            return;
        }
        if (!group.active)
            return;
        const from = message.from;
        if (!from || from.is_bot)
            return;
        // 图片、文件消息的文字与 @ 在 caption / caption_entities 里
        const rawText = message.text ?? message.caption;
        const text = typeof rawText === 'string' ? rawText : '';
        const entities = message.entities ?? message.caption_entities;
        const files = { refs: [], rejected: [] };
        const attachments = addMessageAttachments(files, message);
        const time = message.date * 1000;
        const mediaGroupId = typeof message.media_group_id === 'string' ? message.media_group_id : undefined;
        // TG5：转发来的消息在文字前标明，不写原作者
        const forwarded = isForwarded(message);
        const mark = (s) => (s && forwarded ? `${FORWARDED_MARK}${s}` : s);
        // Q1 / TG1–TG4：被引用的消息与所在话题
        const reply = readReply(message, bot.id);
        const quoted = reply.quoted;
        const queue = queues.get(chat.id) ?? [];
        pruneContext(chat.id, time);
        // 这个人还没开始投递的最新条目（已开始下载或投递的不再并入）
        const open = [...queue].reverse().find((item) => item.fromId === from.id && !item.started);
        if (mediaGroupId !== undefined && open?.mediaGroupId === mediaGroupId) {
            // 相册的其余消息（通常没有配文和 @）：并入同一人同一相册的条目，不再计限流
            if (text.trim())
                open.texts.push(mark(text.trim()).slice(0, ITEM_TEXT_MAX));
            open.messageIds.push(message.message_id);
            mergeAttachments(open.files, files);
            open.lastDate = time;
            open.readyAt = now() + debounceMs;
            scheduleChat(chat.id, 0);
            return;
        }
        if (!text && !attachments)
            return;
        const repliedId = quoted?.fromBot ? quoted.messageId : undefined;
        let body;
        let target = {};
        if (repliedId !== undefined) {
            body = parseBugCommand(text, bot.username) ?? text.trim();
            const card = data.cards.find((c) => c.chatId === chat.id && c.botMessageIds.includes(repliedId));
            if (card)
                target = routeOf(card);
        }
        else {
            // /bug[@bot] 优先，其次 @本 bot；其余消息丢弃
            body =
                parseBugCommand(text, bot.username) ??
                    parseBotMention(text, entities, bot.username);
            // 引用了某张卡片的原始反馈消息：作新反馈，那张卡片只作背景
            const quotedId = quoted?.messageId;
            const card = body === null || quotedId === undefined
                ? undefined
                : [...data.cards].reverse().find((c) => c.chatId === chat.id && c.messageId === quotedId);
            if (card)
                target = { contextCardId: card.id };
        }
        if (body !== null)
            body = mark(body);
        const caption = mark(text.trim());
        /** 这条消息要投递：带上所在话题、引用段和被引用消息的附件（与自己的附件共用数量上限） */
        const addQuote = (item) => {
            if (reply.topic && !item.topic)
                item.topic = reply.topic;
            if (!quoted)
                return;
            (item.quotes ??= []).push(quoted.segment);
            mergeAttachments(item.files, quoted.files);
            // 被引用的消息还在这个人的缓冲里：去掉，免得再作为「@ 之前的消息」出现
            const dup = (buffers.get(chat.id)?.get(from.id) ?? []).filter((m) => m.messageId === quoted.messageId);
            if (dup.length > 0)
                unbuffer(chat.id, from.id, dup);
        };
        /** 把这条消息并入已有条目，重新计算投递时间 */
        const mergeInto = (item, content) => {
            if (content)
                item.texts.push(content.slice(0, ITEM_TEXT_MAX));
            item.messageIds.push(message.message_id);
            mergeAttachments(item.files, files);
            addQuote(item);
            if (mediaGroupId !== undefined)
                item.mediaGroupId = mediaGroupId;
            item.lastDate = time;
            // Q3：每并入一条重新计时，但从开始收集算起最多等 MAX_GATHER_MS
            item.readyAt = Math.min(now() + readyDelay(item), item.gatherStart + MAX_GATHER_MS);
            scheduleChat(chat.id, 0);
        };
        /** 并入的后一条：标明来源（插件生成的说明，用户原文接在后面） */
        const after = (content) => content
            ? `（以下是该用户在 @ 后发的消息）\n${content}`
            : attachments
                ? '（该用户在 @ 后发的附件已并入本条）'
                : '';
        /** silent：跟随来的消息超出限流时静默丢弃，不提示 */
        const limited = (silent = false) => {
            if (!rateLimited(from.id, time))
                return false;
            if (silent)
                return true;
            const noticed = rateNoticed.get(from.id);
            if (noticed === undefined || time - noticed > HOUR_MS) {
                rateNoticed.set(from.id, time);
                void notifyRateLimited(chat.id, message.message_id);
            }
            return true;
        };
        const enqueue = (item) => {
            queue.push(item);
            if (queue.length > MAX_QUEUE_PER_GROUP) {
                discardFiles(queue.splice(0, queue.length - MAX_QUEUE_PER_GROUP));
            }
            queues.set(chat.id, queue);
            scheduleChat(chat.id, 0);
        };
        const newItem = (texts) => ({
            chatId: chat.id,
            fromId: from.id,
            sender: displayName(from),
            messageIds: [message.message_id],
            replyTo: message.message_id,
            texts,
            files: { refs: [], rejected: [] },
            ...(mediaGroupId !== undefined ? { mediaGroupId } : {}),
            lastDate: time,
            readyAt: now(),
            gatherStart: now(),
            outcome: {},
        });
        // F2：连续对话窗口（followMinutes 为 0 时不生效）
        const window = data.followMinutes > 0 ? follows.get(chat.id)?.get(from.id) : undefined;
        const windowOpen = window !== undefined && now() < window.until;
        // M3：维护者一句话确认或取消待确认的需求；他还有没投递的条目时不生效（还在打字，按 Q3 合并）
        const mention = parseBotMention(text, entities, bot.username);
        if (isMaintainer(from.id) && !open && (repliedId !== undefined || windowOpen || mention !== null)) {
            const decision = parseDecision(mention ?? text);
            const routed = target.cardId ?? target.contextCardId ?? (windowOpen ? window.cardId : undefined);
            // 没路由到卡片时只看本群最新的话题（24 小时内最新更新的卡片），不去翻旧的待确认需求
            const card = decision === null
                ? undefined
                : routed !== undefined
                    ? cardById(routed)
                    : data.cards
                        .filter((c) => c.chatId === chat.id && now() - c.updatedAt <= DECISION_CARD_MS)
                        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
            if (decision !== null &&
                card?.kind === 'feature' &&
                (card.status === 'pending-approval' || card.status === 'declined')) {
                // 马上处理：不投递分诊、不计限流、不新建卡片
                markDelivered(chat.id, [message.message_id]);
                if (decision === 'confirm') {
                    approveCard(card);
                }
                else {
                    card.status = 'rejected';
                    card.updatedAt = now();
                    commit();
                }
                const reply = decision === 'confirm'
                    ? TEMPLATES.maintainerApproved(card.id)
                    : TEMPLATES.maintainerRejected(card.id);
                void sendToGroup(card, reply, message.message_id).then(commit);
                openFollow(chat.id, from.id, card.id);
                return;
            }
        }
        // R3：等待中的空 @ 收到同一人的下一条（普通消息或反馈都算），并入后按正常节奏投递；不另计限流
        if (open?.awaiting && now() < open.readyAt) {
            const content = after(body ?? caption);
            if (!content && !quoted) {
                open.messageIds.push(message.message_id); // 又一个空 @：继续等
                return;
            }
            open.awaiting = false;
            open.gatherStart = now();
            mergeInto(open, content);
            return;
        }
        let follow = false;
        if (body === null) {
            // 普通消息
            if (open &&
                !open.awaiting &&
                (attachments || ((caption || quoted) && now() < open.readyAt))) {
                // R4：还没投递的条目在等图，附件和配文一起并入；Q3：还在等待里时纯文字（及其引用）也并入
                mergeInto(open, after(caption));
                return;
            }
            // 窗口内这个人自己的消息：没 @ 别人、没引用别人、有文字或附件才跟随，按回复那张卡片路由
            const followCard = windowOpen ? cardById(window.cardId) : undefined;
            if (followCard &&
                (caption || attachments) &&
                !mentionsOthers(text, entities, bot) &&
                (!quoted || quoted.fromBot || quoted.fromId === from.id)) {
                follow = true;
                body = caption;
                target = routeOf(followCard);
            }
        }
        if (body === null) {
            const source = recent.get(chat.id)?.get(from.id);
            // 窗口打开期间 R5 由跟随规则覆盖
            if (!windowOpen && !open && attachments && source && now() - source.at <= CONTEXT_WINDOW_MS) {
                // R5：反馈投递后 60 秒内补发的附件，按回复该卡片处理；计入限流
                if (limited())
                    return;
                const item = newItem([`${SUPPLEMENT_TEXT}${caption}`.slice(0, ITEM_TEXT_MAX)]);
                mergeAttachments(item.files, files);
                addQuote(item);
                item.supplementOf = source.outcome;
                item.readyAt = now() + readyDelay(item);
                enqueue(item);
                return;
            }
            // 其余只暂存在内存里，等这个人自己的 @ 或回复来取
            bufferMessage(chat.id, from.id, {
                messageId: message.message_id,
                date: time,
                text: caption.slice(0, ITEM_TEXT_MAX),
                files,
                hasFiles: attachments,
            });
            return;
        }
        // 跟随的消息并入已有条目时不计限流（同 Q3），只在新建条目时计
        if (!follow && limited())
            return;
        if (open &&
            !open.awaiting &&
            ((open.cardId === target.cardId &&
                open.contextCardId === target.contextCardId &&
                time - open.lastDate <= DEBOUNCE_MS) ||
                // 跟随条目还在等待时又 @ 了机器人：并进去（Q3）
                (open.follow &&
                    !follow &&
                    target.cardId === undefined &&
                    target.contextCardId === undefined &&
                    now() < open.readyAt))) {
            // 同一人 3 秒内连续发的合成一条；并进了不是跟随的消息，整条不再算跟随
            if (!follow)
                delete open.follow;
            mergeInto(open, body || (attachments ? ATTACHMENT_ONLY_TEXT : ''));
            return;
        }
        if (follow && limited(true))
            return;
        // R2 / Q2：并入同一人前 60 秒内缓冲的全部普通消息——附件一律并入，文字按时间顺序带上（被引用的那条除外）
        const item = Object.assign(newItem([]), target);
        if (follow)
            Object.assign(item, { follow: true, rateAt: time });
        const used = bufferedBefore(chat.id, from.id, time)
            .filter((m) => quoted?.messageId === undefined || m.messageId !== quoted.messageId)
            .sort((a, b) => a.date - b.date || a.messageId - b.messageId);
        const withFiles = used.filter((m) => m.hasFiles);
        for (const m of withFiles)
            mergeAttachments(item.files, m.files);
        mergeAttachments(item.files, files);
        const ownFiles = hasFiles(item);
        addQuote(item);
        const pre = preText(used);
        if (pre)
            item.pre = pre;
        const ago = (m) => Math.max(0, Math.round((time - m.date) / 1000));
        if (body)
            item.texts.push(body.slice(0, ITEM_TEXT_MAX));
        else if (!pre && ownFiles)
            item.texts.push(ATTACHMENT_ONLY_TEXT);
        // 只引用 + @：算有内容，不走「空 @ 等下一条」
        else if (quoted)
            item.texts.push(QUOTE_ONLY_TEXT);
        const first = withFiles[0];
        if (first) {
            item.texts.push(`（该用户在 @ 前 ${ago(first)} 秒内发的 ${withFiles.length} 条图片/文件消息已并入本条）`);
        }
        item.messageIds = [...used.map((m) => m.messageId), message.message_id];
        unbuffer(chat.id, from.id, used);
        if (item.texts.length === 0 && !item.pre) {
            // R3：前面也没有内容，等这个人的后一条
            item.awaiting = true;
            item.readyAt = now() + CONTEXT_WINDOW_MS;
        }
        else {
            item.readyAt = now() + readyDelay(item);
        }
        enqueue(item);
    };
    /**
     * TG-E：编辑后的消息。还没作为反馈投递或排队、编辑后 @ 了机器人或是 /bug 的，当作一条新消息处理；其余忽略。
     */
    const handleEdit = (raw) => {
        const record = asRecord(raw);
        const chat = asRecord(record?.chat);
        const bot = data.bot;
        if (!record ||
            !bot ||
            typeof chat?.id !== 'number' ||
            !isGroupChat(chat) ||
            typeof record.message_id !== 'number' ||
            typeof record.date !== 'number' ||
            typeof asRecord(record.from)?.id !== 'number') {
            return;
        }
        const message = record;
        const chatId = message.chat.id;
        const id = message.message_id;
        const fromId = message.from.id;
        const handled = deliveredIds.has(`${chatId}:${id}`) ||
            (queues.get(chatId) ?? []).some((item) => item.messageIds.includes(id)) ||
            [...inflight.values()].some((item) => item.chatId === chatId && item.messageIds.includes(id)) ||
            data.cards.some((card) => card.chatId === chatId && card.messageId === id);
        if (handled)
            return;
        const rawText = message.text ?? message.caption;
        const text = typeof rawText === 'string' ? rawText : '';
        const entities = message.entities ?? message.caption_entities;
        if (parseBugCommand(text, bot.username) === null &&
            parseBotMention(text, entities, bot.username) === null) {
            return;
        }
        // 去掉缓冲里的旧版本，免得再作为「@ 前的消息」重复出现
        const old = (buffers.get(chatId)?.get(fromId) ?? []).filter((m) => m.messageId === id);
        if (old.length > 0)
            unbuffer(chatId, fromId, old);
        const editDate = record.edit_date;
        handleMessage({ ...message, date: typeof editDate === 'number' ? editDate : message.date });
    };
    const handleUpdate = (update) => {
        if (update.message) {
            handleMessage(update.message);
            return;
        }
        if (update.edited_message !== undefined) {
            handleEdit(update.edited_message);
            return;
        }
        const member = update.my_chat_member;
        if (!member || !isGroupChat(member.chat))
            return;
        const status = member.new_chat_member.status;
        const group = groupOf(member.chat.id);
        if (status === 'left' || status === 'kicked') {
            if (group)
                group.active = false;
            dropQueue(member.chat.id);
            data.candidates = data.candidates.filter((c) => c.chatId !== member.chat.id);
            commit();
            return;
        }
        if (group) {
            group.active = true;
            if (member.chat.title)
                group.title = member.chat.title.slice(0, 256);
            commit();
        }
        else {
            addCandidate(member.chat);
        }
    };
    // ---------- 轮询 ----------
    const pollLoop = async (signal) => {
        const token = data.token;
        if (!token)
            return;
        let delay = 0;
        let ready = false;
        setConnection('connecting');
        while (!signal.aborted) {
            try {
                if (!ready) {
                    data.bot = await deps.telegram.getMe(token, signal);
                    ready = true;
                    // getMe 成功即已连接，不等第一次长轮询返回
                    setConnection('connected');
                    await deps.telegram
                        .setMyCommands(token, signal)
                        .catch((error) => warn(`注册 /bug 命令失败：${errorMessage(error)}`));
                }
                const updates = await deps.telegram.getUpdates(token, data.pollOffset, signal);
                if (signal.aborted)
                    break;
                delay = 0;
                setConnection('connected');
                if (updates.length === 0)
                    continue;
                // 先前进 offset 并尝试落盘；写盘失败只记 warn、照常处理这一批
                // （内存 offset 已前进，本次运行不重复；若随后崩溃，重启可能重复处理这一批）
                data.pollOffset = Math.max(...updates.map((update) => update.update_id)) + 1;
                await persist().catch(() => undefined); // persist 内已记 warn
                for (const update of updates) {
                    try {
                        handleUpdate(update);
                    }
                    catch (error) {
                        warn(`处理 update 失败：${errorMessage(error)}`);
                    }
                }
            }
            catch (error) {
                if (signal.aborted)
                    break;
                const kind = error instanceof TelegramApiError ? error.kind : 'network';
                setConnection(kind === 'unauthorized'
                    ? 'unauthorized'
                    : kind === 'conflict'
                        ? 'conflict'
                        : kind === 'api'
                            ? 'api-error'
                            : 'network-error');
                warn(`轮询失败：${errorMessage(error)}`);
                if (kind === 'unauthorized')
                    break; // token 无效，等用户换 token
                delay = delay === 0 ? BACKOFF_START_MS : Math.min(delay * 2, BACKOFF_MAX_MS);
                await wait(delay, signal);
            }
        }
    };
    const startPolling = () => {
        if (poll || stopped || !data.token)
            return;
        const controller = new AbortController();
        const done = pollLoop(controller.signal).catch((error) => warn(`轮询意外退出：${errorMessage(error)}`));
        poll = { controller, done };
    };
    const stopPolling = async () => {
        const current = poll;
        if (!current)
            return;
        poll = undefined;
        current.controller.abort();
        await current.done;
    };
    // ---------- triage_report ----------
    /** 卡片字段只在电脑上显示：先替换本机信息；命中密钥时保留原文（同内置版，只在本机设置页可见） */
    const clean = async (text) => {
        try {
            const result = await api.channel.filterOutbound({ text });
            return result.ok ? result.text : text;
        }
        catch {
            return text;
        }
    };
    /**
     * 转交：同样的正文和已下载的附件原样排到队首，投给目标项目的分诊会话（pumpChat 会先建会话、刷新干净检出）。
     * 不建卡片、不计限流；outcome 与原条目共用，补充附件会跟到最终的卡片。
     */
    const forwardItem = (item, workspaceId, from) => {
        item.forwarded = true;
        const { workspaceId: _from, reported: _reported, forwarded: _forwarded, lateRejected: _late, ...rest } = item;
        const copy = { ...rest, forward: { workspaceId, from }, readyAt: now() };
        const queue = queues.get(item.chatId) ?? [];
        queue.unshift(copy);
        queues.set(item.chatId, queue);
        scheduleChat(item.chatId, 0);
    };
    const handleTriageReport = async (sessionId, input) => {
        const owner = groupOfSession(sessionId);
        if (!owner)
            return { ok: false, error: 'not a registered triage session' };
        const { group, workspaceId } = owner;
        const item = inflight.get(sessionId);
        if (!item)
            return { ok: false, error: 'no pending item for this session' };
        if (item.reported)
            return { ok: false, error: 'already reported for this item' };
        const report = parseTriageInput(input);
        if (typeof report === 'string')
            return { ok: false, error: report };
        item.reported = true;
        if (item.follow && report.kind === 'invalid') {
            // F3：跟随来的消息明显不是对机器人说的：不发消息、不建卡片、不续窗口，退回限流次数
            refundRate(item);
            return { ok: true };
        }
        if (report.project !== undefined && !item.forward && item.cardId === undefined) {
            // 分诊判断属于本群另一个项目：这次不回复，把同一条反馈原样转过去（匹配不上就照常处理）
            const labels = projectLabels(group, await api.workspaces.list());
            const key = report.project.trim().toLowerCase();
            const target = group.projects.find((p) => p.workspaceId !== workspaceId &&
                (labels.get(p.workspaceId) ?? '').trim().toLowerCase() === key);
            if (target) {
                forwardItem(item, target.workspaceId, labels.get(workspaceId) ?? workspaceId);
                return { ok: true };
            }
        }
        const time = now();
        const [title, summary, evidence, assessment] = await Promise.all([
            clean(report.title),
            clean(report.summary),
            report.evidence ? clean(report.evidence) : undefined,
            report.assessment ? clean(report.assessment) : undefined,
        ]);
        let card = item.cardId === undefined ? undefined : cardById(item.cardId);
        if (!card) {
            card = {
                id: nextCardId(),
                chatId: group.chatId,
                workspaceId,
                status: 'unreported',
                title: '',
                summary: '',
                content: cardContent(item),
                messageId: item.replyTo,
                botMessageIds: [],
                followUps: 0,
                taskIds: [],
                createdAt: time,
                updatedAt: time,
            };
            addCard(card);
        }
        item.outcome.cardId = card.id;
        card.workspaceId = workspaceId;
        card.kind = report.kind;
        card.title = title;
        card.summary = summary;
        card.updatedAt = time;
        delete card.evidence;
        delete card.assessment;
        delete card.assessmentIncomplete;
        if (evidence)
            card.evidence = evidence;
        if (assessment)
            card.assessment = assessment;
        const replyTo = item.replyTo;
        // 核心拒收的附件 AI 看不到：由插件接在回复末尾，仍是一次 @ 一次回复
        if (item.lateRejected)
            report.reply = `${report.reply}\n\n${item.lateRejected}`;
        /** 发了分诊回复（含追问）：打开或续上连续对话窗口；固定模板不算 */
        let replied = true;
        try {
            const followUp = report.needInfo || (report.kind === 'bug' && !report.evidence);
            if (followUp) {
                if (card.followUps >= MAX_FOLLOW_UPS) {
                    card.status = 'unconfirmed';
                    delete card.askedAt;
                    replied = false;
                    await sendToGroup(card, TEMPLATES.closing, replyTo);
                }
                else {
                    card.followUps += 1;
                    card.status = 'asking';
                    card.askedAt = time;
                    await sendTriageReply(card, report.reply, replyTo);
                }
            }
            else if (report.kind === 'bug') {
                card.status = 'fixing';
                card.duty = 'queued';
                await sendTriageReply(card, report.reply, replyTo);
            }
            else if (report.kind === 'feature') {
                const verdict = parseAssessment(report.assessment);
                if (verdict === 'incomplete')
                    card.assessmentIncomplete = true;
                if (isMaintainer(item.fromId)) {
                    // M2：维护者的需求评估通过就直接采纳（同设置页「采纳」，末尾会 pumpDuty）；有顾虑就等他一句话确认
                    if (verdict === 'pass') {
                        card.status = 'fixing';
                        card.duty = 'queued';
                    }
                    else {
                        card.status = 'pending-approval';
                        if (!report.reply.includes('确认')) {
                            report.reply = `${report.reply}\n${TEMPLATES.maintainerConfirmHint}`;
                        }
                    }
                    await sendTriageReply(card, report.reply, replyTo);
                }
                else {
                    card.status = verdict === 'fail' ? 'declined' : 'pending-approval';
                    await sendTriageReply(card, report.reply, replyTo);
                }
                if (card.status === 'pending-approval') {
                    notify('Telegram 新的待确认需求', `卡片 #${card.id}：${card.title}${verdict === 'incomplete' ? '（评估格式不完整）' : ''}`);
                }
            }
            else {
                card.status = report.kind === 'question' ? 'answered' : 'invalid';
                await sendTriageReply(card, report.reply, replyTo);
            }
        }
        catch (error) {
            warn(`处理 triage_report 失败（卡片 #${card.id}）：${errorMessage(error)}`);
        }
        if (replied)
            openFollow(group.chatId, item.fromId, card.id);
        commit();
        if (card.status === 'fixing')
            void pumpDuty(card.workspaceId);
        return { ok: true };
    };
    // ---------- 值班投递、卡片关联与 PR 说明 ----------
    const snapshotOf = (workspaceId) => api.channel.snapshot({ workspaceId });
    const coordinatorTaskIds = (snapshot, sessionId) => {
        const runIds = new Set(snapshot.runs.filter((run) => run.coordinatorSessionId === sessionId).map((run) => run.id));
        return snapshot.tasks.filter((task) => runIds.has(task.runId)).map((task) => task.id);
    };
    /** 新任务归到卡片：值班这一轮里新出现、还没归属的任务都属于这一轮的卡片 */
    const linkRoundTasks = (round, ids) => {
        const card = cardById(round.cardId);
        if (!card)
            return false;
        const owned = new Set(data.cards.flatMap((c) => c.taskIds));
        const fresh = ids.filter((id) => !round.knownTaskIds.has(id) && !owned.has(id));
        if (fresh.length === 0)
            return false;
        card.taskIds = [...card.taskIds, ...fresh].slice(0, 50);
        card.updatedAt = now();
        commit();
        return true;
    };
    /**
     * 内置版在开 PR 时同步取「问题 / 来源」附加段；插件改为主动写：卡片名下的任务一出现就 setPullRequestNote。
     * 宿主会先过滤，命中密钥时拒绝，这时只写来源。
     */
    const syncNotes = async (workspaceId, snapshot) => {
        const present = new Set(snapshot.tasks.map((task) => task.id));
        for (const card of data.cards) {
            if (card.workspaceId !== workspaceId)
                continue;
            for (const taskId of card.taskIds) {
                if (notedTasks.has(taskId) || !present.has(taskId))
                    continue;
                notedTasks.add(taskId);
                try {
                    await api.channel.setPullRequestNote({ taskId, text: pullRequestSection(card) });
                }
                catch {
                    try {
                        await api.channel.setPullRequestNote({
                            taskId,
                            text: `## 来源\n\nTelegram 群反馈（卡片 #${card.id}）`,
                        });
                    }
                    catch (error) {
                        warn(`写入 PR 说明失败（任务 ${taskId}）：${errorMessage(error)}`);
                    }
                }
            }
        }
    };
    const pumpDuty = async (workspaceId) => {
        if (stopped || dutyBusy.has(workspaceId) || dutyRounds.has(workspaceId))
            return;
        const card = data.cards.find((c) => c.workspaceId === workspaceId && c.status === 'fixing' && c.duty === 'queued');
        if (!card)
            return;
        dutyBusy.add(workspaceId);
        try {
            if (!(await findWorkspace(workspaceId)))
                return;
            const sessionId = await ensureDutySession(workspaceId);
            if (!sessionId || (await statusOf(sessionId)) !== 'idle')
                return;
            await applyPendingModel(sessionId, 'restricted');
            await refreshCheckout(workspaceId);
            const known = await snapshotOf(workspaceId)
                .then((snapshot) => coordinatorTaskIds(snapshot, sessionId))
                .catch(() => []);
            dutyRounds.set(workspaceId, { cardId: card.id, sessionId, knownTaskIds: new Set(known) });
            const sent = await api.channel.prompt({ sessionId, text: dutyPrompt(card) });
            if (sent.delivered) {
                if (!isBusy(statuses.get(sessionId)))
                    statuses.set(sessionId, 'running');
                card.duty = 'sent';
                card.deliveredAt = now();
                card.updatedAt = now();
                commit();
                return;
            }
            dutyRounds.delete(workspaceId);
        }
        catch (error) {
            dutyRounds.delete(workspaceId);
            warn(`投递值班会话失败：${errorMessage(error)}`);
        }
        finally {
            dutyBusy.delete(workspaceId);
        }
    };
    /** 值班这一轮结束：这一轮里新建的任务归到这张卡片 */
    const finishDutyRound = async (workspaceId, sessionId) => {
        dutySettledAt.set(sessionId, now());
        const round = dutyRounds.get(workspaceId);
        if (round?.sessionId === sessionId) {
            dutyRounds.delete(workspaceId);
            try {
                const snapshot = await snapshotOf(workspaceId);
                linkRoundTasks(round, coordinatorTaskIds(snapshot, sessionId));
                await syncNotes(workspaceId, snapshot);
            }
            catch (error) {
                warn(`关联卡片任务失败：${errorMessage(error)}`);
            }
        }
        await checkPullRequests(workspaceId);
        await pumpDuty(workspaceId);
    };
    const needsMaintainer = async (card, reason) => {
        card.status = 'needs-maintainer';
        card.updatedAt = now();
        await sendToGroup(card, TEMPLATES.needsMaintainer, card.messageId);
        notify('Telegram 修复需要维护者处理', `卡片 #${card.id}：${card.title}（${reason}）`);
    };
    const checkPullRequests = async (workspaceId) => {
        const cards = data.cards.filter((c) => c.workspaceId === workspaceId && c.status === 'fixing' && c.duty === 'sent');
        if (cards.length === 0)
            return;
        let snapshot;
        try {
            snapshot = await snapshotOf(workspaceId);
        }
        catch (error) {
            warn(`读取编排快照失败：${errorMessage(error)}`);
            return;
        }
        let changed = false;
        for (const card of cards) {
            if (card.status !== 'fixing')
                continue;
            const tasks = snapshot.tasks.filter((task) => card.taskIds.includes(task.id));
            const prTask = tasks.find((task) => task.pullRequest);
            const url = prTask?.pullRequest?.url;
            if (url && /^https:\/\/\S+$/.test(url)) {
                card.status = 'pr-opened';
                card.prUrl = url;
                card.updatedAt = now();
                changed = true;
                // 任务标题和卡片标题是 AI 写的，过滤被拒或含插件 token 时退回只发第一行
                const message = await filterOutbound(prOpenedMessage({ url, kind: card.kind, change: prTask?.title, solved: card.title }));
                const safe = message !== null && !(data.token !== undefined && message.includes(data.token));
                await sendToGroup(card, safe ? message : TEMPLATES.prOpened(url, card.kind), card.messageId);
                notify('Telegram 修复 PR 已开', `卡片 #${card.id}：${card.title}\n${url}`);
                continue;
            }
            if (tasks.length > 0 &&
                tasks.every((t) => t.status === 'failed' || t.status === 'abandoned')) {
                changed = true;
                await needsMaintainer(card, '任务失败或已放弃');
                continue;
            }
            if (dutyRounds.get(workspaceId)?.cardId === card.id)
                continue;
            const dutyId = data.workspaces[workspaceId]?.dutySessionId;
            let busy = false;
            if (dutyId) {
                try {
                    busy = isBusy(await statusOf(dutyId));
                }
                catch {
                    busy = isBusy(statuses.get(dutyId));
                }
            }
            const since = Math.max(card.deliveredAt ?? 0, (dutyId && dutySettledAt.get(dutyId)) || 0);
            if (!busy &&
                now() - since >= DUTY_IDLE_MS &&
                !tasks.some((t) => OPEN_TASK_STATUSES.has(t.status))) {
                changed = true;
                await needsMaintainer(card, '值班会话空闲 30 分钟仍没有 PR');
            }
        }
        if (changed)
            commit();
    };
    /** 编排变化：值班这一轮的新任务立即归到卡片并写 PR 说明，再看 PR 结果 */
    const onOrchestration = async (workspaceId) => {
        try {
            const snapshot = await snapshotOf(workspaceId);
            const round = dutyRounds.get(workspaceId);
            if (round)
                linkRoundTasks(round, coordinatorTaskIds(snapshot, round.sessionId));
            await syncNotes(workspaceId, snapshot);
        }
        catch (error) {
            warn(`读取编排快照失败：${errorMessage(error)}`);
        }
        await checkPullRequests(workspaceId);
    };
    // ---------- 会话事件 ----------
    function onSessionIdle(sessionId) {
        const owner = groupOfSession(sessionId);
        if (owner)
            void pumpChat(owner.group.chatId);
        const workspaceId = workspaceOfDuty(sessionId);
        if (workspaceId)
            void pumpDuty(workspaceId);
    }
    function onSettled(sessionId) {
        const owner = groupOfSession(sessionId);
        const item = inflight.get(sessionId);
        if (item) {
            inflight.delete(sessionId);
            // 跟随条目没调用 triage_report：不发兜底模板，直接丢弃
            if (owner && !item.reported && !item.follow)
                recordUnreported(item);
            // 这条反馈在这里结束（没有转交）：删掉它的附件
            if (!item.forwarded)
                discardFiles([item]);
        }
        const chatId = owner?.group.chatId ?? item?.chatId;
        if (chatId !== undefined)
            void pumpChat(chatId);
        const workspaceId = workspaceOfDuty(sessionId);
        if (workspaceId)
            void finishDutyRound(workspaceId, sessionId);
    }
    // ---------- 旧数据迁移 ----------
    /** 第一次启动：导入内置版的 telegram.json（token 进 secrets），再让宿主停掉内置服务并改名留底 */
    const migrateLegacy = async () => {
        if (data.legacyMigrated)
            return;
        try {
            const raw = await api.legacy.telegramData();
            if (raw !== null && raw !== undefined) {
                const legacy = parseTelegramData(raw);
                if (legacy.token)
                    await api.secrets.set(TOKEN_SECRET_KEY, legacy.token);
                // 旧 telegram.json 没有这一项；enabled 由插件卡片管，不迁移
                legacy.legacyMigrated = true;
                await store.save(legacy);
                data = legacy;
                api.log('info', '已导入内置 Telegram 的旧数据');
            }
            else {
                data.legacyMigrated = true;
                await store.save(data);
            }
            await api.legacy.telegramMigrated();
        }
        catch (error) {
            warn(`迁移内置 Telegram 数据失败，按现有数据继续：${errorMessage(error)}`);
        }
    };
    // ---------- 对外接口 ----------
    const view = () => ({
        connection: poll ? connection : idleConnection(),
        ...(data.token ? { tokenMasked: maskTelegramToken(data.token) } : {}),
        ...(data.bot ? { bot: { ...data.bot } } : {}),
        candidates: data.candidates.map((c) => ({ ...c })),
        groups: data.groups.map((g) => ({
            chatId: g.chatId,
            title: g.title,
            projects: g.projects.map((p) => ({ ...p })),
            active: g.active,
        })),
        cards: [...data.cards].reverse().map((card) => ({
            id: card.id,
            chatId: card.chatId,
            groupTitle: groupOf(card.chatId)?.title ?? '',
            workspaceId: card.workspaceId,
            ...(card.kind ? { kind: card.kind } : {}),
            status: card.status,
            title: card.title,
            summary: card.summary,
            ...(card.evidence ? { evidence: card.evidence } : {}),
            ...(card.assessment ? { assessment: card.assessment } : {}),
            ...(card.assessmentIncomplete ? { assessmentIncomplete: true } : {}),
            followUps: card.followUps,
            taskIds: [...card.taskIds],
            ...(card.prUrl ? { prUrl: card.prUrl } : {}),
            createdAt: card.createdAt,
            updatedAt: card.updatedAt,
        })),
        rateLimitPerHour: data.rateLimitPerHour,
        followMinutes: data.followMinutes,
        ...(data.triageModel ? { triageModel: { ...data.triageModel } } : {}),
        ...(data.dutyModel ? { dutyModel: { ...data.dutyModel } } : {}),
        modelFallback,
        ...(data.maintainer ? { maintainer: { label: data.maintainer.label } } : {}),
        ...(bindCode && now() < bindCode.expiresAt ? { bindCode: { ...bindCode } } : {}),
    });
    /** 设置页改动：落盘成功后通知重画 */
    const commitOrError = async () => {
        const saved = await saveOrError();
        emit();
        return saved;
    };
    /** 放弃一个分诊会话的在途条目（群或项目被移除）；已转交的附件归队列里的副本 */
    const dropInflight = (sessionId) => {
        const item = inflight.get(sessionId);
        inflight.delete(sessionId);
        if (item && !item.forwarded)
            discardFiles([item]);
    };
    const saveOrError = async () => {
        try {
            await persist();
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: safe(`保存失败：${errorMessage(error)}`) };
        }
    };
    async function maintain() {
        const time = now();
        let changed = false;
        for (const card of data.cards) {
            // 追问 24 小时没人回复：记为未确认，群里不再发消息
            if (card.status === 'asking' &&
                time - (card.askedAt ?? card.updatedAt) >= FOLLOW_UP_TIMEOUT_MS) {
                card.status = 'unconfirmed';
                card.updatedAt = time;
                delete card.askedAt;
                changed = true;
            }
        }
        if (changed)
            commit();
        // 补查在途会话的状态：状态事件被合并或丢失时，这里也能发现这一轮已经结束
        for (const sessionId of [...inflight.keys(), ...[...dutyRounds.values()].map((r) => r.sessionId)]) {
            await statusOf(sessionId).catch(() => undefined);
        }
        const workspaceIds = new Set(data.cards
            .filter((c) => c.status === 'fixing' || c.taskIds.some((id) => !notedTasks.has(id)))
            .map((c) => c.workspaceId));
        for (const workspaceId of workspaceIds) {
            try {
                await syncNotes(workspaceId, await snapshotOf(workspaceId));
            }
            catch (error) {
                warn(`读取编排快照失败：${errorMessage(error)}`);
            }
            await checkPullRequests(workspaceId);
            await pumpDuty(workspaceId);
        }
        // 没人再说话的群：缓冲也要过期即删
        for (const chatId of new Set([...buffers.keys(), ...recent.keys(), ...follows.keys()])) {
            pruneContext(chatId, now());
        }
        for (const chatId of queues.keys())
            void pumpChat(chatId);
    }
    const service = {
        async start() {
            stopped = false;
            try {
                data = await store.load();
            }
            catch (error) {
                warn(`读取插件数据失败，按空数据继续：${errorMessage(error)}`);
                data = emptyTelegramData();
            }
            await migrateLegacy();
            // 上次运行残留的附件（崩溃、停止时未删）：文件 mtime 是真实时间，用 Date.now
            void cleanupStaleAttachments(api.dataDir, Date.now());
            connection = idleConnection();
            unsubscribes.push(api.on('channel.session', (payload) => {
                const record = asRecord(payload);
                if (typeof record?.sessionId !== 'string')
                    return;
                if (!CHANNEL_STATUSES.includes(record.status))
                    return;
                service.sessionChanged(record.sessionId, record.status);
            }), api.on('channel.orchestrationChanged', (payload) => {
                const workspaceId = asRecord(payload)?.workspaceId;
                if (typeof workspaceId === 'string')
                    service.orchestrationChanged(workspaceId);
            }), api.handle('channel.report', (args) => {
                const record = asRecord(args);
                if (typeof record?.sessionId !== 'string' || typeof record.method !== 'string') {
                    return { ok: false, error: 'invalid channel.report call' };
                }
                return service.report(record.sessionId, record.method, record.input);
            }));
            maintenanceTimer = setInterval(() => void maintain(), MAINTENANCE_INTERVAL_MS);
            maintenanceTimer.unref?.();
            startPolling();
            emit();
            void maintain().catch((error) => warn(`维护失败：${errorMessage(error)}`));
        },
        async stop() {
            stopped = true;
            clearInterval(maintenanceTimer);
            maintenanceTimer = undefined;
            clearTimeout(bindTimer);
            bindCode = undefined;
            for (const timer of [...chatTimers.values(), ...prChecks.values()])
                clearTimeout(timer);
            chatTimers.clear();
            prChecks.clear();
            for (const queue of queues.values())
                discardFiles(queue);
            buffers.clear();
            recent.clear();
            follows.clear();
            for (const off of unsubscribes.splice(0))
                off();
            await stopPolling();
            await lastWrite;
        },
        getState: view,
        async setToken(token) {
            if (token === null) {
                await stopPolling();
                try {
                    await api.secrets.set(TOKEN_SECRET_KEY, null);
                }
                catch (error) {
                    return { ok: false, error: `清除 token 失败：${errorMessage(error)}` };
                }
                delete data.token;
                delete data.bot;
                data.pollOffset = 0;
                connection = idleConnection();
                await persist().catch(() => undefined);
                emit();
                return { ok: true };
            }
            if (typeof token !== 'string' || !TELEGRAM_TOKEN_PATTERN.test(token)) {
                return { ok: false, error: 'Bot Token 格式不对' };
            }
            let bot;
            try {
                bot = await deps.telegram.getMe(token);
            }
            catch (error) {
                const kind = error instanceof TelegramApiError ? error.kind : 'network';
                return {
                    ok: false,
                    error: kind === 'unauthorized'
                        ? 'Telegram 拒绝了这个 token'
                        : kind === 'network'
                            ? redactToken(`连不上 api.telegram.org（${errorMessage(error).replace(/^getMe:\s*/, '')}）：请确认 VPN 或代理已开启；网络代理默认跟随系统代理，也可以在「设置 → 通用 → 网络代理」改用手动代理`, token)
                            : redactToken(`验证 token 失败：${errorMessage(error)}`, token),
                };
            }
            await stopPolling();
            try {
                await api.secrets.set(TOKEN_SECRET_KEY, token);
            }
            catch (error) {
                return { ok: false, error: redactToken(`保存 token 失败：${errorMessage(error)}`, token) };
            }
            if (data.token !== token)
                data.pollOffset = 0;
            data.token = token;
            data.bot = bot;
            connection = idleConnection();
            const saved = await saveOrError();
            if (!saved.ok)
                return saved;
            startPolling();
            emit();
            return { ok: true };
        },
        async allowGroup(chatId, workspaceId) {
            const candidate = data.candidates.find((c) => c.chatId === chatId);
            if (!candidate)
                return { ok: false, error: '只能允许候选群' };
            if (groupOf(chatId))
                return { ok: false, error: '这个群已经允许过' };
            const workspace = await findWorkspace(workspaceId);
            if (!workspace)
                return { ok: false, error: '工作区不存在' };
            if (!workspace.git)
                return { ok: false, error: '只能绑定有默认分支的 git 工作区' };
            let sessionId;
            try {
                // 宿主建会话前会准备干净检出：没有默认分支或 origin/<默认分支> 时在这里失败
                sessionId = await createSession(workspaceId, 'triage', `Telegram 分诊 · ${candidate.title}`);
            }
            catch (error) {
                return { ok: false, error: `创建分诊会话失败：${errorMessage(error)}` };
            }
            data.workspaces[workspaceId] = { ...data.workspaces[workspaceId] };
            data.groups.push({
                chatId,
                title: candidate.title,
                projects: [{ workspaceId, note: '' }],
                triageSessions: { [workspaceId]: sessionId },
                active: true,
            });
            data.candidates = data.candidates.filter((c) => c.chatId !== chatId);
            commit();
            return { ok: true };
        },
        async removeGroup(chatId) {
            const group = groupOf(chatId);
            if (!group)
                return { ok: false, error: '群不存在' };
            data.groups = data.groups.filter((g) => g.chatId !== chatId);
            dropQueue(chatId);
            for (const sessionId of Object.values(group.triageSessions))
                dropInflight(sessionId);
            if (group.active) {
                data.candidates.push({ chatId, title: group.title, seenAt: now() });
                if (data.candidates.length > MAX_CANDIDATES)
                    data.candidates.shift();
            }
            commit();
            return { ok: true };
        },
        async addProject(chatId, workspaceId) {
            const group = groupOf(chatId);
            if (!group)
                return { ok: false, error: '群不存在' };
            if (group.projects.some((p) => p.workspaceId === workspaceId)) {
                return { ok: false, error: '这个项目已经绑定' };
            }
            const workspace = await findWorkspace(workspaceId);
            if (!workspace)
                return { ok: false, error: '工作区不存在' };
            if (!workspace.git)
                return { ok: false, error: '只能绑定有默认分支的 git 工作区' };
            // 分诊会话用到时再创建
            group.projects.push({ workspaceId, note: '' });
            data.workspaces[workspaceId] = { ...data.workspaces[workspaceId] };
            return commitOrError();
        },
        async removeProject(chatId, workspaceId) {
            const group = groupOf(chatId);
            if (!group)
                return { ok: false, error: '群不存在' };
            if (!group.projects.some((p) => p.workspaceId === workspaceId)) {
                return { ok: false, error: '这个项目没有绑定' };
            }
            if (group.projects.length <= 1)
                return { ok: false, error: '至少要保留一个项目' };
            group.projects = group.projects.filter((p) => p.workspaceId !== workspaceId);
            const sessionId = group.triageSessions[workspaceId];
            delete group.triageSessions[workspaceId];
            if (sessionId)
                dropInflight(sessionId);
            return commitOrError();
        },
        async setPrimaryProject(chatId, workspaceId) {
            const group = groupOf(chatId);
            const project = group?.projects.find((p) => p.workspaceId === workspaceId);
            if (!group || !project)
                return { ok: false, error: '这个项目没有绑定' };
            group.projects = [project, ...group.projects.filter((p) => p !== project)];
            return commitOrError();
        },
        async setProjectNote(chatId, workspaceId, note) {
            const project = groupOf(chatId)?.projects.find((p) => p.workspaceId === workspaceId);
            if (!project)
                return { ok: false, error: '这个项目没有绑定' };
            const trimmed = note.trim();
            if (trimmed.length > PROJECT_NOTE_MAX) {
                return { ok: false, error: `说明最多 ${PROJECT_NOTE_MAX} 字` };
            }
            project.note = trimmed;
            return commitOrError();
        },
        async resolveCard(cardId, action) {
            const card = cardById(cardId);
            if (card?.status !== 'pending-approval') {
                return { ok: false, error: '只能处理待确认的需求' };
            }
            if (action === 'approve') {
                approveCard(card);
                return { ok: true };
            }
            card.updatedAt = now();
            card.status = 'rejected';
            await sendToGroup(card, TEMPLATES.rejected, card.messageId);
            commit();
            return { ok: true };
        },
        async createBindCode() {
            clearTimeout(bindTimer);
            const current = { code: randomBytes(12).toString('base64url'), expiresAt: now() + BIND_CODE_MS };
            bindCode = current;
            // 到期后作废并重画，设置页不再显示过期的码
            bindTimer = setTimeout(() => {
                if (bindCode === current)
                    bindCode = undefined;
                emit();
            }, BIND_CODE_MS);
            bindTimer.unref?.();
            emit();
            return { ok: true };
        },
        async unbindMaintainer() {
            delete data.maintainer;
            return commitOrError();
        },
        async setRateLimit(perHour) {
            if (!isTelegramRateLimit(perHour))
                return { ok: false, error: '限额需为 1–1000 的整数' };
            data.rateLimitPerHour = perHour;
            const saved = await saveOrError();
            if (saved.ok)
                emit();
            return saved;
        },
        async setFollowMinutes(minutes) {
            if (!isFollowMinutes(minutes))
                return { ok: false, error: '连续对话需为 0–60 的整数' };
            data.followMinutes = minutes;
            if (minutes === 0)
                follows.clear();
            const saved = await saveOrError();
            if (saved.ok)
                emit();
            return saved;
        },
        async setModel(kind, model) {
            const key = kind === 'triage' ? 'triageModel' : 'dutyModel';
            // 带上合法的思考档位，其余字段丢弃
            const ref = model ? parseModelRef(model) : undefined;
            if (ref)
                data[key] = ref;
            else
                delete data[key];
            modelFallback = false;
            const saved = await saveOrError();
            emit();
            if (!saved.ok)
                return saved;
            // 只换模型不重建会话：重建会丢掉分诊上下文
            const sessionIds = kind === 'triage'
                ? data.groups.flatMap((group) => Object.values(group.triageSessions))
                : Object.values(data.workspaces).flatMap((entry) => entry.dutySessionId ?? []);
            const profile = kind === 'triage' ? 'triage' : 'restricted';
            for (const sessionId of new Set(sessionIds))
                await applyModel(sessionId, profile);
            return { ok: true };
        },
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async report(sessionId, method, input) {
            if (method !== 'triageReport')
                return { ok: false, error: `unknown method: ${method}` };
            try {
                return await handleTriageReport(sessionId, input);
            }
            catch (error) {
                return { ok: false, error: safe(errorMessage(error)) };
            }
        },
        orchestrationChanged(workspaceId) {
            if (prChecks.has(workspaceId) || stopped)
                return;
            prChecks.set(workspaceId, setTimeout(() => {
                prChecks.delete(workspaceId);
                void onOrchestration(workspaceId);
            }, orchestrationDelayMs));
        },
        sessionChanged(sessionId, status) {
            track(sessionId, status, true);
        },
        maintain,
    };
    return service;
}
