/**
 * 计算工作线程。
 *
 * 赛季模拟是纯 CPU 密集的同步计算（3000 次约 165ms，10000 次约 500ms）。
 * 在主线程里跑会把整个事件循环卡住——实测 simulate 进行时，
 * 一个普通的 /api/meta 请求从 5ms 涨到 469ms。
 *
 * 注意：把同步计算包进 Promise 是没用的，那不会让出线程。
 * 只有真正的工作线程才能把它挪出主线程。
 */
import { parentPort } from 'node:worker_threads';
import { readJson } from './nbaClient.mjs';
import { buildModel, simulateSeason, powerRankings, predictSchedule } from './predict.mjs';
import * as lab from './lab.mjs';
import { bettingEvidence } from './bettingEvidence.mjs';

// 每个 worker 自己加载一份快照。数据约 1MB，几个 worker 的内存开销可以接受，
// 换来的是完全不需要跨线程传数据。
const store = {
  teams: readJson('teams.json'),
  players: readJson('players.json'),
  schedule: readJson('schedule.json'),
  meta: readJson('meta.json'),
};

// 实验室数据集：约 480KB，每个 worker 各持一份，换来完全不用跨线程传数据
const labData = readJson('backtest.json');

const modelCache = new Map();
const getModel = (overrides) => {
  const key = JSON.stringify(Object.entries(overrides ?? {}).sort());
  if (!modelCache.has(key)) modelCache.set(key, buildModel(store, overrides));
  return modelCache.get(key);
};

const HANDLERS = {
  /** 回测一组参数，返回指标 + 校准 + 误差切片 */
  labBacktest({ seasons, params }) {
    if (!labData) throw new Error('缺少 data/backtest.json，请先运行 npm run ingest');
    const rows = lab.replay(labData, seasons, params);
    return {
      seasons,
      summary: lab.score(rows),
      calibration: lab.calibration(rows),
      slices: lab.slices(rows),
      bySeason: seasons.map((s) => ({ season: s, ...lab.score(rows.filter((r) => r.season === s)) })),
    };
  },

  /** 对标博彩收盘盘口 */
  labMarket({ seasons, params }) {
    if (!labData) throw new Error('缺少 data/backtest.json');
    return lab.market(lab.replay(labData, seasons, params));
  },

  /** 逐年测量：主场优势与休息效应 */
  labMeasure({ seasons, params }) {
    if (!labData) throw new Error('缺少 data/backtest.json');
    return {
      homeAdvantage: lab.homeAdvantageBySeason(labData, seasons, params),
      rest: lab.restEffect(labData, seasons, params),
    };
  },

  /** 反事实：某队全季强/弱 N 分 */
  labCounterfactual({ seasons, teamId, deltaPts, params }) {
    if (!labData) throw new Error('缺少 data/backtest.json');
    return lab.counterfactual(labData, seasons, teamId, deltaPts, params);
  },

  /** 投注参考：历史收盘盘口对比 + 平注回测（生产参数，数据静态） */
  labBetting() {
    if (!labData) throw new Error('缺少 data/backtest.json');
    return bettingEvidence(labData);
  },

  simulate({ params, out, sims, seed }) {
    const t0 = Date.now();
    const result = simulateSeason(getModel(params), { sims, out, seed });
    return { ...result, ms: Date.now() - t0 };
  },
  rankings({ params, out }) {
    return powerRankings(getModel(params), out);
  },
  schedule({ params, out, games }) {
    return predictSchedule(getModel(params), games, out);
  },
};

parentPort.on('message', ({ id, type, payload }) => {
  try {
    const handler = HANDLERS[type];
    if (!handler) throw new Error(`未知任务类型: ${type}`);
    parentPort.postMessage({ id, ok: true, result: handler(payload) });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
});

parentPort.postMessage({ ready: true });
