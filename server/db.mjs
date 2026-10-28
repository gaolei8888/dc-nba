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
 * 模拟投注前向账本（见 server/ledger.mjs）。**只追加**，约束写在库里而不是只靠代码自觉：
 *   - 同一 (game_id, rule, book) 再插入一律忽略——BEFORE INSERT 触发器 RAISE(IGNORE)，
 *     连 INSERT OR REPLACE 也绕不过去（REPLACE 的隐式删除默认不触发 DELETE 触发器）；
 *   - 不能删除；
 *   - 记录时的字段（价格、概率、方向……）任何时候都不能改；
 *   - 结算字段只能和 settled_at 一起、从空写成值一次；收盘价/CLV 同样（可以比比分晚到）。
 *   注意：SQLite 挡不住 DROP TRIGGER 之后再改——这防的是程序 bug 和手滑，不防有意篡改。
 */
const FROZEN = ['game_id', 'rule', 'book', 'captured_at', 'event_id', 'game_date', 'tipoff_utc',
  'home_id', 'away_id', 'model_p_home', 'home_elo', 'away_elo', 'home_ml', 'away_ml', 'price_at',
  'open_home_ml', 'open_away_ml', 'odds_fetched_at', 'book_p_home', 'edge', 'threshold', 'bet', 'side', 'bet_ml'];
const SCORE = ['home_score', 'away_score', 'won', 'profit', 'settled_at'];
const CLOSE = ['close_home_ml', 'close_away_ml', 'clv'];
const changed = (cols) => cols.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ');
export const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS paper_bets (
  game_id       TEXT NOT NULL,
  rule          TEXT NOT NULL,
  book          TEXT NOT NULL,
  captured_at   TEXT NOT NULL,
  event_id      TEXT,
  game_date     TEXT NOT NULL,
  tipoff_utc    TEXT,
  home_id       INTEGER NOT NULL,
  away_id       INTEGER NOT NULL,
  model_p_home  REAL NOT NULL,
  home_elo      REAL,
  away_elo      REAL,
  home_ml       INTEGER NOT NULL,
  away_ml       INTEGER NOT NULL,
  price_at      TEXT NOT NULL,
  open_home_ml  INTEGER,
  open_away_ml  INTEGER,
  odds_fetched_at TEXT,
  book_p_home   REAL NOT NULL,
  edge          REAL NOT NULL,
  threshold     REAL NOT NULL,
  bet           INTEGER NOT NULL,
  side          TEXT,
  bet_ml        INTEGER,
  home_score    INTEGER,
  away_score    INTEGER,
  won           INTEGER,
  profit        REAL,
  settled_at    TEXT,
  close_home_ml INTEGER,
  close_away_ml INTEGER,
  clv           REAL,
  PRIMARY KEY (game_id, rule, book)
);
CREATE TRIGGER IF NOT EXISTS paper_bets_dup BEFORE INSERT ON paper_bets
WHEN EXISTS (SELECT 1 FROM paper_bets WHERE game_id = NEW.game_id AND rule = NEW.rule AND book = NEW.book)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS paper_bets_no_delete BEFORE DELETE ON paper_bets
BEGIN SELECT RAISE(ABORT, 'paper_bets 只追加：不能删除'); END;
CREATE TRIGGER IF NOT EXISTS paper_bets_frozen BEFORE UPDATE ON paper_bets
WHEN ${changed(FROZEN)}
  OR (OLD.settled_at IS NOT NULL AND (${changed(SCORE)}))
  OR (NEW.settled_at IS NULL AND (${changed(SCORE)}))
  OR (OLD.close_home_ml IS NOT NULL AND (${changed(CLOSE)}))
  OR (NEW.close_home_ml IS NULL AND (${changed(CLOSE)}))
BEGIN SELECT RAISE(ABORT, 'paper_bets 只追加：已记录的字段不能改'); END;
`;

/**
 * 伤病报告影子运行（见 server/injuryShadow.mjs）：每场三套预测，只记录、不改页面显示的预测。
 *   - (game_id, variant) 只认第一次；不能删；预测与输入字段不能改；比分只写一次；
 *   - 开赛后插不进（按真实时钟，且 captured_at 必须早于开赛）；
 *   - 用到的报告标注时间必须比 captured_at 早至少 15 分钟（发布延迟）——库里兜底「不偷看未来」。
 * injury_reports：抓到的官方报告解析结果，同名只存一次，按标注时间（UTC）找「当时能看到的」那几份。
 */
const SHADOW_FROZEN = ['game_id', 'variant', 'params_version', 'captured_at', 'game_date', 'tipoff_utc', 'home_id', 'away_id',
  'base_margin', 'beta', 'adj_home', 'adj_away', 'margin', 'p_home', 'home_report', 'home_report_as_of',
  'away_report', 'away_report_as_of', 'values_fitted_at', 'values_built_at', 'data_at', 'inputs'];
const SHADOW_SCORE = ['home_score', 'away_score', 'home_win', 'settled_at'];
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
export const SHADOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS shadow_predictions (
  game_id           TEXT NOT NULL,
  variant           TEXT NOT NULL CHECK (variant IN ('base', 'r22', 'r0630')),
  params_version    INTEGER NOT NULL,
  captured_at       TEXT NOT NULL,
  game_date         TEXT NOT NULL,
  tipoff_utc        TEXT NOT NULL,
  home_id           INTEGER NOT NULL,
  away_id           INTEGER NOT NULL,
  base_margin       REAL NOT NULL,
  beta              REAL,
  adj_home          REAL,
  adj_away          REAL,
  margin            REAL NOT NULL,
  p_home            REAL NOT NULL,
  home_report       TEXT,
  home_report_as_of TEXT,
  away_report       TEXT,
  away_report_as_of TEXT,
  values_fitted_at  TEXT,
  values_built_at   TEXT,
  data_at           TEXT,
  inputs            TEXT,
  home_score        INTEGER,
  away_score        INTEGER,
  home_win          INTEGER,
  settled_at        TEXT,
  PRIMARY KEY (game_id, variant)
);
CREATE TRIGGER IF NOT EXISTS shadow_dup BEFORE INSERT ON shadow_predictions
WHEN EXISTS (SELECT 1 FROM shadow_predictions WHERE game_id = NEW.game_id AND variant = NEW.variant)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS shadow_after_tipoff BEFORE INSERT ON shadow_predictions
WHEN NEW.tipoff_utc <= ${NOW_SQL} OR NEW.captured_at >= NEW.tipoff_utc
BEGIN SELECT RAISE(ABORT, 'shadow_predictions：开赛后不能记'); END;
CREATE TRIGGER IF NOT EXISTS shadow_lookahead BEFORE INSERT ON shadow_predictions
WHEN NEW.home_report_as_of > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.captured_at, '-15 minutes')
  OR NEW.away_report_as_of > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.captured_at, '-15 minutes')
BEGIN SELECT RAISE(ABORT, 'shadow_predictions：用了记录时刻之后（未来）的报告'); END;
CREATE TRIGGER IF NOT EXISTS shadow_no_delete BEFORE DELETE ON shadow_predictions
BEGIN SELECT RAISE(ABORT, 'shadow_predictions 只追加：不能删除'); END;
CREATE TRIGGER IF NOT EXISTS shadow_frozen BEFORE UPDATE ON shadow_predictions
WHEN ${changed(SHADOW_FROZEN)}
  OR (OLD.settled_at IS NOT NULL AND (${changed(SHADOW_SCORE)}))
  OR (NEW.settled_at IS NULL AND (${changed(SHADOW_SCORE)}))
BEGIN SELECT RAISE(ABORT, 'shadow_predictions 只追加：已记录的字段不能改'); END;
CREATE TABLE IF NOT EXISTS injury_reports (
  name        TEXT PRIMARY KEY,
  as_of       TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  json        TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS injury_reports_dup BEFORE INSERT ON injury_reports
WHEN EXISTS (SELECT 1 FROM injury_reports WHERE name = NEW.name)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS injury_reports_no_delete BEFORE DELETE ON injury_reports
BEGIN SELECT RAISE(ABORT, 'injury_reports 只追加：不能删除'); END;
CREATE TRIGGER IF NOT EXISTS injury_reports_frozen BEFORE UPDATE ON injury_reports
BEGIN SELECT RAISE(ABORT, 'injury_reports 只追加：不能改'); END;
`;

/**
 * 人机对赌「本季实战」（见 server/livePlay.mjs）。和回放的 picks 表分开：回放可立即结算、
 * 题目答案早已公开，实战是开赛前下判断、赛后才知道结果，两边战绩不能混。
 *   - 一人一场一行；开赛前可改（选择与模型快照一起改），开赛后改不了——触发器按真实时钟兜底，
 *     应用层另有可注入时钟的同样检查；
 *   - 不能删；同一 (player_id, game_id) 再插入一律忽略（INSERT OR REPLACE 也绕不过），修改只能走 UPDATE；
 *   - 结算不落库：比分来自 schedule.json，读的时候现算。
 * tipoff_utc 存成 toISOString() 的定长格式，和 strftime('%Y-%m-%dT%H:%M:%fZ','now') 直接按字符串比较。
 */
export const LIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS live_picks (
  player_id     TEXT NOT NULL,
  game_id       TEXT NOT NULL,
  game_date     TEXT NOT NULL,
  tipoff_utc    TEXT NOT NULL,
  home_id       INTEGER NOT NULL,
  away_id       INTEGER NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('home', 'away')),
  conf          REAL NOT NULL CHECK (conf >= 0.5 AND conf <= 0.95),
  model_p_home  REAL NOT NULL,
  home_elo      REAL,
  away_elo      REAL,
  data_at       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  edits         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_live_picks_game ON live_picks(game_id);
CREATE TRIGGER IF NOT EXISTS live_picks_dup BEFORE INSERT ON live_picks
WHEN EXISTS (SELECT 1 FROM live_picks WHERE player_id = NEW.player_id AND game_id = NEW.game_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS live_picks_insert_locked BEFORE INSERT ON live_picks
WHEN NEW.tipoff_utc <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
BEGIN SELECT RAISE(ABORT, 'live_picks：开赛后不能改'); END;
CREATE TRIGGER IF NOT EXISTS live_picks_no_delete BEFORE DELETE ON live_picks
BEGIN SELECT RAISE(ABORT, 'live_picks：不能删除'); END;
CREATE TRIGGER IF NOT EXISTS live_picks_locked BEFORE UPDATE ON live_picks
WHEN OLD.tipoff_utc <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  OR ${changed(['player_id', 'game_id', 'game_date', 'tipoff_utc', 'home_id', 'away_id', 'created_at'])}
BEGIN SELECT RAISE(ABORT, 'live_picks：开赛后不能改'); END;
`;

/**
 * 只为某个模块打开同一个库文件、只建它自己的表（不建排行榜的表）。和排行榜开关无关：
 * 账本在本地 ENABLE_LEADERBOARD=0 时也能用，默认 data/app.db；线上是 data-db/ 卷里那份。
 * 失败返回 null 并打印原因，调用方据此降级。
 */
export function openWith(schema, label, dbPath = DB_PATH) {
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const h = new DatabaseSync(dbPath);
    h.exec('PRAGMA journal_mode = WAL');
    h.exec('PRAGMA busy_timeout = 4000');
    h.exec(schema);
    return h;
  } catch (e) {
    console.warn(`${label}不可用: ${describeFailure(e)}`);
    return null;
  }
}
// 影子运行与账本同一个句柄：同是「开赛前记下、赛后结算」的前向记录，同一个开关（ENABLE_LEDGER）
export const openLedger = (dbPath = DB_PATH) => openWith(LEDGER_SCHEMA + SHADOW_SCHEMA, '模拟投注账本', dbPath);

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
    // 本季实战的表与排行榜同库（加法迁移，不动已有表）
    db.exec(LIVE_SCHEMA);
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
/** 排行榜那份库的句柄（本季实战在排行榜开启时与它共用） */
export const handle = () => db;
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
