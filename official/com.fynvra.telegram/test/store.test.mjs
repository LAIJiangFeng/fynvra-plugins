// 移植自 Fynvra 内置 telegram/store.test.ts：文件读写换成 api.storage / api.secrets。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTelegramStore, emptyTelegramData, MAX_CARDS, parseTelegramData } from '../dist/store.js';
import { fakeApi, TOKEN } from './helpers.mjs';

describe('telegram store', () => {
  it('非法字段与记录只丢弃自己', () => {
    const data = parseTelegramData({
      token: 'not-a-token',
      bot: { id: 'x' },
      candidates: [{ chatId: -1, title: 'ok', seenAt: 1 }, { chatId: 'bad' }],
      groups: [
        { chatId: -2, title: 'g', workspaceId: 'ws1', triageSessionId: 's1', active: true },
        { chatId: -3, title: 'bad', workspaceId: '../x', triageSessionId: 's2' },
      ],
      workspaces: { ws1: { cleanCheckoutPath: '/tmp/c', dutySessionId: 'd1' }, '../x': {}, ws2: 'x' },
      cards: [{ id: 1 }, 'junk'],
      pollOffset: -5,
    });
    assert.equal(data.token, undefined);
    assert.equal(data.bot, undefined);
    assert.deepEqual(data.candidates, [{ chatId: -1, title: 'ok', seenAt: 1 }]);
    assert.deepEqual(
      data.groups.map((g) => g.chatId),
      [-2]
    );
    assert.deepEqual(data.workspaces, { ws1: { dutySessionId: 'd1' } });
    assert.deepEqual(data.cards, []);
    assert.equal(data.pollOffset, 0);
    assert.equal(data.legacyMigrated, false);
  });

  it('rateLimitPerHour 缺失或非法时按 5，合法时保留', () => {
    for (const bad of [undefined, 0, 1001, 1.5, '10', null]) {
      assert.equal(parseTelegramData({ rateLimitPerHour: bad }).rateLimitPerHour, 5);
    }
    assert.equal(parseTelegramData({ rateLimitPerHour: 1 }).rateLimitPerHour, 1);
    assert.equal(parseTelegramData({ rateLimitPerHour: 1000 }).rateLimitPerHour, 1000);
  });

  it('卡片只保留最近 500 张', () => {
    const cards = Array.from({ length: MAX_CARDS + 3 }, (_, i) => ({
      id: i + 1,
      chatId: -1,
      workspaceId: 'ws1',
      status: 'answered',
      messageId: 1,
      createdAt: 1,
    }));
    const data = parseTelegramData({ cards });
    assert.equal(data.cards.length, MAX_CARDS);
    assert.equal(data.cards[0].id, 4);
  });

  it('写进 storage 后能读回；token 不写进 storage，从 secrets 读', async () => {
    const host = fakeApi({ secrets: { botToken: TOKEN } });
    const store = createTelegramStore(host.api);
    assert.deepEqual(await store.load(), { ...emptyTelegramData(), token: TOKEN });
    await store.save({ ...emptyTelegramData(), token: TOKEN, pollOffset: 12 });
    assert.ok(!JSON.stringify(host.state.storage).includes(TOKEN));
    const loaded = await store.load();
    assert.equal(loaded.token, TOKEN);
    assert.equal(loaded.pollOffset, 12);

    // storage 里混进来的 token 会被忽略；secrets 里格式不对的 token 也不用
    host.state.storage.token = `987654321:${'b'.repeat(35)}`;
    host.state.secrets.set('botToken', 'bad');
    assert.equal((await store.load()).token, undefined);
  });

  it('串行写，按调用顺序落盘', async () => {
    const host = fakeApi();
    const store = createTelegramStore(host.api);
    const data = emptyTelegramData();
    data.pollOffset = 1;
    const first = store.save(data);
    data.pollOffset = 2;
    await Promise.all([first, store.save(data)]);
    assert.deepEqual(
      host.state.writes.map((w) => w.pollOffset),
      [1, 2]
    );
  });
});
