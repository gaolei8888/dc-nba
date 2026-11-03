/**
 * 本季球员输入的每日快照：全量 ingest 每次把「重算本季 SPM 与混合 IMP 所需的一切」存一份，
 * 以后才能研究 N 场时的估计与最终值差多少、K=20 该不该换。players.json 每次被覆盖，这段历史不存就没了。
 *
 * 纯记录：只读 ingest 手上已有的对象，不发请求，失败只警告，写盘在 ingest 所有输出之后，影响不到任何线上值。
 * 位置与字段说明见 deploy/README.md「赛季快照」。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { features, MIN_GP, MIN_MPG } from './impact.mjs';
import { readJsonAuto, writeJsonGz } from './nbaClient.mjs';

/**
 * 相对 data/。放 history/ 下是因为现成的保护都覆盖它：.gitignore（GB10 快进不动、不算本地改动）、
 * .dockerignore（不进镜像、不会被公开）、push-refresh.sh 与 refresh.sh 只认 data/ 顶层的 *.json。
 */
export const SNAPSHOT_DIR = 'history/season-snapshots';
export const SNAPSHOT_SCHEMA = 1;

/** features() 读的全部原始字段：模型换特征时这里要跟着改，测试会逐人核对 SPM */
const INPUT_FIELDS = {
  base: ['pts', 'fga', 'ast', 'tov', 'oreb', 'dreb', 'stl', 'blk', 'pf'],
  adv: ['tsPct', 'usgPct'],
  hustle: ['deflections', 'contested', 'screenAstPts'],
  defend: ['dFga', 'diffPct'],
  track: ['potentialAst'],
};

/** 打分要用的模型字段：impact-model.json 不进 git、重新拟合就覆盖，只记 hash 以后就对不回系数了 */
const MODEL_FIELDS = ['features', 'mu', 'sd', 'beta', 'intercept', 'scale', 'blendW', 'builtAt', 'seasons'];

const pickNull = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] ?? null]));
const round4 = (v) => Math.round(v * 1e4) / 1e4;

/** 按北京日期命名：定时器跑在北京 15:30，这时 GB10 的太平洋时区还是前一天 */
export const snapshotDate = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);

function codeCommit(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function snapshotRow(model, { player, cur, prior, seasonSpm }) {
  const f = features(cur);
  return {
    playerId: player.playerId,
    name: player.name,
    teamId: player.teamId,
    teamAbbr: player.teamAbbr,
    gp: cur.gp,
    min: cur.min,
    ...Object.fromEntries(Object.entries(INPUT_FIELDS).map(([group, keys]) => [group, pickNull(cur[group], keys)])),
    features: f ? Object.fromEntries(model.features.map((k) => [k, round4(f[k])])) : null,
    featuresMissing: f?.missing ?? [],
    seasonSpm,
    priorImp: prior,
    blendedImp: cur.impact,
  };
}

/**
 * @param {object} x
 * @param {Array<{player, cur, prior, seasonSpm}>} x.entries player 是身份字段所在的行，cur 是 p.cur 那份，
 *   prior 是上季 IMP（没有为 null），seasonSpm 是混合时用的本季 SPM（没进混合为 null）
 */
export function buildSnapshot({ season, model, priorGames, entries, now, meta = {}, cwd }) {
  return {
    schema: SNAPSHOT_SCHEMA,
    season,
    date: snapshotDate(now),
    capturedAt: now.toISOString(),
    codeCommit: cwd ? codeCommit(cwd) : null,
    gamesPlayedCurrent: meta.gamesPlayedCurrent ?? null,
    lastResultDate: meta.lastResultDate ?? null,
    model: {
      id: crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex').slice(0, 16),
      ...pickNull(model, MODEL_FIELDS),
    },
    imp: { priorGames, minGpNoPrior: MIN_GP, minGpWithPrior: 1, minMpg: MIN_MPG },
    players: entries.map((e) => snapshotRow(model, e)),
  };
}

const sameData = (a, b) => JSON.stringify({ ...a, capturedAt: null }) === JSON.stringify({ ...b, capturedAt: null });

/**
 * 写当天的快照。**绝不抛错**：这是研究用的数据，不值得挡住抓取或推送。
 * 同一北京日期只有一个文件：数据没变就不动（连 capturedAt 也不改），变了换成最新的（临时文件 + rename，不留半截）。
 * @returns {{status: 'written'|'unchanged'|'skipped'|'failed', file?: string}}
 */
export function saveSeasonSnapshot({
  dataDir, season, model, priorGames, entries, now = new Date(), meta,
  log = (m) => console.log('·', m), warn = (m) => console.warn(m),
}) {
  let tmp = null;
  try {
    if (!model || !entries?.length) {
      log('赛季快照：没有本季出场数据或模型，跳过');
      return { status: 'skipped' };
    }
    const doc = buildSnapshot({ season, model, priorGames, entries, now, meta, cwd: dataDir });
    const file = path.join(dataDir, SNAPSHOT_DIR, season, `${doc.date}.json.gz`);
    let old = null;
    try { old = readJsonAuto(file); } catch { /* 坏文件当没有，下面覆盖 */ }
    if (old && sameData(old, doc)) {
      log(`赛季快照：${doc.date} 已有且数据未变，不改动`);
      return { status: 'unchanged', file };
    }
    tmp = `${file}.${process.pid}.tmp.gz`;
    writeJsonGz(tmp, doc);
    fs.renameSync(tmp, file);
    tmp = null;
    log(`赛季快照：${path.relative(dataDir, file)}（${doc.players.length} 人，${(fs.statSync(file).size / 1024).toFixed(0)}KB）`);
    return { status: 'written', file };
  } catch (e) {
    warn(`  赛季快照写入失败（不影响抓取与推送）：${String(e?.message ?? e).slice(0, 200)}`);
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* 删不掉也不要紧 */ } }
    return { status: 'failed' };
  }
}
