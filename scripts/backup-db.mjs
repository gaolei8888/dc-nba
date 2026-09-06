/**
 * 备份排行榜数据库。
 *
 * **不能用 cp。** 开了 WAL 模式后，最新的事务还在 app.db-wal 里没落到主库，
 * 直接复制 app.db 会拿到一个半截状态。这里用 SQLite 自己的 `VACUUM INTO`：
 * 它在一个一致性快照上工作，产出的是可直接使用的完整单文件，
 * 而且顺带压掉碎片，不需要停服，也不需要容器里装 sqlite3 命令行。
 *
 *   node scripts/backup-db.mjs                        # 写到 <db目录>/backups/
 *   node scripts/backup-db.mjs /path/to/backups       # 指定目录
 *   KEEP=14 node scripts/backup-db.mjs                # 只保留最近 14 份
 *
 * 容器内跑（cron 示例，每天 3:20）：
 *   20 3 * * * docker exec dc-nba node scripts/backup-db.mjs >> /var/log/dc-nba-backup.log 2>&1
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db');
const OUT_DIR = process.argv[2] || path.join(path.dirname(DB_PATH), 'backups');
const KEEP = Number(process.env.KEEP) || 7;

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`数据库不存在: ${DB_PATH}（排行榜可能未启用，无需备份）`);
    process.exit(0);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(OUT_DIR, `app-${stamp}.db`);

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    // VACUUM INTO 的目标文件必须不存在
    if (fs.existsSync(target)) fs.unlinkSync(target);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  const size = fs.statSync(target).size;
  console.log(`备份完成: ${target} (${(size / 1024).toFixed(1)} KB)`);

  // 只留最近 KEEP 份
  const olds = fs.readdirSync(OUT_DIR)
    .filter((f) => /^app-.*\.db$/.test(f))
    .sort()
    .reverse()
    .slice(KEEP);
  for (const f of olds) {
    fs.unlinkSync(path.join(OUT_DIR, f));
    console.log(`  清理旧备份 ${f}`);
  }
}

try {
  main();
} catch (e) {
  console.error('备份失败:', e.message);
  process.exit(1);
}
