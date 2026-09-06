/**
 * 只重建实验室数据集（data/backtest.json），不去 stats.nba.com 拉数据。
 *
 *   node scripts/build-dataset.mjs
 *
 * 用途：抓完历史盘口（npm run odds:history）之后把盘口并进数据集。
 * 全量 ingest 也会做这一步，但那要重新拉 30 支球队的名单，没必要。
 */
import { buildBacktestDataset } from '../server/dataset.mjs';

const out = buildBacktestDataset();
if (!out) process.exit(1);
