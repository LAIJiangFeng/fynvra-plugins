// 设置页：把服务状态生成 UI 描述 v1（纯函数），并把用户操作（ui.action）分派给服务。
// 按 Fynvra 渲染器的规则排版：field 后紧跟的 text 是说明，紧跟的按钮并入同一行。
// 插件的启用和停用在 Fynvra 的插件卡片上，这里不放开关。
import type {
  TelegramCardKind,
  TelegramCardStatus,
  TelegramConnection,
  TelegramStateView,
} from './model.js';
import { FOLLOW_MINUTES_MAX, TELEGRAM_RATE_LIMIT_MAX } from './model.js';
import type { ActionResult, TelegramService } from './service.js';
import { isThinkingLevel } from './model.js';
import type {
  ChannelModel,
  ChannelModelRef,
  ChannelThinkingLevel,
  PluginWorkspace,
} from './types/appPluginApi.js';
import type { PluginUi, UiListItem, UiNode } from './types/appPluginUi.js';
import { httpsUrl, isUiId } from './types/appPluginUi.js';
import { asRecord } from './util.js';

/** 最近记录最多显示几条（列表上限 200，整页 ≤ 256 KB） */
export const RECENT_LIMIT = 50;

export const ACTIONS = {
  saveToken: 'token.save',
  clearToken: 'token.clear',
  allowGroup: 'group.allow',
  removeGroup: 'group.remove',
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
  bindCode: 'maintainer.code',
  unbind: 'maintainer.unbind',
} as const;

const BIND_HINT =
  '用要绑定的 Telegram 账号打开下面的链接（会打开和机器人的私聊并自动发送），或在和机器人的私聊里发送 /start <码>。10 分钟内有效。';

/** 「维护者」分组：当前绑定、生成绑定码、解除绑定 */
function maintainerNodes(state: TelegramStateView): UiNode[] {
  const nodes: UiNode[] = [
    { type: 'keyValue', items: [{ label: '维护者', value: state.maintainer?.label ?? '未绑定' }] },
    { type: 'button', label: '生成绑定码', action: ACTIONS.bindCode },
  ];
  if (state.maintainer) {
    nodes.push({
      type: 'button',
      label: '解除绑定',
      action: ACTIONS.unbind,
      tone: 'destructive',
      confirm: '解除后他在群里提的需求按普通成员处理。确定解除绑定？',
    });
  }
  const code = state.bindCode;
  if (code) {
    nodes.push({ type: 'text', text: BIND_HINT, tone: 'muted' });
    const url = state.bot ? httpsUrl(`https://t.me/${state.bot.username}?start=${code.code}`) : null;
    if (url) {
      nodes.push({ type: 'list', items: [{ key: 'bindLink', title: clip(url, 200), link: { label: '打开', url } }] });
    }
    nodes.push({ type: 'text', text: `绑定码：${code.code}` });
  }
  return nodes;
}

const CONNECTION_TEXT: Record<TelegramConnection, string> = {
  'no-token': '未配置',
  connecting: '连接中…',
  connected: '已连接',
  'network-error': '网络错误，正在重试',
  unauthorized: 'token 无效，请重新填写',
  conflict: '另有实例在轮询，请关掉另一处',
  'api-error': 'Telegram 接口出错，正在重试',
};

const STATUS_TEXT: Record<TelegramCardStatus, string> = {
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

const KIND_TEXT: Record<TelegramCardKind, string> = {
  bug: 'Bug',
  feature: '新功能',
  question: '提问/闲聊',
  invalid: '无效',
};

const PRIVACY_WARNING = '隐私模式开着：机器人只收到 @ 它的消息。到 @BotFather 关闭后，把机器人移出群再拉回来';
const NETWORK_HINT = '连不上 Telegram：检查 VPN 或「设置 → 通用 → 网络代理」';

/** 思考档位的显示文字，和 Fynvra 输入框一致 */
const THINKING_TEXT: Record<ChannelThinkingLevel, string> = {
  off: 'off · 关闭',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/** 「x 分钟前出现」 */
function seenAgo(seenAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - seenAt) / 60_000));
  if (minutes < 1) return '刚刚出现';
  if (minutes < 60) return `${minutes} 分钟前出现`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前出现` : `${Math.floor(hours / 24)} 天前出现`;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * 设置页能选的模型：旧版 Fynvra 不支持时 supported=false；
 * models 为 null 表示这次没读到列表（不把已选的标成不可用）
 */
export type ModelChoices = { supported: false } | { supported: true; models: ChannelModel[] | null };

/** 下拉里「默认」的值；模型的值都含 `/`，不会混淆 */
export const DEFAULT_MODEL_VALUE = 'default';
/** 下拉选项值的上限（UI 描述 v1） */
const OPTION_VALUE_MAX = 200;

/** 下拉选项的值：两段各自 encodeURIComponent（`/` 会被编码），再用 `/` 连起来 */
export function modelValue(ref: ChannelModelRef): string {
  return `${encodeURIComponent(ref.providerId)}/${encodeURIComponent(ref.modelId)}`;
}

/** 把下拉的值拆回模型；默认返回 null，非法返回 undefined */
export function parseModelValue(value: unknown): ChannelModelRef | null | undefined {
  if (value === DEFAULT_MODEL_VALUE) return null;
  if (typeof value !== 'string') return undefined;
  const parts = value.split('/');
  if (parts.length !== 2) return undefined;
  try {
    const [providerId, modelId] = parts.map((part) => decodeURIComponent(part));
    if (!providerId || !modelId || providerId.length > 200 || modelId.length > 200) return undefined;
    return { providerId, modelId };
  } catch {
    return undefined;
  }
}

const sameModel = (a: ChannelModelRef, b: ChannelModelRef) =>
  a.providerId === b.providerId && a.modelId === b.modelId;

/** 模型支持的档位；列表里找不到或旧版 Fynvra 时为空 */
export function thinkingLevelsOf(
  models: readonly ChannelModel[] | null | undefined,
  ref: ChannelModelRef
): ChannelThinkingLevel[] {
  return models?.find((model) => sameModel(model, ref))?.thinkingLevels ?? [];
}

function modelNodes(state: TelegramStateView, choices: ModelChoices): UiNode[] {
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
  const nodes: UiNode[] = [];
  let unavailable = false;
  const select = (kind: 'triage' | 'duty', label: string, hint: string, chosen?: ChannelModelRef) => {
    const options = [
      { value: DEFAULT_MODEL_VALUE, label: '默认（跟随 Fynvra）' },
      ...listed.map(({ value, label }) => ({ value, label })),
    ];
    const found = chosen && listed.find((option) => sameModel(option.model, chosen))?.model;
    if (chosen && !found) {
      // 已选的不在列表里：保留这一项；读到了列表才标「不可用」
      const missing = choices.models !== null;
      if (missing) unavailable = true;
      options.push({
        value: modelValue(chosen),
        label: clip(`${chosen.providerId} / ${chosen.modelId}${missing ? '（不可用）' : ''}`, 200),
      });
    }
    nodes.push(
      {
        type: 'field',
        id: `${kind}Model`,
        label,
        kind: 'select',
        value: chosen ? modelValue(chosen) : DEFAULT_MODEL_VALUE,
        options,
        action: kind === 'triage' ? ACTIONS.triageModel : ACTIONS.dutyModel,
      },
      { type: 'text', text: hint, tone: 'muted' }
    );
    // 选了默认、模型不在列表里或不支持思考时不显示档位
    if (!found || found.thinkingLevels.length === 0) return;
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
export function buildSettingsUi(
  state: TelegramStateView,
  workspaces: PluginWorkspace[],
  models: ModelChoices,
  now = Date.now()
): PluginUi {
  const workspaceName = (id: string) =>
    workspaces.find((workspace) => workspace.id === id)?.name ?? '工作区已移除';
  const gitOptions = workspaces
    .filter((workspace) => workspace.git)
    .map((workspace) => ({ value: workspace.id, label: clip(workspace.name, 200) }));

  const connection: UiNode[] = [
    {
      type: 'keyValue',
      items: [
        { label: '状态', value: CONNECTION_TEXT[state.connection] },
        ...(state.bot ? [{ label: '机器人', value: `@${state.bot.username}` }] : []),
        ...(typeof state.bot?.canReadAll === 'boolean'
          ? [{ label: '隐私模式', value: state.bot.canReadAll ? '关闭' : '开启' }]
          : []),
      ],
    },
  ];
  if (state.bot?.canReadAll === false) {
    connection.push({ type: 'text', text: PRIVACY_WARNING, tone: 'warning' });
  }
  if (state.connection === 'network-error') {
    connection.push({ type: 'text', text: NETWORK_HINT, tone: 'error' });
  }
  // 没有 action：输入只是草稿，点「保存」时随按钮一起发出
  connection.push(
    {
      type: 'field',
      id: 'token',
      label: 'Bot Token',
      kind: 'password',
      placeholder: '粘贴 @BotFather 给的 token',
    },
    {
      type: 'text',
      text: state.tokenMasked ? `已设置：${state.tokenMasked}` : '还没设置',
      tone: 'muted',
    },
    { type: 'button', label: '保存', action: ACTIONS.saveToken }
  );
  if (state.tokenMasked) {
    connection.push({
      type: 'button',
      label: '清除',
      action: ACTIONS.clearToken,
      tone: 'destructive',
      confirm: '清除后机器人停止轮询，群里的反馈不再处理。确定清除 token？',
    });
  }

  const candidates: UiListItem[] = state.candidates.map((candidate) => ({
    key: String(candidate.chatId),
    title: clip(candidate.title || '（无群名）', 200),
    ...(gitOptions.length === 0
      ? { subtitle: `${seenAgo(candidate.seenAt, now)} · 没有可选的 git 工作区` }
      : {
          subtitle: seenAgo(candidate.seenAt, now),
          controls: [
            {
              type: 'field' as const,
              id: 'workspace',
              label: '项目',
              kind: 'select' as const,
              options: gitOptions,
            },
            { type: 'button' as const, label: '允许', action: ACTIONS.allowGroup },
          ],
        }),
  }));

  // 每个群一个 list：群本身、各项目、添加项目
  const groups: UiNode[] = state.groups.map((group) => {
    const unbound = gitOptions.filter(
      (option) => !group.projects.some((p) => p.workspaceId === option.value)
    );
    const groupItem: UiListItem = {
      key: String(group.chatId),
      title: clip(group.title || '（无群名）', 200),
      badges: [group.active ? { text: '在群里', tone: 'success' } : { text: '已移出', tone: 'error' }],
      subtitle: `${group.projects.length} 个项目`,
      controls: [
        {
          type: 'button',
          label: '移除群',
          action: ACTIONS.removeGroup,
          tone: 'destructive',
          confirm: `移除「${clip(group.title, 100)}」后，这个群的反馈不再处理。确定移除？`,
        },
      ],
    };
    const projects: UiListItem[] = group.projects.map((project, index) => ({
      key: projectKey(group.chatId, project.workspaceId, index),
      title: clip(workspaceName(project.workspaceId), 200),
      ...(index === 0 ? { badges: [{ text: '主项目', tone: 'success' as const }] } : {}),
      controls: [
        {
          type: 'field' as const,
          id: 'note',
          label: '说明',
          kind: 'text' as const,
          value: project.note,
          placeholder: '一句话说明，帮 AI 判断转交',
          action: ACTIONS.saveNote,
        },
        ...(index > 0
          ? [{ type: 'button' as const, label: '设为主项目', action: ACTIONS.setPrimary }]
          : []),
        ...(group.projects.length > 1
          ? [
              {
                type: 'button' as const,
                label: '移除',
                action: ACTIONS.removeProject,
                tone: 'destructive' as const,
                confirm: `从「${clip(group.title, 100)}」移除项目「${clip(workspaceName(project.workspaceId), 100)}」？`,
              },
            ]
          : []),
      ],
    }));
    const addItem: UiListItem[] =
      unbound.length > 0
        ? [
            {
              key: addProjectKey(group.chatId),
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
    return { type: 'list', items: [groupItem, ...projects, ...addItem] };
  });

  const pending: UiListItem[] = state.cards
    .filter((card) => card.status === 'pending-approval')
    .map((card) => ({
      key: String(card.id),
      title: clip(card.title || `卡片 #${card.id}`, 200),
      subtitle: clip(card.groupTitle || '未知群', 500),
      ...(card.assessmentIncomplete
        ? { badges: [{ text: '评估不完整', tone: 'warning' as const }] }
        : {}),
      ...(card.assessment ? { body: clip(card.assessment, 4000) } : {}),
      controls: [
        { type: 'button' as const, label: '采纳', action: ACTIONS.approve },
        { type: 'button' as const, label: '拒绝', action: ACTIONS.reject },
      ],
    }));

  const recent: UiListItem[] = state.cards.slice(0, RECENT_LIMIT).map((card) => {
    const url = card.prUrl ? httpsUrl(card.prUrl) : null;
    return {
      key: String(card.id),
      title: clip(card.title || `卡片 #${card.id}`, 200),
      subtitle: clip(`${card.groupTitle || '未知群'} · 追问 ${card.followUps}/2`, 500),
      badges: [
        { text: STATUS_TEXT[card.status] },
        ...(card.kind ? [{ text: KIND_TEXT[card.kind], tone: 'muted' as const }] : []),
      ],
      ...(url ? { link: { label: '打开 PR', url } } : {}),
    };
  });

  return {
    children: [
      { type: 'section', title: '连接', children: connection },
      { type: 'section', title: '维护者', children: maintainerNodes(state) },
      {
        type: 'section',
        title: '群',
        children: [
          {
            type: 'section',
            title: '候选群',
            children: [
              { type: 'list', empty: '把机器人拉进群并 @ 它，群会出现在这里', items: candidates },
            ],
          },
          {
            type: 'section',
            title: '已允许的群',
            children:
              groups.length > 0 ? groups : [{ type: 'list', empty: '还没有允许的群', items: [] }],
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
            max: TELEGRAM_RATE_LIMIT_MAX,
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

/** 「添加项目」行的 key：`add:<群 id>`，不会和群行、项目行混淆 */
const addProjectKey = (chatId: number) => `add:${chatId}`;

/**
 * 项目行的 key：`<群 id>:<工作区 id>`；超出 UI key 的格式（例如太长）时改用 `<群 id>:.<序号>`
 * （工作区 id 不含 `.`，不会混淆）。
 */
export function projectKey(chatId: number, workspaceId: string, index: number): string {
  const key = `${chatId}:${workspaceId}`;
  return isUiId(key) ? key : `${chatId}:.${index}`;
}

/** 把项目行的 key 解析回群 id 与工作区 id（序号按当前状态查） */
function parseProjectKey(
  service: TelegramService,
  itemKey: unknown
): { chatId: number; workspaceId: string } | null {
  if (typeof itemKey !== 'string') return null;
  const match = /^(-?\d{1,20}):(.+)$/.exec(itemKey);
  const chatId = intKey(match?.[1]);
  const rest = match?.[2];
  if (chatId === null || rest === undefined) return null;
  if (!rest.startsWith('.')) return { chatId, workspaceId: rest };
  const group = service.getState().groups.find((g) => g.chatId === chatId);
  const workspaceId = /^\.\d{1,4}$/.test(rest)
    ? group?.projects[Number(rest.slice(1))]?.workspaceId
    : undefined;
  return workspaceId === undefined ? null : { chatId, workspaceId };
}

/** itemKey 是整数 id（群 id 可为负） */
function intKey(itemKey: unknown): number | null {
  if (typeof itemKey !== 'string' || !/^-?\d{1,20}$/.test(itemKey)) return null;
  const value = Number(itemKey);
  return Number.isSafeInteger(value) ? value : null;
}

/** 处理宿主送来的 ui.action（入参未收窄）；未知操作返回错误 */
export async function handleUiAction(
  service: TelegramService,
  raw: unknown,
  /** 最近一次读到的模型列表，用来校验思考档位 */
  models: readonly ChannelModel[] | null = null
): Promise<ActionResult> {
  const record = asRecord(raw);
  const action = record?.action;
  const values = asRecord(record?.values) ?? {};
  const itemKey = record?.itemKey;
  switch (action) {
    case ACTIONS.saveToken: {
      const token = values.token;
      if (typeof token !== 'string' || token.trim() === '') return { ok: false, error: '请填写 Bot Token' };
      return service.setToken(token.trim());
    }
    case ACTIONS.clearToken:
      return service.setToken(null);
    case ACTIONS.allowGroup: {
      const chatId = intKey(itemKey);
      const workspaceId = values.workspace;
      if (chatId === null) return { ok: false, error: '群不存在' };
      if (typeof workspaceId !== 'string' || workspaceId === '') {
        return { ok: false, error: '请先选择工作区' };
      }
      return service.allowGroup(chatId, workspaceId);
    }
    case ACTIONS.removeGroup: {
      const chatId = intKey(itemKey);
      return chatId === null ? { ok: false, error: '群不存在' } : service.removeGroup(chatId);
    }
    case ACTIONS.addProject: {
      const chatId = intKey(typeof itemKey === 'string' ? itemKey.replace(/^add:/, '') : itemKey);
      const workspaceId = values.workspace;
      if (chatId === null) return { ok: false, error: '群不存在' };
      if (typeof workspaceId !== 'string' || workspaceId === '') {
        return { ok: false, error: '请先选择工作区' };
      }
      return service.addProject(chatId, workspaceId);
    }
    case ACTIONS.removeProject:
    case ACTIONS.setPrimary:
    case ACTIONS.saveNote: {
      const ref = parseProjectKey(service, itemKey);
      if (!ref) return { ok: false, error: '项目不存在' };
      if (action === ACTIONS.removeProject) return service.removeProject(ref.chatId, ref.workspaceId);
      if (action === ACTIONS.setPrimary) return service.setPrimaryProject(ref.chatId, ref.workspaceId);
      const note = values.note;
      if (typeof note !== 'string') return { ok: false, error: '说明格式不对' };
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
      if (model === undefined) return { ok: false, error: '模型格式不对' };
      if (!model) return service.setModel(triage ? 'triage' : 'duty', null);
      // 新模型支持原来的档位就保留，否则回到默认
      const thinking = service.getState()[triage ? 'triageModel' : 'dutyModel']?.thinking;
      const keep = thinking !== undefined && thinkingLevelsOf(models, model).includes(thinking);
      return service.setModel(triage ? 'triage' : 'duty', keep ? { ...model, thinking } : model);
    }
    case ACTIONS.triageThinking:
    case ACTIONS.dutyThinking: {
      const triage = action === ACTIONS.triageThinking;
      const current = service.getState()[triage ? 'triageModel' : 'dutyModel'];
      if (!current) return { ok: false, error: '请先选模型' };
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
      if (cardId === null) return { ok: false, error: '只能处理待确认的需求' };
      return service.resolveCard(cardId, action === ACTIONS.approve ? 'approve' : 'reject');
    }
    case ACTIONS.bindCode:
      return service.createBindCode();
    case ACTIONS.unbind:
      return service.unbindMaintainer();
    default:
      return { ok: false, error: `未知操作：${String(action)}` };
  }
}
