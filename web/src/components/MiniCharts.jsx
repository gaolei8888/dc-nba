import React from 'react';
import { useI18n } from '../i18n/react.jsx';
import { domainOf, linear, ciDomain } from '../lib/moneylineUi.js';

// 小图表：纯 SVG、无依赖，沿用 Board.jsx 累计盈亏曲线的画法（viewBox + vector-effect 不缩放描边）。
// 所有图按比例画：数值域含 0 线（或起始资金），同一张图内的行共用一个比例尺。
// 颜色只用主题变量（深浅两套主题都有定义）：模型 --accent、市场 --accent-2、盈 --good、亏 --bad。

/**
 * 折线图（累计资金曲线）。points: [{ date, value }]，横轴按点的顺序等距；baseline 画成虚线（如起始资金 100）。
 * format：数值 → 文本（默认保留 1 位小数）。
 */
export function LineChart({ points, label, baseline = null, format }) {
  const { t, fmt } = useI18n();
  const f = format ?? ((v) => fmt.num(v, 1));
  if (!points || points.length < 2) return <div className="empty">{t('lab.beat.chart.tooFew')}</div>;
  const W = 600; const H = 160; const P = 8;
  const vals = points.map((p) => p.value);
  const dom = domainOf(vals, baseline == null ? [] : [baseline]);
  const x = (i) => P + (i * (W - 2 * P)) / (points.length - 1);
  const y = linear(dom, [H - P, P]);
  const last = vals.at(-1);
  const up = baseline == null ? last >= vals[0] : last >= baseline;
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}
        style={{ width: '100%', height: H, display: 'block' }}>
        {baseline != null && (
          <line x1={0} x2={W} y1={y(baseline)} y2={y(baseline)} stroke="var(--text-faint)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        )}
        <polyline fill="none" stroke={up ? 'var(--good)' : 'var(--bad)'} strokeWidth="2" vectorEffect="non-scaling-stroke"
          points={points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')} />
      </svg>
      <div className="note" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span>{t('lab.beat.chart.range', { from: fmt.dateShort(points[0].date), to: fmt.dateShort(points.at(-1).date) })}</span>
        <span>
          {t('lab.beat.chart.axis', { lo: f(dom[0]), hi: f(dom[1]) })}
          {' · '}
          <b className={up ? 'pos' : 'neg'}>{t('lab.beat.chart.end', { v: f(last) })}</b>
        </span>
      </div>
    </>
  );
}

/**
 * 区间条图：每行一个点估计 + 95% 区间，所有行共用一个含 0 的比例尺。
 * rows: [{ key, label, value, lo, hi, tag? }]；tag 是行尾的小标注（如「★ 选定」「基准」），emphasis 'selected' 加粗高亮。
 * format：数值 → 文本（默认百分比 1 位）。value 为 null 的行只显示标签与「—」。
 */
export function CiBars({ rows, label, format }) {
  const { t, fmt } = useI18n();
  const f = format ?? ((v) => fmt.pct(v, 1));
  const dom = ciDomain(rows ?? []);
  const anyValue = (rows ?? []).some((r) => typeof r.value === 'number' && Number.isFinite(r.value));
  if (!rows?.length || !dom || !anyValue) return <div className="empty">{t('lab.beat.chart.tooFew')}</div>;
  const W = 300; const H = 18;
  const x = linear(dom, [4, W - 4]);
  const x0 = x(0);
  return (
    <div role="img" aria-label={label}>
      {rows.map((r) => {
        const has = typeof r.value === 'number' && Number.isFinite(r.value);
        const hasCi = typeof r.lo === 'number' && typeof r.hi === 'number';
        const color = !has ? 'var(--text-faint)' : r.value >= 0 ? 'var(--good)' : 'var(--bad)';
        const strong = r.emphasis === 'selected';
        return (
          <div key={r.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(84px, 30%) 1fr minmax(64px, auto)', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: strong ? 700 : 400, color: strong ? 'var(--text)' : 'var(--text-dim)' }} title={r.label}>
              {r.label}
              {r.tag && <span className="dim" style={{ marginLeft: 5, fontSize: 10.5 }}>{r.tag}</span>}
            </span>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: H, display: 'block' }}>
              <line x1={x0} x2={x0} y1={0} y2={H} stroke="var(--text-faint)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
              {has && hasCi && (
                <line x1={x(r.lo)} x2={x(r.hi)} y1={H / 2} y2={H / 2} stroke={color} strokeWidth={strong ? 3 : 2} strokeOpacity=".55" vectorEffect="non-scaling-stroke" />
              )}
              {has && (
                <line x1={x(r.value)} x2={x(r.value)} y1={3} y2={H - 3} stroke={color} strokeWidth={strong ? 4 : 3} vectorEffect="non-scaling-stroke" />
              )}
            </svg>
            <span className="mono" style={{ textAlign: 'right', whiteSpace: 'nowrap', color: strong ? 'var(--text)' : 'var(--text-dim)' }}>
              {has ? f(r.value) : '—'}
            </span>
          </div>
        );
      })}
      <div className="note" style={{ display: 'grid', gridTemplateColumns: 'minmax(84px, 30%) 1fr minmax(64px, auto)', gap: 8 }}>
        <span />
        <span style={{ display: 'flex', justifyContent: 'space-between' }}><span>{f(dom[0])}</span><span>{f(dom[1])}</span></span>
        <span />
      </div>
    </div>
  );
}

/**
 * 校准图：横轴预测概率、纵轴实际频率，0–1 等比例正方形；对角线 = 完全校准。
 * model / market：Bin[]（{ lo, hi, n, predicted, actual }，同 lab.calibration）。
 */
export function ReliabilityPlot({ model, market, label }) {
  const { t, fmt } = useI18n();
  if (!model?.length && !market?.length) return <div className="empty">{t('lab.beat.chart.tooFew')}</div>;
  const S = 240; const P = 26;
  const s = linear([0, 1], [P, S - 8]);
  const sy = linear([0, 1], [S - P, 8]);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const series = [
    { key: 'model', bins: model ?? [], color: 'var(--accent)', name: t('lab.beat.chart.model') },
    { key: 'market', bins: market ?? [], color: 'var(--accent-2)', name: t('lab.beat.chart.market') },
  ];
  const pts = (bins) => bins.filter((b) => b.predicted != null && b.actual != null);
  return (
    <>
      <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label={label} style={{ width: '100%', maxWidth: 320, display: 'block', margin: '0 auto' }}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={s(v)} x2={s(v)} y1={sy(0)} y2={sy(1)} stroke="var(--line)" />
            <line x1={s(0)} x2={s(1)} y1={sy(v)} y2={sy(v)} stroke="var(--line)" />
            <text x={s(v)} y={S - P + 12} fontSize="8" fill="var(--text-faint)" textAnchor="middle">{fmt.pct(v, 0)}</text>
            <text x={P - 3} y={sy(v) + 3} fontSize="8" fill="var(--text-faint)" textAnchor="end">{fmt.pct(v, 0)}</text>
          </g>
        ))}
        <line x1={s(0)} y1={sy(0)} x2={s(1)} y2={sy(1)} stroke="var(--text-faint)" strokeDasharray="4 4" />
        {series.map((se) => {
          const ps = pts(se.bins);
          return (
            <g key={se.key}>
              <polyline fill="none" stroke={se.color} strokeWidth="1.5"
                points={ps.map((b) => `${s(b.predicted).toFixed(1)},${sy(b.actual).toFixed(1)}`).join(' ')} />
              {ps.map((b) => (
                <circle key={b.lo} cx={s(b.predicted)} cy={sy(b.actual)} r="3" fill={se.color}>
                  <title>{`${se.name} · ${b.lo}–${b.hi}% · n ${b.n} · ${fmt.pct(b.predicted, 1)} → ${fmt.pct(b.actual, 1)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
      <div className="legend" style={{ justifyContent: 'center', marginTop: 6 }}>
        <span><i style={{ background: 'var(--accent)' }} />{t('lab.beat.chart.model')}</span>
        <span><i style={{ background: 'var(--accent-2)' }} />{t('lab.beat.chart.market')}</span>
        <span><i style={{ background: 'var(--text-faint)' }} />{t('lab.beat.chart.diag')}</span>
      </div>
      <div className="note" style={{ textAlign: 'center' }}>
        {t('lab.beat.chart.predicted')} → {t('lab.beat.chart.actual')}
      </div>
    </>
  );
}
