// 轻量刷新要让 cur.confRank 跟上战绩（线上 2026-11-02：PHI 6-1 排在 DET 5-1 后面、TOR 3-3 排在 BOS 5-1 前面）。
// 名次来自 ESPN 的 playoffSeed；校验不过（失败、残缺、与战绩矛盾）就整份不用，保留旧名次。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confrank-'));
process.env.FETCH_STATE_FILE = path.join(stateDir, 'fetch-state.json');
test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const load = () => import('../server/espnStandings.mjs');
const { ESPN_TO_NBA } = await import('../server/oddsClient.mjs');
const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/espn-standings-2026-11-02.json', import.meta.url), 'utf8'));
const NBA_TO_ESPN = new Map([...ESPN_TO_NBA].map(([espn, nba]) => [nba, espn]));

/** rows: [[espn 球队 id, 种子, 胜, 负], …] → ESPN 响应 */
const payload = (east, west) => ({
  children: [['Eastern Conference', east], ['Western Conference', west]].map(([name, rows]) => ({
    name,
    standings: {
      entries: rows.map(([id, seed, wins, losses]) => ({
        team: { id: String(id) },
        stats: [
          { name: 'playoffSeed', value: seed }, { name: 'wins', value: wins }, { name: 'losses', value: losses },
        ],
      })),
    },
  })),
});

/** 与解析结果战绩一致的球队快照，overrides 按 teamId 改 */
const teamsFor = (rows, overrides = {}) => rows.map((r) => ({
  teamId: r.teamId,
  conference: r.conference,
  cur: { wins: r.wins, losses: r.losses, confRank: 99 },
  ...overrides[r.teamId],
}));

const team = (teamId, conference, wins, losses) => ({ teamId, conference, cur: { wins, losses, confRank: 99 } });
const nba = (espnId) => ESPN_TO_NBA.get(espnId);

test('线上实况：胜率定名次，场次不同也对（PHI 6-1 > DET 5-1，BOS 5-1 > TOR 3-3）', async () => {
  const { parseStandings, conferenceRanks } = await load();
  const rows = parseStandings(FIXTURE);
  const ranks = conferenceRanks(teamsFor(rows), rows);
  const rank = (abbr) => {
    const entry = FIXTURE.children.flatMap((c) => c.standings.entries).find((e) => e.team.abbreviation === abbr);
    return ranks.get(nba(Number(entry.team.id)));
  };
  assert.equal(ranks.size, 30);
  assert.equal(rank('PHI'), 1);
  assert.equal(rank('DET'), 2);
  assert.ok(rank('BOS') < rank('TOR'), `BOS ${rank('BOS')} 应在 TOR ${rank('TOR')} 前`);
  assert.equal(rank('MEM'), 1);
  assert.equal(rank('SAC'), 15);
});

test('胜率相同（2-1 与 4-2，场次不同）：按 ESPN 种子定序，与响应里的行序无关', async () => {
  const { parseStandings, conferenceRanks } = await load();
  const east = [[1, 1, 4, 2], [2, 2, 2, 1], [17, 3, 0, 1]];
  const west = [[7, 1, 1, 0], [9, 2, 0, 1]];
  const forward = parseStandings(payload(east, west));
  const backward = parseStandings(payload([...east].reverse(), [...west].reverse()));
  const a = conferenceRanks(teamsFor(forward), forward);
  const b = conferenceRanks(teamsFor(backward), backward);
  assert.equal(a.get(nba(1)), 1);
  assert.equal(a.get(nba(2)), 2);
  assert.deepEqual([...a].sort(), [...b].sort());
});

test('东西部名次各自从 1 开始', async () => {
  const { parseStandings, conferenceRanks } = await load();
  const rows = parseStandings(payload([[1, 1, 1, 0]], [[7, 1, 1, 0]]));
  const ranks = conferenceRanks(teamsFor(rows), rows);
  assert.equal(ranks.get(nba(1)), 1);
  assert.equal(ranks.get(nba(7)), 1);
});

test('空响应：拒绝', async () => {
  const { parseStandings, conferenceRanks } = await load();
  assert.throws(() => conferenceRanks([team(nba(1), 'East', 1, 0)], parseStandings({})));
  assert.throws(() => conferenceRanks([team(nba(1), 'East', 1, 0)], parseStandings(null)));
});

test('残缺响应（少一个分区）：拒绝', async () => {
  const { parseStandings, conferenceRanks } = await load();
  const rows = parseStandings(payload([[1, 1, 1, 0]], []));
  assert.throws(() => conferenceRanks([team(nba(1), 'East', 1, 0), team(nba(7), 'West', 1, 0)], rows));
});

test('响应里多出快照没有的球队或同队两行：拒绝', async () => {
  const { parseStandings, conferenceRanks } = await load();
  const extra = parseStandings(payload([[1, 1, 1, 0], [2, 2, 0, 1]], []));
  assert.throws(() => conferenceRanks([team(nba(1), 'East', 1, 0)], extra));
  const dup = parseStandings(payload([[1, 1, 1, 0], [1, 2, 1, 0]], []));
  assert.throws(() => conferenceRanks([team(nba(1), 'East', 1, 0)], dup));
});

test('认不出的 ESPN 球队 id：拒绝', async () => {
  const { parseStandings, conferenceRanks } = await load();
  const rows = parseStandings(payload([[999, 1, 1, 0]], []));
  assert.throws(() => conferenceRanks([team(nba(1), 'East', 1, 0)], rows));
});

test('种子重复、跳号、缺失、为 0：拒绝', async () => {
  const { parseStandings, conferenceRanks } = await load();
  const check = (seedA, seedB) => {
    const rows = parseStandings(payload([[1, seedA, 1, 0], [2, seedB, 1, 0]], []));
    assert.throws(() => conferenceRanks(teamsFor(rows), rows), undefined, `种子 ${seedA},${seedB}`);
  };
  check(1, 1);
  check(1, 3);
  check(1, undefined);
  check(0, 1);
});

test('ESPN 的战绩与本次刷新算出的不一致（比分还没对齐）：拒绝，不混用两份战绩', async () => {
  const { parseStandings, conferenceRanks } = await load();
  const rows = parseStandings(payload([[1, 1, 2, 0]], []));
  assert.throws(() => conferenceRanks([team(nba(1), 'East', 1, 0)], rows));
});

test('种子与胜率矛盾（TOR 3-3 排在 BOS 5-1 前面这种）：拒绝', async () => {
  const { parseStandings, conferenceRanks } = await load();
  const rows = parseStandings(payload([[1, 1, 3, 3], [2, 2, 5, 1]], []));
  assert.throws(() => conferenceRanks(teamsFor(rows), rows));
});

test('分区对不上、球队没有 cur：拒绝', async () => {
  const { parseStandings, conferenceRanks } = await load();
  const rows = parseStandings(payload([[1, 1, 1, 0]], []));
  assert.throws(() => conferenceRanks([team(nba(1), 'West', 1, 0)], rows));
  assert.throws(() => conferenceRanks([{ teamId: nba(1), conference: 'East' }], rows));
});

// ---------------------------------------------------------------- 整条 espn-refresh：临时副本 + 假 fetch，与 refresh.sh 的取数方式相同

const exec = promisify(execFile);
const FAKE_FETCH = `
const respond = process.env.FAKE_STANDINGS;
globalThis.fetch = async (url) => {
  if (String(url).includes('/standings')) {
    return respond === 'blocked' ? new Response('forbidden', { status: 403 })
      : new Response(respond, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
`;

/** 东部三队（A 胜 B、A 胜 C）的快照：ingest 留下的旧名次是 C=1、B=2、A=3，战绩已经变了 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confrank-e2e-'));
  fs.cpSync(path.join(ROOT, 'server'), path.join(dir, 'server'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.mkdirSync(path.join(dir, 'data'));
  const write = (f, v) => fs.writeFileSync(path.join(dir, 'data', f), JSON.stringify(v));
  const row = (espn, abbr, confRank) => ({
    teamId: nba(espn), abbr, conference: 'East', eloPreseason: 1500, cur: { wins: 0, losses: 0, winPct: 0, confRank },
  });
  write('teams.json', [row(1, 'AAA', 3), row(2, 'BBB', 2), row(17, 'CCC', 1)]);
  write('schedule.json', {
    games: [
      { gameId: 'g1', type: 'regular', date: '2020-01-01', homeId: nba(1), awayId: nba(2), homeScore: 100, awayScore: 90 },
      { gameId: 'g2', type: 'regular', date: '2020-01-02', homeId: nba(1), awayId: nba(17), homeScore: 100, awayScore: 90 },
    ],
  });
  write('players.json', []);
  write('meta.json', { targetSeason: '2026-27', fetchedAt: '2020-01-01T00:00:00Z' });
  fs.writeFileSync(path.join(dir, 'fake-fetch.mjs'), FAKE_FETCH);
  return dir;
}

async function refresh(standings) {
  const dir = sandbox();
  try {
    await exec(process.execPath, ['--import', path.join(dir, 'fake-fetch.mjs'), 'scripts/espn-refresh.mjs'], {
      cwd: dir,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        FAKE_STANDINGS: standings,
        FETCH_STATE_FILE: path.join(dir, 'fetch-state.json'),
        ESPN_MIN_GAP_MS: '0',
        ESPN_MAX_GAP_MS: '0',
      },
    });
    const teams = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'teams.json'), 'utf8'));
    const summary = (abbr) => {
      const c = teams.find((t) => t.abbr === abbr).cur;
      return [c.wins, c.losses, c.confRank];
    };
    return { AAA: summary('AAA'), BBB: summary('BBB'), CCC: summary('CCC') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const GOOD = [[1, 1, 2, 0], [2, 2, 0, 1], [17, 3, 0, 1]];

test('espn-refresh：名次随战绩更新并写进 teams.json', async () => {
  assert.deepEqual(await refresh(JSON.stringify(payload(GOOD, []))), {
    AAA: [2, 0, 1], BBB: [0, 1, 2], CCC: [0, 1, 3],
  });
});

test('espn-refresh：standings 被拦（403）→ 刷新照常完成，战绩更新，名次一个都不动', async () => {
  assert.deepEqual(await refresh('blocked'), { AAA: [2, 0, 3], BBB: [0, 1, 2], CCC: [0, 1, 1] });
});

test('espn-refresh：standings 残缺 / 战绩对不上 → 名次一个都不动（不会只改一部分）', async () => {
  const kept = { AAA: [2, 0, 3], BBB: [0, 1, 2], CCC: [0, 1, 1] };
  assert.deepEqual(await refresh(JSON.stringify(payload(GOOD.slice(0, 2), []))), kept);
  assert.deepEqual(await refresh(JSON.stringify(payload([[1, 1, 3, 0], [2, 2, 0, 1], [17, 3, 0, 1]], []))), kept);
  assert.deepEqual(await refresh('{}'), kept);
});
