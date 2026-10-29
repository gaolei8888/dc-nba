import React, { useMemo } from 'react';
import { DataTable, Th } from './common.jsx';
import { useI18n } from '../i18n/react.jsx';
import { num, rate, signed, signClass, ABBR } from '../lib/format.js';

const b = (key) => (r) => r.base?.[key] ?? null;
const a = (key) => (r) => r.adv?.[key] ?? null;
const e = (key) => (r) => r.est?.[key] ?? null;
const h = (key) => (r) => r.hustle?.[key] ?? null;
const d = (key) => (r) => r.defend?.[key] ?? null;
const t = (key) => (r) => r.track?.[key] ?? null;
const m = (key) => (r) => r.misc?.[key] ?? null;

/** 缺数据时显示破折号，而不是 0——0 和"没有记录"是两回事 */
const dash = <span className="dim">—</span>;
const val = (v, f) => (v === null || v === undefined ? dash : f(v));

/**
 * 比率类数据的样本门槛。
 *
 * 不是拍脑袋定的：对位出手不足 150 次时，对位压制（DIFF%）的标准差是 13.68 个百分点，
 * 超过 300 次只有 3.04——小样本的噪声是 4.5 倍。不设门槛的话榜首永远是
 * 只防过 5 次出手、DIFF% -43.7% 的边缘球员，那不是防守好，那是运气。
 *
 * 处理方式是**不参与排名但仍然显示**：value 返回 null，DataTable 会把 null 排到最后
 * （升序降序都一样），数值本身照常渲染，只是变灰并注明样本量。隐藏行会让人以为数据缺失。
 */
const QUALIFY = { defend: 200, drive: 100, catchShoot: 100, pullUp: 100 };

/** total 为该项的赛季总出手/总对位次数 */
/** 赛季总对位出手 = 场均 × 出场 */
const defendedFga = (r) => (r.defend?.dFga ?? 0) * (r.gp ?? 0);

const qualified = (total, min) => total !== null && total !== undefined && total >= min;

/** 生成一个「够样本才参与排名」的列 */
const rateCol = (key, width, get, totalOf, min, opts = {}) => col(
  key, width,
  (r, t) => {
    const v = get(r);
    if (v === null || v === undefined) return dash;
    const total = totalOf(r);
    const ok = qualified(total, min);
    const text = opts.render ? opts.render(v) : rate(v);
    return ok ? text : (
      <span className="dim" title={t('playerTable.sampleLow', { count: Math.round(total ?? 0) })}>{text}</span>
    );
  },
  { ...opts, value: (r) => (qualified(totalOf(r), min) ? get(r) : null) },
);

/**
 * 列定义的简写（规格，尚未翻译）。
 * 列名取 playerTable.<key>，悬停说明取 playerTable.hint.<key>（opts.hint 为真时）；
 * 真正的表头在 PlayerTable 里按当前语言用 buildColumns 生成。
 * render(r, t) 的第二个参数是翻译函数，供需要文案的单元格（如样本不足的提示）使用。
 */
const col = (key, width, render, opts = {}) => ({
  key,
  abbr: ABBR[opts.abbrKey ?? key],
  width,
  render,
  hint: !!opts.hint,
  ...(opts.value ? { value: opts.value } : {}),
});

/**
 * 把列规格翻成 DataTable 的列。
 * label 是「英文缩写在上、中文在下」的两行表头（英文界面只显示缩写），所以 title 必须显式给字符串——
 * DataTable 默认拿 label 当 title，label 是 JSX 的话会渲染成 [object Object]。
 */
const buildColumns = (specs, t) => specs.map((c) => {
  const name = t(`playerTable.${c.key}`);
  return {
    key: c.key,
    label: <Th abbr={c.abbr} label={name} />,
    title: c.hint ? `${name} ${c.abbr} — ${t(`playerTable.hint.${c.key}`)}` : `${name} ${c.abbr}`,
    width: c.width,
    render: (r) => c.render(r, t),
    ...(c.value ? { value: c.value } : {}),
  };
});

/** 每种视图都带的前两列 */
const LEAD = [
  col('gp', 52, (r) => num(r.gp, 0)),
  col('min', 52, (r) => num(r.min)),
];

/** 基础数据列（场均） */
export const BASE_COLUMNS = [
  ...LEAD,
  col('pts', 56, (r) => <b>{num(r.base?.pts)}</b>, { value: b('pts') }),
  col('reb', 56, (r) => num(r.base?.reb), { value: b('reb') }),
  col('ast', 56, (r) => num(r.base?.ast), { value: b('ast') }),
  col('stl', 52, (r) => num(r.base?.stl), { value: b('stl') }),
  col('blk', 52, (r) => num(r.base?.blk), { value: b('blk') }),
  col('tov', 52, (r) => num(r.base?.tov), { value: b('tov') }),
  col('fgPct', 58, (r) => rate(r.base?.fgPct), { value: b('fgPct') }),
  col('fg3m', 56, (r) => num(r.base?.fg3m), { value: b('fg3m') }),
  col('fg3Pct', 58, (r) => rate(r.base?.fg3Pct), { value: b('fg3Pct') }),
  col('ftPct', 58, (r) => rate(r.base?.ftPct), { value: b('ftPct') }),
  col('plusMinus', 62, (r) => (
    <span className={signClass(r.base?.plusMinus)}>{signed(r.base?.plusMinus)}</span>
  ), { value: b('plusMinus'), hint: true }),
];

/** 高阶数据列 */
export const ADV_COLUMNS = [
  ...LEAD,
  col('impact', 76, (r) => (r.impact === null || r.impact === undefined ? dash : (
    <b className={signClass(r.impact)}>{signed(r.impact, 1)}</b>
  )), {
    hint: true,
  }),
  col('pie', 62, (r) => <b>{rate(r.adv?.pie, 1)}</b>, {
    value: a('pie'),
    hint: true,
  }),
  col('estNetRtg', 78, (r) => val(r.est?.netRtg, (v) => (
    <span className={signClass(v)}>{signed(v, 1)}</span>
  )), {
    value: e('netRtg'),
    hint: true,
  }),
  col('usgPct', 60, (r) => rate(r.adv?.usgPct), {
    value: a('usgPct'), hint: true,
  }),
  col('tsPct', 66, (r) => rate(r.adv?.tsPct), {
    value: a('tsPct'), hint: true,
  }),
  col('efgPct', 66, (r) => rate(r.adv?.efgPct), {
    value: a('efgPct'), hint: true,
  }),
  col('offRtg', 68, (r) => num(r.adv?.offRtg), {
    value: a('offRtg'), hint: true,
  }),
  col('defRtg', 68, (r) => num(r.adv?.defRtg), {
    value: a('defRtg'), hint: true,
  }),
  col('netRtg', 66, (r) => (
    <span className={signClass(r.adv?.netRtg)}>{signed(r.adv?.netRtg)}</span>
  ), { value: a('netRtg'), hint: true }),
  col('astPct', 62, (r) => rate(r.adv?.astPct), {
    value: a('astPct'), hint: true,
  }),
  col('rebPct', 62, (r) => rate(r.adv?.rebPct), { value: a('rebPct') }),
  col('tovPct', 62, (r) => rate(r.adv?.tovPct), { value: a('tovPct') }),
  col('astTo', 74, (r) => num(r.adv?.astTo, 2), { value: a('astTo') }),
  col('outCostPts', 74, (r, t) => {
    if (r.outCostPts === null || r.outCostPts === undefined) return dash;
    if (r.outCostPts > -0.05) {
      return <span className="dim" title={t('playerTable.outCostZero')}>≈0</span>;
    }
    return <span className="neg">{num(r.outCostPts, 1)}</span>;
  }, { hint: true }),
];

/**
 * 防守与拼抢。
 * 抢断盖帽只反映了防守的一小部分，这里的对位命中率与拼抢数据
 * 才是公开数据里最接近"这个人防守好不好"的东西。
 */
export const DEFENSE_COLUMNS = [
  ...LEAD,
  rateCol('diffPct', 72, d('diffPct'), defendedFga, QUALIFY.defend, {
    // 负数 = 把对手压到了低于其正常命中率，是好事，所以取反上色
    render: (v) => <b className={signClass(-v)}>{signed(v * 100, 1)}</b>,
    hint: true,
  }),
  rateCol('dFgPct', 68, d('dFgPct'), defendedFga, QUALIFY.defend, {
    hint: true,
  }),
  col('dFga', 68, (r) => val(r.defend?.dFga, (v) => num(v)), {
    value: d('dFga'), hint: true,
  }),
  col('contested', 72, (r) => val(r.hustle?.contested, (v) => num(v)), {
    value: h('contested'), hint: true,
  }),
  col('deflections', 64, (r) => val(r.hustle?.deflections, (v) => num(v)), {
    value: h('deflections'), hint: true,
  }),
  col('stl', 52, (r) => num(r.base?.stl), { value: b('stl') }),
  col('blk', 52, (r) => num(r.base?.blk), { value: b('blk') }),
  col('charges', 64, (r) => val(r.hustle?.charges, (v) => num(v, 2)), {
    value: h('charges'), hint: true,
  }),
  col('looseBalls', 64, (r) => val(r.hustle?.looseBalls, (v) => num(v)), {
    value: h('looseBalls'), hint: true,
  }),
  col('boxOuts', 56, (r) => val(r.hustle?.boxOuts, (v) => num(v)), {
    value: h('boxOuts'), hint: true,
  }),
  col('drebChancePct', 88, (r) => val(r.track?.drebChancePct, (v) => rate(v)), {
    value: t('drebChancePct'), hint: true,
  }),
  col('defRtg', 68, (r) => num(r.adv?.defRtg), { value: a('defRtg') }),
];

/** 得分方式：球从哪来、怎么进的 */
export const SCORING_COLUMNS = [
  ...LEAD,
  col('pts', 56, (r) => <b>{num(r.base?.pts)}</b>, { value: b('pts') }),
  col('drives', 56, (r) => val(r.track?.drives, (v) => num(v)), {
    value: t('drives'), hint: true,
  }),
  col('drivePts', 72, (r) => val(r.track?.drivePts, (v) => num(v)), {
    value: t('drivePts'),
  }),
  rateCol('driveFgPct', 72, t('driveFgPct'),
    (r) => (r.track?.driveFga ?? 0) * (r.gp ?? 0), QUALIFY.drive, {}),
  col('csPts', 88, (r) => val(r.track?.csPts, (v) => num(v)), {
    value: t('csPts'), hint: true,
  }),
  rateCol('csEfg', 88, t('csEfg'),
    (r) => (r.track?.csFga ?? 0) * (r.gp ?? 0), QUALIFY.catchShoot, {}),
  col('puPts', 72, (r) => val(r.track?.puPts, (v) => num(v)), {
    value: t('puPts'), hint: true,
  }),
  rateCol('puEfg', 88, t('puEfg'),
    (r) => (r.track?.puFga ?? 0) * (r.gp ?? 0), QUALIFY.pullUp, {}),
  col('ptsPaint', 82, (r) => val(r.misc?.ptsPaint, (v) => num(v)), {
    value: m('ptsPaint'),
  }),
  col('ptsFb', 72, (r) => val(r.misc?.ptsFb, (v) => num(v)), { value: m('ptsFb') }),
  col('pts2nd', 72, (r) => val(r.misc?.pts2nd, (v) => num(v)), { value: m('pts2nd') }),
  col('ptsOffTov', 72, (r) => val(r.misc?.ptsOffTov, (v) => num(v)), {
    value: m('ptsOffTov'), hint: true,
  }),
  col('pfd', 64, (r) => val(r.misc?.pfd, (v) => num(v)), {
    value: m('pfd'), hint: true,
  }),
];

/** 传球与控球：真正的组织能力，助攻数看不出来 */
export const PLAYMAKING_COLUMNS = [
  ...LEAD,
  col('ast', 56, (r) => num(r.base?.ast), { value: b('ast') }),
  col('potentialAst', 76, (r) => val(r.track?.potentialAst, (v) => <b>{num(v)}</b>), {
    value: t('potentialAst'),
    hint: true,
  }),
  col('astPtsCreated', 92, (r) => val(r.track?.astPtsCreated, (v) => num(v)), {
    value: t('astPtsCreated'), hint: true,
  }),
  col('secondaryAst', 76, (r) => val(r.track?.secondaryAst, (v) => num(v)), {
    value: t('secondaryAst'), hint: true,
  }),
  col('touches', 56, (r) => val(r.track?.touches, (v) => num(v, 0)), {
    value: t('touches'), hint: true,
  }),
  col('timeOfPoss', 76, (r) => val(r.track?.timeOfPoss, (v) => num(v)), {
    value: t('timeOfPoss'), hint: true,
  }),
  col('secPerTouch', 92, (r) => val(r.track?.secPerTouch, (v) => num(v, 2)), {
    value: t('secPerTouch'), hint: true,
  }),
  col('ptsPerTouch', 92, (r) => val(r.track?.ptsPerTouch, (v) => num(v, 3)), {
    value: t('ptsPerTouch'),
  }),
  col('passes', 56, (r) => val(r.track?.passes, (v) => num(v, 0)), { value: t('passes') }),
  col('tov', 52, (r) => num(r.base?.tov), { value: b('tov') }),
  col('astTo', 74, (r) => num(r.adv?.astTo, 2), { value: a('astTo') }),
  col('screenAstPts', 92, (r) => val(r.hustle?.screenAstPts, (v) => num(v)), {
    value: h('screenAstPts'), hint: true,
  }),
  col('distMiles', 72, (r) => val(r.track?.distMiles, (v) => num(v, 1)), {
    value: t('distMiles'), hint: true,
  }),
];

export const MODES = {
  base: BASE_COLUMNS,
  adv: ADV_COLUMNS,
  defense: DEFENSE_COLUMNS,
  scoring: SCORING_COLUMNS,
  playmaking: PLAYMAKING_COLUMNS,
};

/** 每种视图的默认排序列 */
const DEFAULT_SORT = {
  base: 'pts', adv: 'impact', defense: 'diffPct', scoring: 'pts', playmaking: 'potentialAst',
};

export const MODE_KEYS = ['base', 'adv', 'defense', 'scoring', 'playmaking'];

/** 视图切换选项（已翻译）：Segmented 用 */
export const modeOptions = (t) => MODE_KEYS.map((value) => ({ value, label: t(`playerTable.mode.${value}`) }));

/**
 * 球员数据表。mode 见 MODE_OPTIONS
 * nameColumn 可覆盖首列（例如球队页加缺阵勾选框）
 */
export default function PlayerTable({
  rows, mode = 'base', nameColumn, extraColumns = [], onRowClick, maxHeight, showRank = false,
}) {
  const { t } = useI18n();
  const stats = useMemo(() => buildColumns(MODES[mode] ?? BASE_COLUMNS, t), [mode, t]);
  const columns = [nameColumn, ...extraColumns, ...stats].filter(Boolean);
  return (
    <DataTable
      // 换视图等于换一套列，用 key 强制重挂载，
      // 这样排序会重置成该视图自己的默认列，而不是沿用上一个视图的
      key={mode}
      columns={columns}
      rows={rows}
      // 对位压制是负数越好，所以这一列默认升序
      initialSort={{ key: DEFAULT_SORT[mode] ?? 'pts', dir: mode === 'defense' ? 'asc' : 'desc' }}
      rowKey={(r) => r.playerId}
      onRowClick={onRowClick}
      maxHeight={maxHeight}
      showRank={showRank}
    />
  );
}
