/** 思考档位，顺序同 Fynvra 输入框 */
export const THINKING_LEVELS = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
];
export const isThinkingLevel = (value) => THINKING_LEVELS.includes(value);
export const CHAT_TYPE_TEXT = { group: '群聊', p2p: '私聊' };
/** 没有群名时的显示：「群聊 · 短 id」 */
export function chatFallbackTitle(type, chatId) {
    return `${CHAT_TYPE_TEXT[type]} · ${chatId.slice(-6)}`;
}
/** 每人每小时限额：默认 5，可配 1–1000 */
export const RATE_LIMIT_DEFAULT = 5;
export const RATE_LIMIT_MAX = 1000;
export function isRateLimit(value) {
    return (Number.isSafeInteger(value) && value >= 1 && value <= RATE_LIMIT_MAX);
}
/** 连续对话分钟数：默认 5，可配 0–60，0 表示关闭 */
export const FOLLOW_MINUTES_DEFAULT = 5;
export const FOLLOW_MINUTES_MAX = 60;
export function isFollowMinutes(value) {
    return (Number.isSafeInteger(value) && value >= 0 && value <= FOLLOW_MINUTES_MAX);
}
/** App Secret 只给首尾各两位 */
export function maskSecret(secret) {
    return secret.length < 8 ? '…' : `${secret.slice(0, 2)}…${secret.slice(-2)}`;
}
