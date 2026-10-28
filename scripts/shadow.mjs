/**
 * 伤病报告影子运行：抓当时最新的官方报告、记三套赛前预测、赛后结算（只追加，见 server/injuryShadow.mjs）。
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
import { readJson } from '../server/nbaClient.mjs';
import { openLedger } from '../server/db.mjs';
import { buildModel, predictSchedule } from '../server/predict.mjs';
import { REPORT_BASE, candidates, isS3Missing, parseReportText } from '../server/injuryReport.mjs';
import { asPdf, injuryClient, pdfText } from '../server/injuryFetch.mjs';
import {
  captureDate, etToUtc, insertShadow, settleShadow, shadowAll, shadowRows, shadowSummary, storeReport, storedReports,
} from '../server/injuryShadow.mjs';

const PARAMS = JSON.parse(fs.readFileSync(new URL('../server/injury-params-v1.json', import.meta.url), 'utf8'));
const db = openLedger();
if (!db) process.exit(1);
const cmd = process.argv[2];
const slot = process.argv.includes('--late') || process.env.LEDGER_RUN === 'late' ? '0630' : '22';
const now = process.env.NODE_ENV !== 'production' && process.env.SHADOW_NOW ? Date.parse(process.env.SHADOW_NOW) : Date.now();
const iso = (ms) => new Date(ms).toISOString();

/** 当时能看到的最新一份报告：已存就不再请求；抓不到（被拦、到上限）只记日志，用库里已有的继续 */
async function fetchLatest() {
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
    const parsed = parseReportText(pdfText(bytes));
    // 标注时间取文件名（换成 UTC ISO），PDF 里的 'MM/DD/YY hh:mm AM' 只作核对，不能覆盖它
    storeReport(db, { ...parsed, name: c.name, asOf: iso(etToUtc(c.date, c.min)), fetchedAt: iso(Date.now()) });
    return `${c.name}（新抓，PDF 标 ${parsed.asOf ?? '?'}，${parsed.rows.length} 行、未交名单 ${parsed.notSubmitted.length} 队）`;
  }
  return null;
}

async function capture() {
  const D = captureDate(now, slot);
  if (!D) { console.log(`· 影子运行：现在不在 ${slot === '22' ? '22:00' : '06:30'} 时点窗口内，不记`); return; }
  const got = process.env.SHADOW_NO_FETCH ? '（未抓）' : await fetchLatest();
  const store = {
    teams: readJson('teams.json'), players: readJson('players.json'),
    schedule: readJson('schedule.json'), meta: readJson('meta.json'),
  };
  const games = store.schedule.games.filter((g) => g.type === 'regular' && g.date === D && g.homeScore == null);
  const slate = predictSchedule(buildModel(store), games, {}).map((g) => ({
    gameId: g.gameId, date: g.date, tipoff: g.dateTimeUtc, homeId: g.homeId, awayId: g.awayId,
    margin: g.prediction.margin, dataAt: store.meta.fetchedAt,
  }));
  const values = readJson('player-values.json');
  const rows = shadowRows({
    slate, slot, now, params: PARAMS, values, reports: storedReports(db, iso(now - 48 * 3600e3)), teams: store.teams,
  });
  const n = insertShadow(db, rows);
  const by = rows.reduce((o, r) => ({ ...o, [r.variant]: (o[r.variant] ?? 0) + 1 }), {});
  console.log(`· 影子运行（${slot === '22' ? '22:00' : '06:30'}，美东 ${D}）：赛程 ${games.length} 场，${JSON.stringify(by)}，新插入 ${n} 行；`
    + `报告 ${got ?? '没找到'}；球员价值 ${values ? `拟合于 ${values.fittedAt}、生成于 ${values.builtAt}` : '缺失'}`
    + `${values && !rows.some((r) => r.variant !== 'base') && rows.length ? '（过期，只记基线）' : ''}`);
}

function settle() {
  const scores = Object.fromEntries(readJson('schedule.json').games.filter((g) => g.homeScore != null)
    .map((g) => [g.gameId, { homeScore: g.homeScore, awayScore: g.awayScore }]));
  console.log(`· 影子运行结算：${settleShadow(db, scores)} 行`);
}

function show() {
  const s = shadowSummary(shadowAll(db));
  console.log(`影子运行：06:30 方案已结算 ${s.progress}/${s.target} 场，待结算 ${s.pending} 场（自 ${s.firstDate ?? '—'}）`);
  for (const v of s.variants) {
    const d = v.dLogLoss ? `  Δ ${v.dLogLoss.mean.toFixed(4)} [${v.dLogLoss.lo.toFixed(4)}, ${v.dLogLoss.hi.toFixed(4)}]（配对 ${v.paired} 场）` : '';
    console.log(`  ${v.variant.padEnd(6)} n=${v.n} LL ${v.logLoss?.toFixed(4) ?? '—'} Brier ${v.brier?.toFixed(4) ?? '—'}${d}`);
  }
}

const CMDS = { capture, settle, show };
if (!CMDS[cmd]) {
  console.error('用法：node scripts/shadow.mjs capture [--late]|settle|show');
  process.exit(2);
}
await CMDS[cmd]();
