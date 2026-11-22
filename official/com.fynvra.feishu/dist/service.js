// 飞书反馈值班服务（复制自 Telegram 插件 0.1.6 的 service.ts，只换掉「平台收发」这一层）：
// 长连接收事件、会话发现与准入、分诊投递、triage_report 处理、追问、值班投递、卡片与任务关联、PR 结果通知。
// 会话里只会收到经 api.channel.filterOutbound 过滤后的 triage 回复与固定模板。
// shortcut: 引擎复制自 Telegram 插件，两边分别维护；出现第三个渠道或两边修复开始分叉时再抽公共模块
import { createHash } from 'node:crypto';
import { chatFallbackTitle, isRateLimit, maskSecret, } from './model.js';
import { cleanupStaleAttachments, downloadAttachments, mergeAttachments, rejectionSummary, removeFiles, } from './attachments.js';
import { dutyPrompt, MAX_FOLLOW_UPS, parseAssessment, parseTriageInput, pullRequestSection, pullRequestSource, TEMPLATES, triagePrompt, } from './content.js';
import { APP_ID_PATTERN, APP_SECRET_PATTERN, FeishuApiError, redactSecrets, } from './feishuApi.js';
import { parseMessage } from './message.js';
import { createFeishuStore, emptyFeishuData, MAX_BOT_MESSAGES, MAX_CANDIDATES, MAX_CARDS, parseModelRef, PROJECT_NOTE_MAX, SECRET_KEY, } from './store.js';
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
const BUFFER_PER_SENDER = 10;
const BUFFER_SENDERS_PER_GROUP = 200;
/** 去重：记住最近处理过的消息 id 的条数（长连接可能重推同一事件） */
const SEEN_MESSAGES_MAX = 1_000;
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
/** 发送者的匿名短标签：只用 open_id 的哈希，不取姓名 */
export function memberLabel(openId) {
    return `成员 ${createHash('sha256').update(openId).digest('hex').slice(0, 4)}`;
}
const sessionTitle = (title) => title.slice(0, SESSION_TITLE_MAX);
/** 连接失败时给人看的说明（不带密钥） */
const CONNECTION_ERROR_TEXT = {
    unauthorized: 'App ID 或 App Secret 不对',
    'not-ready': '应用还没发布，或没开启机器人能力：在飞书开放平台发布版本后再试',
    network: '连不上飞书',
};
const connectionOf = (kind) => kind === 'unauthorized'
    ? 'unauthorized'
    : kind === 'not-ready'
        ? 'not-ready'
        : kind === 'network'
            ? 'network-error'
            : 'api-error';
export function createFeishuService(deps) {
    const { api } = deps;
    const store = createFeishuStore(api);
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
    let data = emptyFeishuData();
    let connection = 'no-credentials';
    /** 最近一次连接失败的说明（已打码） */
    let connectionError;
    /** 长连接：abort 后停止重试并关掉 */
    let link;
    /** 最近处理过的消息 id（长连接可能重推） */
    const seenMessages = new Set();
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
    const safe = (text) => redactSecrets(text, [data.appSecret]);
    const creds = () => data.appId && data.appSecret ? { appId: data.appId, appSecret: data.appSecret } : undefined;
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
    };
    /** 丢掉超过 60 秒的缓冲与 R5 记录（缓冲按消息时间，R5 按本机时间） */
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
    const idleConnection = () => (creds() ? 'connecting' : 'no-credentials');
    // ---------- 查找 ----------
    const cardById = (id) => data.cards.find((card) => card.id === id);
    const groupOf = (chatId) => data.chats.find((group) => group.chatId === chatId);
    /** 回复了某张卡片：还在分诊阶段的算追问回复，其余按新反馈并把它作背景 */
    const routeOf = (card) => RETRIAGE_STATUSES.has(card.status) ? { cardId: card.id } : { contextCardId: card.id };
    /** 分诊会话属于哪个群的哪个项目（项目已从群里移除的不算） */
    const groupOfSession = (sessionId) => {
        for (const group of data.chats) {
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
            ...data.chats.map((g) => g.triageSessions[workspaceId]),
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
    // ---------- 会话消息发送（只接受过滤后的 triage 回复与固定模板） ----------
    /** 引用回复一条消息，记下机器人这条消息的 id（判断「回复机器人」用） */
    const replyTo = async (chatId, messageId, text) => {
        const c = creds();
        if (!c || !groupOf(chatId)?.active || text.trim() === '')
            return undefined;
        const sent = await deps.feishu.reply(c, messageId, text);
        data.botMessageIds = [...data.botMessageIds, sent.messageId].slice(-MAX_BOT_MESSAGES);
        return sent.messageId;
    };
    const sendToGroup = async (card, text, replyToId) => {
        try {
            const sent = await replyTo(card.chatId, replyToId, text);
            if (sent)
                card.botMessageIds = [...card.botMessageIds, sent].slice(-20);
        }
        catch (error) {
            warn(`发送回复失败（卡片 #${card.id}）：${errorMessage(error)}`);
        }
    };
    /** 限流提示：固定模板，不关联卡片、不调用模型 */
    const notifyRateLimited = async (chatId, replyToId) => {
        try {
            await replyTo(chatId, replyToId, TEMPLATES.rateLimited);
            commit();
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
        // 插件自己的 App Secret 也不许发（宿主的已知密钥里已有它，这里再兜一层）
        if (filtered === null || (data.appSecret !== undefined && filtered.includes(data.appSecret))) {
            card.lastReply = TEMPLATES.blocked;
            notify('飞书回复已拦下', `卡片 #${card.id} 的回复疑似含密钥，已改发中性提示。`);
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
            sessionId = await createSession(workspaceId, 'triage', `飞书分诊 · ${group.title}`);
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
            sessionId = await createSession(workspaceId, 'restricted', '飞书值班');
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
                warn(`会话绑定的工作区不存在：${workspaceId}`);
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
            }
            if (!item.downloaded) {
                const c = creds();
                item.downloaded = c
                    ? await downloadAttachments({
                        dataDir: api.dataDir,
                        creds: c,
                        feishu: deps.feishu,
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
            const prompt = triagePrompt({
                chatTitle: group.title,
                chatType: group.chatType,
                ...(otherProjects.length > 0 ? { otherProjects } : {}),
                ...(item.forward ? { forwardedFrom: item.forward.from } : {}),
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
        const text = item.texts.join('\n');
        warn(`分诊会话这一轮没有调用 triage_report（会话 ${item.chatId}）`);
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
            chatType: group.chatType,
            workspaceId: item.workspaceId,
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
        item.outcome.cardId = card.id;
        commit();
        reply(card);
    };
    /** 已经去接口取过群名的会话（本次运行内只取一次） */
    const titleFetched = new Set();
    /** 群名：事件里没有时去接口取（需要 im:chat:readonly），取到后更新候选和已允许的会话 */
    const fetchTitle = async (chatId) => {
        const c = creds();
        if (!c || titleFetched.has(chatId))
            return;
        titleFetched.add(chatId);
        const name = await deps.feishu.chatName(c, chatId);
        if (!name)
            return;
        for (const entry of [...data.candidates, ...data.chats])
            if (entry.chatId === chatId)
                entry.title = name;
        commit();
    };
    /** 记为候选会话；title 为空时群聊去接口取群名，取不到显示「群聊 · 短 id」 */
    const addCandidate = (chatId, chatType, title) => {
        const existing = data.candidates.find((candidate) => candidate.chatId === chatId);
        if (existing) {
            if (title)
                existing.title = title;
            existing.seenAt = now();
        }
        else {
            data.candidates.push({ chatId, chatType, title: title || chatFallbackTitle(chatType, chatId), seenAt: now() });
            data.candidates.sort((a, b) => a.seenAt - b.seenAt);
            if (data.candidates.length > MAX_CANDIDATES) {
                data.candidates.splice(0, data.candidates.length - MAX_CANDIDATES);
            }
        }
        commit();
        if (chatType === 'group' && !title)
            void fetchTitle(chatId);
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
    /** 机器人发过的消息（判断「回复机器人」） */
    const isBotMessage = (id) => id !== undefined &&
        (data.botMessageIds.includes(id) || data.cards.some((c) => c.botMessageIds.includes(id)));
    const handleMessage = (event) => {
        if (event.senderType !== 'user')
            return; // 机器人和应用发的消息不处理
        // 长连接可能重推同一条事件
        if (seenMessages.has(event.messageId))
            return;
        seenMessages.add(event.messageId);
        if (seenMessages.size > SEEN_MESSAGES_MAX) {
            const oldest = seenMessages.values().next().value;
            if (oldest !== undefined)
                seenMessages.delete(oldest);
        }
        const bot = data.bot;
        if (!bot)
            return;
        const chatId = event.chatId;
        const p2p = event.chatType === 'p2p';
        const group = groupOf(chatId);
        if (!group) {
            // 没允许的会话：只记为候选，消息丢弃、不回复
            addCandidate(chatId, event.chatType, p2p ? `私聊 · ${memberLabel(event.senderOpenId)}` : '');
            return;
        }
        if (!group.active)
            return;
        const parsed = parseMessage(event, bot.openId);
        if (!parsed)
            return;
        const fromId = event.senderOpenId;
        const messageId = event.messageId;
        const text = parsed.text;
        const files = parsed.files;
        const attachments = parsed.hasFiles;
        const time = event.createTime;
        const queue = queues.get(chatId) ?? [];
        pruneContext(chatId, time);
        // 这个人还没开始投递的最新条目（已开始下载或投递的不再并入）
        const open = [...queue].reverse().find((item) => item.fromId === fromId && !item.started);
        if (!text && !attachments)
            return;
        // 引用回复（parent_id）或话题（root_id）指向机器人发过的消息
        const repliedId = [event.parentId, event.rootId].find(isBotMessage);
        let body;
        let target = {};
        if (repliedId !== undefined) {
            body = text;
            const card = data.cards.find((c) => c.chatId === chatId && c.botMessageIds.includes(repliedId));
            if (card)
                target = routeOf(card);
        }
        else if (p2p) {
            // 私聊里每条都算反馈；不用引用回复，直接接上正在追问的卡片
            body = text;
            const asking = [...data.cards].reverse().find((c) => c.chatId === chatId && c.status === 'asking');
            if (asking)
                target = { cardId: asking.id };
        }
        else {
            // 群里只有 @机器人 才算反馈；其余消息丢弃或暂存
            body = parsed.mentioned ? text : null;
        }
        const caption = text;
        /** 把这条消息并入已有条目，重新计算投递时间 */
        const mergeInto = (item, content) => {
            if (content)
                item.texts.push(content.slice(0, ITEM_TEXT_MAX));
            item.messageIds.push(messageId);
            mergeAttachments(item.files, files);
            item.lastDate = time;
            item.readyAt = now() + readyDelay(item);
            scheduleChat(chatId, 0);
        };
        /** 并入的后一条：标明来源（插件生成的说明，用户原文接在后面） */
        const after = (content) => content
            ? `（以下是该用户在 @ 后发的消息）\n${content}`
            : attachments
                ? '（该用户在 @ 后发的附件已并入本条）'
                : '';
        const limited = () => {
            if (!rateLimited(fromId, time))
                return false;
            const noticed = rateNoticed.get(fromId);
            if (noticed === undefined || time - noticed > HOUR_MS) {
                rateNoticed.set(fromId, time);
                void notifyRateLimited(chatId, messageId);
            }
            return true;
        };
        const enqueue = (item) => {
            queue.push(item);
            if (queue.length > MAX_QUEUE_PER_GROUP) {
                discardFiles(queue.splice(0, queue.length - MAX_QUEUE_PER_GROUP));
            }
            queues.set(chatId, queue);
            scheduleChat(chatId, 0);
        };
        const newItem = (texts) => ({
            chatId,
            fromId,
            sender: memberLabel(fromId),
            messageIds: [messageId],
            replyTo: messageId,
            texts,
            files: { refs: [], rejected: [] },
            lastDate: time,
            readyAt: now(),
            outcome: {},
        });
        // 私聊：同一人还没投递的条目在等（有附件 3 秒、纯文字 8 秒），连续发的都并进去，不另计限流
        if (p2p &&
            open &&
            !open.awaiting &&
            open.cardId === target.cardId &&
            open.contextCardId === target.contextCardId) {
            mergeInto(open, body ?? '');
            return;
        }
        // R3：等待中的空 @ 收到同一人的下一条（普通消息或反馈都算），并入后按正常节奏投递；不另计限流
        if (open?.awaiting && now() < open.readyAt) {
            const content = after(body ?? caption);
            if (!content) {
                open.messageIds.push(messageId); // 又一个空 @：继续等
                return;
            }
            open.awaiting = false;
            mergeInto(open, content);
            return;
        }
        if (body === null) {
            // 普通群消息
            if (open && !open.awaiting && attachments) {
                // R4：还没投递的条目在等图，附件和配文一起并入
                mergeInto(open, after(caption));
                return;
            }
            const source = recent.get(chatId)?.get(fromId);
            if (!open && attachments && source && now() - source.at <= CONTEXT_WINDOW_MS) {
                // R5：反馈投递后 60 秒内补发的附件，按回复该卡片处理；计入限流
                if (limited())
                    return;
                const item = newItem([`${SUPPLEMENT_TEXT}${caption}`.slice(0, ITEM_TEXT_MAX)]);
                mergeAttachments(item.files, files);
                item.supplementOf = source.outcome;
                item.readyAt = now() + readyDelay(item);
                enqueue(item);
                return;
            }
            // 其余只暂存在内存里，等这个人自己的 @ 或回复来取
            bufferMessage(chatId, fromId, {
                messageId,
                date: time,
                text: caption.slice(0, ITEM_TEXT_MAX),
                files,
                hasFiles: attachments,
            });
            return;
        }
        if (limited())
            return;
        if (open &&
            !open.awaiting &&
            open.cardId === target.cardId &&
            open.contextCardId === target.contextCardId &&
            time - open.lastDate <= DEBOUNCE_MS) {
            // 同一人 3 秒内连续发的合成一条
            mergeInto(open, body || (attachments ? ATTACHMENT_ONLY_TEXT : ''));
            return;
        }
        // R2：并入同一人前 60 秒内缓冲的普通消息——附件一律并入，文字只在本条正文为空时取最近一条
        const item = Object.assign(newItem([]), target);
        const earlier = bufferedBefore(chatId, fromId, time);
        const withFiles = earlier.filter((m) => m.hasFiles);
        const prevText = body ? undefined : earlier.filter((m) => m.text).at(-1);
        const used = [...new Set([...withFiles, ...(prevText ? [prevText] : [])])].sort((a, b) => a.date - b.date);
        for (const m of withFiles)
            mergeAttachments(item.files, m.files);
        mergeAttachments(item.files, files);
        const ago = (m) => Math.max(0, Math.round((time - m.date) / 1000));
        if (body)
            item.texts.push(body.slice(0, ITEM_TEXT_MAX));
        else if (prevText) {
            item.texts.push(`（以下是该用户在 @ 前 ${ago(prevText)} 秒发的消息）\n${prevText.text}`);
        }
        else if (hasFiles(item))
            item.texts.push(ATTACHMENT_ONLY_TEXT);
        const first = withFiles[0];
        if (first) {
            item.texts.push(`（该用户在 @ 前 ${ago(first)} 秒内发的 ${withFiles.length} 条图片/文件消息已并入本条）`);
        }
        item.messageIds = [...used.map((m) => m.messageId), messageId];
        unbuffer(chatId, fromId, used);
        if (item.texts.length === 0) {
            // R3：前面也没有内容，等这个人的后一条
            item.awaiting = true;
            item.readyAt = now() + CONTEXT_WINDOW_MS;
        }
        else {
            item.readyAt = now() + readyDelay(item);
        }
        enqueue(item);
    };
    const handleBotAdded = (chatId, name) => {
        const group = groupOf(chatId);
        if (group) {
            group.active = true;
            if (name)
                group.title = name;
            commit();
        }
        else {
            addCandidate(chatId, 'group', name);
        }
    };
    const handleBotRemoved = (chatId) => {
        const group = groupOf(chatId);
        if (group)
            group.active = false;
        dropQueue(chatId);
        data.candidates = data.candidates.filter((c) => c.chatId !== chatId);
        commit();
    };
    const handleP2pEntered = (chatId, openId) => {
        if (!groupOf(chatId))
            addCandidate(chatId, 'p2p', `私聊 · ${memberLabel(openId)}`);
    };
    // ---------- 长连接 ----------
    const markConnected = () => {
        connectionError = undefined;
        setConnection('connected');
        emit();
    };
    const markFailed = (error) => {
        const kind = error instanceof FeishuApiError ? error.kind : 'network';
        const detail = safe(errorMessage(error));
        connectionError = CONNECTION_ERROR_TEXT[kind] ?? `飞书接口出错：${detail}`;
        warn(`连接飞书失败：${detail}`);
        setConnection(connectionOf(kind));
        emit();
        return kind;
    };
    /** 先用 bot/v3/info 验证凭证并取机器人信息，再建长连接；长连接自己重连，放弃时过一会儿整个重来 */
    const connectLoop = async (signal) => {
        const c = creds();
        if (!c)
            return;
        let delay = 0;
        setConnection('connecting');
        while (!signal.aborted) {
            try {
                data.bot = await deps.feishu.botInfo(c);
                commit();
                if (signal.aborted)
                    break;
                const events = await deps.feishu.connect(c, {
                    onMessage: (event) => {
                        if (!signal.aborted)
                            handleMessage(event);
                    },
                    onBotAdded: (chatId, name) => {
                        if (!signal.aborted)
                            handleBotAdded(chatId, name);
                    },
                    onBotRemoved: (chatId) => {
                        if (!signal.aborted)
                            handleBotRemoved(chatId);
                    },
                    onP2pEntered: (chatId, openId) => {
                        if (!signal.aborted)
                            handleP2pEntered(chatId, openId);
                    },
                }, {
                    onReady: () => {
                        if (!signal.aborted)
                            markConnected();
                    },
                    onReconnected: () => {
                        if (!signal.aborted)
                            markConnected();
                    },
                    onReconnecting: () => {
                        if (!signal.aborted)
                            setConnection('connecting');
                    },
                    onError: (error) => {
                        if (signal.aborted)
                            return;
                        if (markFailed(error) === 'unauthorized')
                            return;
                        void wait(BACKOFF_MAX_MS, signal).then(() => {
                            if (!signal.aborted)
                                void restartLink();
                        });
                    },
                });
                const current = link;
                if (signal.aborted || !current || current.controller.signal !== signal) {
                    events.close();
                    break;
                }
                current.events = events;
                return;
            }
            catch (error) {
                if (signal.aborted)
                    break;
                if (markFailed(error) === 'unauthorized')
                    break; // 凭证不对，等用户重新填
                delay = delay === 0 ? BACKOFF_START_MS : Math.min(delay * 2, BACKOFF_MAX_MS);
                await wait(delay, signal);
            }
        }
    };
    const startLink = () => {
        if (link || stopped || !creds())
            return;
        const controller = new AbortController();
        const current = { controller, done: Promise.resolve() };
        link = current;
        current.done = connectLoop(controller.signal).catch((error) => warn(`连接意外退出：${errorMessage(error)}`));
    };
    const stopLink = async () => {
        const current = link;
        if (!current)
            return;
        link = undefined;
        current.controller.abort();
        await current.done;
        current.events?.close();
    };
    const restartLink = async () => {
        await stopLink();
        startLink();
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
                chatType: group.chatType,
                workspaceId,
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
                    notify('飞书新的待确认需求', `卡片 #${card.id}：${card.title}${verdict === 'incomplete' ? '（评估格式不完整）' : ''}`);
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
                            text: `## 来源\n\n${pullRequestSource(card)}`,
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
        notify('飞书反馈修复需要维护者处理', `卡片 #${card.id}：${card.title}（${reason}）`);
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
                notify('飞书反馈修复 PR 已开', `卡片 #${card.id}：${card.title}\n${url}`);
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
            if (owner && !item.reported)
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
    // ---------- 对外接口 ----------
    const view = () => ({
        connection: link ? connection : idleConnection(),
        ...(connectionError ? { connectionError } : {}),
        ...(data.appId ? { appId: data.appId } : {}),
        ...(data.appSecret ? { secretMasked: maskSecret(data.appSecret) } : {}),
        ...(data.bot ? { bot: { ...data.bot } } : {}),
        candidates: data.candidates.map((c) => ({ ...c })),
        chats: data.chats.map((g) => ({
            chatId: g.chatId,
            chatType: g.chatType,
            title: g.title,
            projects: g.projects.map((p) => ({ ...p })),
            active: g.active,
        })),
        cards: [...data.cards].reverse().map((card) => ({
            id: card.id,
            chatId: card.chatId,
            chatTitle: groupOf(card.chatId)?.title ?? '',
            chatType: card.chatType,
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
        ...(data.triageModel ? { triageModel: { ...data.triageModel } } : {}),
        ...(data.dutyModel ? { dutyModel: { ...data.dutyModel } } : {}),
        modelFallback,
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
        for (const chatId of new Set([...buffers.keys(), ...recent.keys()]))
            pruneContext(chatId, now());
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
                data = emptyFeishuData();
            }
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
            startLink();
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
            buffers.clear();
            recent.clear();
            for (const off of unsubscribes.splice(0))
                off();
            await stopLink();
            await lastWrite;
        },
        getState: view,
        async setCredentials(input) {
            if (input === null) {
                await stopLink();
                try {
                    await api.secrets.set(SECRET_KEY, null);
                }
                catch (error) {
                    return { ok: false, error: safe(`清除 App Secret 失败：${errorMessage(error)}`) };
                }
                delete data.appSecret;
                delete data.appId;
                delete data.bot;
                connectionError = undefined;
                connection = idleConnection();
                await persist().catch(() => undefined);
                emit();
                return { ok: true };
            }
            const { appId } = input;
            // 留空表示沿用已保存的 Secret（设置页不回显）
            const appSecret = input.appSecret ?? data.appSecret;
            if (!APP_ID_PATTERN.test(appId)) {
                return { ok: false, error: 'App ID 格式不对：应为 cli_ 加 16 位字母数字' };
            }
            if (!appSecret)
                return { ok: false, error: '请填写 App Secret' };
            if (!APP_SECRET_PATTERN.test(appSecret))
                return { ok: false, error: 'App Secret 格式不对' };
            const hide = (text) => redactSecrets(text, [appSecret, data.appSecret]);
            let bot;
            try {
                bot = await deps.feishu.botInfo({ appId, appSecret });
            }
            catch (error) {
                const kind = error instanceof FeishuApiError ? error.kind : 'network';
                const detail = hide(errorMessage(error));
                api.log('warn', `验证飞书凭证失败：${detail}`);
                return {
                    ok: false,
                    error: kind === 'network'
                        ? '连不上飞书：检查网络，或「设置 → 通用 → 网络代理」'
                        : (CONNECTION_ERROR_TEXT[kind] ?? `飞书接口出错：${detail}`),
                };
            }
            await stopLink();
            try {
                await api.secrets.set(SECRET_KEY, appSecret);
            }
            catch (error) {
                return { ok: false, error: hide(`保存 App Secret 失败：${errorMessage(error)}`) };
            }
            data.appId = appId;
            data.appSecret = appSecret;
            data.bot = bot;
            connectionError = undefined;
            connection = idleConnection();
            const saved = await saveOrError();
            if (!saved.ok)
                return saved;
            startLink();
            emit();
            return { ok: true };
        },
        async allowChat(chatId, workspaceId) {
            const candidate = data.candidates.find((c) => c.chatId === chatId);
            if (!candidate)
                return { ok: false, error: '只能允许候选会话' };
            if (groupOf(chatId))
                return { ok: false, error: '这个会话已经允许过' };
            const workspace = await findWorkspace(workspaceId);
            if (!workspace)
                return { ok: false, error: '工作区不存在' };
            if (!workspace.git)
                return { ok: false, error: '只能绑定有默认分支的 git 工作区' };
            let sessionId;
            try {
                // 宿主建会话前会准备干净检出：没有默认分支或 origin/<默认分支> 时在这里失败
                sessionId = await createSession(workspaceId, 'triage', `飞书分诊 · ${candidate.title}`);
            }
            catch (error) {
                return { ok: false, error: `创建分诊会话失败：${errorMessage(error)}` };
            }
            data.workspaces[workspaceId] = { ...data.workspaces[workspaceId] };
            data.chats.push({
                chatId,
                chatType: candidate.chatType,
                title: candidate.title,
                projects: [{ workspaceId, note: '' }],
                triageSessions: { [workspaceId]: sessionId },
                active: true,
            });
            data.candidates = data.candidates.filter((c) => c.chatId !== chatId);
            commit();
            return { ok: true };
        },
        async removeChat(chatId) {
            const group = groupOf(chatId);
            if (!group)
                return { ok: false, error: '会话不存在' };
            data.chats = data.chats.filter((g) => g.chatId !== chatId);
            dropQueue(chatId);
            for (const sessionId of Object.values(group.triageSessions))
                dropInflight(sessionId);
            if (group.active) {
                data.candidates.push({ chatId, chatType: group.chatType, title: group.title, seenAt: now() });
                if (data.candidates.length > MAX_CANDIDATES)
                    data.candidates.shift();
            }
            commit();
            return { ok: true };
        },
        async addProject(chatId, workspaceId) {
            const group = groupOf(chatId);
            if (!group)
                return { ok: false, error: '会话不存在' };
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
                return { ok: false, error: '会话不存在' };
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
            if (!isRateLimit(perHour))
                return { ok: false, error: '限额需为 1–1000 的整数' };
            data.rateLimitPerHour = perHour;
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
                ? data.chats.flatMap((group) => Object.values(group.triageSessions))
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
