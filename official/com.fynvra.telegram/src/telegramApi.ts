// Telegram Bot API 客户端（移植自 Fynvra 内置 telegram/api.ts）：HTTP 可注入；token 与带 token 的 URL 绝不进日志、错误与返回值。
import { Agent, request } from 'node:https';
import type { PluginProxyEnv } from './types/appPluginApi.js';
import { asRecord, errorMessage } from './util.js';

export type TelegramErrorKind = 'network' | 'unauthorized' | 'conflict' | 'api';

/** Bot token 的格式（同 Fynvra secrets 的检测规则） */
export const TELEGRAM_TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{35}$/;
const TOKEN_ANYWHERE = /\d{6,12}:[A-Za-z0-9_-]{35}/g;

/** 把文本里的 token 打码（含已知 token 与任何像 token 的串）。 */
export function redactToken(text: string, token?: string): string {
  let out = token ? text.split(token).join('<token>') : text;
  out = out.replace(TOKEN_ANYWHERE, '<token>');
  return out;
}

export class TelegramApiError extends Error {
  readonly kind: TelegramErrorKind;
  readonly retryAfterSec?: number;
  constructor(kind: TelegramErrorKind, message: string, retryAfterSec?: number) {
    super(message);
    this.name = 'TelegramApiError';
    this.kind = kind;
    if (retryAfterSec !== undefined) this.retryAfterSec = retryAfterSec;
  }
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

/** POST JSON；网络失败时 reject。实现方不要把 url 写进错误（调用方仍会打码）。 */
export type HttpPost = (
  url: string,
  body: unknown,
  options: { signal?: AbortSignal; timeoutMs: number }
) => Promise<HttpResponse>;

/** GET 二进制（下载文件）；超过 maxBytes 立即中止并 reject。实现方不要把 url 写进错误。 */
export type HttpGet = (
  url: string,
  options: { signal?: AbortSignal; timeoutMs: number; maxBytes: number }
) => Promise<{ status: number; body: Buffer }>;

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  /** 外部数据，使用前逐项收窄（见 parseBotMention） */
  entities?: { type: string; offset: number; length: number }[];
  /** 图片、文件等消息的配文与其中的 entities（外部数据，同上收窄） */
  caption?: string;
  caption_entities?: { type: string; offset: number; length: number }[];
  /** 附件（外部数据，使用前逐项收窄，见 attachments.ts） */
  photo?: unknown[];
  document?: { file_id?: string; file_size?: number; mime_type?: string; file_name?: string };
  video?: unknown;
  animation?: unknown;
  sticker?: unknown;
  voice?: unknown;
  video_note?: unknown;
  audio?: unknown;
  /** 相册：同一组的图片各是一条消息，配文只在其中一条 */
  media_group_id?: string;
  reply_to_message?: { message_id: number; from?: TgUser };
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
}

export interface TgChatMemberUpdated {
  chat: TgChat;
  new_chat_member: { status: string; user: TgUser };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  my_chat_member?: TgChatMemberUpdated;
}

export interface TelegramApi {
  getMe(token: string, signal?: AbortSignal): Promise<{ id: number; username: string; canReadAll?: boolean }>;
  getUpdates(token: string, offset: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(
    token: string,
    input: { chatId: number; text: string; replyTo?: number },
    signal?: AbortSignal
  ): Promise<{ messageId: number }>;
  setMyCommands(token: string, signal?: AbortSignal): Promise<void>;
  getFile(
    token: string,
    fileId: string,
    signal?: AbortSignal
  ): Promise<{ file_path: string; file_size?: number }>;
  /** 下载 getFile 给出的 file_path；超过 maxBytes 中止 */
  downloadFile(
    token: string,
    filePath: string,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<Buffer>;
}

const API_BASE = 'https://api.telegram.org';
export const LONG_POLL_TIMEOUT_SEC = 30;
const REQUEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** file_path 只接受这些字符，且不许有空段、`.`、`..`，防止拼出别的 URL */
const FILE_PATH = /^[A-Za-z0-9_.\-/]{1,256}$/;
export function isSafeFilePath(path: string): boolean {
  return FILE_PATH.test(path) && path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}
/** 429 最多等这么久再重试；更长的直接报错 */
const MAX_RETRY_AFTER_SEC = 60;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TelegramApiError('network', 'aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TelegramApiError('network', 'aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface TelegramApiOptions {
  http: HttpPost;
  /** 下载文件用；缺省时 downloadFile 报错 */
  download?: HttpGet;
  /** 测试注入，缺省真实等待 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function createTelegramApi(options: TelegramApiOptions): TelegramApi {
  const http = options.http;
  const wait = options.sleep ?? sleep;

  async function call(
    token: string,
    method: string,
    body: unknown,
    signal: AbortSignal | undefined,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      let response: HttpResponse;
      try {
        response = await http(`${API_BASE}/bot${token}/${method}`, body, {
          ...(signal ? { signal } : {}),
          timeoutMs,
        });
      } catch (error) {
        throw new TelegramApiError(
          'network',
          redactToken(`${method}: ${errorMessage(error)}`, token)
        );
      }
      const record = asRecord(response.body);
      if (response.status === 200 && record?.ok === true) return record.result;
      const description = typeof record?.description === 'string' ? record.description : '';
      const text = redactToken(
        `${method}: HTTP ${response.status}${description ? ` ${description}` : ''}`,
        token
      );
      if (response.status === 401) throw new TelegramApiError('unauthorized', text);
      if (response.status === 409) throw new TelegramApiError('conflict', text);
      if (response.status === 429) {
        const retryAfter = asRecord(record?.parameters)?.retry_after;
        const seconds = typeof retryAfter === 'number' && retryAfter >= 0 ? retryAfter : 1;
        if (attempt === 0 && seconds <= MAX_RETRY_AFTER_SEC) {
          await wait(seconds * 1000, signal);
          continue;
        }
        throw new TelegramApiError('api', text, seconds);
      }
      throw new TelegramApiError('api', text);
    }
  }

  return {
    async getMe(token, signal) {
      const user = asRecord(await call(token, 'getMe', {}, signal));
      if (typeof user?.id !== 'number' || typeof user.username !== 'string') {
        throw new TelegramApiError('api', 'getMe: unexpected response');
      }
      // can_read_all_group_messages 为 true 表示隐私模式已关闭
      return {
        id: user.id,
        username: user.username,
        canReadAll: user.can_read_all_group_messages === true,
      };
    },
    async getUpdates(token, offset, signal) {
      const result = await call(
        token,
        'getUpdates',
        {
          offset,
          timeout: LONG_POLL_TIMEOUT_SEC,
          allowed_updates: ['message', 'my_chat_member'],
        },
        signal,
        (LONG_POLL_TIMEOUT_SEC + 15) * 1000
      );
      if (!Array.isArray(result))
        throw new TelegramApiError('api', 'getUpdates: unexpected response');
      return result.filter(
        (item): item is TgUpdate => typeof asRecord(item)?.update_id === 'number'
      );
    },
    async sendMessage(token, input, signal) {
      const result = asRecord(
        await call(
          token,
          'sendMessage',
          {
            chat_id: input.chatId,
            text: input.text,
            link_preview_options: { is_disabled: true },
            ...(input.replyTo === undefined
              ? {}
              : {
                  reply_parameters: {
                    message_id: input.replyTo,
                    allow_sending_without_reply: true,
                  },
                }),
          },
          signal
        )
      );
      if (typeof result?.message_id !== 'number') {
        throw new TelegramApiError('api', 'sendMessage: unexpected response');
      }
      return { messageId: result.message_id };
    },
    async getFile(token, fileId, signal) {
      const file = asRecord(await call(token, 'getFile', { file_id: fileId }, signal));
      if (typeof file?.file_path !== 'string') {
        throw new TelegramApiError('api', 'getFile: unexpected response');
      }
      return {
        file_path: file.file_path,
        ...(typeof file.file_size === 'number' ? { file_size: file.file_size } : {}),
      };
    },
    async downloadFile(token, filePath, maxBytes, signal) {
      if (!isSafeFilePath(filePath)) throw new TelegramApiError('api', 'downloadFile: unsafe file_path');
      const download = options.download;
      if (!download) throw new TelegramApiError('network', 'downloadFile: no downloader');
      let response: { status: number; body: Buffer };
      try {
        response = await download(`${API_BASE}/file/bot${token}/${filePath}`, {
          ...(signal ? { signal } : {}),
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          maxBytes,
        });
      } catch (error) {
        throw new TelegramApiError('network', redactToken(`downloadFile: ${errorMessage(error)}`, token));
      }
      if (response.status !== 200) {
        throw new TelegramApiError('api', `downloadFile: HTTP ${response.status}`);
      }
      return response.body;
    },
    async setMyCommands(token, signal) {
      await call(
        token,
        'setMyCommands',
        {
          commands: [{ command: 'bug', description: '反馈 bug 或需求' }],
          scope: { type: 'all_group_chats' },
        },
        signal
      );
    },
  };
}

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

type HttpsSend = (
  url: string,
  options: {
    method: 'GET' | 'POST';
    payload?: string;
    signal?: AbortSignal;
    timeoutMs: number;
    maxBytes: number;
  }
) => Promise<{ status: number; body: Buffer }>;

/**
 * 生产用：每次请求现取 Fynvra 的代理设置（api.net.proxyEnv），交给 https.Agent 的 proxyEnv；错误文本不含 url。
 * 守卫同内置版：TLS 校验被关掉时不发 token；配了代理但 Node 不支持 proxyEnv 时拒绝，不悄悄直连。
 */
function createHttpsSend(
  proxyEnv: () => Promise<PluginProxyEnv>,
  nodeVersion: string,
  processEnv: Record<string, string | undefined>
): HttpsSend {
  return (url, { method, payload, signal, timeoutMs, maxBytes }) =>
    proxyEnv().then(
      (current) =>
        new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
          const env = current as Record<string, string | undefined>;
          // 代理握手不继承请求的 rejectUnauthorized：TLS 校验被全局关掉时不发 token
          if (disablesNodeTlsVerification(env) || disablesNodeTlsVerification(processEnv)) {
            reject(
              new TelegramApiError(
                'network',
                'NODE_TLS_REJECT_UNAUTHORIZED=0 关闭了 TLS 校验，已拒绝连接'
              )
            );
            return;
          }
          const proxy = { ...env };
          if (!supportsProxyEnv(nodeVersion) && proxy.HTTPS_PROXY) {
            reject(
              new TelegramApiError(
                'network',
                `当前 Node ${nodeVersion} 不支持 proxyEnv，配置的代理无法生效，已拒绝直连`
              )
            );
            return;
          }
          const agent = new Agent({ proxyEnv: proxy, rejectUnauthorized: true });
          let settled = false;
          const done = (error?: Error, response?: { status: number; body: Buffer }) => {
            if (settled) return;
            settled = true;
            agent.destroy();
            if (error) reject(error);
            else if (response) resolve(response);
          };
          try {
            const req = request(
              url,
              {
                method,
                agent,
                ...(signal ? { signal } : {}),
                timeout: timeoutMs,
                rejectUnauthorized: true,
                ...(payload === undefined
                  ? {}
                  : {
                      headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                      },
                    }),
              },
              (res) => {
                const tooLarge = () => {
                  res.destroy();
                  req.destroy();
                  done(new Error('response too large'));
                };
                // 声明的长度已超限：不读正文直接中止
                if (Number(res.headers['content-length'] ?? 0) > maxBytes) return tooLarge();
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (chunk: Buffer) => {
                  size += chunk.length;
                  if (size > maxBytes) return tooLarge();
                  chunks.push(chunk);
                });
                res.on('end', () =>
                  done(undefined, { status: res.statusCode ?? 0, body: Buffer.concat(chunks) })
                );
                res.on('error', () => done(new Error('response error')));
              }
            );
            req.on('timeout', () => req.destroy(new Error('request timed out')));
            // 只取错误码，Node 的错误文本可能带主机与路径
            req.on('error', (error: NodeJS.ErrnoException) =>
              done(new Error(error.code ?? (signal?.aborted ? 'aborted' : 'request failed')))
            );
            req.end(payload);
          } catch (error) {
            done(new Error((error as NodeJS.ErrnoException).code ?? 'request failed'));
          }
        })
    );
}

export function createHttpsPost(
  proxyEnv: () => Promise<PluginProxyEnv>,
  nodeVersion: string = process.versions.node,
  processEnv: Record<string, string | undefined> = process.env
): HttpPost {
  const send = createHttpsSend(proxyEnv, nodeVersion, processEnv);
  return async (url, body, { signal, timeoutMs }) => {
    const response = await send(url, {
      method: 'POST',
      payload: JSON.stringify(body),
      ...(signal ? { signal } : {}),
      timeoutMs,
      maxBytes: 8 * 1024 * 1024,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body.toString('utf8'));
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed };
  };
}

/** 下载用的 GET：与 createHttpsPost 同一套代理与 TLS 守卫 */
export function createHttpsGet(
  proxyEnv: () => Promise<PluginProxyEnv>,
  nodeVersion: string = process.versions.node,
  processEnv: Record<string, string | undefined> = process.env
): HttpGet {
  const send = createHttpsSend(proxyEnv, nodeVersion, processEnv);
  return (url, options) => send(url, { method: 'GET', ...options });
}
