// Telegram 群反馈值班的视图类型（移植自 Fynvra src/shared/types/telegram.ts）；不含 token 明文。
// 插件的启用和停用由 Fynvra 的插件卡片负责，所以没有内置版的 enabled 与 disabled 状态。
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
