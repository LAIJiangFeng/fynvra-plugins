// Telegram 群反馈值班服务（移植自 Fynvra 内置 telegram/service.ts，ARCHITECTURE §7.14）：
// 轮询、群发现与准入、分诊投递、triage_report 处理、追问、值班投递、卡片与任务关联、PR 结果通知。
// 群里只会收到经 api.channel.filterOutbound 过滤后的 triage 回复与固定模板。
// 与内置版的差别只在依赖：会话、干净检出、编排快照、出站过滤、通知都走宿主 API（见 README「与内置版的差异」）。
import { isTelegramRateLimit, maskTelegramToken, } from './model.js';
import { addMessageAttachments, cleanupStaleAttachments, downloadAttachments, mergeAttachments, rejectionSummary, removeFiles, } from './attachments.js';
import { dutyPrompt, MAX_FOLLOW_UPS, parseAssessment, parseBotMention, parseBugCommand, parseTriageInput, pullRequestSection, TEMPLATES, triagePrompt, } from './content.js';
import { createTelegramStore, emptyTelegramData, MAX_CANDIDATES, MAX_CARDS, parseTelegramData, TOKEN_SECRET_KEY, } from './store.js';
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
function displayName(user) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
    return (name || user.username || '匿名').slice(0, 128);
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
    const rate = new Map();
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
    };
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
    const groupOfSession = (sessionId) => data.groups.find((group) => group.triageSessionId === sessionId);
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
            ...data.groups.filter((g) => g.workspaceId === workspaceId).map((g) => g.triageSessionId),
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
        const { sessionId } = await api.channel.createSession({
            workspaceId,
            profile,
            title: sessionTitle(title),
        });
        statuses.set(sessionId, 'idle');
        return sessionId;
    };
    const ensureTriageSession = async (group) => {
        if (await sessionAlive(group.triageSessionId))
            return true;
        try {
            group.triageSessionId = await createSession(group.workspaceId, 'triage', `Telegram 分诊 · ${group.title}`);
        }
        catch (error) {
            warn(`重建分诊会话失败：${errorMessage(error)}`);
            return false;
        }
        commit();
        return true;
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
    const pumpChat = async (chatId) => {
        if (pumping.has(chatId) || stopped)
            return;
        const queue = queues.get(chatId);
        const head = queue?.[0];
        if (!queue || !head)
            return;
        const group = groupOf(chatId);
        if (!group?.active) {
            dropQueue(chatId);
            return;
        }
        if (inflight.has(group.triageSessionId))
            return;
        if (head.readyAt > now()) {
            scheduleChat(chatId, head.readyAt - now());
            return;
        }
        pumping.add(chatId);
        try {
            if (!(await findWorkspace(group.workspaceId))) {
                warn(`群绑定的工作区不存在：${group.workspaceId}`);
                return;
            }
            if (!(await ensureTriageSession(group)))
                return;
            const sessionId = group.triageSessionId;
            if ((await statusOf(sessionId)) !== 'idle')
                return; // 忙：结束或 idle 事件后再投
            await refreshCheckout(group.workspaceId);
            const item = queue[0];
            if (!item || inflight.has(sessionId))
                return;
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
                if (stopped || queues.get(chatId)?.[0] !== item) {
                    discardFiles([item]);
                    return;
                }
            }
            const downloaded = item.downloaded;
            const card = item.cardId === undefined ? undefined : cardById(item.cardId);
            const context = item.contextCardId === undefined ? undefined : cardById(item.contextCardId);
            const prompt = triagePrompt({
                groupTitle: group.title,
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
                text: item.texts.join('\n'),
                attachments: downloaded.attachments.length,
                rejected: rejectionSummary([...item.files.rejected, ...downloaded.rejected]),
            });
            // 先登记在途条目：triage_report 可能在 prompt 返回前就到
            const pending = { ...item, reported: false };
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
                // 核心已在 prompt 内读完附件
                discardFiles([item]);
                queue.shift();
                if (queue.length === 0)
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
        const text = item.texts.join('\n');
        warn(`分诊会话这一轮没有调用 triage_report（群 ${item.chatId}）`);
        const group = groupOf(item.chatId);
        if (!group)
            return;
        const reply = (card) => void sendToGroup(card, TEMPLATES.unreported, item.replyTo).then(commit);
        if (item.cardId !== undefined) {
            // 追问回复：卡片状态不变，只发兜底
            const existing = cardById(item.cardId);
            if (existing)
                reply(existing);
            return;
        }
        const time = now();
        const card = {
            id: nextCardId(),
            chatId: item.chatId,
            workspaceId: group.workspaceId,
            status: 'unreported',
            title: text.replace(/\s+/g, ' ').slice(0, 80),
            summary: '',
            content: text.slice(0, ITEM_TEXT_MAX),
            messageId: item.replyTo,
            botMessageIds: [],
            followUps: 0,
            taskIds: [],
            createdAt: time,
            updatedAt: time,
        };
        addCard(card);
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
    const handleMessage = (message) => {
        const chat = message.chat;
        if (!isGroupChat(chat))
            return; // 私聊与频道一律忽略，不回复
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
        const queue = queues.get(chat.id) ?? [];
        const tail = queue[queue.length - 1];
        // 已开始下载或投递的条目不再并入
        const last = tail && !tail.downloaded && !(pumping.has(chat.id) && tail === queue[0]) ? tail : undefined;
        if (mediaGroupId !== undefined &&
            last?.mediaGroupId === mediaGroupId &&
            last.fromId === from.id) {
            // 相册的其余消息（通常没有配文和 @）：并入同一人同一相册的条目，不再计限流
            if (text.trim())
                last.texts.push(text.trim().slice(0, ITEM_TEXT_MAX));
            last.messageIds.push(message.message_id);
            mergeAttachments(last.files, files);
            last.lastDate = time;
            last.readyAt = now() + debounceMs;
            scheduleChat(chat.id, debounceMs);
            return;
        }
        if (!text && !attachments)
            return;
        const repliedId = message.reply_to_message?.from?.id === bot.id
            ? message.reply_to_message.message_id
            : undefined;
        let body;
        let target = {};
        if (repliedId !== undefined) {
            body = parseBugCommand(text, bot.username) ?? text.trim();
            const card = data.cards.find((c) => c.chatId === chat.id && c.botMessageIds.includes(repliedId));
            if (card) {
                target = RETRIAGE_STATUSES.has(card.status)
                    ? { cardId: card.id }
                    : { contextCardId: card.id };
            }
        }
        else {
            // /bug[@bot] 优先，其次 @本 bot；其余消息丢弃
            body =
                parseBugCommand(text, bot.username) ??
                    parseBotMention(text, entities, bot.username);
        }
        if (body === '' && attachments)
            body = ATTACHMENT_ONLY_TEXT;
        if (!body)
            return;
        if (rateLimited(from.id, time)) {
            const noticed = rateNoticed.get(from.id);
            if (noticed === undefined || time - noticed > HOUR_MS) {
                rateNoticed.set(from.id, time);
                void notifyRateLimited(chat.id, message.message_id);
            }
            return;
        }
        if (last &&
            last.fromId === from.id &&
            last.cardId === target.cardId &&
            last.contextCardId === target.contextCardId &&
            time - last.lastDate <= DEBOUNCE_MS) {
            // 同一人 3 秒内连续发的合成一条
            last.texts.push(body.slice(0, ITEM_TEXT_MAX));
            last.messageIds.push(message.message_id);
            mergeAttachments(last.files, files);
            if (mediaGroupId !== undefined)
                last.mediaGroupId = mediaGroupId;
            last.lastDate = time;
            last.readyAt = now() + debounceMs;
        }
        else {
            queue.push({
                chatId: chat.id,
                ...target,
                fromId: from.id,
                sender: displayName(from),
                messageIds: [message.message_id],
                replyTo: message.message_id,
                texts: [body.slice(0, ITEM_TEXT_MAX)],
                files,
                ...(mediaGroupId !== undefined ? { mediaGroupId } : {}),
                lastDate: time,
                readyAt: now() + debounceMs,
            });
            if (queue.length > MAX_QUEUE_PER_GROUP) {
                discardFiles(queue.splice(0, queue.length - MAX_QUEUE_PER_GROUP));
            }
        }
        queues.set(chat.id, queue);
        scheduleChat(chat.id, debounceMs);
    };
    const handleUpdate = (update) => {
        if (update.message) {
            handleMessage(update.message);
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
    const handleTriageReport = async (sessionId, input) => {
        const group = groupOfSession(sessionId);
        if (!group)
            return { ok: false, error: 'not a registered triage session' };
        const item = inflight.get(sessionId);
        if (!item)
            return { ok: false, error: 'no pending item for this session' };
        if (item.reported)
            return { ok: false, error: 'already reported for this item' };
        const report = parseTriageInput(input);
        if (typeof report === 'string')
            return { ok: false, error: report };
        item.reported = true;
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
                workspaceId: group.workspaceId,
                status: 'unreported',
                title: '',
                summary: '',
                content: item.texts.join('\n').slice(0, ITEM_TEXT_MAX),
                messageId: item.replyTo,
                botMessageIds: [],
                followUps: 0,
                taskIds: [],
                createdAt: time,
                updatedAt: time,
            };
            addCard(card);
        }
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
        try {
            const followUp = report.needInfo || (report.kind === 'bug' && !report.evidence);
            if (followUp) {
                if (card.followUps >= MAX_FOLLOW_UPS) {
                    card.status = 'unconfirmed';
                    delete card.askedAt;
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
                card.status = verdict === 'fail' ? 'declined' : 'pending-approval';
                if (verdict === 'incomplete')
                    card.assessmentIncomplete = true;
                await sendTriageReply(card, report.reply, replyTo);
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
            const url = tasks.find((task) => task.pullRequest)?.pullRequest?.url;
            if (url && /^https:\/\/\S+$/.test(url)) {
                card.status = 'pr-opened';
                card.prUrl = url;
                card.updatedAt = now();
                changed = true;
                await sendToGroup(card, TEMPLATES.prOpened(url), card.messageId);
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
        const group = groupOfSession(sessionId);
        if (group)
            void pumpChat(group.chatId);
        const workspaceId = workspaceOfDuty(sessionId);
        if (workspaceId)
            void pumpDuty(workspaceId);
    }
    function onSettled(sessionId) {
        const group = groupOfSession(sessionId);
        if (group) {
            const item = inflight.get(sessionId);
            if (item) {
                inflight.delete(sessionId);
                if (!item.reported)
                    recordUnreported(item);
            }
            void pumpChat(group.chatId);
        }
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
        groups: data.groups.map((g) => ({ ...g })),
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
    });
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
            for (const timer of [...chatTimers.values(), ...prChecks.values()])
                clearTimeout(timer);
            chatTimers.clear();
            prChecks.clear();
            for (const queue of queues.values())
                discardFiles(queue);
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
                workspaceId,
                triageSessionId: sessionId,
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
            inflight.delete(group.triageSessionId);
            if (group.active) {
                data.candidates.push({ chatId, title: group.title, seenAt: now() });
                if (data.candidates.length > MAX_CANDIDATES)
                    data.candidates.shift();
            }
            commit();
            return { ok: true };
        },
        async resolveCard(cardId, action) {
            const card = cardById(cardId);
            if (card?.status !== 'pending-approval') {
                return { ok: false, error: '只能处理待确认的需求' };
            }
            card.updatedAt = now();
            if (action === 'approve') {
                card.status = 'fixing';
                card.duty = 'queued';
                commit();
                void pumpDuty(card.workspaceId);
                return { ok: true };
            }
            card.status = 'rejected';
            await sendToGroup(card, TEMPLATES.rejected, card.messageId);
            commit();
            return { ok: true };
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
