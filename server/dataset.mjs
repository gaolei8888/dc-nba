/**
 * 实验室数据集：把 data/history/ 里的抓取缓存压成一份紧凑的逐场结果，
 * 并附上（抓过的话）当场的收盘盘口。
 *
 * 单独成文件是因为它有两个调用方：ingest 每次抓完顺手重建；
 * scripts/build-dataset.mjs 则可以在只更新了盘口之后单独重建，
 * 不必为此再去 stats.nba.com 拉一遍全部数据。
 */
import fsNode from 'node:fs';
import pathNode from 'node:path';
import { writeJson, DATA_DIR } from './nbaClient.mjs';

const log = (...a) => console.log('·', ...a);

/**
 * @returns {object|null} 写出的数据集，缺少 history 缓存时返回 null
 */
export function buildBacktestDataset() {
  const dir = pathNode.join(DATA_DIR, 'history');
  if (!fsNode.existsSync(dir)) {
    console.warn('  未找到 data/history/，跳过实验室数据集（先跑一次 npm run backtest）');
    return null;
  }
  const out = {
    seasons: {},
    teamAdv: {},
    odds: { seasons: {}, providers: {} },
    builtAt: new Date().toISOString(),
  };
  let games = 0;

  // 先读盘口缓存，等会儿按 gameId 贴到每场比赛上
  const oddsByGame = new Map();
  for (const f of fsNode.readdirSync(dir)) {
    const m = f.match(/^odds_(\d{4}-\d{2})\.json$/);
    if (!m) continue;
    const c = JSON.parse(fsNode.readFileSync(pathNode.join(dir, f), 'utf8'));
    let n = 0;
    for (const [gameId, o] of Object.entries(c.games ?? {})) {
      if (o?.spread === null || o?.spread === undefined) continue;
      oddsByGame.set(gameId, o);
      n += 1;
    }
    out.odds.seasons[m[1]] = n;
    for (const [p, k] of Object.entries(c.providers ?? {})) {
      out.odds.providers[p] = (out.odds.providers[p] ?? 0) + k;
    }
  }

  for (const f of fsNode.readdirSync(dir)) {
    let m = f.match(/^gamelog_(\d{4}-\d{2})\.json$/);
    if (m) {
      const rows = JSON.parse(fsNode.readFileSync(pathNode.join(dir, f), 'utf8'));
      const byGame = new Map();
      for (const r of rows) {
        const g = byGame.get(r.GAME_ID) ?? { d: r.GAME_DATE, s: [] };
        g.s.push([r.TEAM_ID, r.PTS, r.MATCHUP.includes('vs.') ? 1 : 0]);
        byGame.set(r.GAME_ID, g);
      }
      out.seasons[m[1]] = [...byGame.entries()].map(([i, g]) => {
        const o = oddsByGame.get(i);
        // 盘口压成四个数：主队让分、总分、两边的美式赔率。其余字段留在缓存里。
        return o
          ? { i, d: g.d, s: g.s, o: [o.spread, o.total ?? null, o.homeMl ?? null, o.awayMl ?? null] }
          : { i, d: g.d, s: g.s };
      });
      games += out.seasons[m[1]].length;
      continue;
    }
    m = f.match(/^teamadv_(\d{4}-\d{2})\.json$/);
    if (m) {
      out.teamAdv[m[1]] = JSON.parse(fsNode.readFileSync(pathNode.join(dir, f), 'utf8'))
        .map((r) => ({ t: r.TEAM_ID, n: r.NET_RATING, p: r.PACE }));
    }
  }

  writeJson('backtest.json', out);
  const withOdds = Object.values(out.seasons).flat().filter((g) => g.o).length;
  log(`实验室数据集：${Object.keys(out.seasons).length} 个赛季 / ${games} 场`
    + `（含盘口 ${withOdds} 场）`);
  if (!withOdds) {
    console.warn('  没有历史盘口，「对标盘口」不可用。跑一次 npm run odds:history 即可。');
  }
  return out;
}
