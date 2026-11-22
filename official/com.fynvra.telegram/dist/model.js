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
/** 每人每小时限额：默认 5，可配 1–1000 */
export const TELEGRAM_RATE_LIMIT_DEFAULT = 5;
export const TELEGRAM_RATE_LIMIT_MAX = 1000;
export function isTelegramRateLimit(value) {
    return (Number.isSafeInteger(value) &&
        value >= 1 &&
        value <= TELEGRAM_RATE_LIMIT_MAX);
}
/** token 只给首尾几位：`123456:AB…yz`。 */
export function maskTelegramToken(token) {
    const colon = token.indexOf(':');
    if (colon < 0 || token.length - colon < 6)
        return '…';
    return `${token.slice(0, colon + 3)}…${token.slice(-2)}`;
}
