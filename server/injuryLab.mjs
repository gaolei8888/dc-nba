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

/** 报告的开赛时间 '07:00 (ET)' 不带上下午：10、11 点按上午，12 点中午，其余按下午。返回美东当天第几分钟 */
export function tipMinutes(gameTime) {
  const m = /^(\d\d):(\d\d)/.exec(gameTime ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  return ((h >= 10 ? h : h + 12) * 60) + Number(m[2]);
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
  const hits = idx.get(full) ?? [];
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
