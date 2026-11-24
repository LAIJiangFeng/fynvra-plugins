// 设置页：把服务状态生成 UI 描述 v1（纯函数），并把用户操作（ui.action）分派给服务。
// 按 Fynvra 渲染器的规则排版：field 后紧跟的 text 是说明，紧跟的按钮并入同一行。
// 插件的启用和停用在 Fynvra 的插件卡片上，这里不放开关。
import { isFeishuId } from './feishuApi.js';
import { CHAT_TYPE_TEXT, chatFallbackTitle, FOLLOW_MINUTES_MAX, isThinkingLevel, RATE_LIMIT_MAX, } from './model.js';
import { httpsUrl, isUiId } from './types/appPluginUi.js';
import { asRecord } from './util.js';
/** 最近记录最多显示几条（列表上限 200，整页 ≤ 256 KB） */
export const RECENT_LIMIT = 50;
export const ACTIONS = {
    saveCredentials: 'credentials.save',
    clearCredentials: 'credentials.clear',
    allowChat: 'chat.allow',
    removeChat: 'chat.remove',
    addProject: 'project.add',
    removeProject: 'project.remove',
    setPrimary: 'project.primary',
    saveNote: 'project.note',
    saveRateLimit: 'rateLimit.save',
    saveFollowMinutes: 'followMinutes.save',
    triageModel: 'model.triage',
    dutyModel: 'model.duty',
    triageThinking: 'thinking.triage',
    dutyThinking: 'thinking.duty',
    approve: 'card.approve',
    reject: 'card.reject',
};
const CONNECTION_TEXT = {
    'no-credentials': '未配置',
    connecting: '连接中…',
    connected: '已连接',
    'network-error': '连不上飞书，正在重试',
    unauthorized: 'App ID 或 App Secret 不对',
    'not-ready': '应用还没发布，或没开启机器人能力',
    'api-error': '飞书接口出错，正在重试',
};
const STATUS_TEXT = {
    asking: '追问中',
    answered: '已回答',
    invalid: '无效',
    fixing: '修复中',
    'pending-approval': '待确认',
    declined: '评估未通过',
    rejected: '已拒绝',
    unconfirmed: '未确认',
    'pr-opened': 'PR 已开',
    'needs-maintainer': '需要维护者处理',
    unreported: '分诊未完成',
};
const KIND_TEXT = {
    bug: 'Bug',
    feature: '新功能',
    question: '提问/闲聊',
    invalid: '无效',
};
const NETWORK_HINT = '检查网络，或「设置 → 通用 → 网络代理」';
/** 思考档位的显示文字，和 Fynvra 输入框一致 */
const THINKING_TEXT = {
    off: 'off · 关闭',
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
};
/** 「x 分钟前出现」 */
function seenAgo(seenAt, now) {
    const minutes = Math.max(0, Math.floor((now - seenAt) / 60_000));
    if (minutes < 1)
        return '刚刚出现';
    if (minutes < 60)
        return `${minutes} 分钟前出现`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours} 小时前出现` : `${Math.floor(hours / 24)} 天前出现`;
}
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** 下拉里「默认」的值；模型的值都含 `/`，不会混淆 */
export const DEFAULT_MODEL_VALUE = 'default';
/** 下拉选项值的上限（UI 描述 v1） */
const OPTION_VALUE_MAX = 200;
/** 下拉选项的值：两段各自 encodeURIComponent（`/` 会被编码），再用 `/` 连起来 */
export function modelValue(ref) {
    return `${encodeURIComponent(ref.providerId)}/${encodeURIComponent(ref.modelId)}`;
}
/** 把下拉的值拆回模型；默认返回 null，非法返回 undefined */
export function parseModelValue(value) {
    if (value === DEFAULT_MODEL_VALUE)
        return null;
    if (typeof value !== 'string')
        return undefined;
    const parts = value.split('/');
    if (parts.length !== 2)
        return undefined;
    try {
        const [providerId, modelId] = parts.map((part) => decodeURIComponent(part));
        if (!providerId || !modelId || providerId.length > 200 || modelId.length > 200)
            return undefined;
        return { providerId, modelId };
    }
    catch {
        return undefined;
    }
}
const sameModel = (a, b) => a.providerId === b.providerId && a.modelId === b.modelId;
/** 模型支持的档位；列表里找不到或旧版 Fynvra 时为空 */
export function thinkingLevelsOf(models, ref) {
    return models?.find((model) => sameModel(model, ref))?.thinkingLevels ?? [];
}
function modelNodes(state, choices) {
    if (!choices.supported) {
        return [{ type: 'text', text: '当前 Fynvra 不支持选模型', tone: 'muted' }];
    }
    const listed = (choices.models ?? [])
        // shortcut: 编码后超过 200 字符的模型不列出（id 极长才会碰到），有人遇到再改按序号编码
        .filter((model) => modelValue(model).length <= OPTION_VALUE_MAX)
        .slice(0, 198)
        .map((model) => ({
        value: modelValue(model),
        label: clip(`${model.providerName} / ${model.label}`, 200),
        model,
    }));
    const nodes = [];
    let unavailable = false;
    const select = (kind, label, hint, chosen) => {
        const options = [
            { value: DEFAULT_MODEL_VALUE, label: '默认（跟随 Fynvra）' },
            ...listed.map(({ value, label }) => ({ value, label })),
        ];
        const found = chosen && listed.find((option) => sameModel(option.model, chosen))?.model;
        if (chosen && !found) {
            // 已选的不在列表里：保留这一项；读到了列表才标「不可用」
            const missing = choices.models !== null;
            if (missing)
                unavailable = true;
            options.push({
                value: modelValue(chosen),
                label: clip(`${chosen.providerId} / ${chosen.modelId}${missing ? '（不可用）' : ''}`, 200),
            });
        }
        nodes.push({
            type: 'field',
            id: `${kind}Model`,
            label,
            kind: 'select',
            value: chosen ? modelValue(chosen) : DEFAULT_MODEL_VALUE,
            options,
            action: kind === 'triage' ? ACTIONS.triageModel : ACTIONS.dutyModel,
        }, { type: 'text', text: hint, tone: 'muted' });
        // 选了默认、模型不在列表里或不支持思考时不显示档位
        if (!found || found.thinkingLevels.length === 0)
            return;
        const levels = found.thinkingLevels;
        const thinkingOptions = [
            { value: DEFAULT_MODEL_VALUE, label: '默认' },
            ...levels.map((level) => ({
                value: level,
                label: `${THINKING_TEXT[level]}${level === found.defaultThinking ? '（默认）' : ''}`,
            })),
        ];
        if (chosen.thinking && !levels.includes(chosen.thinking)) {
            thinkingOptions.push({ value: chosen.thinking, label: `${THINKING_TEXT[chosen.thinking]}（不可用）` });
        }
        nodes.push({
            type: 'field',
            id: `${kind}Thinking`,
            label: kind === 'triage' ? '分诊思考档位' : '值班思考档位',
            kind: 'select',
            value: chosen.thinking ?? DEFAULT_MODEL_VALUE,
            options: thinkingOptions,
            action: kind === 'triage' ? ACTIONS.triageThinking : ACTIONS.dutyThinking,
        });
    };
    select('triage', '分诊模型', '读群消息、追问、回复，建议用快的模型', state.triageModel);
    select('duty', '值班模型', '修 bug、开 PR，建议用强的模型', state.dutyModel);
    if (choices.models === null) {
        nodes.push({ type: 'text', text: '暂时读不到模型列表', tone: 'warning' });
    }
    if (unavailable) {
        nodes.push({ type: 'text', text: '所选模型不可用，新会话用默认', tone: 'warning' });
    }
    if (state.modelFallback) {
        nodes.push({ type: 'text', text: '所选模型不可用，已改用默认', tone: 'warning' });
    }
    return nodes;
}
/** 生成整份设置页 */
export function buildSettingsUi(state, workspaces, models, now = Date.now()) {
    const workspaceName = (id) => workspaces.find((workspace) => workspace.id === id)?.name ?? '工作区已移除';
    const gitOptions = workspaces
        .filter((workspace) => workspace.git)
        .map((workspace) => ({ value: workspace.id, label: clip(workspace.name, 200) }));
    const connection = [
        {
            type: 'keyValue',
            items: [
                { label: '状态', value: CONNECTION_TEXT[state.connection] },
                ...(state.bot
                    ? [{ label: '机器人', value: clip(state.bot.name || state.bot.openId, 200) }]
                    : []),
            ],
        },
    ];
    if (state.connectionError && state.connection !== 'connected') {
        connection.push({ type: 'text', text: clip(state.connectionError, 500), tone: 'error' });
    }
    if (state.connection === 'network-error') {
        connection.push({ type: 'text', text: NETWORK_HINT, tone: 'error' });
    }
    // 没有 action：输入只是草稿，点「保存」时随按钮一起发出
    connection.push({
        type: 'field',
        id: 'appId',
        label: 'App ID',
        kind: 'text',
        ...(state.appId ? { value: state.appId } : {}),
        placeholder: 'cli_ 开头，在飞书开放平台「凭证与基础信息」里',
    }, {
        type: 'field',
        id: 'appSecret',
        label: 'App Secret',
        kind: 'password',
        placeholder: state.secretMasked ? '不改 Secret 可以留空' : '粘贴应用的 App Secret',
    }, {
        type: 'text',
        text: state.secretMasked ? `已设置：${state.secretMasked}` : '还没设置',
        tone: 'muted',
    }, { type: 'button', label: '保存', action: ACTIONS.saveCredentials });
    if (state.secretMasked || state.appId) {
        connection.push({
            type: 'button',
            label: '清除',
            action: ACTIONS.clearCredentials,
            tone: 'destructive',
            confirm: '清除后机器人断开连接，飞书里的反馈不再处理。确定清除 App ID 和 App Secret？',
        });
    }
    connection.push({ type: 'text', text: '需要的权限和事件见使用说明', tone: 'muted' });
    const typeBadge = (type) => ({ text: CHAT_TYPE_TEXT[type], tone: 'muted' });
    const candidates = state.candidates.map((candidate) => ({
        key: candidate.chatId,
        title: clip(candidate.title || chatFallbackTitle(candidate.chatType, candidate.chatId), 200),
        badges: [typeBadge(candidate.chatType)],
        ...(gitOptions.length === 0
            ? { subtitle: `${seenAgo(candidate.seenAt, now)} · 没有可选的 git 工作区` }
            : {
                subtitle: seenAgo(candidate.seenAt, now),
                controls: [
                    {
                        type: 'field',
                        id: 'workspace',
                        label: '项目',
                        kind: 'select',
                        options: gitOptions,
                    },
                    { type: 'button', label: '允许', action: ACTIONS.allowChat },
                ],
            }),
    }));
    // 每个会话一个 list：会话本身、各项目、添加项目
    const chats = state.chats.map((chat) => {
        const unbound = gitOptions.filter((option) => !chat.projects.some((p) => p.workspaceId === option.value));
        const title = chat.title || chatFallbackTitle(chat.chatType, chat.chatId);
        const chatItem = {
            key: chat.chatId,
            title: clip(title, 200),
            badges: [
                typeBadge(chat.chatType),
                ...(chat.chatType === 'group'
                    ? [chat.active ? { text: '在群里', tone: 'success' } : { text: '已移出', tone: 'error' }]
                    : []),
            ],
            subtitle: `${chat.projects.length} 个项目`,
            controls: [
                {
                    type: 'button',
                    label: '移除会话',
                    action: ACTIONS.removeChat,
                    tone: 'destructive',
                    confirm: `移除「${clip(title, 100)}」后，这个会话的反馈不再处理。确定移除？`,
                },
            ],
        };
        const projects = chat.projects.map((project, index) => ({
            key: projectKey(chat.chatId, project.workspaceId, index),
            title: clip(workspaceName(project.workspaceId), 200),
            ...(index === 0 ? { badges: [{ text: '主项目', tone: 'success' }] } : {}),
            controls: [
                {
                    type: 'field',
                    id: 'note',
                    label: '说明',
                    kind: 'text',
                    value: project.note,
                    placeholder: '一句话说明，帮 AI 判断转交',
                    action: ACTIONS.saveNote,
                },
                ...(index > 0
                    ? [{ type: 'button', label: '设为主项目', action: ACTIONS.setPrimary }]
                    : []),
                ...(chat.projects.length > 1
                    ? [
                        {
                            type: 'button',
                            label: '移除',
                            action: ACTIONS.removeProject,
                            tone: 'destructive',
                            confirm: `从「${clip(title, 100)}」移除项目「${clip(workspaceName(project.workspaceId), 100)}」？`,
                        },
                    ]
                    : []),
            ],
        }));
        const addItem = unbound.length > 0
            ? [
                {
                    key: addProjectKey(chat.chatId),
                    title: '添加项目',
                    controls: [
                        {
                            type: 'field',
                            id: 'workspace',
                            label: '项目',
                            kind: 'select',
                            options: unbound,
                        },
                        { type: 'button', label: '添加', action: ACTIONS.addProject },
                    ],
                },
            ]
            : [];
        return { type: 'list', items: [chatItem, ...projects, ...addItem] };
    });
    const pending = state.cards
        .filter((card) => card.status === 'pending-approval')
        .map((card) => ({
        key: String(card.id),
        title: clip(card.title || `卡片 #${card.id}`, 200),
        subtitle: clip(card.chatTitle || '未知会话', 500),
        ...(card.assessmentIncomplete
            ? { badges: [{ text: '评估不完整', tone: 'warning' }] }
            : {}),
        ...(card.assessment ? { body: clip(card.assessment, 4000) } : {}),
        controls: [
            { type: 'button', label: '采纳', action: ACTIONS.approve },
            { type: 'button', label: '拒绝', action: ACTIONS.reject },
        ],
    }));
    const recent = state.cards.slice(0, RECENT_LIMIT).map((card) => {
        const url = card.prUrl ? httpsUrl(card.prUrl) : null;
        return {
            key: String(card.id),
            title: clip(card.title || `卡片 #${card.id}`, 200),
            subtitle: clip(`${card.chatTitle || '未知会话'} · 追问 ${card.followUps}/2`, 500),
            badges: [
                { text: STATUS_TEXT[card.status] },
                ...(card.kind ? [{ text: KIND_TEXT[card.kind], tone: 'muted' }] : []),
            ],
            ...(url ? { link: { label: '打开 PR', url } } : {}),
        };
    });
    return {
        children: [
            { type: 'section', title: '连接', children: connection },
            {
                type: 'section',
                title: '会话',
                children: [
                    {
                        type: 'section',
                        title: '候选会话',
                        children: [
                            {
                                type: 'list',
                                empty: '把机器人拉进群，或者私聊它，会话会出现在这里',
                                items: candidates,
                            },
                        ],
                    },
                    {
                        type: 'section',
                        title: '已允许的会话',
                        children: chats.length > 0 ? chats : [{ type: 'list', empty: '还没有允许的会话', items: [] }],
                    },
                ],
            },
            { type: 'section', title: '模型', children: modelNodes(state, models) },
            {
                type: 'section',
                title: '限流',
                children: [
                    {
                        type: 'field',
                        id: 'rateLimit',
                        label: '每人每小时最多处理几条',
                        kind: 'number',
                        value: state.rateLimitPerHour,
                        min: 1,
                        max: RATE_LIMIT_MAX,
                        action: ACTIONS.saveRateLimit,
                    },
                    { type: 'text', text: '超出后提示一次，1–1000', tone: 'muted' },
                    {
                        type: 'field',
                        id: 'followMinutes',
                        label: '连续对话（分钟）',
                        kind: 'number',
                        value: state.followMinutes,
                        min: 0,
                        max: FOLLOW_MINUTES_MAX,
                        action: ACTIONS.saveFollowMinutes,
                    },
                    {
                        type: 'text',
                        text: '机器人回复某个成员后，这段时间内该成员不 @ 的消息也会读；明显不是对机器人说的不会回复。0 表示关闭，最多 60。',
                        tone: 'muted',
                    },
                ],
            },
            {
                type: 'section',
                title: '待确认需求',
                children: [{ type: 'list', empty: '没有待确认的需求', items: pending }],
            },
            {
                type: 'section',
                title: '反馈记录',
                children: [{ type: 'list', empty: '还没有记录', items: recent }],
            },
        ],
    };
}
/** 「添加项目」行的 key：`add:<会话 id>`，不会和会话行、项目行混淆 */
const addProjectKey = (chatId) => `add:${chatId}`;
/**
 * 项目行的 key：`<会话 id>:<工作区 id>`；超出 UI key 的格式（例如太长）时改用 `<会话 id>:.<序号>`
 * （工作区 id 不含 `.`，不会混淆）。
 */
export function projectKey(chatId, workspaceId, index) {
    const key = `${chatId}:${workspaceId}`;
    return isUiId(key) ? key : `${chatId}:.${index}`;
}
/** 把项目行的 key 解析回会话 id 与工作区 id（序号按当前状态查） */
function parseProjectKey(service, itemKey) {
    if (typeof itemKey !== 'string')
        return null;
    const match = /^([A-Za-z0-9_-]{1,64}):(.+)$/.exec(itemKey);
    const chatId = match?.[1];
    const rest = match?.[2];
    if (chatId === undefined || rest === undefined)
        return null;
    if (!rest.startsWith('.'))
        return { chatId, workspaceId: rest };
    const chat = service.getState().chats.find((c) => c.chatId === chatId);
    const workspaceId = /^\.\d{1,4}$/.test(rest)
        ? chat?.projects[Number(rest.slice(1))]?.workspaceId
        : undefined;
    return workspaceId === undefined ? null : { chatId, workspaceId };
}
/** itemKey 是卡片 id（非负整数） */
function intKey(itemKey) {
    if (typeof itemKey !== 'string' || !/^\d{1,15}$/.test(itemKey))
        return null;
    const value = Number(itemKey);
    return Number.isSafeInteger(value) ? value : null;
}
/** itemKey 是会话 id */
const chatKey = (itemKey) => (isFeishuId(itemKey) ? itemKey : null);
/** 处理宿主送来的 ui.action（入参未收窄）；未知操作返回错误 */
export async function handleUiAction(service, raw, 
/** 最近一次读到的模型列表，用来校验思考档位 */
models = null) {
    const record = asRecord(raw);
    const action = record?.action;
    const values = asRecord(record?.values) ?? {};
    const itemKey = record?.itemKey;
    switch (action) {
        case ACTIONS.saveCredentials: {
            const appId = typeof values.appId === 'string' ? values.appId.trim() : '';
            const appSecret = typeof values.appSecret === 'string' ? values.appSecret.trim() : '';
            if (!appId)
                return { ok: false, error: '请填写 App ID' };
            return service.setCredentials({ appId, appSecret: appSecret || null });
        }
        case ACTIONS.clearCredentials:
            return service.setCredentials(null);
        case ACTIONS.allowChat: {
            const chatId = chatKey(itemKey);
            const workspaceId = values.workspace;
            if (chatId === null)
                return { ok: false, error: '会话不存在' };
            if (typeof workspaceId !== 'string' || workspaceId === '') {
                return { ok: false, error: '请先选择工作区' };
            }
            return service.allowChat(chatId, workspaceId);
        }
        case ACTIONS.removeChat: {
            const chatId = chatKey(itemKey);
            return chatId === null ? { ok: false, error: '会话不存在' } : service.removeChat(chatId);
        }
        case ACTIONS.addProject: {
            const chatId = chatKey(typeof itemKey === 'string' ? itemKey.replace(/^add:/, '') : itemKey);
            const workspaceId = values.workspace;
            if (chatId === null)
                return { ok: false, error: '会话不存在' };
            if (typeof workspaceId !== 'string' || workspaceId === '') {
                return { ok: false, error: '请先选择工作区' };
            }
            return service.addProject(chatId, workspaceId);
        }
        case ACTIONS.removeProject:
        case ACTIONS.setPrimary:
        case ACTIONS.saveNote: {
            const ref = parseProjectKey(service, itemKey);
            if (!ref)
                return { ok: false, error: '项目不存在' };
            if (action === ACTIONS.removeProject)
                return service.removeProject(ref.chatId, ref.workspaceId);
            if (action === ACTIONS.setPrimary)
                return service.setPrimaryProject(ref.chatId, ref.workspaceId);
            const note = values.note;
            if (typeof note !== 'string')
                return { ok: false, error: '说明格式不对' };
            return service.setProjectNote(ref.chatId, ref.workspaceId, note);
        }
        case ACTIONS.saveRateLimit: {
            const perHour = values.rateLimit;
            return service.setRateLimit(typeof perHour === 'number' ? perHour : Number.NaN);
        }
        case ACTIONS.saveFollowMinutes: {
            const minutes = values.followMinutes;
            return service.setFollowMinutes(typeof minutes === 'number' ? minutes : Number.NaN);
        }
        case ACTIONS.triageModel:
        case ACTIONS.dutyModel: {
            const triage = action === ACTIONS.triageModel;
            const model = parseModelValue(values[triage ? 'triageModel' : 'dutyModel']);
            if (model === undefined)
                return { ok: false, error: '模型格式不对' };
            if (!model)
                return service.setModel(triage ? 'triage' : 'duty', null);
            // 新模型支持原来的档位就保留，否则回到默认
            const thinking = service.getState()[triage ? 'triageModel' : 'dutyModel']?.thinking;
            const keep = thinking !== undefined && thinkingLevelsOf(models, model).includes(thinking);
            return service.setModel(triage ? 'triage' : 'duty', keep ? { ...model, thinking } : model);
        }
        case ACTIONS.triageThinking:
        case ACTIONS.dutyThinking: {
            const triage = action === ACTIONS.triageThinking;
            const current = service.getState()[triage ? 'triageModel' : 'dutyModel'];
            if (!current)
                return { ok: false, error: '请先选模型' };
            const value = values[triage ? 'triageThinking' : 'dutyThinking'];
            const { providerId, modelId } = current;
            if (value === DEFAULT_MODEL_VALUE) {
                return service.setModel(triage ? 'triage' : 'duty', { providerId, modelId });
            }
            if (!isThinkingLevel(value) || !thinkingLevelsOf(models, current).includes(value)) {
                return { ok: false, error: '这个模型不支持该档位' };
            }
            return service.setModel(triage ? 'triage' : 'duty', { providerId, modelId, thinking: value });
        }
        case ACTIONS.approve:
        case ACTIONS.reject: {
            const cardId = intKey(itemKey);
            if (cardId === null)
                return { ok: false, error: '只能处理待确认的需求' };
            return service.resolveCard(cardId, action === ACTIONS.approve ? 'approve' : 'reject');
        }
        default:
            return { ok: false, error: `未知操作：${String(action)}` };
    }
}
