// Fynvra 插件作者用的宿主 API 类型（ARCHITECTURE §7.12「Fynvra 插件」）。
// 插件入口（清单的 host.main，ESM）导出 activate(api)，可选 deactivate()；api 的每个方法经 RPC 交给 Main 处理，
// Main 按清单权限检查。本文件只有类型，插件仓库可整份照抄。
// 照抄自 Fynvra src/shared/types/appPluginApi.ts；legacy 段按 H4a 约定的形状补上。
export {};
