/**
 * 伤病报告影子运行：抓当时最新的官方报告、记三套赛前预测、赛后结算（只追加，见 server/injuryShadow.mjs）。
 * 同一次运行另记阵容+战绩榜的 rr22 / rr0630（server/rosterResultsShadow.mjs，表 shadow_rr_predictions）：
 * 与前三套完全隔离——rr 出任何错只跳过 rr 行、只记日志，base / r22 / r0630 照常。
 * 再另记伤病感知 Elo 的 inj-p1-* / inj-a-*（server/injuryEloShadow.mjs，表 shadow_inj_elo_predictions），同样隔离。
 *
 *   node scripts/shadow.mjs capture          # 北京 22:00 那次：base + r22（06:30 前开打的场另记 r0630）
 *   node scripts/shadow.mjs capture --late   # 北京 06:30 那次：r0630。身份由参数给出，不按钟点猜
 *   node scripts/shadow.mjs settle           # 用 data/schedule.json 的比分结算，零请求
 *   node scripts/shadow.mjs show             # 打印汇总
 *   SHADOW_NO_FETCH=1 …capture               # 不抓报告，只用库里已存的
 *   SHADOW_NOW=2026-10-28T14:05:00Z …        # 演练：把「现在」拨到某一刻（production 下忽略）
 *
 * 线上由 deploy/refresh.sh 在新容器健康之后 `docker exec dc-nba node scripts/shadow.mjs …` 调用，
 * 和模拟投注账本同一时机、同一个库（data-db/app.db）：只有运行中的容器挂着持久卷，也只有运行镜像里装了 pdftotext。
 * 每次 capture 最多抓 1 份新报告（从「现在 − 15 分钟」往前按 15 分钟找，S3 不存在的跳过，最多 12 个文件名），
 * 单次上限 15、单日 40 个请求，熔断状态与单日计数放在库旁边（跨运行保留）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson } from '../server/nbaClient.mjs';
import { openLedger } from '../server/db.mjs';
import { DEFAULT_PARAMS, buildModel, predictSchedule, powerRankings } from '../server/predict.mjs';
import { REPORT_BASE, candidates, isS3Missing, parseReportText } from '../server/injuryReport.mjs';
import { asPdf, injuryClient, pdfText } from '../server/injuryFetch.mjs';
import {
  captureDate, etToUtc, insertShadow, settleShadow, shadowAll, shadowRows, shadowSummary, storeReport, storedReports,
} from '../server/injuryShadow.mjs';
import { RR_COLS, rrAll, rrBoard, rrRows } from '../server/rosterResultsShadow.mjs';
import { INJ_ELO_COLS, injEloAll, injEloRows, injEloSummary } from '../server/injuryEloShadow.mjs';

const PARAMS = JSON.parse(fs.readFileSync(new URL('../server/injury-params-v1.json', import.meta.url), 'utf8'));
const RR_PARAMS_FILE = new URL('../server/roster-results-params-v1.json', import.meta.url);
/** 榜的代码指纹：影子期内榜的代码若有改动（分钟 / 缺阵逻辑等），逐行可查，评估时据此分段报告 */
const RR_CODE_FILES = ['liveRosterRankings.mjs', 'rosterProjection.mjs', 'rotationMinutes.mjs', 'injury-params-v1.json',
  'rosterResults.mjs', 'rosterResultsShadow.mjs', 'impact.mjs', 'impactShrink.mjs'];
const boardCode = () => {
  const h = crypto.createHash('sha256');
  for (const f of RR_CODE_FILES) h.update(fs.readFileSync(new URL(`../server/${f}`, import.meta.url)));
  return h.digest('hex').slice(0, 12);
};
const INJ_ELO_PARAMS_FILE = new URL('../server/injury-elo-params-v1.json', import.meta.url);
const INJ_ELO_CODE_FILES = ['injuryEloShadow.mjs', 'injuryEloLab.mjs', 'injury-elo-params-v1.json', 'injuryLab.mjs', 'injuryShadow.mjs'];
const fingerprint = (files) => {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(fs.readFileSync(new URL(`../server/${f}`, import.meta.url)));
  return h.digest('hex').slice(0, 12);
};
const db = openLedger();
if (!db) process.exit(1);
const cmd = process.argv[2];
const slot = process.argv.includes('--late') || process.env.LEDGER_RUN === 'late' ? '0630' : '22';
// 演练时钟固定；线上每次取真实时间（抓报告可能要几分钟，插入前要重新取，免得刚开赛的场被当成没开赛）
const FIXED = process.env.NODE_ENV !== 'production' && process.env.SHADOW_NOW ? Date.parse(process.env.SHADOW_NOW) : null;
const clock = () => FIXED ?? Date.now();
const iso = (ms) => new Date(ms).toISOString();

/** 当时能看到的最新一份报告：已存就不再请求；抓不到（被拦、到上限）只记日志，用库里已有的继续 */
async function fetchLatest(now) {
  const have = new Set(storedReports(db, iso(now - 86400e3)).map((r) => r.name));
  const http = injuryClient({
    maxPerRun: 15, maxPerDay: 40,
    statePath: process.env.DB_PATH ? path.join(path.dirname(process.env.DB_PATH), 'injury-fetch-state.json') : undefined,
  });
  for (const c of candidates(now - PARAMS.lagMin * 60000, 'minute', 12)) {
    if (have.has(c.name)) return `${c.name}（已存）`;
    let bytes;
    try {
      bytes = await http.get(`${REPORT_BASE}${c.name}.pdf`, { notFoundOk: isS3Missing, parse: asPdf });
    } catch (e) {
      console.warn(`  报告抓取停止：${String(e.message).slice(0, 120)}`);
      return null;
    }
    if (!bytes) continue;
    let parsed;
    try {
      parsed = parseReportText(pdfText(bytes));
      // 标注时间取文件名（换成 UTC ISO），PDF 里的 'MM/DD/YY hh:mm AM' 只作核对，不能覆盖它
      storeReport(db, { ...parsed, name: c.name, asOf: iso(etToUtc(c.date, c.min)), fetchedAt: iso(Date.now()) });
    } catch (e) {
      // pdftotext 不在、PDF 坏了：不能连累基线，用库里已有的报告继续
      console.warn(`  报告 ${c.name} 解析失败：${String(e.message).slice(0, 120)}`);
      return null;
    }
    return `${c.name}（新抓，PDF 标 ${parsed.asOf ?? '?'}，${parsed.rows.length} 行、未交名单 ${parsed.notSubmitted.length} 队）`;
  }
  return null;
}

async function capture() {
  const D = captureDate(clock(), slot);
  if (!D) { console.log(`· 影子运行：现在不在 ${slot === '22' ? '22:00' : '06:30'} 时点窗口内，不记`); return; }
  const got = process.env.SHADOW_NO_FETCH ? '（未抓）' : await fetchLatest(clock());
  const now = clock();
  const store = {
    teams: readJson('teams.json'), players: readJson('players.json'),
    schedule: readJson('schedule.json'), meta: readJson('meta.json'),
  };
  const games = store.schedule.games.filter((g) => g.type === 'regular' && g.date === D && g.homeScore == null);
  const slate = predictSchedule(buildModel(store), games, {}).map((g) => ({
    gameId: g.gameId, date: g.date, tipoff: g.dateTimeUtc, homeId: g.homeId, awayId: g.awayId,
    margin: g.prediction.margin, dataAt: store.meta.fetchedAt,
    neutral: !!g.neutral, restHome: g.prediction.restHome, restAway: g.prediction.restAway,
  }));
  // 06:30 方案加在 22:00 那次记下的基线上（配对比较的是同一个基线）；没有基线才用此刻的线上预测
  const baseM = new Map(shadowAll(db).filter((r) => r.variant === 'base' && r.game_date === D).map((r) => [r.game_id, r.base_margin]));
  if (slot === '0630') for (const g of slate) g.margin = baseM.get(g.gameId) ?? g.margin;
  const values = readJson('player-values.json');
  const rows = shadowRows({
    slate, slot, now, params: PARAMS, values, reports: storedReports(db, iso(now - 48 * 3600e3)), teams: store.teams,
  });
  const { n, rejected } = insertShadow(db, rows);
  const tipped = slate.filter((g) => !(Date.parse(g.tipoff) > now)).map((g) => g.gameId);
  const by = rows.reduce((o, r) => ({ ...o, [r.variant]: (o[r.variant] ?? 0) + 1 }), {});
  console.log(`· 影子运行（${slot === '22' ? '22:00' : '06:30'}，美东 ${D}）：赛程 ${games.length} 场，${JSON.stringify(by)}，新插入 ${n} 行；`
    + `报告 ${got ?? '没找到'}；球员价值 ${values ? `拟合于 ${values.fittedAt}、生成于 ${values.builtAt}` : '缺失'}`
    + `${values && !rows.some((r) => r.variant !== 'base') && rows.length ? '（过期，只记基线）' : ''}`
    + `${tipped.length ? `；已开赛未记 ${tipped.join(',')}` : ''}${rejected.length ? `；库拒绝 ${rejected.map((r) => `${r.game_id}/${r.variant}`).join(',')}` : ''}`);
  // 阵容+战绩榜：放在前三套已落库之后，出错只记日志
  try {
    captureRr({ D, store, slate, now: clock() });
  } catch (e) {
    console.warn(`· 阵容+战绩影子：失败（不影响 base / r22 / r0630）：${String(e.message).slice(0, 200)}`);
  }
  // 伤病感知 Elo（inj-p1 / inj-a）：同样放在前面几套落库之后，出错只记日志
  try {
    captureInjElo({ D, store, slate, now: clock() });
  } catch (e) {
    console.warn(`· 伤病感知 Elo 影子：失败（不影响其他影子）：${String(e.message).slice(0, 200)}`);
  }
}

function captureInjElo({ D, store, slate, now }) {
  const params = JSON.parse(fs.readFileSync(INJ_ELO_PARAMS_FILE, 'utf8'));
  const values = readJson('player-values.json');
  // 22:00 记下的 base（06:30 那次沿用它；22:00 那次就是刚插入的那行）
  const baseMargins = new Map(shadowAll(db).filter((r) => r.variant === 'base' && r.game_date === D).map((r) => [r.game_id, r.base_margin]));
  const { rows, skipped, info } = injEloRows({
    slate, slot, now, params, store, values, baseMargins,
    reports: storedReports(db, iso(now - 240 * 86400e3)),
    eloWeight: DEFAULT_PARAMS.wElo / ((DEFAULT_PARAMS.wElo + DEFAULT_PARAMS.wNet) || 1),
    code: fingerprint(INJ_ELO_CODE_FILES),
  });
  const { n, rejected } = insertShadow(db, rows, { table: 'shadow_inj_elo_predictions', cols: INJ_ELO_COLS });
  const by = rows.reduce((o, r) => ({ ...o, [r.variant]: (o[r.variant] ?? 0) + 1 }), {});
  const why = [...new Set(skipped.map((x) => x.why))];
  const partial = rows.filter((r) => r.variant.startsWith('inj-a') && (r.covered_home < r.games_home || r.covered_away < r.games_away));
  console.log(`· 伤病感知 Elo 影子（${slot === '22' ? '22:00' : '06:30'}，美东 ${D}）：${JSON.stringify(by)}，新插入 ${n} 行；`
    + `${info ? `出场数据 ${info.src}、赛果截至 ${info.resultsThrough ?? '—'}（${info.resultsN} 场）、线上 Elo 核对差 ${info.eloCheck.toFixed(2)}` : ''}`
    + `${partial.length ? `；D_post 不全的 inj-a 行 ${partial.length}` : ''}`
    + `${skipped.length ? `；跳过 ${skipped.length} 行（${why.join('；')}）` : ''}`
    + `${rejected.length ? `；库拒绝 ${rejected.map((r) => `${r.game_id}/${r.variant}：${r.why}`).join(',')}` : ''}`);
}

function captureRr({ D, store, slate, now }) {
  const params = JSON.parse(fs.readFileSync(RR_PARAMS_FILE, 'utf8'));
  const full = { ...store, injuries: readJson('injuries.json') ?? { players: [], fetchedAt: null }, impactModel: readJson('impact-model.json') };
  const legacy = powerRankings(buildModel(full), {});
  const board = rrBoard({ store: full, legacy, D, params, now });
  const { rows, skipped } = rrRows({ slate, slot, now, params, board, code: boardCode() });
  const { n, rejected } = insertShadow(db, rows, { table: 'shadow_rr_predictions', cols: RR_COLS });
  const by = rows.reduce((o, r) => ({ ...o, [r.variant]: (o[r.variant] ?? 0) + 1 }), {});
  const why = [...new Set(skipped.map((x) => x.why))];
  console.log(`· 阵容+战绩影子（${slot === '22' ? '22:00' : '06:30'}，美东 ${D}）：${JSON.stringify(by)}，新插入 ${n} 行；`
    + `${board.ok ? `快照 ${board.fetchedAt}、赛果截至 ${board.resultsThrough ?? '—'}（${board.resultsN} 场）` : `榜不可用：${board.reason}`}`
    + `${skipped.length ? `；跳过 ${skipped.length} 行（${why.join('；')}）` : ''}`
    + `${rejected.length ? `；库拒绝 ${rejected.map((r) => `${r.game_id}/${r.variant}：${r.why}`).join(',')}` : ''}`);
}

function settle() {
  const scores = Object.fromEntries(readJson('schedule.json').games.filter((g) => g.homeScore != null)
    .map((g) => [g.gameId, { homeScore: g.homeScore, awayScore: g.awayScore }]));
  console.log(`· 影子运行结算：${settleShadow(db, scores)} 行`);
  try {
    console.log(`· 阵容+战绩影子结算：${settleShadow(db, scores, undefined, 'shadow_rr_predictions')} 行`);
  } catch (e) {
    console.warn(`· 阵容+战绩影子结算失败：${String(e.message).slice(0, 200)}`);
  }
  try {
    console.log(`· 伤病感知 Elo 影子结算：${settleShadow(db, scores, undefined, 'shadow_inj_elo_predictions')} 行`);
  } catch (e) {
    console.warn(`· 伤病感知 Elo 影子结算失败：${String(e.message).slice(0, 200)}`);
  }
}

function show() {
  const s = shadowSummary([...shadowAll(db), ...rrAll(db)]);
  console.log(`影子运行：06:30 方案已结算 ${s.progress}/${s.target} 场，rr0630 ${s.rrProgress}/${s.target} 场，待结算 ${s.pending} 场（自 ${s.firstDate ?? '—'}）`);
  for (const v of s.variants) {
    const d = v.dLogLoss ? `  Δ ${v.dLogLoss.mean.toFixed(4)} [${v.dLogLoss.lo.toFixed(4)}, ${v.dLogLoss.hi.toFixed(4)}]（配对 ${v.paired} 场）` : '';
    console.log(`  ${v.variant.padEnd(6)} n=${v.n} LL ${v.logLoss?.toFixed(4) ?? '—'} Brier ${v.brier?.toFixed(4) ?? '—'}${d}`);
  }
  const j = injEloSummary([...shadowAll(db), ...rrAll(db), ...injEloAll(db)]);
  const ci = (c) => (c ? `${c.mean.toFixed(4)} [${c.lo.toFixed(4)}, ${c.hi.toFixed(4)}]（${c.days} 天）` : '—');
  console.log(`伤病感知 Elo 影子：共同结算 ${j.n}/${j.target} 场（自 ${j.firstDate ?? '—'}），待结算 ${j.pending} 场；inj-a 的 D_post 覆盖（队·场）${j.dpostCoverage == null ? '—' : `${(100 * j.dpostCoverage).toFixed(1)}%`}`);
  for (const a of j.arms) console.log(`  ${a.variant.padEnd(11)} n=${a.n} LL ${a.logLoss?.toFixed(4) ?? '—'} Brier ${a.brier?.toFixed(4) ?? '—'}`);
  for (const d of j.deltas) console.log(`  ${d.a} − ${d.b}：ΔLL ${ci(d.dLogLoss)}  ΔBrier ${ci(d.dBrier)}`);
  console.log(`  两队 D_post 全覆盖的 ${j.fullCoverage.n} 场：inj-a − inj-p1 ΔLL ${ci(j.fullCoverage.dLogLoss)}`);
}

const CMDS = { capture, settle, show };
if (!CMDS[cmd]) {
  console.error('用法：node scripts/shadow.mjs capture [--late]|settle|show');
  process.exit(2);
}
await CMDS[cmd]();
