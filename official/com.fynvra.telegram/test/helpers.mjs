// 测试用的假宿主 API 与假 Telegram 客户端（只依赖 Node 内置模块）。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TOKEN = `123456789:${'A'.repeat(35)}`;
export const KNOWN_KEY = 'known-provider-key-123';
const TOKEN_LIKE = /\d{6,12}:[A-Za-z0-9_-]{35}/;

/** 反复执行断言，直到通过或超时 */
export async function waitFor(check, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

export const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 假宿主 API。行为对齐 Fynvra 的 channels/host.ts：只认本插件的会话；filterOutbound 替换本机路径、命中密钥时拒绝；
 * setPullRequestNote 先过滤；sessionStatus 对别人的会话报 session not found。
 */
export function fakeApi(options = {}) {
  const state = {
    storage: options.storage === undefined ? null : structuredClone(options.storage),
    secrets: new Map(Object.entries(options.secrets ?? {})),
    writes: [],
    secretWrites: [],
    logs: [],
    notifications: [],
    prompts: [],
    created: [],
    refreshed: [],
    notes: new Map(),
    noteCalls: [],
    renders: [],
    filtered: [],
    calls: [],
    legacyData: options.legacy,
    legacyMigratedCalls: 0,
    sessions: new Map(
      Object.entries(options.sessions ?? { sA: 'idle', sB: 'idle' }).map(([id, status]) => [
        id,
        { id, status, workspaceId: 'ws1' },
      ])
    ),
    snapshot: { runs: [], tasks: [] },
    workspaces: options.workspaces ?? [
      { id: 'ws1', name: 'repo', git: true },
      { id: 'ws2', name: 'notes', git: false },
    ],
  };
  const listeners = new Map();
  const handlers = new Map();
  let created = 0;
  const record = (method, params) => state.calls.push({ method, params });

  const knownSecrets = () => [KNOWN_KEY, ...state.secrets.values()];
  const filter = (text) => {
    const sanitized = text.split('C:\\Users\\alice').join('<本机路径>');
    const hit = TOKEN_LIKE.test(sanitized) || knownSecrets().some((s) => s && sanitized.includes(s));
    return hit ? { ok: false, reason: 'secret' } : { ok: true, text: sanitized };
  };
  const emit = (event, payload) => {
    for (const handler of listeners.get(event) ?? []) handler(payload);
  };
  const own = (sessionId) => {
    const session = state.sessions.get(sessionId);
    if (!session) throw new Error('session not found');
    return session;
  };

  const api = {
    pluginId: 'com.fynvra.telegram',
    // 默认不创建；用到附件时插件自己建 attachments/
    dataDir: options.dataDir ?? join(tmpdir(), `fyn-tg-test-${randomUUID()}`),
    log: (level, message) => state.logs.push({ level, message }),
    storage: {
      read: async () => {
        record('storage.read');
        return structuredClone(state.storage);
      },
      write: async (value) => {
        record('storage.write', value);
        if (options.failWrite?.(value)) throw new Error('disk full');
        state.storage = structuredClone(value);
        state.writes.push(structuredClone(value));
      },
    },
    secrets: {
      get: async (key) => state.secrets.get(key) ?? null,
      set: async (key, value) => {
        record('secrets.set', { key });
        if (options.failSecrets) throw new Error('secrets unavailable');
        state.secretWrites.push({ key, value });
        if (value === null) state.secrets.delete(key);
        else state.secrets.set(key, value);
      },
    },
    notify: async (input) => {
      state.notifications.push(input);
    },
    net: { proxyEnv: async () => ({}) },
    workspaces: { list: async () => structuredClone(state.workspaces) },
    channel: {
      createSession: async (input) => {
        record('channel.createSession', input);
        if (options.origin === false) throw new Error('clean checkout failed: origin/main does not exist');
        const id = `p${++created}`;
        state.sessions.set(id, { id, status: 'idle', workspaceId: input.workspaceId });
        state.created.push(input);
        return { sessionId: id };
      },
      refreshCheckout: async (input) => {
        state.refreshed.push(input.workspaceId);
      },
      originCommit: async () => ({ commit: 'a'.repeat(40) }),
      prompt: async ({ sessionId, text, attachments }) => {
        const session = own(sessionId);
        if (session.status !== 'idle') return { delivered: false, rejected: [] };
        const dir = join(api.dataDir, 'attachments');
        state.prompts.push({
          sessionId,
          text,
          ...(attachments
            ? { attachments, existed: attachments.map((a) => existsSync(join(dir, a.file))) }
            : {}),
        });
        session.status = 'running';
        emit('channel.session', { sessionId, status: 'running' });
        return { delivered: true, rejected: options.promptRejected?.(attachments ?? []) ?? [] };
      },
      sessionStatus: async ({ sessionId }) => ({ status: own(sessionId).status }),
      snapshot: async () => structuredClone(state.snapshot),
      filterOutbound: async ({ text }) => {
        state.filtered.push(text);
        return filter(text);
      },
      setPullRequestNote: async ({ taskId, text }) => {
        state.noteCalls.push({ taskId, text });
        if (!state.snapshot.tasks.some((task) => task.id === taskId)) throw new Error('task not found');
        if (text === null) return void state.notes.delete(taskId);
        const filtered = filter(text);
        if (!filtered.ok) throw new Error('note rejected: contains a secret');
        state.notes.set(taskId, filtered.text);
      },
    },
    ui: {
      render: async (schema) => {
        state.renders.push(structuredClone(schema));
      },
    },
    legacy: {
      telegramData: async () => {
        record('legacy.telegramData');
        if (state.legacyData instanceof Error) throw state.legacyData;
        return state.legacyData === undefined ? null : structuredClone(state.legacyData);
      },
      telegramMigrated: async () => {
        record('legacy.telegramMigrated');
        state.legacyMigratedCalls += 1;
      },
    },
    on: (event, handler) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    handle: (name, handler) => {
      handlers.set(name, handler);
      return () => {
        if (handlers.get(name) === handler) handlers.delete(name);
      };
    },
  };

  return {
    api,
    state,
    emit,
    /** 宿主调插件（同 host.ts 的 call） */
    call: async (name, args) => {
      const handler = handlers.get(name);
      assert.ok(handler, `no handler: ${name}`);
      return handler(args);
    },
    hasHandler: (name) => handlers.has(name),
    /** 会话这一轮结束：状态回到 idle 并推事件 */
    settle(sessionId) {
      const session = state.sessions.get(sessionId);
      session.status = 'idle';
      emit('channel.session', { sessionId, status: 'idle' });
    },
  };
}

/** 假 Telegram 客户端：getUpdates 按批次返回，没有批次时挂起直到有新批次或被 abort */
export function fakeTelegram() {
  const queued = [];
  const sent = [];
  const offsets = [];
  const calls = { getMe: 0, getUpdates: 0, getFile: [], download: [] };
  /** fileId → { size?, data }；没有的 fileId 下载失败 */
  const files = new Map();
  let wake;
  const failures = { getMe: [] };
  const telegram = {
    getMe: async () => {
      calls.getMe += 1;
      const failure = failures.getMe.shift();
      if (failure) throw failure;
      return { id: 42, username: 'fyn_bot' };
    },
    setMyCommands: async () => undefined,
    getFile: async (_token, fileId) => {
      calls.getFile.push(fileId);
      const file = files.get(fileId);
      if (!file) throw new Error('getFile: HTTP 400 Bad Request: file not found');
      return { file_path: `photos/${fileId}.bin`, ...(file.size ? { file_size: file.size } : {}) };
    },
    downloadFile: async (_token, filePath) => {
      calls.download.push(filePath);
      const fileId = filePath.replace(/^photos\//, '').replace(/\.bin$/, '');
      return Buffer.from(files.get(fileId).data);
    },
    getUpdates: async (_token, offset, signal) => {
      calls.getUpdates += 1;
      offsets.push(offset);
      const next = queued.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
      if (signal?.aborted) return [];
      return new Promise((resolve) => {
        wake = () => resolve([]);
        signal?.addEventListener('abort', () => resolve([]), { once: true });
      });
    },
    sendMessage: async (_token, input) => {
      sent.push(input);
      return { messageId: 5_000 + sent.length };
    },
  };
  return {
    telegram,
    sent,
    offsets,
    calls,
    failures,
    files,
    push(...items) {
      queued.push(...items);
      wake?.();
      wake = undefined;
    },
  };
}
