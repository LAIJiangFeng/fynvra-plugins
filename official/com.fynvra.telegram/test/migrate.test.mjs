// 旧数据迁移：顺序、token 去向、失败时继续运行。
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createTelegramService } from '../dist/service.js';
import { fakeApi, fakeTelegram, tick, TOKEN, waitFor } from './helpers.mjs';

const services = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
});

const LEGACY = {
  enabled: true,
  token: TOKEN,
  bot: { id: 42, username: 'fyn_bot' },
  candidates: [{ chatId: -300, title: '候选', seenAt: 1 }],
  groups: [{ chatId: -100, title: 'Alpha 群', workspaceId: 'ws1', triageSessionId: 'old1', active: true }],
  workspaces: { ws1: { cleanCheckoutPath: 'C:\\Users\\alice\\wt', dutySessionId: 'oldDuty' } },
  cards: [
    {
      id: 3,
      chatId: -100,
      workspaceId: 'ws1',
      status: 'pending-approval',
      title: '暗色模式',
      summary: 's',
      content: 'c',
      messageId: 9,
      createdAt: 1,
    },
  ],
  pollOffset: 55,
  rateLimitPerHour: 7,
};

function start(options) {
  const host = fakeApi({ sessions: {}, ...options });
  const tg = fakeTelegram();
  // getMe 记进同一个调用序列，用来核对「迁移完才开始轮询」
  const getMe = tg.telegram.getMe;
  tg.telegram.getMe = async (...args) => {
    host.state.calls.push({ method: 'telegram.getMe' });
    return getMe(...args);
  };
  const service = createTelegramService({
    api: host.api,
    telegram: tg.telegram,
    sleep: async () => undefined,
    debounceMs: 0,
  });
  services.push(service);
  return { host, tg, service, state: host.state };
}

const order = (state) => state.calls.map((c) => c.method);

describe('旧数据迁移', () => {
  it('先读 storage，再导入旧数据：token 进 secrets、不进 storage，标记已迁移后才开始轮询', async () => {
    const { service, state, tg } = start({ legacy: LEGACY });
    await service.start();
    await waitFor(() => assert.ok(tg.offsets.length > 0));
    const calls = order(state);
    const at = (method) => calls.indexOf(method);
    assert.equal(at('storage.read'), 0);
    assert.ok(at('legacy.telegramData') > at('storage.read'));
    assert.ok(at('secrets.set') > at('legacy.telegramData'));
    assert.ok(at('storage.write') > at('secrets.set'));
    assert.ok(at('legacy.telegramMigrated') > at('storage.write'));
    assert.ok(at('telegram.getMe') > at('legacy.telegramMigrated'));

    assert.equal(state.secrets.get('botToken'), TOKEN);
    for (const write of state.writes) assert.ok(!JSON.stringify(write).includes(TOKEN));
    const stored = state.writes[0];
    assert.equal(stored.legacyMigrated, true);
    assert.equal(stored.pollOffset, 55);
    assert.equal(stored.rateLimitPerHour, 7);
    assert.equal('enabled' in stored, false);
    // 插件拿不到路径：cleanCheckoutPath 不保存
    assert.deepEqual(stored.workspaces, { ws1: { dutySessionId: 'oldDuty' } });
    assert.equal(tg.offsets[0], 55);

    const view = service.getState();
    assert.equal(view.tokenMasked, '123456789:AA…AA');
    assert.deepEqual(view.groups.map((g) => g.chatId), [-100]);
    assert.deepEqual(view.candidates.map((c) => c.chatId), [-300]);
    assert.equal(view.cards[0].status, 'pending-approval');
    assert.equal(state.legacyMigratedCalls, 1);
  });

  it('已经迁移过就不再读旧数据', async () => {
    const { service, state } = start({ storage: { legacyMigrated: true }, legacy: LEGACY });
    await service.start();
    assert.equal(order(state).includes('legacy.telegramData'), false);
    assert.equal(state.legacyMigratedCalls, 0);
    assert.equal(service.getState().connection, 'no-token');
  });

  it('没有旧数据：记为已迁移并通知宿主', async () => {
    const { service, state } = start({});
    await service.start();
    assert.equal(state.storage.legacyMigrated, true);
    assert.equal(state.legacyMigratedCalls, 1);
  });

  it('读取旧数据失败：只记日志，按空数据继续，下次启动再试', async () => {
    const { service, state } = start({ legacy: new Error('legacy unavailable') });
    await service.start();
    assert.ok(state.logs.some((l) => l.level === 'warn' && l.message.includes('legacy unavailable')));
    assert.equal(state.legacyMigratedCalls, 0);
    assert.notEqual(state.storage?.legacyMigrated, true);
    assert.equal(service.getState().connection, 'no-token');
    assert.deepEqual(await service.setRateLimit(9), { ok: true });
  });

  it('token 写不进 secrets：不写 storage、不标记迁移，按空数据继续', async () => {
    const { service, state, tg } = start({ legacy: LEGACY, failSecrets: true });
    await service.start();
    await tick(20);
    assert.equal(state.writes.length, 0);
    assert.equal(state.legacyMigratedCalls, 0);
    assert.equal(tg.calls.getMe, 0);
    assert.deepEqual(service.getState().groups, []);
    assert.ok(state.logs.some((l) => l.message.includes('迁移内置 Telegram 数据失败')));
  });

  it('宿主没有 legacy API 时同样继续运行', async () => {
    const { service, host, state } = start({});
    delete host.api.legacy;
    await service.start();
    assert.equal(service.getState().connection, 'no-token');
    assert.ok(state.logs.some((l) => l.message.includes('迁移内置 Telegram 数据失败')));
  });
});
