// Fynvra 插件的声明式设置页：UI 描述 v1（ARCHITECTURE §7.12「Fynvra 插件」）。
// 插件调 `ui.render(schema)`，Main 用 parsePluginUi 校验后交给 Renderer 用 Fynvra 自己的组件渲染。
// 本文件只放类型和纯函数，不得 import Node / Electron。
// 照抄自 Fynvra src/shared/types/appPluginUi.ts（去掉 IPC 入参部分，asRecord 内联），测试用它校验生成的设置页。
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
export const MAX_UI_BYTES = 256 * 1024;
export const MAX_UI_DEPTH = 6;
export const MAX_UI_LIST_ITEMS = 200;
/** 非 list 的数组（children、keyValue、options、badges、controls、values）的上限 */
const MAX_ARRAY = 200;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const TONES = ['muted', 'error', 'warning', 'success'];
const KINDS = ['text', 'password', 'number', 'toggle', 'select'];
/** id、action、key 的格式 */
export function isUiId(value) {
    return typeof value === 'string' && ID_RE.test(value);
}
/** 只接受 https，返回规范化后的地址 */
export function httpsUrl(value) {
    if (typeof value !== 'string' || value.length > 2048)
        return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.href : null;
    }
    catch {
        return null;
    }
}
class Invalid extends Error {
}
const fail = () => {
    throw new Invalid();
};
/** 对象且只含给定键 */
function obj(raw, keys) {
    const record = asRecord(raw);
    if (!record || !Object.keys(record).every((key) => keys.includes(key)))
        fail();
    return record;
}
function str(value, max) {
    if (typeof value !== 'string' || value.length > max)
        fail();
    return value;
}
function optStr(value, max) {
    return value === undefined ? undefined : str(value, max);
}
function id(value) {
    if (!isUiId(value))
        fail();
    return value;
}
function arr(value, max) {
    if (!Array.isArray(value) || value.length > max)
        fail();
    return value;
}
function num(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        fail();
    return value;
}
function tone(value) {
    if (value === undefined)
        return undefined;
    if (!TONES.includes(value))
        fail();
    return value;
}
/** 去掉值为 undefined 的键，结果里只留出现过的可选字段 */
function compact(value) {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
function field(r) {
    const kind = r.kind;
    if (!KINDS.includes(kind))
        fail();
    let value;
    if (r.value !== undefined) {
        if (kind === 'number')
            value = num(r.value);
        else if (kind === 'toggle') {
            if (typeof r.value !== 'boolean')
                fail();
            value = r.value;
        }
        else
            value = str(r.value, 4000);
    }
    let options;
    if (kind === 'select') {
        options = arr(r.options, MAX_ARRAY).map((raw) => {
            const option = obj(raw, ['value', 'label']);
            return { value: str(option.value, 200), label: str(option.label, 200) };
        });
        if (options.length === 0)
            fail();
    }
    else if (r.options !== undefined)
        fail();
    if (kind !== 'number' && (r.min !== undefined || r.max !== undefined))
        fail();
    const min = r.min === undefined ? undefined : num(r.min);
    const max = r.max === undefined ? undefined : num(r.max);
    if (min !== undefined && max !== undefined && min > max)
        fail();
    return compact({
        type: 'field',
        id: id(r.id),
        label: str(r.label, 200),
        kind,
        value,
        placeholder: optStr(r.placeholder, 200),
        options,
        min,
        max,
        action: r.action === undefined ? undefined : id(r.action),
    });
}
function button(r) {
    if (r.tone !== undefined && r.tone !== 'default' && r.tone !== 'destructive')
        fail();
    return compact({
        type: 'button',
        label: str(r.label, 200),
        action: id(r.action),
        tone: r.tone,
        confirm: optStr(r.confirm, 500),
    });
}
const FIELD_KEYS = [
    'type',
    'id',
    'label',
    'kind',
    'value',
    'placeholder',
    'options',
    'min',
    'max',
    'action',
];
const BUTTON_KEYS = ['type', 'label', 'action', 'tone', 'confirm'];
/** depth：本节点所在层（顶层为 1） */
function node(raw, depth) {
    if (depth > MAX_UI_DEPTH)
        fail();
    const type = asRecord(raw)?.type;
    switch (type) {
        case 'section': {
            const r = obj(raw, ['type', 'title', 'children']);
            return {
                type,
                title: str(r.title, 200),
                children: arr(r.children, MAX_ARRAY).map((child) => node(child, depth + 1)),
            };
        }
        case 'text': {
            const r = obj(raw, ['type', 'text', 'tone']);
            return compact({ type, text: str(r.text, 4000), tone: tone(r.tone) });
        }
        case 'keyValue': {
            const r = obj(raw, ['type', 'items']);
            return {
                type,
                items: arr(r.items, MAX_ARRAY).map((item) => {
                    const pair = obj(item, ['label', 'value']);
                    return { label: str(pair.label, 200), value: str(pair.value, 1000) };
                }),
            };
        }
        case 'field':
            return field(obj(raw, FIELD_KEYS));
        case 'button':
            return button(obj(raw, BUTTON_KEYS));
        case 'list': {
            const r = obj(raw, ['type', 'empty', 'items']);
            const keys = new Set();
            const items = arr(r.items, MAX_UI_LIST_ITEMS).map((rawItem) => listItem(rawItem, depth, keys));
            return compact({ type, empty: optStr(r.empty, 500), items });
        }
        default:
            return fail();
    }
}
function listItem(raw, depth, keys) {
    const r = obj(raw, ['key', 'title', 'subtitle', 'badges', 'body', 'link', 'controls']);
    const key = id(r.key);
    if (keys.has(key))
        fail();
    keys.add(key);
    let link;
    if (r.link !== undefined) {
        const l = obj(r.link, ['label', 'url']);
        const url = httpsUrl(l.url);
        if (!url)
            fail();
        link = { label: str(l.label, 200), url: url };
    }
    // 列表项里的控件比列表深一层
    if (r.controls !== undefined && depth + 1 > MAX_UI_DEPTH)
        fail();
    return compact({
        key,
        title: str(r.title, 200),
        subtitle: optStr(r.subtitle, 500),
        badges: r.badges === undefined
            ? undefined
            : arr(r.badges, 20).map((rawBadge) => {
                const badge = obj(rawBadge, ['text', 'tone']);
                return compact({ text: str(badge.text, 50), tone: tone(badge.tone) });
            }),
        body: optStr(r.body, 4000),
        link,
        controls: r.controls === undefined
            ? undefined
            : arr(r.controls, MAX_ARRAY).map((control) => {
                const type = asRecord(control)?.type;
                if (type === 'field')
                    return field(obj(control, FIELD_KEYS));
                if (type === 'button')
                    return button(obj(control, BUTTON_KEYS));
                return fail();
            }),
    });
}
/** 序列化后的 UTF-8 字节数；不可序列化时按超限 */
function byteSize(raw) {
    try {
        return new TextEncoder().encode(JSON.stringify(raw) ?? '').length;
    }
    catch {
        return Number.POSITIVE_INFINITY;
    }
}
/** 校验 UI 描述；任何一处不合法整份拒绝（返回 null）。结果是新对象，不含多余键 */
export function parsePluginUi(raw) {
    if (byteSize(raw) > MAX_UI_BYTES)
        return null;
    try {
        const r = obj(raw, ['children']);
        return { children: arr(r.children, MAX_ARRAY).map((child) => node(child, 1)) };
    }
    catch (error) {
        if (error instanceof Invalid)
            return null;
        throw error;
    }
}
