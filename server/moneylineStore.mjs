// 独赢盘回测报告（data/moneyline-backtest.json）的加载：主线程与每个 worker 各持一份，
// 每次取用先看文件 mtime，变了就重读——报告重建后不需要重启服务，旧结果也不会被继续使用。
// 测试可用环境变量 ML_REPORT 指向别的文件。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './nbaClient.mjs';

export const ML_REPORT_PATH = process.env.ML_REPORT || path.join(DATA_DIR, 'moneyline-backtest.json');

/** 每个调用方持有一个加载器（状态不跨线程共享） */
export function reportLoader(file = ML_REPORT_PATH) {
  let cur = { data: null, mtimeMs: null };
  let warned = false;
  return () => {
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* 缺失 */ }
    // 运维提示只进日志（页面对访客只说「尚未生成」）；每个加载器缺失期间只提示一次，文件出现后复位
    if (mtimeMs == null && !warned) {
      console.warn(`未找到独赢盘回测报告 ${file}：在本机运行 npm run ml:backtest，再把它放进服务器 data/（见 deploy/README.md）`);
      warned = true;
    } else if (mtimeMs != null) warned = false;
    if (mtimeMs !== cur.mtimeMs) {
      let data = null;
      if (mtimeMs != null) {
        try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`独赢盘报告读取失败: ${e.message}`); }
      }
      cur = { data, mtimeMs };
    }
    return cur;
  };
}
