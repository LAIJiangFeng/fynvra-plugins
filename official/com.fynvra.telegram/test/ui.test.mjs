// 设置页：生成的 UI 描述要能通过照抄来的校验（parsePluginUi），每个 ui.action 都有处理。
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as entry from '../dist/index.js';
import { MAX_UI_BYTES, MAX_UI_DEPTH, parsePluginUi } from '../dist/types/appPluginUi.js';
import { ACTIONS, buildSettingsUi, handleUiAction } from '../dist/ui.js';
import { fakeApi, fakeTelegram, TOKEN, waitFor } from './helpers.mjs';

const running = [];
afterEach(async () => {
  for (const plugin of running.splice(0)) await plugin.stop();
});

const WORKSPACES = [
  { id: 'ws1', name: 'repo', git: true },
  { id: 'ws2', name: 'notes', git: false },
];

function card(id, extra = {}) {
  return {
    id,
    chatId: -100,
    groupTitle: 'Alpha 群',
    workspaceId: 'ws1',
    kind: 'bug',
    status: 'fixing',
    title: `卡片标题 ${id} `.repeat(10),
    summary: 's'.repeat(4000),
    followUps: 1,
    taskIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function richState(cardCount = 3) {
  return {
    connection: 'network-error',
    tokenMasked: '123456789:AA…AA',
    bot: { id: 42, username: 'fyn_bot' },
    candidates: [{ chatId: -300, title: '候选'.repeat(200), seenAt: 1 }],
    groups: [
      { chatId: -100, title: 'Alpha 群', workspaceId: 'ws1', triageSessionId: 's', active: true },
      { chatId: -200, title: 'Beta 群', workspaceId: 'gone', triageSessionId: 's2', active: false },
    ],
    cards: [
      card(1, {
        kind: 'feature',
        status: 'pending-approval',
        assessment: 'a'.repeat(5000),
        assessmentIncomplete: true,
      }),
      card(2, { status: 'pr-opened', prUrl: 'https://github.com/o/r/pull/9' }),
      card(3, { status: 'pr-opened', prUrl: 'http://evil.example/pull/1' }),
      ...Array.from({ length: Math.max(0, cardCount - 3) }, (_, i) => card(i + 4)),
    ],
    rateLimitPerHour: 5,
  };
}

/** 求 UI 描述的最大嵌套层数（同 parsePluginUi 的计法：列表项控件比列表深一层） */
function depth(nodes, level = 1) {
  let max = 0;
  for (const node of nodes) {
    let d = level;
    if (node.type === 'section') d = Math.max(d, depth(node.children, level + 1));
    if (node.type === 'list' && node.items.some((item) => item.controls)) d = level + 1;
    max = Math.max(max, d);
  }
  return max;
}

const walk = (nodes, out = []) => {
  for (const node of nodes) {
    out.push(node);
    if (node.type === 'section') walk(node.children, out);
  }
  return out;
};

describe('设置页 UI 描述', () => {
  it('能通过 parsePluginUi：大小、深度、id 格式、只放 https 链接', () => {
    const ui = buildSettingsUi(richState(), WORKSPACES);
    const parsed = parsePluginUi(ui);
    assert.ok(parsed, 'parsePluginUi 拒绝了生成的 UI 描述');
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(ui)));
    assert.ok(new TextEncoder().encode(JSON.stringify(ui)).length <= MAX_UI_BYTES);
    assert.ok(depth(ui.children) <= MAX_UI_DEPTH);

    const nodes = walk(ui.children);
    const lists = nodes.filter((n) => n.type === 'list');
    const links = lists.flatMap((l) => l.items).filter((i) => i.link).map((i) => i.link.url);
    assert.deepEqual(links, ['https://github.com/o/r/pull/9']);
    // 候选群：select 只有 git 工作区，带「允许」按钮
    const candidate = lists[0].items[0];
    assert.equal(candidate.key, '-300');
    assert.deepEqual(candidate.controls[0].options, [{ value: 'ws1', label: 'repo' }]);
    assert.equal(candidate.controls[1].action, ACTIONS.allowGroup);
    // 已允许的群：显示工作区名，移除要确认
    assert.equal(lists[1].items[0].subtitle, 'repo');
    assert.equal(lists[1].items[1].subtitle, '工作区已移除');
    assert.ok(lists[1].items[0].controls[0].confirm);
    // token 只显示掩码，清除要确认
    const text = JSON.stringify(ui);
    assert.ok(!text.includes(TOKEN));
    const clear = nodes.find((n) => n.type === 'button' && n.action === ACTIONS.clearToken);
    assert.equal(clear.tone, 'destructive');
    assert.ok(clear.confirm);
    assert.ok(nodes.some((n) => n.type === 'field' && n.kind === 'password' && n.action === ACTIONS.saveToken));
    const rate = nodes.find((n) => n.type === 'field' && n.id === 'rateLimit');
    assert.deepEqual([rate.kind, rate.min, rate.max, rate.action], ['number', 1, 1000, ACTIONS.saveRateLimit]);
    assert.match(text, /@BotFather/);
    assert.match(text, /隐私模式/);
  });

  it('500 张卡片时仍在上限内；没有 git 工作区时不出 select', () => {
    const ui = buildSettingsUi(richState(500), [{ id: 'ws2', name: 'notes', git: false }]);
    assert.ok(parsePluginUi(ui));
    const candidate = walk(ui.children).filter((n) => n.type === 'list')[0].items[0];
    assert.equal(candidate.controls, undefined);
  });

  it('各种连接状态与空数据都能通过校验', () => {
    for (const connection of ['no-token', 'connecting', 'connected', 'unauthorized', 'conflict', 'api-error']) {
      const ui = buildSettingsUi(
        { connection, candidates: [], groups: [], cards: [], rateLimitPerHour: 5 },
        []
      );
      assert.ok(parsePluginUi(ui), connection);
    }
  });
});

describe('插件入口与 ui.action', () => {
  async function startWith(storage) {
    const host = fakeApi({ storage, secrets: {} });
    const tg = fakeTelegram();
    const plugin = await entry.startPlugin(host.api, tg.telegram, {
      sleep: async () => undefined,
      debounceMs: 0,
      renderThrottleMs: 0,
    });
    running.push(plugin);
    return { host, tg, plugin, state: host.state };
  }

  it('导出 activate / deactivate；启动后注册 channel.report 与 ui.action，并渲染一次', async () => {
    assert.equal(typeof entry.activate, 'function');
    assert.equal(typeof entry.deactivate, 'function');
    const { host, state } = await startWith({ legacyMigrated: true });
    assert.ok(host.hasHandler('channel.report'));
    assert.ok(host.hasHandler('ui.action'));
    assert.ok(state.renders.length >= 1);
    assert.ok(parsePluginUi(state.renders.at(-1)));
  });

  it('每个 action 都有处理', async () => {
    const { host, state } = await startWith({
      legacyMigrated: true,
      bot: { id: 42, username: 'fyn_bot' },
      candidates: [{ chatId: -300, title: '新群', seenAt: 1 }],
      cards: [
        { id: 1, chatId: -300, workspaceId: 'ws1', status: 'pending-approval', title: 'a', messageId: 1, createdAt: 1 },
        { id: 2, chatId: -300, workspaceId: 'ws1', status: 'pending-approval', title: 'b', messageId: 2, createdAt: 1 },
      ],
    });
    const act = (action, extra = {}) => host.call('ui.action', { action, values: {}, ...extra });

    assert.deepEqual(await act(ACTIONS.saveToken, { values: { token: ` ${TOKEN} ` } }), { ok: true });
    assert.equal(state.secrets.get('botToken'), TOKEN);
    assert.equal((await act(ACTIONS.saveToken, { values: {} })).ok, false);

    assert.equal((await act(ACTIONS.saveRateLimit, { values: { rateLimit: 0 } })).ok, false);
    assert.deepEqual(await act(ACTIONS.saveRateLimit, { values: { rateLimit: 12 } }), { ok: true });

    assert.equal((await act(ACTIONS.allowGroup, { itemKey: '-300', values: {} })).ok, false);
    assert.equal((await act(ACTIONS.allowGroup, { itemKey: 'x', values: { workspace: 'ws1' } })).ok, false);
    assert.deepEqual(await act(ACTIONS.allowGroup, { itemKey: '-300', values: { workspace: 'ws1' } }), {
      ok: true,
    });
    assert.deepEqual(state.created.at(-1), { workspaceId: 'ws1', profile: 'triage', title: 'Telegram 分诊 · 新群' });

    assert.deepEqual(await act(ACTIONS.reject, { itemKey: '2' }), { ok: true });
    assert.deepEqual(await act(ACTIONS.approve, { itemKey: '1' }), { ok: true });
    assert.equal((await act(ACTIONS.approve, { itemKey: '1' })).ok, false);

    assert.deepEqual(await act(ACTIONS.removeGroup, { itemKey: '-300' }), { ok: true });
    assert.equal((await act(ACTIONS.removeGroup, { itemKey: '-300' })).ok, false);

    assert.deepEqual(await act(ACTIONS.clearToken), { ok: true });
    assert.equal(state.secrets.has('botToken'), false);

    assert.equal((await act('nope')).ok, false);
    // 操作后（节流合并）重新渲染，最后一次反映最新状态，渲染结果始终合法
    await waitFor(() => {
      const last = walk(state.renders.at(-1).children);
      assert.equal(last.find((n) => n.id === 'rateLimit').value, 12);
      assert.ok(!JSON.stringify(last).includes('已设置：'));
    });
    assert.ok(state.renders.length >= 2);
    for (const ui of state.renders) assert.ok(parsePluginUi(ui));
  });

  it('ACTIONS 里的每个 action 都不会落到「未知操作」', async () => {
    const fake = new Proxy({}, { get: () => async () => ({ ok: true }) });
    for (const action of Object.values(ACTIONS)) {
      const result = await handleUiAction(fake, {
        action,
        itemKey: '1',
        values: { token: TOKEN, workspace: 'ws1', rateLimit: 3 },
      });
      assert.deepEqual(result, { ok: true }, action);
    }
  });
});
