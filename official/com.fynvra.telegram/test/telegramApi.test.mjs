// 移植自 Fynvra 内置 telegram/api.test.ts。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createHttpsGet,
  createHttpsPost,
  createTelegramApi,
  redactToken,
  supportsProxyEnv,
  TelegramApiError,
} from '../dist/telegramApi.js';
import { TOKEN } from './helpers.mjs';

function fakeHttp(responses) {
  const calls = [];
  const http = async (url, body) => {
    calls.push({ url, body });
    const next = responses.shift();
    if (!next) throw new Error(`connect ECONNREFUSED ${url}`);
    return next;
  };
  return { http, calls };
}

async function caught(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('createHttpsPost 守卫', () => {
  const send = (proxy, version, env = {}) =>
    caught(createTelegramApi({ http: createHttpsPost(async () => proxy, version, env) }).getMe(TOKEN));

  it('TLS 校验被关闭时拒绝请求且错误不含 token', async () => {
    for (const [proxy, env] of [
      [{}, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }],
      [{}, { node_tls_reject_unauthorized: '0' }],
      [{ NODE_TLS_REJECT_UNAUTHORIZED: '0' }, {}],
    ]) {
      const error = await send(proxy, '24.5.0', env);
      assert.equal(error.kind, 'network');
      assert.match(error.message, /NODE_TLS_REJECT_UNAUTHORIZED/);
      assert.ok(!error.message.includes(TOKEN));
    }
  });

  it('配了代理但不支持 proxyEnv 时拒绝请求且错误不含 token', async () => {
    const error = await send({ HTTPS_PROXY: 'http://127.0.0.1:9' }, '22.20.0');
    assert.equal(error.kind, 'network');
    assert.match(error.message, /proxyEnv/);
    assert.ok(!error.message.includes(TOKEN));
  });

  it('proxyEnv 支持的 Node 版本', () => {
    assert.equal(supportsProxyEnv('24.5.0'), true);
    assert.equal(supportsProxyEnv('25.0.0'), true);
    assert.equal(supportsProxyEnv('22.21.0'), true);
    assert.equal(supportsProxyEnv('24.4.9'), false);
    assert.equal(supportsProxyEnv('23.11.1'), false);
    assert.equal(supportsProxyEnv('22.20.0'), false);
  });
});

describe('telegram api', () => {
  it('getMe 解析 can_read_all_group_messages；缺省或非 true 时按隐私模式开启', async () => {
    const user = { id: 42, is_bot: true, username: 'fyn_bot' };
    const { http } = fakeHttp([
      { status: 200, body: { ok: true, result: { ...user, can_read_all_group_messages: true } } },
      { status: 200, body: { ok: true, result: { ...user, can_read_all_group_messages: false } } },
      { status: 200, body: { ok: true, result: { ...user, can_read_all_group_messages: 'yes' } } },
      { status: 200, body: { ok: true, result: user } },
    ]);
    const api = createTelegramApi({ http });
    assert.deepEqual(await api.getMe(TOKEN), { id: 42, username: 'fyn_bot', canReadAll: true });
    for (let i = 0; i < 3; i += 1) assert.equal((await api.getMe(TOKEN)).canReadAll, false);
  });

  it('getUpdates 用长轮询并只收 message 与 my_chat_member', async () => {
    const { http, calls } = fakeHttp([{ status: 200, body: { ok: true, result: [{ update_id: 5 }] } }]);
    const api = createTelegramApi({ http });
    assert.deepEqual(await api.getUpdates(TOKEN, 3), [{ update_id: 5 }]);
    assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/getUpdates`);
    assert.deepEqual(calls[0].body, {
      offset: 3,
      timeout: 30,
      allowed_updates: ['message', 'my_chat_member'],
    });
  });

  it('sendMessage 纯文本、回复原消息、关闭链接预览', async () => {
    const { http, calls } = fakeHttp([{ status: 200, body: { ok: true, result: { message_id: 9 } } }]);
    const api = createTelegramApi({ http });
    assert.deepEqual(await api.sendMessage(TOKEN, { chatId: -1, text: 'hi', replyTo: 7 }), {
      messageId: 9,
    });
    const body = calls[0].body;
    assert.equal(body.parse_mode, undefined);
    assert.equal(body.reply_parameters.message_id, 7);
    assert.deepEqual(body.link_preview_options, { is_disabled: true });
  });

  it('setMyCommands 只注册 /bug，作用域为群聊', async () => {
    const { http, calls } = fakeHttp([{ status: 200, body: { ok: true, result: true } }]);
    await createTelegramApi({ http }).setMyCommands(TOKEN);
    assert.deepEqual(
      calls[0].body.commands.map((c) => c.command),
      ['bug']
    );
    assert.deepEqual(calls[0].body.scope, { type: 'all_group_chats' });
  });

  it('429 按 retry_after 等待后重试一次', async () => {
    const waits = [];
    const sleep = async (ms, signal) => {
      waits.push([ms, signal]);
    };
    const { http, calls } = fakeHttp([
      { status: 429, body: { ok: false, parameters: { retry_after: 2 } } },
      { status: 200, body: { ok: true, result: [] } },
    ]);
    await createTelegramApi({ http, sleep }).getUpdates(TOKEN, 0);
    assert.deepEqual(waits, [[2000, undefined]]);
    assert.equal(calls.length, 2);

    const twice = fakeHttp([
      { status: 429, body: { ok: false, parameters: { retry_after: 1 } } },
      { status: 429, body: { ok: false, parameters: { retry_after: 1 } } },
    ]);
    const error = await caught(createTelegramApi({ http: twice.http, sleep }).getUpdates(TOKEN, 0));
    assert.equal(error.kind, 'api');
    assert.equal(twice.calls.length, 2);
  });

  it('401 / 409 / 网络错误分类，错误文本不含 token', async () => {
    const cases = [
      [{ status: 401, body: { ok: false, description: `Unauthorized ${TOKEN}` } }, 'unauthorized'],
      [{ status: 409, body: { ok: false, description: 'Conflict: terminated by other getUpdates' } }, 'conflict'],
      [{ status: 400, body: { ok: false, description: 'Bad Request' } }, 'api'],
    ];
    for (const [response, kind] of cases) {
      const { http } = fakeHttp([response]);
      const error = await caught(createTelegramApi({ http }).getUpdates(TOKEN, 0));
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.kind, kind);
      assert.ok(!error.message.includes(TOKEN));
    }
    // 网络错误的文本里带了完整 URL（含 token）
    const { http } = fakeHttp([]);
    const error = await caught(createTelegramApi({ http }).getMe(TOKEN));
    assert.equal(error.kind, 'network');
    assert.ok(!error.message.includes(TOKEN));
    assert.match(error.message, /<token>/);
  });

  it('getFile 与 downloadFile：URL 带 token，错误不带；file_path 只接受安全字符', async () => {
    const { http, calls } = fakeHttp([
      { status: 200, body: { ok: true, result: { file_id: 'x', file_path: 'photos/f_1.jpg', file_size: 9 } } },
    ]);
    const downloads = [];
    const download = async (url, options) => {
      downloads.push({ url, options });
      if (downloads.length === 2) throw new Error(`connect ECONNREFUSED ${url}`);
      if (downloads.length === 3) return { status: 404, body: Buffer.alloc(0) };
      return { status: 200, body: Buffer.from('jpeg') };
    };
    const api = createTelegramApi({ http, download });
    assert.deepEqual(await api.getFile(TOKEN, 'x'), { file_path: 'photos/f_1.jpg', file_size: 9 });
    assert.deepEqual(calls[0].body, { file_id: 'x' });
    assert.equal((await api.downloadFile(TOKEN, 'photos/f_1.jpg', 100)).toString(), 'jpeg');
    assert.equal(downloads[0].url, `https://api.telegram.org/file/bot${TOKEN}/photos/f_1.jpg`);
    assert.equal(downloads[0].options.maxBytes, 100);
    for (const kind of ['network', 'api']) {
      const error = await caught(api.downloadFile(TOKEN, 'photos/f_1.jpg', 100));
      assert.equal(error.kind, kind);
      assert.ok(!error.message.includes(TOKEN));
    }
    for (const bad of ['../x', 'a//b', '/abs', 'a?b=1', 'a#b', 'x/../../y', 'a b', '@evil.com/x']) {
      const error = await caught(api.downloadFile(TOKEN, bad, 100));
      assert.match(error.message, /unsafe file_path/);
    }
    assert.equal(downloads.length, 3);
  });

  it('createHttpsGet 同样有 TLS 守卫，错误不含 token', async () => {
    const api = createTelegramApi({
      http: fakeHttp([]).http,
      download: createHttpsGet(async () => ({}), '24.5.0', { NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
    });
    const error = await caught(api.downloadFile(TOKEN, 'photos/a.jpg', 100));
    assert.match(error.message, /NODE_TLS_REJECT_UNAUTHORIZED/);
    assert.ok(!error.message.includes(TOKEN));
  });

  it('redactToken 打码已知 token 与任何像 token 的串', () => {
    assert.equal(redactToken(`a ${TOKEN} b`, TOKEN), 'a <token> b');
    assert.equal(redactToken(`x 987654321:${'b'.repeat(35)}`), 'x <token>');
  });
});
