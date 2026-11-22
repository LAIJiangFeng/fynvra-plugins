// 飞书接入层：用官方 @larksuiteoapi/node-sdk 的 WSClient 长连接收事件、Client 调接口（SDK 由入口注入，测试可换成假的）。
// App Secret 与 tenant_access_token 绝不进日志、错误与返回值：SDK 的日志经 sdkLogger 只取状态码和错误码再打码。
// shortcut: domain 固定为飞书 open.feishu.cn，国际版 Lark 暂不支持；有人要用 Lark 时加一个「域名」选项
import { Agent } from 'node:https';
import type { Readable } from 'node:stream';
import type { PluginProxyEnv } from './types/appPluginApi.js';
import { asRecord, errorMessage } from './util.js';

export const FEISHU_DOMAIN = 'https://open.feishu.cn';

export type FeishuErrorKind =
  | 'network'
  | 'unauthorized'
  | 'not-ready'
  | 'rate-limited'
  | 'too-large'
  | 'api';

export class FeishuApiError extends Error {
  readonly kind: FeishuErrorKind;
  constructor(kind: FeishuErrorKind, message: string) {
    super(message);
    this.name = 'FeishuApiError';
    this.kind = kind;
  }
}

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
}

/** App ID 的格式（同 SDK 长连接的检查，不合格式的 SDK 会静默不连） */
export const APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;
/** App Secret：字母数字，长度留宽 */
export const APP_SECRET_PATTERN = /^[A-Za-z0-9]{16,128}$/;
/** 飞书的各种 id（oc_ / om_ / ou_ / img_ / file_ 等）只接受这些字符，防止拼出别的路径 */
const FEISHU_ID = /^[A-Za-z0-9_-]{1,256}$/;
export const isFeishuId = (value: unknown): value is string =>
  typeof value === 'string' && FEISHU_ID.test(value);

/** 把文本里的密钥和 token 打码 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 6) out = out.split(secret).join('<secret>');
  // tenant / app access token（t- / a- 开头）与 Bearer 头
  return out
    .replace(/\b[ta]-[A-Za-z0-9._-]{20,}/g, '<token>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <token>');
}

export interface FeishuMention {
  key: string;
  openId?: string;
  name: string;
}

/** im.message.receive_v1 收窄后的形状 */
export interface FeishuMessageEvent {
  messageId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  parentId?: string;
  rootId?: string;
  /** 毫秒 */
  createTime: number;
  senderOpenId: string;
  /** user 才处理；机器人自己发的是 app */
  senderType: string;
  msgType: string;
  /** JSON 字符串，按 msgType 解析（见 message.ts） */
  content: string;
  mentions: FeishuMention[];
}

export interface FeishuEvents {
  onMessage(event: FeishuMessageEvent): void;
  /** 机器人进群；name 是群名（可能为空） */
  onBotAdded(chatId: string, name: string): void;
  onBotRemoved(chatId: string): void;
  /** 用户第一次打开和机器人的私聊 */
  onP2pEntered(chatId: string, openId: string): void;
}

export interface FeishuStatusCallbacks {
  onReady(): void;
  onReconnecting(): void;
  onReconnected(): void;
  /** 长连接放弃重连 */
  onError(error: FeishuApiError): void;
}

export interface FeishuEventConnection {
  close(): void;
}

export interface FeishuApi {
  botInfo(creds: FeishuCredentials): Promise<{ openId: string; name: string }>;
  /** 群名；拿不到（没开 im:chat:readonly 等）返回 null */
  chatName(creds: FeishuCredentials, chatId: string): Promise<string | null>;
  /** 引用回复一条消息（text）；返回机器人这条消息的 id */
  reply(creds: FeishuCredentials, messageId: string, text: string): Promise<{ messageId: string }>;
  /** 下载消息里的图片或文件；超过 maxBytes 中止并抛 too-large */
  download(
    creds: FeishuCredentials,
    input: { messageId: string; fileKey: string; type: 'image' | 'file'; maxBytes: number }
  ): Promise<{ data: Buffer; contentType: string }>;
  /** 建长连接收事件 */
  connect(
    creds: FeishuCredentials,
    events: FeishuEvents,
    status: FeishuStatusCallbacks
  ): Promise<FeishuEventConnection>;
}

/** 用到的 SDK 形状（只取需要的部分，测试用假的实现） */
interface HttpLike {
  request(opts: Record<string, unknown>): Promise<unknown>;
  get(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  delete(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  head(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  options(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  post(url: string, data?: unknown, opts?: Record<string, unknown>): Promise<unknown>;
  put(url: string, data?: unknown, opts?: Record<string, unknown>): Promise<unknown>;
  patch(url: string, data?: unknown, opts?: Record<string, unknown>): Promise<unknown>;
}
export interface FeishuSdk {
  Client: new (params: Record<string, unknown>) => {
    request(payload: Record<string, unknown>): Promise<unknown>;
  };
  WSClient: new (params: Record<string, unknown>) => {
    start(params: { eventDispatcher: unknown }): Promise<void>;
    close(params?: { force?: boolean }): void;
  };
  EventDispatcher: new (params: Record<string, unknown>) => {
    register(handles: Record<string, (data: unknown) => unknown>): unknown;
  };
  /** SDK 的 axios 实例；有它时请求经 Fynvra 的代理设置 */
  defaultHttpInstance?: HttpLike;
}

export interface FeishuApiOptions {
  sdk: FeishuSdk;
  /** Fynvra 当前的代理设置（api.net.proxyEnv） */
  proxyEnv: () => Promise<PluginProxyEnv>;
  log: (level: 'info' | 'warn', message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  nodeVersion?: string;
  processEnv?: Record<string, string | undefined>;
}

/** 飞书的限频错误码 */
const RATE_LIMIT_CODES = new Set([99991400, 11232, 230020]);
/** token 无效或过期 */
const TOKEN_CODES = new Set([99991661, 99991663, 99991664, 99991665, 99991668, 99991671, 10014, 10003]);
/** 限频重试的次数与等待上限 */
const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 10_000;
/** 请求超时（axios 默认不超时） */
const REQUEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** SDK 的日志级别：warn */
const SDK_LOGGER_LEVEL = 2;

/** 环境变量里有 NODE_TLS_REJECT_UNAUTHORIZED=0（不区分键的大小写） */
export function disablesNodeTlsVerification(env: Record<string, string | undefined>): boolean {
  return Object.entries(env).some(
    ([key, value]) => key.toUpperCase() === 'NODE_TLS_REJECT_UNAUTHORIZED' && value === '0'
  );
}

/** Node 24.5+ / 22.21+ 的 https.Agent 才支持 proxyEnv */
export function supportsProxyEnv(nodeVersion: string): boolean {
  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}

/** 只取错误里安全的部分：message、HTTP 状态、飞书错误码和说明；不碰 config / headers / 请求体 */
export function describeError(error: unknown): string {
  if (typeof error === 'string') return error;
  const record = asRecord(error);
  if (!record) return String(error);
  const parts: string[] = [];
  if (typeof record.message === 'string') parts.push(record.message);
  const response = asRecord(record.response);
  if (typeof response?.status === 'number') parts.push(`HTTP ${response.status}`);
  const body = asRecord(response?.data) ?? record;
  if (typeof body.code === 'number' && body.code !== 0) parts.push(`code ${body.code}`);
  if (typeof body.msg === 'string') parts.push(body.msg);
  if (typeof record.code === 'string') parts.push(record.code);
  return parts.length > 0 ? parts.join(' ') : '[object]';
}

export function createFeishuApi(options: FeishuApiOptions): FeishuApi {
  const { sdk } = options;
  const wait = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const processEnv = options.processEnv ?? process.env;
  const known = new Set<string>();
  const redact = (text: string) => redactSecrets(text, [...known]);
  const sdkLog = (level: 'info' | 'warn') => (...args: unknown[]) =>
    options.log(level, redact(`[飞书 SDK] ${args.map(describeError).join(' ')}`.slice(0, 500)));
  const logger = {
    error: sdkLog('warn'),
    warn: sdkLog('warn'),
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
  };

  // 代理：连接或建客户端时按 Fynvra 的代理设置换 agent。
  // shortcut: 改代理后要到下次重连或重新保存凭证才生效，有人反馈再改成每次请求现取
  let agent = new Agent({ rejectUnauthorized: true });
  let tlsDisabled = false;
  const refreshAgent = async () => {
    let env: Record<string, string | undefined> = {};
    try {
      env = (await options.proxyEnv()) as Record<string, string | undefined>;
    } catch (error) {
      options.log('warn', `读取代理设置失败，改为直连：${errorMessage(error)}`);
    }
    tlsDisabled = disablesNodeTlsVerification(env) || disablesNodeTlsVerification(processEnv);
    agent.destroy();
    // 不支持 proxyEnv 的 Node 上直连（飞书是国内服务）
    agent = supportsProxyEnv(nodeVersion)
      ? new Agent({ proxyEnv: { ...env }, rejectUnauthorized: true })
      : new Agent({ rejectUnauthorized: true });
  };
  const guardTls = () => {
    // TLS 校验被全局关掉时不发 App Secret
    if (tlsDisabled) {
      throw new FeishuApiError('network', 'NODE_TLS_REJECT_UNAUTHORIZED=0 关闭了 TLS 校验，已拒绝连接');
    }
  };
  const base = sdk.defaultHttpInstance;
  const withAgent = (opts?: Record<string, unknown>) => {
    guardTls();
    return { ...opts, httpsAgent: agent, proxy: false };
  };
  const httpInstance: HttpLike | undefined = base && {
    request: (o) => base.request(withAgent(o)),
    get: (u, o) => base.get(u, withAgent(o)),
    delete: (u, o) => base.delete(u, withAgent(o)),
    head: (u, o) => base.head(u, withAgent(o)),
    options: (u, o) => base.options(u, withAgent(o)),
    post: (u, d, o) => base.post(u, d, withAgent(o)),
    put: (u, d, o) => base.put(u, d, withAgent(o)),
    patch: (u, d, o) => base.patch(u, d, withAgent(o)),
  };
  const common = () => ({
    domain: FEISHU_DOMAIN,
    logger,
    loggerLevel: SDK_LOGGER_LEVEL,
    ...(httpInstance ? { httpInstance } : {}),
  });

  let cached: { key: string; client: InstanceType<FeishuSdk['Client']> } | undefined;
  const clientFor = async (creds: FeishuCredentials) => {
    known.add(creds.appSecret);
    const key = `${creds.appId}\n${creds.appSecret}`;
    if (cached?.key !== key) {
      await refreshAgent();
      cached = { key, client: new sdk.Client({ appId: creds.appId, appSecret: creds.appSecret, ...common() }) };
    }
    return cached.client;
  };

  /** 把 SDK / axios 抛出的错误归类；文本只含状态码、错误码与说明 */
  const classify = (label: string, error: unknown): FeishuApiError => {
    if (error instanceof FeishuApiError) return error;
    const record = asRecord(error);
    const response = asRecord(record?.response);
    const body = asRecord(response?.data);
    const status = typeof response?.status === 'number' ? response.status : undefined;
    const code = typeof body?.code === 'number' ? body.code : undefined;
    const text = redact(`${label}: ${describeError(error)}`);
    if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
      return new FeishuApiError('rate-limited', text);
    }
    if (status === 401 || (code !== undefined && TOKEN_CODES.has(code))) {
      return new FeishuApiError('unauthorized', text);
    }
    if (response) return new FeishuApiError('api', text);
    // SDK 取 tenant_access_token 失败（HTTP 200 但业务出错）：只带错误码和说明
    const token = /failed to get \w*access_token, code: (\S+), msg: (.*)$/.exec(errorMessage(error));
    if (token) {
      const kind = /publish|online|enable|install|disabled|未发布|停用/i.test(token[2] ?? '')
        ? 'not-ready'
        : 'unauthorized';
      return new FeishuApiError(kind, redact(`${label}: code ${token[1]} ${token[2]}`));
    }
    return new FeishuApiError('network', text);
  };

  const backoff = (attempt: number) => Math.min(1000 * 2 ** attempt, MAX_RETRY_WAIT_MS);

  /** 调接口：code 不为 0 时抛错；限频时退避重试，最多 MAX_RETRIES 次 */
  const call = async (
    creds: FeishuCredentials,
    label: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    for (let attempt = 0; ; attempt += 1) {
      let error: FeishuApiError;
      try {
        const body = asRecord(
          await (await clientFor(creds)).request({ timeout: REQUEST_TIMEOUT_MS, ...payload })
        );
        if (body?.code === 0) return body;
        const code = typeof body?.code === 'number' ? body.code : undefined;
        const msg = typeof body?.msg === 'string' ? body.msg : '';
        error = new FeishuApiError(
          code !== undefined && RATE_LIMIT_CODES.has(code)
            ? 'rate-limited'
            : code !== undefined && TOKEN_CODES.has(code)
              ? 'unauthorized'
              : 'api',
          redact(`${label}: code ${code ?? '?'} ${msg}`.trim())
        );
      } catch (thrown) {
        error = classify(label, thrown);
      }
      if (error.kind === 'rate-limited' && attempt < MAX_RETRIES) {
        await wait(backoff(attempt));
        continue;
      }
      throw error;
    }
  };

  return {
    async botInfo(creds) {
      let body: Record<string, unknown>;
      try {
        body = await call(creds, 'bot/info', { method: 'GET', url: 'open-apis/bot/v3/info' });
      } catch (error) {
        // 凭证对但机器人接口报错：多半是没开机器人能力或没发布
        if (error instanceof FeishuApiError && error.kind === 'api') {
          throw new FeishuApiError('not-ready', error.message);
        }
        throw error;
      }
      const bot = asRecord(body.bot);
      if (!isFeishuId(bot?.open_id)) throw new FeishuApiError('api', 'bot/info: unexpected response');
      // activate_status：2 为已启用；其他（待安装、停用、待上线等）都算还没发布
      if (typeof bot.activate_status === 'number' && bot.activate_status !== 2) {
        throw new FeishuApiError('not-ready', `bot/info: activate_status ${bot.activate_status}`);
      }
      return {
        openId: bot.open_id,
        name: typeof bot.app_name === 'string' ? bot.app_name.slice(0, 128) : '',
      };
    },
    async chatName(creds, chatId) {
      if (!isFeishuId(chatId)) return null;
      try {
        const body = await call(creds, 'chats/get', {
          method: 'GET',
          url: `open-apis/im/v1/chats/${chatId}`,
        });
        const name = asRecord(body.data)?.name;
        return typeof name === 'string' && name.trim() ? name.trim().slice(0, 256) : null;
      } catch (error) {
        options.log('warn', redact(`读取群名失败：${errorMessage(error)}`));
        return null;
      }
    },
    async reply(creds, messageId, text) {
      if (!isFeishuId(messageId)) throw new FeishuApiError('api', 'reply: bad message id');
      // 文本消息会解析 <at> 标签：换成全角，回复里不能 @ 人或 @所有人
      const safe = text.replace(/<(\s*\/?\s*at\b)/gi, '＜$1');
      const body = await call(creds, 'messages/reply', {
        method: 'POST',
        url: `open-apis/im/v1/messages/${messageId}/reply`,
        data: { msg_type: 'text', content: JSON.stringify({ text: safe }) },
      });
      const id = asRecord(body.data)?.message_id;
      if (!isFeishuId(id)) throw new FeishuApiError('api', 'reply: unexpected response');
      return { messageId: id };
    },
    async download(creds, { messageId, fileKey, type, maxBytes }) {
      if (!isFeishuId(messageId) || !isFeishuId(fileKey)) {
        throw new FeishuApiError('api', 'download: bad id');
      }
      let result: Record<string, unknown> | null;
      try {
        const client = await clientFor(creds);
        result = asRecord(
          await client.request({
            method: 'GET',
            url: `open-apis/im/v1/messages/${messageId}/resources/${fileKey}`,
            params: { type },
            timeout: DOWNLOAD_TIMEOUT_MS,
            responseType: 'stream',
            $return_headers: true,
          })
        );
      } catch (error) {
        throw classify('download', error);
      }
      const stream = result?.data as Readable | undefined;
      const headers = asRecord(result?.headers) ?? {};
      if (!stream || typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function') {
        throw new FeishuApiError('api', 'download: unexpected response');
      }
      // 声明的长度已超限：不读正文直接中止
      if (Number(headers['content-length'] ?? 0) > maxBytes) {
        stream.destroy?.();
        throw new FeishuApiError('too-large', 'download: too large');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of stream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          size += buf.length;
          if (size > maxBytes) {
            stream.destroy?.();
            throw new FeishuApiError('too-large', 'download: too large');
          }
          chunks.push(buf);
        }
      } catch (error) {
        if (error instanceof FeishuApiError) throw error;
        throw new FeishuApiError('network', redact(`download: ${describeError(error)}`));
      }
      const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'] : '';
      return { data: Buffer.concat(chunks), contentType };
    },
    async connect(creds, events, status) {
      known.add(creds.appSecret);
      await refreshAgent();
      guardTls();
      cached = undefined;
      // 事件处理只做收窄和分派，不能抛错（会被 SDK 当成处理失败）
      const guarded = (name: string, fn: (data: unknown) => void) => (data: unknown) => {
        try {
          fn(data);
        } catch (error) {
          options.log('warn', redact(`处理事件 ${name} 失败：${errorMessage(error)}`));
        }
      };
      const dispatcher = new sdk.EventDispatcher({ logger, loggerLevel: SDK_LOGGER_LEVEL }).register({
        'im.message.receive_v1': guarded('im.message.receive_v1', (data) => {
          const event = parseMessageEvent(data);
          if (event) events.onMessage(event);
        }),
        'im.chat.member.bot.added_v1': guarded('bot.added', (data) => {
          const r = asRecord(data);
          if (isFeishuId(r?.chat_id)) {
            events.onBotAdded(r.chat_id, typeof r.name === 'string' ? r.name.slice(0, 256) : '');
          }
        }),
        'im.chat.member.bot.deleted_v1': guarded('bot.deleted', (data) => {
          const r = asRecord(data);
          if (isFeishuId(r?.chat_id)) events.onBotRemoved(r.chat_id);
        }),
        'im.chat.access_event.bot_p2p_chat_entered_v1': guarded('p2p.entered', (data) => {
          const r = asRecord(data);
          const openId = asRecord(r?.operator_id)?.open_id;
          if (isFeishuId(r?.chat_id) && isFeishuId(openId)) events.onP2pEntered(r.chat_id, openId);
        }),
      });
      const ws = new sdk.WSClient({
        appId: creds.appId,
        appSecret: creds.appSecret,
        ...common(),
        agent,
        autoReconnect: true,
        onReady: () => status.onReady(),
        onReconnecting: () => status.onReconnecting(),
        onReconnected: () => status.onReconnected(),
        onError: (error: unknown) => status.onError(classify('ws', error)),
      });
      try {
        await ws.start({ eventDispatcher: dispatcher });
      } catch (error) {
        ws.close({ force: true });
        throw classify('ws', error);
      }
      return { close: () => ws.close({ force: true }) };
    },
  };
}

/** im.message.receive_v1 的事件体按 unknown 收窄；不合法返回 null */
export function parseMessageEvent(raw: unknown): FeishuMessageEvent | null {
  const r = asRecord(raw);
  const message = asRecord(r?.message);
  const sender = asRecord(r?.sender);
  const senderOpenId = asRecord(sender?.sender_id)?.open_id;
  if (!message || !isFeishuId(message.message_id) || !isFeishuId(message.chat_id)) return null;
  if (message.chat_type !== 'group' && message.chat_type !== 'p2p') return null;
  if (!isFeishuId(senderOpenId)) return null;
  const createTime = Number(message.create_time);
  const mentions: FeishuMention[] = (Array.isArray(message.mentions) ? message.mentions : []).flatMap(
    (item: unknown) => {
      const m = asRecord(item);
      if (typeof m?.key !== 'string' || m.key.length > 64) return [];
      const openId = asRecord(m.id)?.open_id;
      return [
        {
          key: m.key,
          ...(isFeishuId(openId) ? { openId } : {}),
          name: typeof m.name === 'string' ? m.name.slice(0, 64) : '',
        },
      ];
    }
  );
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type,
    ...(isFeishuId(message.parent_id) ? { parentId: message.parent_id } : {}),
    ...(isFeishuId(message.root_id) ? { rootId: message.root_id } : {}),
    createTime: Number.isFinite(createTime) && createTime > 0 ? createTime : Date.now(),
    senderOpenId,
    senderType: typeof sender?.sender_type === 'string' ? sender.sender_type : '',
    msgType: typeof message.message_type === 'string' ? message.message_type : '',
    content: typeof message.content === 'string' ? message.content : '',
    mentions,
  };
}
