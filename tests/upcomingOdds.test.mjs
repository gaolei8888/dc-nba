// 熔断/上限发生在盘口扫描中途时，fetchUpcomingOdds 必须整体失败，
// 让 espn-refresh 保留旧 odds.json——而不是把「每个比赛日都失败」当成空盘口写进去。
// 单独一个文件：espnHttp 是模块级单例，熔断状态会留在进程里。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odds-'));
process.env.FETCH_STATE_FILE = path.join(dir, 'fetch-state.json');
process.env.ESPN_MIN_GAP_MS = '0';
process.env.ESPN_MAX_GAP_MS = '0';

test('盘口扫描中被拦（403）→ 抛 BLOCKED，不返回空盘口', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('forbidden', { status: 403 });
  };
  const { fetchUpcomingOdds } = await import('../server/oddsClient.mjs');
  const games = ['2099-01-01', '2099-01-02', '2099-01-03'].map((date, i) => ({
    type: 'regular', date, homeId: 1610612737, awayId: 1610612738, gameId: `g${i}`,
  }));
  await assert.rejects(fetchUpcomingOdds(games, { from: '2099-01-01' }), (e) => e.code === 'BLOCKED');
  assert.equal(calls, 1, '熔断后不再发请求');
  fs.rmSync(dir, { recursive: true, force: true });
});
