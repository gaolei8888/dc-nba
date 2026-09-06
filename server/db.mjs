/**
 * SQLite 存储：跨用户排行榜需要服务端状态，这是唯一有状态的部分。
 *
 * 用 Node 22 内置的 node:sqlite，不引 better-sqlite3——后者要原生编译，
 * 在 alpine 容器和 Windows 上都是麻烦。
 *
 * 版本注意：早期 22.x 需要 --experimental-sqlite 标志，22.23 起不需要。
 * 如果以后有人把基础镜像往回钉到更早的 22.x，这里会以「找不到模块」失败。
 *
 * 三条设计约束：
 *  1. **写不进去要优雅降级，不能崩。** 容器以非 root 用户(uid 1001)运行，
 *     卷若归 root 就会 SQLITE_READONLY。这时服务端继续提供只读功能，
 *     排行榜接口返回明确错误，前端退回纯本地存档模式。
 *  2. **绝不相信客户端报上来的分数。** 客户端只提交"押了哪边、多少信心"，
 *     得分由服务端查真实结果自己算。否则谁都能 POST 一个 999999 分。
 *  3. **不存密码。** 身份用随机令牌，服务端只存哈希——库泄漏也换不出身份。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './nbaClient.mjs';

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

let db = null;
/** 打不开时记下原因，接口用它给出可诊断的错误 */
let disabledReason = null;

const nowIso = () => new Date().toISOString();
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export const newToken = () => crypto.randomBytes(24).toString('base64url');
export const newId = () => crypto.randomBytes(9).toString('base64url');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS picks (
  player_id     TEXT NOT NULL,
  game_id       TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'practice',
  side          TEXT NOT NULL,
  conf          REAL NOT NULL,
  correct       INTEGER NOT NULL,
  points        INTEGER NOT NULL,
  brier         REAL NOT NULL,
  model_correct INTEGER NOT NULL,
  model_points  INTEGER NOT NULL,
  model_brier   REAL NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (player_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_picks_player ON picks(player_id);
CREATE INDEX IF NOT EXISTS idx_picks_mode   ON picks(mode);
`;

/**
 * 打开数据库。任何失败都不抛，只记原因并让 isEnabled() 返回 false。
 */
export function initDb() {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 4000');
    db.exec(SCHEMA);
    // 真正写一次，确认不是只读挂载——只开成功不代表写得进去
    db.exec('CREATE TABLE IF NOT EXISTS _writecheck (x INTEGER)');
    db.exec('DROP TABLE _writecheck');
    disabledReason = null;
    console.log(`SQLite 已就绪: ${DB_PATH}`);
    return true;
  } catch (e) {
    db = null;
    disabledReason = describeFailure(e);
    console.warn(`\n排行榜功能不可用: ${disabledReason}`);
    console.warn('  服务端其余功能正常，前端会退回纯本地存档模式。\n');
    return false;
  }
}

/** 把常见的挂载权限问题翻译成能照着修的提示 */
function describeFailure(e) {
  const msg = String(e?.message ?? e);
  const where = `路径 ${DB_PATH}`;
  if (/readonly|SQLITE_READONLY|attempt to write a readonly/i.test(msg)) {
    return `数据库只读（${where}）。容器以 uid ${typeof process.getuid === 'function' ? process.getuid() : '?'} 运行，`
      + '请确认挂载卷对该用户可写，例如 chown -R 1001:1001 宿主机目录。';
  }
  if (/EACCES|permission denied/i.test(msg)) {
    return `没有写权限（${where}）。同上，检查卷的属主与权限。`;
  }
  if (/ENOENT/i.test(msg)) return `目录不存在且无法创建（${where}）。`;
  return `${msg}（${where}）`;
}

export const isEnabled = () => db !== null;
export const getDisabledReason = () => disabledReason;

// ---------------------------------------------------------------- 玩家

export function createPlayer(name) {
  const id = newId();
  const token = newToken();
  const clean = String(name ?? '').trim().slice(0, 24) || '匿名玩家';
  db.prepare(
    'INSERT INTO players (id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)',
  ).run(id, clean, hash(token), nowIso(), nowIso());
  // token 只在创建时返回一次，服务端不留明文
  return { id, name: clean, token };
}

/** 用令牌换玩家，顺便刷新 last_seen */
export function authenticate(token) {
  if (!token) return null;
  const row = db.prepare('SELECT id, name FROM players WHERE token_hash = ?').get(hash(token));
  if (!row) return null;
  db.prepare('UPDATE players SET last_seen = ? WHERE id = ?').run(nowIso(), row.id);
  return row;
}

export function renamePlayer(playerId, name) {
  const clean = String(name ?? '').trim().slice(0, 24);
  if (!clean) return false;
  db.prepare('UPDATE players SET name = ? WHERE id = ?').run(clean, playerId);
  return true;
}

// ---------------------------------------------------------------- 预测

/**
 * 写入一批预测。得分由调用方（服务端）算好传入，客户端报的分数一律忽略。
 * 同一个玩家对同一场比赛只算第一次，重复提交直接忽略。
 */
export function savePicks(playerId, rows) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO picks
      (player_id, game_id, mode, side, conf, correct, points, brier,
       model_correct, model_points, model_brier, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  // node:sqlite 的事务用 exec 包起来，批量插入快很多
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const res = stmt.run(
        playerId, r.gameId, r.mode ?? 'practice', r.side, r.conf,
        r.correct ? 1 : 0, r.points, r.brier,
        r.modelCorrect ? 1 : 0, r.modelPoints, r.modelBrier, nowIso(),
      );
      inserted += Number(res.changes ?? 0);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return inserted;
}

export function playerStats(playerId, mode) {
  const where = mode ? 'WHERE player_id = ? AND mode = ?' : 'WHERE player_id = ?';
  const args = mode ? [playerId, mode] : [playerId];
  return db.prepare(`
    SELECT COUNT(*) AS n,
           SUM(correct) AS correct,
           SUM(points) AS points,
           AVG(brier) AS brier,
           SUM(model_correct) AS model_correct,
           SUM(model_points) AS model_points,
           AVG(model_brier) AS model_brier
    FROM picks ${where}
  `).get(...args);
}

/**
 * 排行榜。默认只看至少预测过 min 场的玩家，避免"押一场全中排第一"。
 */
export function leaderboard({ mode = null, min = 10, limit = 50 } = {}) {
  const where = mode ? 'WHERE p.mode = ?' : '';
  const args = mode ? [mode, min, limit] : [min, limit];
  return db.prepare(`
    SELECT pl.id, pl.name,
           COUNT(*) AS n,
           SUM(p.correct) AS correct,
           SUM(p.points) AS points,
           AVG(p.brier) AS brier,
           SUM(p.model_points) AS model_points,
           AVG(p.model_brier) AS model_brier,
           MAX(p.created_at) AS last_at
    FROM picks p
    JOIN players pl ON pl.id = p.player_id
    ${where}
    GROUP BY pl.id
    HAVING COUNT(*) >= ?
    ORDER BY SUM(p.points) DESC
    LIMIT ?
  `).all(...args);
}

export function counts() {
  return {
    players: db.prepare('SELECT COUNT(*) AS n FROM players').get().n,
    picks: db.prepare('SELECT COUNT(*) AS n FROM picks').get().n,
  };
}
