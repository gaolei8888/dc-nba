import React from 'react';
import { DataTable } from './common.jsx';
import { num, rate, signed, signClass } from '../lib/format.js';

const b = (key) => (r) => r.base?.[key] ?? null;
const a = (key) => (r) => r.adv?.[key] ?? null;

/** 基础数据列（场均） */
export const BASE_COLUMNS = [
  { key: 'gp', label: '出场', width: 52 },
  { key: 'min', label: '时间', width: 52, render: (r) => num(r.min) },
  { key: 'pts', label: '得分', width: 56, value: b('pts'), render: (r) => <b>{num(r.base?.pts)}</b> },
  { key: 'reb', label: '篮板', width: 56, value: b('reb'), render: (r) => num(r.base?.reb) },
  { key: 'ast', label: '助攻', width: 56, value: b('ast'), render: (r) => num(r.base?.ast) },
  { key: 'stl', label: '抢断', width: 52, value: b('stl'), render: (r) => num(r.base?.stl) },
  { key: 'blk', label: '盖帽', width: 52, value: b('blk'), render: (r) => num(r.base?.blk) },
  { key: 'tov', label: '失误', width: 52, value: b('tov'), render: (r) => num(r.base?.tov) },
  { key: 'fgPct', label: '投篮%', width: 60, value: b('fgPct'), render: (r) => rate(r.base?.fgPct) },
  { key: 'fg3m', label: '三分', width: 52, value: b('fg3m'), render: (r) => num(r.base?.fg3m) },
  { key: 'fg3Pct', label: '三分%', width: 60, value: b('fg3Pct'), render: (r) => rate(r.base?.fg3Pct) },
  { key: 'ftPct', label: '罚球%', width: 60, value: b('ftPct'), render: (r) => rate(r.base?.ftPct) },
  {
    key: 'plusMinus', label: '正负值', width: 64, value: b('plusMinus'),
    render: (r) => <span className={signClass(r.base?.plusMinus)}>{signed(r.base?.plusMinus)}</span>,
  },
];

/** 高阶数据列。impactB 是服务端拟合出的“影响力 -> 净效率”系数。 */
export const advColumns = (impactB = 2.6) => [
  { key: 'gp', label: '出场', width: 52 },
  { key: 'min', label: '时间', width: 52, render: (r) => num(r.min) },
  {
    key: 'pie', label: 'PIE', width: 58, value: a('pie'),
    title: 'Player Impact Estimate：球员对比赛所有可统计事件的贡献占比',
    render: (r) => <b>{rate(r.adv?.pie, 1)}</b>,
  },
  {
    key: 'usgPct', label: '使用率', width: 62, value: a('usgPct'),
    title: '在场时球队回合以该球员终结的比例',
    render: (r) => rate(r.adv?.usgPct),
  },
  {
    key: 'tsPct', label: '真实命中', width: 70, value: a('tsPct'),
    title: '计入三分与罚球权重的命中率',
    render: (r) => rate(r.adv?.tsPct),
  },
  { key: 'efgPct', label: '有效命中', width: 70, value: a('efgPct'), title: '三分记 1.5 倍的命中率', render: (r) => rate(r.adv?.efgPct) },
  { key: 'offRtg', label: '进攻效率', width: 70, value: a('offRtg'), title: '在场时球队每百回合得分', render: (r) => num(r.adv?.offRtg) },
  { key: 'defRtg', label: '防守效率', width: 70, value: a('defRtg'), title: '在场时球队每百回合失分', render: (r) => num(r.adv?.defRtg) },
  {
    key: 'netRtg', label: '净效率', width: 64, value: a('netRtg'),
    render: (r) => <span className={signClass(r.adv?.netRtg)}>{signed(r.adv?.netRtg)}</span>,
  },
  { key: 'astPct', label: '助攻率', width: 62, value: a('astPct'), title: '在场时队友进球由其助攻的比例', render: (r) => rate(r.adv?.astPct) },
  { key: 'rebPct', label: '篮板率', width: 62, value: a('rebPct'), render: (r) => rate(r.adv?.rebPct) },
  { key: 'tovPct', label: '失误率', width: 62, value: a('tovPct'), render: (r) => rate(r.adv?.tovPct) },
  { key: 'astTo', label: '助攻失误比', width: 78, value: a('astTo'), render: (r) => num(r.adv?.astTo, 2) },
  {
    key: 'impactRaw', label: '缺阵影响', width: 76,
    title: '该球员缺阵时模型预计球队每场净胜分的损失',
    render: (r) => (r.impactRaw > 0
      ? <span className="neg">-{num(r.impactRaw * impactB, 1)}</span>
      : <span className="dim">—</span>),
  },
];

/**
 * 球员数据表。mode: 'base' | 'adv'
 * nameColumn 可覆盖首列（例如球队页加缺阵勾选框）
 */
export default function PlayerTable({
  rows, mode = 'base', nameColumn, extraColumns = [], onRowClick, maxHeight, impactB,
}) {
  const stats = mode === 'adv' ? advColumns(impactB) : BASE_COLUMNS;
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
