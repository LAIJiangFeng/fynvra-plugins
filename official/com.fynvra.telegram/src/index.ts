// 插件入口（清单 host.main → dist/index.js）：activate 组装 Telegram 客户端、服务与设置页，deactivate 停止。
import { createTelegramService, type TelegramService, type TelegramServiceDeps } from './service.js';
import {
  createHttpsGet,
  createHttpsPost,
  createTelegramApi,
  type TelegramApi,
} from './telegramApi.js';
import type { FynvraPluginApi, Unsubscribe } from './types/appPluginApi.js';
import { buildSettingsUi, handleUiAction, type ModelChoices } from './ui.js';
import { asRecord, errorMessage } from './util.js';

/** 状态变化后合并多久再重新 render */
export const RENDER_THROTTLE_MS = 500;
/** 工作区列表不会推事件：隔这么久看一次，有变化才重新 render（候选群的下拉框要用） */
const WORKSPACE_REFRESH_MS = 60_000;

export interface RunningPlugin {
  service: TelegramService;
  /** 立即重新 render 一次（测试用） */
  render(): Promise<void>;
  stop(): Promise<void>;
}

/** 组装并启动；Telegram 客户端可注入（测试用假的） */
export async function startPlugin(
  api: FynvraPluginApi,
  telegram: TelegramApi,
  options: Omit<TelegramServiceDeps, 'api' | 'telegram'> & { renderThrottleMs?: number } = {}
): Promise<RunningPlugin> {
  const service = createTelegramService({ api, telegram, ...options });
  const throttleMs = options.renderThrottleMs ?? RENDER_THROTTLE_MS;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let lastWorkspaces = '';

  /** 读可选的模型；旧版 Fynvra 没有 channel.models（或拒绝调用）时不支持 */
  const loadModels = async (): Promise<ModelChoices> => {
    if (typeof api.channel.models !== 'function') return { supported: false };
    try {
      const raw = asRecord(await api.channel.models())?.models;
      const models = (Array.isArray(raw) ? raw : []).flatMap((item) => {
        const m = asRecord(item);
        const str = (v: unknown) => typeof v === 'string' && v.length > 0;
        return m && str(m.providerId) && str(m.modelId)
          ? [
              {
                providerId: m.providerId as string,
                modelId: m.modelId as string,
                providerName: str(m.providerName) ? (m.providerName as string) : (m.providerId as string),
                label: str(m.label) ? (m.label as string) : (m.modelId as string),
              },
            ]
          : [];
      });
      return { supported: true, models };
    } catch (error) {
      const message = errorMessage(error);
      if (/method not allowed|permission required/.test(message)) return { supported: false };
      api.log('warn', `读取模型列表失败：${message}`);
      return { supported: true, models: null };
    }
  };

  const render = async () => {
    try {
      const [workspaces, models] = await Promise.all([api.workspaces.list(), loadModels()]);
      lastWorkspaces = JSON.stringify(workspaces);
      await api.ui.render(buildSettingsUi(service.getState(), workspaces, models));
    } catch (error) {
      api.log('warn', `设置页渲染失败：${errorMessage(error)}`);
    }
  };
  const scheduleRender = () => {
    if (renderTimer || stopped) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      void render();
    }, throttleMs);
  };

  const offs: Unsubscribe[] = [
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
        if (JSON.stringify(list) !== lastWorkspaces) scheduleRender();
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
      for (const off of offs) off();
      await service.stop();
    },
  };
}

let running: RunningPlugin | undefined;

export async function activate(api: FynvraPluginApi): Promise<void> {
  const proxyEnv = () => api.net.proxyEnv();
  const telegram = createTelegramApi({
    http: createHttpsPost(proxyEnv),
    download: createHttpsGet(proxyEnv),
  });
  running = await startPlugin(api, telegram);
}

export async function deactivate(): Promise<void> {
  const current = running;
  running = undefined;
  await current?.stop();
}
