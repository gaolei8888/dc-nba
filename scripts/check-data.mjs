/**
 * 数据量纲体检：抓完之后跑一遍，防止"同名字段量纲不同"这类错误流到界面上。
 *
 *   node scripts/check-data.mjs
 *
 * 起因是一个真实的坑：`TM_TOV_PCT` 在 leaguedashteamstats 里是小数（0.124），
 * 在 leaguedashplayerstats 里却已经是百分数（8.7）。显示层两边都乘 100，
 * 于是球员的失误率显示成 870.0%。这种错误单看代码看不出来，
 * 但只要检查一下数值范围就一目了然。
 *
 * 规则很简单：凡是约定以小数存储的比率字段，全联盟最大值不该超过 1.2。
 */
import { readJson } from '../server/nbaClient.mjs';

/** 约定以小数存储的比率字段（显示层会乘 100） */
const FRACTION_FIELDS = {
  'players[].adv': ['usgPct', 'tsPct', 'efgPct', 'astPct', 'orebPct', 'drebPct', 'rebPct', 'tovPct', 'pie'],
  'players[].est': ['usgPct', 'tovPct', 'rebPct'],
  'players[].base': ['fgPct', 'fg3Pct', 'ftPct'],
  'players[].defend': ['dFgPct', 'normalFgPct', 'freq'],
  'players[].track': ['driveFgPct', 'csEfg', 'puEfg', 'orebChancePct', 'drebChancePct'],
  'teams[].adv': ['astPct', 'orebPct', 'drebPct', 'rebPct', 'tovPct', 'efgPct', 'tsPct', 'pie'],
  'teams[].fourFactors': ['efgPct', 'ftaRate', 'tovPct', 'orebPct', 'oppEfgPct', 'oppFtaRate', 'oppTovPct', 'oppOrebPct'],
  'teams[].base': ['fgPct', 'fg3Pct', 'ftPct'],
  'teams[].scoring': ['pct2pt', 'pct3pt', 'pctPaint', 'pctFastBreak', 'pctFt', 'pctAssisted'],
};

/** 这些字段本来就不是小数，列在这里是为了说明"我知道，不是漏了" */
const KNOWN_NOT_FRACTIONS = {
  'players[].adv': ['astRatio', 'astTo', 'pace', 'poss', 'offRtg', 'defRtg', 'netRtg'],
  'players[].defend': ['diffPct'],   // 差值，范围约 ±0.15，本身就是小数但可为负
};

/**
 * 上限。多数比率不会超过 1，留 1.2 的余量。
 * 但 eFG% 与 TS% 的理论最大值是 **1.5**——只出手一次三分且命中，
 * eFG = (1 + 0.5) / 1 = 1.5。这不是异常，是定义。
 */
const MAX_FRACTION = 1.2;
const EFG_LIKE = new Set(['tsPct', 'efgPct', 'csEfg', 'puEfg']);
const maxFor = (f) => (EFG_LIKE.has(f) ? 1.5 : MAX_FRACTION);
let problems = 0;

function checkGroup(label, rows, group, fields) {
  for (const f of fields) {
    const vals = rows
      .map((r) => (group ? (r[group] ?? {})[f] : r[f]))
      .filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    if (!vals.length) {
      console.log(`  ⚠ ${label}.${f}  没有任何数值（字段名写错了？）`);
      problems += 1;
      continue;
    }
    const mx = Math.max(...vals.map(Math.abs));
    const cap = maxFor(f);
    if (mx > cap) {
      console.log(`  ✗ ${label}.${f}  最大 ${mx.toFixed(3)} 超过 ${cap}`
        + `——约定按小数存储，显示层会再乘 100，这里很可能已经是百分数了`);
      problems += 1;
    }
  }
}

const players = readJson('players.json');
const teams = readJson('teams.json');
if (!players || !teams) {
  console.error('缺少 data/players.json 或 data/teams.json，先运行 npm run ingest');
  process.exit(1);
}

console.log('\n数据量纲体检\n');
for (const [path, fields] of Object.entries(FRACTION_FIELDS)) {
  const [src, group] = path.replace('[]', '').split('.');
  const rows = src === 'players' ? players : teams;
  checkGroup(path, rows, group, fields);
}

// 顺带检查影响力指标的取值范围是否落在训练区间内
const withImpact = players.filter((p) => p.impact !== undefined && p.impact !== null);
if (withImpact.length) {
  const v = withImpact.map((p) => p.impact);
  const lo = Math.min(...v); const hi = Math.max(...v);
  console.log(`\n  IMP：${withImpact.length} 人，范围 ${lo.toFixed(2)} ~ ${hi.toFixed(2)}`);
  // 训练区间内的球员 IMP 大致在 ±15 以内，超出说明护栏漏了
  if (lo < -20 || hi > 20) {
    console.log('  ✗ IMP 超出合理范围（±20），说明模型被用到了训练区间之外的球员身上');
    problems += 1;
  }
  const under = withImpact.filter((p) => (p.gp ?? 0) < 20 || (p.min ?? 0) < 10);
  if (under.length) {
    console.log(`  ✗ ${under.length} 名不满足训练门槛的球员也有 IMP（应为空值）`);
    problems += 1;
  }
}

if (problems) {
  console.log(`\n发现 ${problems} 处问题\n`);
  process.exit(1);
}
console.log('\n量纲检查通过\n');
