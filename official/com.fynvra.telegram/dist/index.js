// 插件入口（清单 host.main → dist/index.js）：activate 组装 Telegram 客户端、服务与设置页，deactivate 停止。
import { createTelegramService } from './service.js';
import { createHttpsPost, createTelegramApi } from './telegramApi.js';
import { buildSettingsUi, handleUiAction } from './ui.js';
import { errorMessage } from './util.js';
/** 状态变化后合并多久再重新 render */
export const RENDER_THROTTLE_MS = 500;
/** 工作区列表不会推事件：隔这么久看一次，有变化才重新 render（候选群的下拉框要用） */
const WORKSPACE_REFRESH_MS = 60_000;
/** 组装并启动；Telegram 客户端可注入（测试用假的） */
export async function startPlugin(api, telegram, options = {}) {
    const service = createTelegramService({ api, telegram, ...options });
    const throttleMs = options.renderThrottleMs ?? RENDER_THROTTLE_MS;
    let renderTimer;
    let stopped = false;
    let lastWorkspaces = '';
    const render = async () => {
        try {
            const workspaces = await api.workspaces.list();
            lastWorkspaces = JSON.stringify(workspaces);
            await api.ui.render(buildSettingsUi(service.getState(), workspaces));
        }
        catch (error) {
            api.log('warn', `设置页渲染失败：${errorMessage(error)}`);
        }
    };
    const scheduleRender = () => {
        if (renderTimer || stopped)
            return;
        renderTimer = setTimeout(() => {
            renderTimer = undefined;
            void render();
        }, throttleMs);
    };
    const offs = [
        service.onChange(scheduleRender),
        api.handle('ui.action', async (args) => {
            const result = await handleUiAction(service, args);
            // 失败时也重画：例如数字框的非法值要恢复成已保存的值
            scheduleRender();
            return result;
        }),
    ];
    const workspaceTimer = setInterval(() => {
        void api.workspaces
            .list()
            .then((list) => {
            if (JSON.stringify(list) !== lastWorkspaces)
                scheduleRender();
        })
            .catch(() => undefined);
    }, WORKSPACE_REFRESH_MS);
    workspaceTimer.unref?.();
    // 先读数据、迁移旧数据，然后才开始轮询（都在 service.start 里按顺序做）
    await service.start();
    await render();
    return {
        service,
        render,
        async stop() {
            stopped = true;
            clearTimeout(renderTimer);
            clearInterval(workspaceTimer);
            for (const off of offs)
                off();
            await service.stop();
        },
    };
}
let running;
export async function activate(api) {
    const telegram = createTelegramApi({ http: createHttpsPost(() => api.net.proxyEnv()) });
    running = await startPlugin(api, telegram);
}
export async function deactivate() {
    const current = running;
    running = undefined;
    await current?.stop();
}
