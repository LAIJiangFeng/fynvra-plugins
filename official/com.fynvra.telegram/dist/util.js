// 小工具（同 Fynvra src/shared/guards.ts 的同名函数）。
export function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
