import React from 'react';
import { DataTable, Th } from './common.jsx';
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
const rateCol = (key, cn, width, get, totalOf, min, opts = {}) => col(
  key, cn, width,
  (r) => {
    const v = get(r);
    if (v === null || v === undefined) return dash;
    const total = totalOf(r);
    const ok = qualified(total, min);
    const text = opts.render ? opts.render(v) : rate(v);
    return ok ? text : (
      <span className="dim" title={`样本仅 ${Math.round(total ?? 0)} 次，不参与排名`}>{text}</span>
    );
  },
  { ...opts, value: (r) => (qualified(totalOf(r), min) ? get(r) : null) },
);

/**
 * 列定义的简写。
 * label 是「英文缩写在上、中文在下」的两行表头，所以 title 必须显式给字符串——
 * DataTable 默认拿 label 当 title，label 是 JSX 的话会渲染成 [object Object]。
 */
const col = (key, cn, width, render, opts = {}) => {
  const abbr = ABBR[opts.abbrKey ?? key];
  return {
    key,
    label: <Th abbr={abbr} label={cn} />,
    title: opts.hint ? `${cn} ${abbr} — ${opts.hint}` : `${cn} ${abbr}`,
    width,
    render,
    ...(opts.value ? { value: opts.value } : {}),
  };
};

/** 每种视图都带的前两列 */
const LEAD = [
  col('gp', '出场', 52, (r) => num(r.gp, 0)),
  col('min', '时间', 52, (r) => num(r.min)),
];

/** 基础数据列（场均） */
export const BASE_COLUMNS = [
  ...LEAD,
  col('pts', '得分', 56, (r) => <b>{num(r.base?.pts)}</b>, { value: b('pts') }),
  col('reb', '篮板', 56, (r) => num(r.base?.reb), { value: b('reb') }),
  col('ast', '助攻', 56, (r) => num(r.base?.ast), { value: b('ast') }),
  col('stl', '抢断', 52, (r) => num(r.base?.stl), { value: b('stl') }),
  col('blk', '盖帽', 52, (r) => num(r.base?.blk), { value: b('blk') }),
  col('tov', '失误', 52, (r) => num(r.base?.tov), { value: b('tov') }),
  col('fgPct', '投篮', 58, (r) => rate(r.base?.fgPct), { value: b('fgPct') }),
  col('fg3m', '三分球', 56, (r) => num(r.base?.fg3m), { value: b('fg3m') }),
  col('fg3Pct', '三分', 58, (r) => rate(r.base?.fg3Pct), { value: b('fg3Pct') }),
  col('ftPct', '罚球', 58, (r) => rate(r.base?.ftPct), { value: b('ftPct') }),
  col('plusMinus', '正负值', 62, (r) => (
    <span className={signClass(r.base?.plusMinus)}>{signed(r.base?.plusMinus)}</span>
  ), { value: b('plusMinus'), hint: '在场时球队的净胜分' }),
];

/** 高阶数据列 */
export const ADV_COLUMNS = [
  ...LEAD,
  col('impact', '影响力分', 76, (r) => (r.impact === null || r.impact === undefined ? dash : (
    <b className={signClass(r.impact)}>{signed(r.impact, 1)}</b>
  )), {
    hint: '本站自制的综合影响力指标：相对联盟平均，该球员每百回合给球队带来多少分。由 box score、球场追踪、拼抢、防守对位回归到个人 on/off 拟合而成，用留出赛季验证过',
  }),
  col('pie', '事件贡献', 62, (r) => <b>{rate(r.adv?.pie, 1)}</b>, {
    value: a('pie'),
    hint: 'Player Impact Estimate，球员对比赛所有可统计事件的贡献占比',
  }),
  col('estNetRtg', '估计净效率', 78, (r) => val(r.est?.netRtg, (v) => (
    <span className={signClass(v)}>{signed(v, 1)}</span>
  )), {
    value: e('netRtg'),
    hint: 'NBA 官方按球员贡献估计的每百回合净效率。与下面的「净效率」不同——那个几乎等于在场时球队的表现，受队友影响很大',
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
    if (r.outCostPts === null || r.outCostPts === undefined) return dash;
    if (r.outCostPts > -0.05) {
      return <span className="dim" title="PIE 低于替补级，模型认为顶替者可以打平">≈0</span>;
    }
    return <span className="neg">{num(r.outCostPts, 1)}</span>;
  }, { hint: '该球员缺阵时，模型预计球队每场净胜分的变化（空出的时间由名单里排在后面的人顶上）' }),
];

/**
 * 防守与拼抢。
 * 抢断盖帽只反映了防守的一小部分，这里的对位命中率与拼抢数据
 * 才是公开数据里最接近"这个人防守好不好"的东西。
 */
export const DEFENSE_COLUMNS = [
  ...LEAD,
  rateCol('diffPct', '对位压制', 72, d('diffPct'), defendedFga, QUALIFY.defend, {
    // 负数 = 把对手压到了低于其正常命中率，是好事，所以取反上色
    render: (v) => <b className={signClass(-v)}>{signed(v * 100, 1)}</b>,
    hint: '被该球员防守时对手的命中率，减去对手的正常命中率。负数越大，压制越强' + '。样本不足 200 次对位出手的不参与排名',
  }),
  rateCol('dFgPct', '对位命中', 68, d('dFgPct'), defendedFga, QUALIFY.defend, {
    hint: '被该球员防守时对手的命中率',
  }),
  col('dFga', '对位出手', 68, (r) => val(r.defend?.dFga, (v) => num(v)), {
    value: d('dFga'), hint: '每场被该球员防守的出手次数，衡量他要扛多少防守任务',
  }),
  col('contested', '干扰投篮', 72, (r) => val(r.hustle?.contested, (v) => num(v)), {
    value: h('contested'), hint: '每场干扰的对手出手次数',
  }),
  col('deflections', '偏转球', 64, (r) => val(r.hustle?.deflections, (v) => num(v)), {
    value: h('deflections'), hint: '每场把球拨离对手控制的次数，抢断的先行指标',
  }),
  col('stl', '抢断', 52, (r) => num(r.base?.stl), { value: b('stl') }),
  col('blk', '盖帽', 52, (r) => num(r.base?.blk), { value: b('blk') }),
  col('charges', '造犯规', 64, (r) => val(r.hustle?.charges, (v) => num(v, 2)), {
    value: h('charges'), hint: '每场造成的进攻犯规',
  }),
  col('looseBalls', '争抢球', 64, (r) => val(r.hustle?.looseBalls, (v) => num(v)), {
    value: h('looseBalls'), hint: '每场抢到的无主球',
  }),
  col('boxOuts', '卡位', 56, (r) => val(r.hustle?.boxOuts, (v) => num(v)), {
    value: h('boxOuts'), hint: '每场卡位次数',
  }),
  col('drebChancePct', '防守篮板把握', 88, (r) => val(r.track?.drebChancePct, (v) => rate(v)), {
    value: t('drebChancePct'), hint: '球落在他身边时，他把防守篮板拿下的比例',
  }),
  col('defRtg', '防守效率', 68, (r) => num(r.adv?.defRtg), { value: a('defRtg') }),
];

/** 得分方式：球从哪来、怎么进的 */
export const SCORING_COLUMNS = [
  ...LEAD,
  col('pts', '得分', 56, (r) => <b>{num(r.base?.pts)}</b>, { value: b('pts') }),
  col('drives', '突破', 56, (r) => val(r.track?.drives, (v) => num(v)), {
    value: t('drives'), hint: '每场从三分线外持球突入禁区附近的次数',
  }),
  col('drivePts', '突破得分', 72, (r) => val(r.track?.drivePts, (v) => num(v)), {
    value: t('drivePts'),
  }),
  rateCol('driveFgPct', '突破命中', 72, t('driveFgPct'),
    (r) => (r.track?.driveFga ?? 0) * (r.gp ?? 0), QUALIFY.drive, {}),
  col('csPts', '接球投篮得分', 88, (r) => val(r.track?.csPts, (v) => num(v)), {
    value: t('csPts'), hint: '接球后两秒内、无运球出手的得分',
  }),
  rateCol('csEfg', '接球有效命中', 88, t('csEfg'),
    (r) => (r.track?.csFga ?? 0) * (r.gp ?? 0), QUALIFY.catchShoot, {}),
  col('puPts', '干拔得分', 72, (r) => val(r.track?.puPts, (v) => num(v)), {
    value: t('puPts'), hint: '运球后直接出手的得分，难度最高的一类',
  }),
  rateCol('puEfg', '干拔有效命中', 88, t('puEfg'),
    (r) => (r.track?.puFga ?? 0) * (r.gp ?? 0), QUALIFY.pullUp, {}),
  col('ptsPaint', '油漆区得分', 82, (r) => val(r.misc?.ptsPaint, (v) => num(v)), {
    value: m('ptsPaint'),
  }),
  col('ptsFb', '快攻得分', 72, (r) => val(r.misc?.ptsFb, (v) => num(v)), { value: m('ptsFb') }),
  col('pts2nd', '二次进攻', 72, (r) => val(r.misc?.pts2nd, (v) => num(v)), { value: m('pts2nd') }),
  col('ptsOffTov', '失误转化', 72, (r) => val(r.misc?.ptsOffTov, (v) => num(v)), {
    value: m('ptsOffTov'), hint: '对手失误后转化的得分',
  }),
  col('pfd', '造犯规', 64, (r) => val(r.misc?.pfd, (v) => num(v)), {
    value: m('pfd'), hint: '每场造成对手犯规的次数',
  }),
];

/** 传球与控球：真正的组织能力，助攻数看不出来 */
export const PLAYMAKING_COLUMNS = [
  ...LEAD,
  col('ast', '助攻', 56, (r) => num(r.base?.ast), { value: b('ast') }),
  col('potentialAst', '潜在助攻', 76, (r) => val(r.track?.potentialAst, (v) => <b>{num(v)}</b>), {
    value: t('potentialAst'),
    hint: '传出后队友直接出手的传球数——不管有没有进。助攻数受队友命中率影响，这个不受',
  }),
  col('astPtsCreated', '助攻创造得分', 92, (r) => val(r.track?.astPtsCreated, (v) => num(v)), {
    value: t('astPtsCreated'), hint: '由他的助攻直接产生的球队得分',
  }),
  col('secondaryAst', '二次助攻', 76, (r) => val(r.track?.secondaryAst, (v) => num(v)), {
    value: t('secondaryAst'), hint: '助攻的前一传，俗称"潜在助攻的助攻"',
  }),
  col('touches', '触球', 56, (r) => val(r.track?.touches, (v) => num(v, 0)), {
    value: t('touches'), hint: '每场碰到球的次数',
  }),
  col('timeOfPoss', '控球时间', 76, (r) => val(r.track?.timeOfPoss, (v) => num(v)), {
    value: t('timeOfPoss'), hint: '每场持球的分钟数',
  }),
  col('secPerTouch', '每次触球秒数', 92, (r) => val(r.track?.secPerTouch, (v) => num(v, 2)), {
    value: t('secPerTouch'), hint: '数值高说明球到他手里会停一停，是持球型打法',
  }),
  col('ptsPerTouch', '每次触球得分', 92, (r) => val(r.track?.ptsPerTouch, (v) => num(v, 3)), {
    value: t('ptsPerTouch'),
  }),
  col('passes', '传球', 56, (r) => val(r.track?.passes, (v) => num(v, 0)), { value: t('passes') }),
  col('tov', '失误', 52, (r) => num(r.base?.tov), { value: b('tov') }),
  col('astTo', '助攻失误比', 74, (r) => num(r.adv?.astTo, 2), { value: a('astTo') }),
  col('screenAstPts', '掩护创造得分', 92, (r) => val(r.hustle?.screenAstPts, (v) => num(v)), {
    value: h('screenAstPts'), hint: '由他的掩护直接产生的队友得分，内线的隐形贡献',
  }),
  col('distMiles', '跑动英里', 72, (r) => val(r.track?.distMiles, (v) => num(v, 1)), {
    value: t('distMiles'), hint: '每场跑动距离（英里）',
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

export const MODE_OPTIONS = [
  { value: 'base', label: '基础' },
  { value: 'adv', label: '高阶' },
  { value: 'defense', label: '防守拼抢' },
  { value: 'scoring', label: '得分方式' },
  { value: 'playmaking', label: '传球控球' },
];

export const MODE_LABEL = Object.fromEntries(MODE_OPTIONS.map((o) => [o.value, o.label]));

/**
 * 球员数据表。mode 见 MODE_OPTIONS
 * nameColumn 可覆盖首列（例如球队页加缺阵勾选框）
 */
export default function PlayerTable({
  rows, mode = 'base', nameColumn, extraColumns = [], onRowClick, maxHeight,
}) {
  const stats = MODES[mode] ?? BASE_COLUMNS;
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
    />
  );
}
