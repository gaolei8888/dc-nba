import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleEloGames, buildGames, computeElo } from '../server/ratings.mjs';

const teams = [{ teamId: 1610612743, abbr: 'DEN' }, { teamId: 1610612754, abbr: 'IND' }];
// 2026-11-07 墨西哥城赛：赛程（NBA isNeutral）与 ESPN neutralSite 都标中立场
const mexico = { gameId: '0022600123', type: 'regular', date: '2026-11-07', neutral: true,
  homeId: 1610612754, awayId: 1610612743, homeScore: 110, awayScore: 112 };

test('scheduleEloGames：赛程标中立场的比赛进 Elo 时也是中立场', () => {
  const [g] = scheduleEloGames([mexico], teams);
  assert.equal(g.neutral, true);
  assert.deepEqual([g.home.abbr, g.away.abbr, g.away.win], ['IND', 'DEN', true]);
});

test('scheduleEloGames：普通比赛、未结束、季前赛照旧', () => {
  const games = scheduleEloGames([
    { ...mexico, gameId: 'b', neutral: false },
    { ...mexico, gameId: 'c', homeScore: null, awayScore: null },
    { ...mexico, gameId: 'd', type: 'preseason' },
  ], teams);
  assert.deepEqual(games.map((g) => [g.gameId, g.neutral]), [['b', false]]);
});

test('ESPN 刷新的中立场 Elo 与 ingest（leaguegamelog 两行都标 @）一分不差', () => {
  const log = [
    { GAME_ID: mexico.gameId, GAME_DATE: mexico.date, TEAM_ID: 1610612743, TEAM_ABBREVIATION: 'DEN', PTS: 112, WL: 'W', MATCHUP: 'DEN @ IND' },
    { GAME_ID: mexico.gameId, GAME_DATE: mexico.date, TEAM_ID: 1610612754, TEAM_ABBREVIATION: 'IND', PTS: 110, WL: 'L', MATCHUP: 'IND @ DEN' },
  ];
  const initial = { 1610612743: 1600, 1610612754: 1500 };
  const fromIngest = computeElo(buildGames(log), { initial }).final;
  const fromRefresh = computeElo(scheduleEloGames([mexico], teams), { initial }).final;
  for (const id of Object.keys(initial)) assert.ok(Math.abs(fromIngest[id] - fromRefresh[id]) < 1e-9);
});
