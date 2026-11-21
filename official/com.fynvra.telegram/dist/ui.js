import { TELEGRAM_RATE_LIMIT_MAX } from './model.js';
import { httpsUrl } from './types/appPluginUi.js';
import { asRecord } from './util.js';
/** 最近记录最多显示几条（列表上限 200，整页 ≤ 256 KB） */
export const RECENT_LIMIT = 50;
export const ACTIONS = {
    saveToken: 'token.save',
    clearToken: 'token.clear',
    allowGroup: 'group.allow',
    removeGroup: 'group.remove',
    saveRateLimit: 'rateLimit.save',
    approve: 'card.approve',
    reject: 'card.reject',
};
const CONNECTION_TEXT = {
    'no-token': '未配置：还没有 token',
    connecting: '连接中…',
    connected: '已连接',
    'network-error': '网络错误，正在重试',
    unauthorized: 'token 无效，请重新填写',
    conflict: '另有实例在轮询：同一个 token 另有程序在轮询，请关掉另一处',
    'api-error': 'Telegram 接口出错，正在重试',
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
const GUIDE = [
    '1. 在 Telegram 找 @BotFather，发送 /newbot 取得 token，填到上面的 Bot Token，再把机器人拉进群。',
    '2. 群成员在群里 @机器人 就算反馈：可以提问、闲聊或反馈问题，也可以直接回复机器人的消息，或者用 /bug 命令。可以发图片或文档并在配文里 @机器人：支持图片和文档（与 Fynvra 输入框相同的格式和上限），视频、语音、贴纸等不处理，机器人会在回复里说明。',
    '3. 如果 @ 了机器人没有反应：在 @BotFather 用 /setprivacy 关闭隐私模式，再把机器人移出群、重新拉进来；关闭后机器人能收到群里的所有消息，但插件只处理 @机器人、/bug 和回复机器人的消息，其余直接丢弃、不保存。',
    '4. 群第一次 @机器人 后会出现在「候选群」，选好 git 工作区再点「允许」。',
    '5. bug 定位到原因才会修复并开 PR；新功能要你在「待确认需求」里采纳。本机需要先运行 gh auth login 才能开 PR。',
    '6. 网络默认跟随 Fynvra 的代理设置；连不上时检查 VPN，或在「设置 → 通用 → 网络代理」改用手动代理。',
    '7. Fynvra 关着的时候不会处理群消息。',
].join('\n');
const NETWORK_HINT = '连不上 api.telegram.org：请确认 VPN 或代理已开启；网络代理默认跟随系统代理，也可以在「设置 → 通用 → 网络代理」改用手动代理';
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** 生成整份设置页 */
export function buildSettingsUi(state, workspaces) {
    const workspaceName = (id) => workspaces.find((workspace) => workspace.id === id)?.name ?? '工作区已移除';
    const gitOptions = workspaces
        .filter((workspace) => workspace.git)
        .map((workspace) => ({ value: workspace.id, label: clip(workspace.name, 200) }));
    const connection = [
        {
            type: 'keyValue',
            items: [
                { label: '状态', value: CONNECTION_TEXT[state.connection] },
                ...(state.bot ? [{ label: '机器人', value: `@${state.bot.username}` }] : []),
            ],
        },
    ];
    if (state.connection === 'network-error') {
        connection.push({ type: 'text', text: NETWORK_HINT, tone: 'error' });
    }
    else if (state.connection === 'unauthorized' || state.connection === 'conflict') {
        connection.push({ type: 'text', text: CONNECTION_TEXT[state.connection], tone: 'error' });
    }
    connection.push({
        type: 'field',
        id: 'token',
        label: 'Bot Token',
        kind: 'password',
        placeholder: '粘贴 @BotFather 给的 token',
        action: ACTIONS.saveToken,
    });
    if (state.tokenMasked) {
        connection.push({ type: 'text', text: `已设置：${state.tokenMasked}`, tone: 'muted' }, {
            type: 'button',
            label: '清除 token',
            action: ACTIONS.clearToken,
            tone: 'destructive',
            confirm: '清除后机器人停止轮询，群里的反馈不再处理。确定清除 token？',
        });
    }
    const candidates = state.candidates.map((candidate) => ({
        key: String(candidate.chatId),
        title: clip(candidate.title || '（无群名）', 200),
        ...(gitOptions.length === 0
            ? { subtitle: '没有可用的 git 工作区：先在 Fynvra 里打开一个有远端的 git 仓库' }
            : {
                controls: [
                    {
                        type: 'field',
                        id: 'workspace',
                        label: '工作区',
                        kind: 'select',
                        options: gitOptions,
                    },
                    { type: 'button', label: '允许', action: ACTIONS.allowGroup },
                ],
            }),
    }));
    const groups = state.groups.map((group) => ({
        key: String(group.chatId),
        title: clip(group.title || '（无群名）', 200),
        subtitle: clip(workspaceName(group.workspaceId), 500),
        badges: [
            group.active ? { text: '在群里', tone: 'success' } : { text: '已被移出群', tone: 'error' },
        ],
        controls: [
            {
                type: 'button',
                label: '移除',
                action: ACTIONS.removeGroup,
                tone: 'destructive',
                confirm: `移除「${clip(group.title, 100)}」后，这个群的反馈不再处理。确定移除？`,
            },
        ],
    }));
    const pending = state.cards
        .filter((card) => card.status === 'pending-approval')
        .map((card) => ({
        key: String(card.id),
        title: clip(card.title || `卡片 #${card.id}`, 200),
        subtitle: clip(`来自 ${card.groupTitle || '未知群'}`, 500),
        ...(card.assessmentIncomplete
            ? { badges: [{ text: '三问评估格式不完整，请自行判断', tone: 'warning' }] }
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
            subtitle: clip(`${card.groupTitle || '未知群'} · 追问 ${card.followUps}/2`, 500),
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
                title: '候选群',
                children: [
                    {
                        type: 'list',
                        empty: '暂无候选群：把机器人拉进群后，在群里 @机器人 发一条消息，群就会出现在这里',
                        items: candidates,
                    },
                ],
            },
            {
                type: 'section',
                title: '已允许的群',
                children: [{ type: 'list', empty: '还没有允许的群', items: groups }],
            },
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
                        max: TELEGRAM_RATE_LIMIT_MAX,
                        action: ACTIONS.saveRateLimit,
                    },
                    {
                        type: 'text',
                        text: '超出后会提示一次「你发得有点快」，不再调用模型（1–1000，默认 5）',
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
                title: '最近记录',
                children: [{ type: 'list', empty: '还没有记录', items: recent }],
            },
            { type: 'section', title: '使用说明', children: [{ type: 'text', text: GUIDE }] },
        ],
    };
}
/** itemKey 是整数 id（群 id 可为负） */
function intKey(itemKey) {
    if (typeof itemKey !== 'string' || !/^-?\d{1,20}$/.test(itemKey))
        return null;
    const value = Number(itemKey);
    return Number.isSafeInteger(value) ? value : null;
}
/** 处理宿主送来的 ui.action（入参未收窄）；未知操作返回错误 */
export async function handleUiAction(service, raw) {
    const record = asRecord(raw);
    const action = record?.action;
    const values = asRecord(record?.values) ?? {};
    const itemKey = record?.itemKey;
    switch (action) {
        case ACTIONS.saveToken: {
            const token = values.token;
            if (typeof token !== 'string' || token.trim() === '')
                return { ok: false, error: '请填写 Bot Token' };
            return service.setToken(token.trim());
        }
        case ACTIONS.clearToken:
            return service.setToken(null);
        case ACTIONS.allowGroup: {
            const chatId = intKey(itemKey);
            const workspaceId = values.workspace;
            if (chatId === null)
                return { ok: false, error: '群不存在' };
            if (typeof workspaceId !== 'string' || workspaceId === '') {
                return { ok: false, error: '请先选择工作区' };
            }
            return service.allowGroup(chatId, workspaceId);
        }
        case ACTIONS.removeGroup: {
            const chatId = intKey(itemKey);
            return chatId === null ? { ok: false, error: '群不存在' } : service.removeGroup(chatId);
        }
        case ACTIONS.saveRateLimit: {
            const perHour = values.rateLimit;
            return service.setRateLimit(typeof perHour === 'number' ? perHour : Number.NaN);
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
