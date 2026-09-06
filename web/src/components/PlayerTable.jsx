import React from 'react';
import { DataTable, Th } from './common.jsx';
import { num, rate, signed, signClass, ABBR } from '../lib/format.js';

const b = (key) => (r) => r.base?.[key] ?? null;
const a = (key) => (r) => r.adv?.[key] ?? null;

/**
 * 列定义的简写。
 * label 是「英文缩写在上、中文在下」的两行表头，所以 title 必须显式给字符串——
 * DataTable 默认拿 label 当 title，label 是 JSX 的话会渲染成 [object Object]。
 */
const col = (key, cn, width, render, opts = {}) => {
  const abbr = ABBR[opts.abbrKey ?? key];
  return {
    key,
    label: <Th abbr={abbr} cn={cn} />,
    title: opts.hint ? `${cn} ${abbr} — ${opts.hint}` : `${cn} ${abbr}`,
    width,
    render,
    ...(opts.value ? { value: opts.value } : {}),
  };
};

/** 基础数据列（场均） */
export const BASE_COLUMNS = [
  col('gp', '出场', 52, (r) => num(r.gp, 0)),
  col('min', '时间', 52, (r) => num(r.min)),
  col('pts', '得分', 56, (r) => <b>{num(r.base?.pts)}</b>, { value: b('pts') }),
  col('reb', '篮板', 56, (r) => num(r.base?.reb), { value: b('reb') }),
  col('ast', '助攻', 56, (r) => num(r.base?.ast), { value: b('ast') }),
  col('stl', '抢断', 52, (r) => num(r.base?.stl), { value: b('stl') }),
  col('blk', '盖帽', 52, (r) => num(r.base?.blk), { value: b('blk') }),
  col('tov', '失误', 52, (r) => num(r.base?.tov), { value: b('tov') }),
  col('fgPct', '投篮', 58, (r) => rate(r.base?.fgPct), { value: b('fgPct') }),
  col('fg3m', '三分球', 52, (r) => num(r.base?.fg3m), { value: b('fg3m') }),
  col('fg3Pct', '三分', 58, (r) => rate(r.base?.fg3Pct), { value: b('fg3Pct') }),
  col('ftPct', '罚球', 58, (r) => rate(r.base?.ftPct), { value: b('ftPct') }),
  col('plusMinus', '正负值', 62, (r) => (
    <span className={signClass(r.base?.plusMinus)}>{signed(r.base?.plusMinus)}</span>
  ), { value: b('plusMinus'), hint: '在场时球队的净胜分' }),
];

/** 高阶数据列 */
export const ADV_COLUMNS = [
  col('gp', '出场', 52, (r) => num(r.gp, 0)),
  col('min', '时间', 52, (r) => num(r.min)),
  col('pie', '影响力', 58, (r) => <b>{rate(r.adv?.pie, 1)}</b>, {
    value: a('pie'),
    hint: 'Player Impact Estimate，球员对比赛所有可统计事件的贡献占比',
  }),
  col('usgPct', '使用率', 60, (r) => rate(r.adv?.usgPct), {
    value: a('usgPct'), hint: '在场时球队回合以该球员终结的比例',
  }),
  col('tsPct', '真实命中', 66, (r) => rate(r.adv?.tsPct), {
    value: a('tsPct'), hint: '计入三分与罚球权重的命中率',
  }),
  col('efgPct', '有效命中', 66, (r) => rate(r.adv?.efgPct), {
    value: a('efgPct'), hint: '三分记 1.5 倍的命中率',
  }),
  col('offRtg', '进攻效率', 68, (r) => num(r.adv?.offRtg), {
    value: a('offRtg'), hint: '在场时球队每百回合得分',
  }),
  col('defRtg', '防守效率', 68, (r) => num(r.adv?.defRtg), {
    value: a('defRtg'), hint: '在场时球队每百回合失分',
  }),
  col('netRtg', '净效率', 66, (r) => (
    <span className={signClass(r.adv?.netRtg)}>{signed(r.adv?.netRtg)}</span>
  ), { value: a('netRtg'), hint: '进攻效率减防守效率' }),
  col('astPct', '助攻率', 62, (r) => rate(r.adv?.astPct), {
    value: a('astPct'), hint: '在场时队友进球由其助攻的比例',
  }),
  col('rebPct', '篮板率', 62, (r) => rate(r.adv?.rebPct), { value: a('rebPct') }),
  col('tovPct', '失误率', 62, (r) => rate(r.adv?.tovPct), { value: a('tovPct') }),
  col('astTo', '助攻失误比', 74, (r) => num(r.adv?.astTo, 2), { value: a('astTo') }),
  col('outCostPts', '缺阵影响', 74, (r) => {
    if (r.outCostPts === null || r.outCostPts === undefined) return <span className="dim">—</span>;
    if (r.outCostPts > -0.05) {
      return <span className="dim" title="PIE 低于替补级，模型认为顶替者可以打平">≈0</span>;
    }
    return <span className="neg">{num(r.outCostPts, 1)}</span>;
  }, { hint: '该球员缺阵时，模型预计球队每场净胜分的变化（空出的时间由名单里排在后面的人顶上）' }),
];

/**
 * 球员数据表。mode: 'base' | 'adv'
 * nameColumn 可覆盖首列（例如球队页加缺阵勾选框）
 */
export default function PlayerTable({
  rows, mode = 'base', nameColumn, extraColumns = [], onRowClick, maxHeight,
}) {
  const stats = mode === 'adv' ? ADV_COLUMNS : BASE_COLUMNS;
  const columns = [nameColumn, ...extraColumns, ...stats].filter(Boolean);
  return (
    <DataTable
      columns={columns}
      rows={rows}
      initialSort={{ key: mode === 'adv' ? 'pie' : 'pts', dir: 'desc' }}
      rowKey={(r) => r.playerId}
      onRowClick={onRowClick}
      maxHeight={maxHeight}
    />
  );
}
