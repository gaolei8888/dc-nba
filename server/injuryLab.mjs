/**
 * 伤病报告实验的纯逻辑（scripts/injury-lab.mjs 用）：球员价值的轮换加总、报告姓名 -> playerId、
 * P(出场 | 报告状态)、按报告算出的「预期缺阵」调整。口径与 oracle 上界实验一致：
 *   - 常规轮换 = 该队前 W 场的场均分钟（缺席算 0）；
 *   - 轮换价值 = 按分钟从多到少填满 240 分钟，每分钟乘该球员 RAPM（没有值的按 unknownV），
 *     不够 240 的用替补水平 repl 补齐，再 /48 变成「每 100 回合净胜分」量级；
 *   - 调整量 = min(0, 今天的轮换价值 − 常规轮换价值)：只罚缺人，不奖励（与 oracle d1 相同）。
 * oracle 用「今天实际谁上场」；这里用报告：每人分钟乘 P(出场 | 状态)，没上报告的按 1。
 */
import { normalizeName } from './espnClient.mjs';
import { flipName } from './injuryReport.mjs';

export const STATUS_KEYS = ['Out', 'Doubtful', 'Questionable', 'Probable', 'Available'];

/** list: [{ id, m }]（会被排序），val: Map(id -> 每 100 回合净值) */
export function rotValue(list, val, { unknownV = -1, repl = -2 } = {}) {
  const sorted = [...list].sort((a, b) => b.m - a.m);
  let rem = 240; let sum = 0;
  for (const p of sorted) {
    if (rem <= 0) break;
    const m = Math.min(p.m, rem);
    sum += (val.get(p.id) ?? unknownV) * m;
    rem -= m;
  }
  return (sum + repl * rem) / 48;
}

/** 一场的段 -> { home: Map(id -> 分钟), away: Map }。段格式见 scripts/pbp-history.mjs：前 10 位是主 5 客 5，x[14] 是秒 */
export function stintMinutes(st) {
  const home = new Map(); const away = new Map();
  for (const x of st) {
    for (let i = 0; i < 5; i++) home.set(x[i], (home.get(x[i]) ?? 0) + x[14] / 60);
    for (let i = 5; i < 10; i++) away.set(x[i], (away.get(x[i]) ?? 0) + x[14] / 60);
  }
  return { home, away };
}

/**
 * 常规轮换：比赛日 date 之前最近 W 场的场均分钟（缺席算 0）。recent: [{ date, mins: Map 或 {id: 分钟} }]，按日期升序。
 * 不足 3 场返回 null（调整记 0）
 */
export function usualRotation(recent, date, W = 10) {
  const past = recent.filter((g) => g.date < date).slice(-W);
  if (past.length < 3) return null;
  const tot = new Map();
  for (const g of past) for (const [id, m] of g.mins instanceof Map ? g.mins : Object.entries(g.mins)) tot.set(Number(id), (tot.get(Number(id)) ?? 0) + m);
  return [...tot].map(([id, m]) => ({ id, m: m / past.length }));
}

/**
 * RAPM 的训练段：parts = [{ w, games: [{ date, st }] }]，w = 1 的是本季，只取 before 之前的场；
 * 往季（w < 1）整季都用，回合与得分按 w 缩放（效率不变、权重变小），秒数不变。
 */
export function weightedStints(parts, before) {
  const merged = [];
  for (const { w, games } of parts) {
    for (const g of games) {
      if (w === 1 && g.date >= before) continue;
      for (const x of g.st) merged.push(w === 1 ? x : [...x.slice(0, 10), x[10] * w, x[11] * w, x[12] * w, x[13] * w, x[14]]);
    }
  }
  return merged;
}

/**
 * 按报告的预期缺阵调整。statusOf(id) -> 状态或 undefined（不在报告上），pPlay[状态] = 出场概率。
 * 球队没交名单（NOT YET SUBMITTED）或报告里没有这场：调用方别调这个，调整记 0。
 */
export function reportAdj(usual, statusOf, pPlay, val, opts) {
  const scaled = usual.map((p) => {
    const s = statusOf(p.id);
    return { id: p.id, m: p.m * (s === undefined ? 1 : pPlay[s] ?? 1) };
  });
  return Math.min(0, rotValue(scaled, val, opts) - rotValue(usual, val, opts));
}

/**
 * 报告的开赛时间 '07:00 (ET)' 不带上下午：12 点是中午，其余（含 10:00、10:30 的西部夜场）一律下午。
 * 上午 11 点开的场极少，算成晚上只会让它不被当作「06:30 时已开打」。返回美东当天第几分钟
 */
export function tipMinutes(gameTime) {
  const m = /^(\d\d):(\d\d)/.exec(gameTime ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  return ((h === 12 ? 12 : h + 12) * 60) + Number(m[2]);
}

/** people: [{ id, name:'First Last' }] -> Map(规范化姓名 -> [id…]) */
export function nameIndex(people) {
  const idx = new Map();
  for (const { id, name } of people) {
    const k = normalizeName(name);
    if (!idx.has(k)) idx.set(k, []);
    if (!idx.get(k).includes(id)) idx.get(k).push(id);
  }
  return idx;
}

/**
 * 报告里的 'Last, First' -> playerId。先按全名（去重音/后缀/标点）；重名时取本季在这支队打过球的那个。
 * 全名对不上（昵称、改名）就在该队本季名单里找「姓相同且名首字母相同」的唯一一人。
 * roster: 该队本季上过场的 id 集合；nameOf: id -> 'First Last'。都对不上返回 null。
 */
export function matchName(reportName, idx, roster, nameOf) {
  const full = normalizeName(flipName(reportName));
  // 姓在前的名字（Yang Hansen、Cui Yongxi）NBA 名单里就按报告里的顺序写
  const hits = idx.get(full) ?? idx.get(normalizeName(reportName.replace(',', ' '))) ?? [];
  if (hits.length === 1) return hits[0];
  const inTeam = hits.filter((id) => roster.has(id));
  if (inTeam.length === 1) return inTeam[0];
  if (hits.length) return null;
  const parts = full.split(' ');
  const [first, last] = [parts[0], parts.slice(1).join(' ')];
  const loose = [...roster].filter((id) => {
    const n = normalizeName(nameOf(id) ?? '').split(' ');
    return n.slice(1).join(' ') === last && n[0]?.[0] === first?.[0];
  });
  return loose.length === 1 ? loose[0] : null;
}

/**
 * obs: [{ status, played }] -> { 状态: { n, p } }。weight(o) 给每个观测加权（如按常规分钟），
 * p = (Σw·出场 + 0.5) / (Σw + 1)，免得小样本出 0/1。
 */
export function playRates(obs, weight = () => 1) {
  const out = {};
  for (const s of STATUS_KEYS) {
    const sub = obs.filter((o) => o.status === s);
    const w = sub.reduce((a, o) => a + weight(o), 0);
    const k = sub.reduce((a, o) => a + (o.played ? weight(o) : 0), 0);
    out[s] = { n: sub.length, p: (k + 0.5) / (w + 1) };
  }
  return out;
}
