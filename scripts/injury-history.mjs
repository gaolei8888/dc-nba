/**
 * 抓历史 NBA 官方伤病报告（PDF），每个比赛日取我们两个决策时点「当时能看到的最新一份」：
 *   22:00 北京（美东上午 9/10 点）、06:30 北京（美东傍晚 5:30/6:30）。见 server/injuryReport.mjs。
 *
 *   node scripts/injury-history.mjs [赛季…]        默认 2022-23..2025-26 再 2021-22
 *
 * 可断点续跑：已下载的 PDF、已确认不存在的文件名、每个 (比赛日, 时点) 的结论都落盘，重跑不再请求。
 * 输出目录 INJURY_DIR（默认 data/history/injury-reports，已被 .gitignore 排除）：
 *   pdf/<名>.pdf、json/<名>.json（解析结果）、index.json（{ picks_lag<分>: {"日期|时点": 名|null}, missing: [名…] }）
 * INJURY_LAG_MIN（默认 15）：报告标注时间要早于决策时点这么多分钟才算「当时看得到」——PDF 准点生成，
 * 挂上网要几分钟，标注时间 = 决策时点的那份决策时多半还拿不到。0 只作敏感性对照。
 * 请求全部走 politeFetch：1.5–3 秒随机间隔（robots crawl-delay 1 秒）、上限、熔断。
 * S3 对不存在的文件回 403 AccessDenied XML，按「没有这份」处理；别的 403/429/超时照样熔断停手。
 * 解析 PDF 用系统的 pdftotext（poppler），不引入 npm 依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromeHeaders, createPoliteClient } from '../server/politeFetch.mjs';
import { REPORT_BASE, candidates, decisionInstant, isS3Missing, parseReportText } from '../server/injuryReport.mjs';

const env = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
const DIR = process.env.INJURY_DIR ?? 'data/history/injury-reports';
const SEASONS = process.argv.slice(2).length ? process.argv.slice(2) : ['2022-23', '2023-24', '2024-25', '2025-26', '2021-22'];
const LAG_MIN = env('INJURY_LAG_MIN', 15);
const MAX_BACK = { hour: 8, minute: 12 };   // 往前最多找几份（旧版 8 小时、新版 3 小时）

// 像从 official.nba.com 的伤病报告页点开 PDF：顶层导航，不是 fetch
const { Origin, ...base } = chromeHeaders({ referer: 'https://official.nba.com/', origin: '' });
const http = createPoliteClient({
  name: 'nba-injury',
  headers: {
    ...base,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', priority: 'u=0, i',
  },
  gapMs: [env('INJURY_MIN_GAP_MS', 1500), env('INJURY_MAX_GAP_MS', 3000)],
  pauseEvery: [25, 50],
  pauseMs: [5000, 15000],
  maxPerRun: env('INJURY_MAX_REQUESTS', 4000),
  maxPerDay: env('INJURY_MAX_PER_DAY', 6000),
  timeoutMs: 30000,
});
const asPdf = (r) => {
  if (!r.bytes || r.bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('不是 PDF');
  return r.bytes;
};

for (const d of ['pdf', 'json']) fs.mkdirSync(path.join(DIR, d), { recursive: true });
const indexPath = path.join(DIR, 'index.json');
const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : { missing: [] };
const PICKS = `picks_lag${LAG_MIN}`;
if (index.picks) { index.picks_lag0 = index.picks; delete index.picks; }   // 早期版本只有「不留延迟」那一套
index[PICKS] ??= {};
const sinceHit = { misses: [], keys: [] };   // 上次找到报告以来记下的「不存在」，连续找不到时要撤回
const missing = new Set(index.missing);
const save = () => {
  index.missing = [...missing];
  fs.writeFileSync(`${indexPath}.tmp`, JSON.stringify(index));
  fs.renameSync(`${indexPath}.tmp`, indexPath);
};
const stats = { requests: 0, hits: 0, notFound: 0, cached: 0 };

/** 有就返回 true（并落盘 PDF + 解析），确认没有返回 false */
async function have(name) {
  const pdf = path.join(DIR, 'pdf', `${name}.pdf`);
  if (fs.existsSync(pdf)) { stats.cached++; return true; }
  if (missing.has(name)) return false;
  stats.requests++;
  const bytes = await http.get(`${REPORT_BASE}${name}.pdf`, { notFoundOk: isS3Missing, parse: asPdf });
  if (!bytes) { stats.notFound++; missing.add(name); sinceHit.misses.push(name); return false; }
  stats.hits++;
  sinceHit.misses = []; sinceHit.keys = [];
  fs.writeFileSync(`${pdf}.tmp`, bytes);
  fs.renameSync(`${pdf}.tmp`, pdf);
  const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  fs.writeFileSync(path.join(DIR, 'json', `${name}.json`), JSON.stringify(parseReportText(text)));
  return true;
}

const dataset = JSON.parse(fs.readFileSync('data/backtest.json', 'utf8'));
let style = 'hour';
let streak = 0;
try {
  for (const season of SEASONS) {
    const dates = [...new Set(dataset.seasons[season].map((r) => r.d))].sort();
    style = 'hour';
    for (const date of dates) {
      for (const slot of ['22', '0630']) {
        const key = `${date}|${slot}`;
        if (key in index[PICKS]) continue;
        const at = decisionInstant(date, slot) - LAG_MIN * 60000;
        let pick = null;
        // 2025-26 赛季中途从每小时一份改成每 15 分钟一份：旧写法第一份就没有时，试一下新写法，认出就一直用新写法
        if (style === 'hour' && !(await have(candidates(at, 'hour', 1)[0].name))
          && (await have(candidates(at, 'minute', 1)[0].name))) style = 'minute';
        for (const c of candidates(at, style, MAX_BACK[style])) if (await have(c.name)) { pick = c.name; break; }
        index[PICKS][key] = pick;
        if (!pick) sinceHit.keys.push(key);
        streak = pick ? 0 : streak + 1;
        if (streak >= 6) {
          // 可能是被拦了但回的也是 AccessDenied XML：撤回这一串「不存在」，下次重跑会重新请求
          for (const n of sinceHit.misses) missing.delete(n);
          for (const k of sinceHit.keys) delete index[PICKS][k];
          throw new Error(`连续 ${streak} 个时点都找不到报告（最近 ${key}），已撤回这段的「不存在」记录，停下来人工看看`);
        }
      }
      save();
    }
    console.log(`${season} 完成`, stats);
  }
} finally {
  save();
  const picks = Object.values(index[PICKS]);
  console.log('统计', stats, `时点 ${picks.length} 个，找到 ${picks.filter(Boolean).length}`);
}
