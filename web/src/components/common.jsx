import React, { useMemo, useState } from 'react';
import { probColor } from '../lib/format.js';
import { useI18n } from '../i18n/react.jsx';
import { errorText } from '../lib/apiError.js';

const LOGO = (teamId) => `https://cdn.nba.com/logos/nba/${teamId}/primary/L/logo.svg`;
const HEADSHOT = (playerId) => `https://cdn.nba.com/headshots/nba/latest/260x190/${playerId}.png`;

/**
 * 官方队标，加载失败（离线等）时回退到队色缩写块。
 */
export function TeamLogo({ team, size = 26 }) {
  const [failed, setFailed] = useState(false);
  if (!team) return null;
  if (failed) {
    return (
      <span
        className="badge"
        style={{
          width: size, height: size,
          fontSize: Math.round(size * 0.36),
          background: `linear-gradient(140deg, ${team.color}, ${team.colorAlt})`,
        }}
        title={team.full}
      >
        {team.abbr}
      </span>
    );
  }
  return (
    <img
      className="logo"
      src={LOGO(team.teamId)}
      width={size}
      height={size}
      alt={team.abbr}
      title={team.full}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** 球员头像，失败时回退到姓名首字母 */
export function PlayerHeadshot({ player, size = 30 }) {
  const [failed, setFailed] = useState(false);
  if (!player) return null;
  if (failed || !player.playerId) {
    const initials = (player.name ?? '')
      .split(' ')
      .map((w) => w[0])
      .slice(0, 2)
      .join('');
    return (
      <span
        className="headshot-fallback"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      >
        {initials}
      </span>
    );
  }
  return (
    <img
      className="headshot"
      src={HEADSHOT(player.playerId)}
      width={size}
      height={size}
      alt={player.name}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** 球队单元格：队标 + 队名（中文用 cn、英文用 full，+ 缩写） */
export function TeamCell({ team, onClick, showAbbr = true, size = 22 }) {
  const { fmt } = useI18n();
  if (!team) return <span className="dim">—</span>;
  return (
    <span
      className="team-cell"
      style={onClick ? { cursor: 'pointer' } : undefined}
      onClick={onClick}
    >
      <TeamLogo team={team} size={size} />
      <span className="nm">{fmt.teamName(team)}</span>
      {showAbbr && <span className="ab">{team.abbr}</span>}
    </span>
  );
}

/** 球员单元格：头像 + 姓名（+ 附加内容） */
export function PlayerCell({ player, size = 28, children }) {
  return (
    <span className="player-cell">
      <PlayerHeadshot player={player} size={size} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {player.name}
        {children}
      </span>
    </span>
  );
}

/** 伤病徽标：鼠标悬停显示伤处与预计复出 */
export function InjuryBadge({ injury }) {
  const { t } = useI18n();
  if (!injury) return null;
  const parts = [injury.statusRaw, injury.side, injury.type, injury.detail]
    .filter(Boolean).join(' · ');
  const back = injury.returnDate ? ` · ${t('common.returnDate', { date: injury.returnDate })}` : '';
  return (
    <span
      className={`chip ${injury.status === 'out' ? 'injury-out' : 'injury-dtd'}`}
      style={{ marginLeft: 6 }}
      title={parts + back}
    >
      {t(`common.injury.${injury.status}`)}
    </span>
  );
}

/**
 * 表头标签：缩写在上、本地语言名称在下（中文）。
 * 英文界面缩写本身就是通用语言，只显示缩写，label 放进悬停说明。
 */
export function Th({ abbr, label }) {
  const { lang } = useI18n();
  if (!abbr) return label;
  if (lang === 'en') {
    return (
      <span className="th-label" title={typeof label === 'string' ? label : undefined}>
        <b>{abbr}</b>
      </span>
    );
  }
  return (
    <span className="th-label">
      <b>{abbr}</b>
      <i>{label}</i>
    </span>
  );
}

export function StatTile({ label, abbr, value, unit, hint }) {
  return (
    <div className="tile" title={hint}>
      <div className="k">
        {abbr && <em>{abbr}</em>}
        {label}
      </div>
      <div className="v">
        {value}
        {unit && <small>{unit}</small>}
      </div>
    </div>
  );
}

/** 胜率条：颜色随概率从红过渡到绿 */
export function ProbBar({ p, width }) {
  return (
    <span className="probbar" style={{ display: 'inline-block', width }}>
      <i style={{ width: `${Math.round(p * 100)}%`, background: probColor(p) }} />
    </span>
  );
}

export function Meter({ value, max = 1, label }) {
  return (
    <span className="meter">
      <span className="track">
        <i style={{ width: `${Math.max(0, Math.min(1, value / max)) * 100}%` }} />
      </span>
      <span className="val mono">{label}</span>
    </span>
  );
}

/**
 * 可排序数据表。
 * columns: [{ key, label, align?, render?(row), value?(row), width?, title? }]
 */
export function DataTable({ columns, rows, initialSort, onRowClick, rowKey = (r, i) => i, maxHeight }) {
  const { t, fmt } = useI18n();
  const intl = fmt.intl;
  const [sort, setSort] = useState(initialSort ?? { key: columns[0].key, dir: 'desc' });

  const valueOf = (col, row) => (col.value ? col.value(row) : row[col.key]);

  const sorted = useMemo(() => {
    // 列集合换掉之后（比如球员表从"基础"切到"防守拼抢"），旧的排序键可能已经不存在。
    // 以前这里直接 return rows，表会静默地变成未排序——看起来像乱序的 bug。
    // 退回 initialSort，实在没有就用第一列。
    const col = columns.find((c) => c.key === sort.key)
      ?? columns.find((c) => c.key === initialSort?.key)
      ?? columns[0];
    if (!col) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = valueOf(col, a);
      const y = valueOf(col, b);
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === 'string' || typeof y === 'string') {
        return String(x).localeCompare(String(y), intl) * dir;
      }
      return (x - y) * dir;
    });
  }, [rows, sort, columns, intl]);

  const toggle = (key) =>
    setSort((s) => (s.key === key
      ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' }
      : { key, dir: 'desc' }));

  return (
    <div className="table-wrap" style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
      <table className="data">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`${c.align === 'left' ? 'left' : ''} ${sort.key === c.key ? 'sorted' : ''}`}
                style={c.width ? { width: c.width } : undefined}
                title={c.title ?? c.label}
                onClick={() => toggle(c.key)}
              >
                {c.label}
                {sort.key === c.key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              className={onRowClick ? 'clickable' : ''}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={c.align === 'left' ? 'left' : ''}>
                  {c.render ? c.render(row, i) : valueOf(c, row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && <div className="empty">{t('common.noMatch')}</div>}
    </div>
  );
}

export function Loading({ text }) {
  const { t } = useI18n();
  return <div className="loading">{text ?? t('common.loading')}</div>;
}

export function ErrorBox({ error }) {
  const { t } = useI18n();
  if (!error) return null;
  return <div className="err">{errorText(error, t)}</div>;
}

export function Segmented({ options, value, onChange }) {
  return (
    <span className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/**
 * 盘口对照：模型 vs 博彩收盘/当前盘口。
 *
 * 刻意把盘口放在**模型旁边**而不是模型里面。盘口不参与我们的计算——
 * 一旦让它进模型，"和市场比谁更准"就没意义了。
 * 回测的结论也不支持跟着分歧下注：模型相对盘口选边的让分命中率 49.1%，
 * 低于 52.38% 的打平线。所以这里只讲"分歧在哪"，不讲"该买哪边"。
 */
export function MarketCompare({ market, prediction, home, away }) {
  const { t, fmt } = useI18n();
  if (!market) return null;
  const fmtLine = (v) => (v > 0 ? `+${v}` : `${v}`);
  // 盘口是抓取时的快照，博彩商随后可能改线。旧到一定程度就要显式警告：
  // 用户看到一条三周前的线却以为是当前的，比看不到盘口更糟。
  const age = fmt.snapshotAge(market.fetchedAt);
  const edge = market.edge ?? 0;
  const big = Math.abs(edge) >= 3;
  const favors = edge > 0 ? home : away;

  const rows = [
    {
      k: t('common.market.spread'),
      hint: t('common.market.spreadHint'),
      model: fmtLine(prediction.spread),
      market: fmtLine(market.spread),
    },
    {
      k: t('common.market.total'),
      model: fmt.num(prediction.total, 1),
      market: fmt.num(market.total, 1),
    },
    {
      k: t('common.market.homeProb'),
      hint: market.homeProb === null ? t('common.market.noMoneyline') : t('common.market.vigRemoved'),
      model: `${(prediction.homeWinProb * 100).toFixed(0)}%`,
      market: market.homeProb === null || market.homeProb === undefined
        ? '—' : `${(market.homeProb * 100).toFixed(0)}%`,
    },
  ];

  return (
    <div className="market">
      <div className="market-head">
        <span className="market-title">{t('common.market.title')}</span>
        <span className="dim">
          {market.provider ?? t('common.market.provider')}
          {market.openSpread !== null && market.openSpread !== undefined
            && market.openSpread !== market.spread
            && ` · ${t('common.market.open', { line: fmtLine(market.openSpread) })}`}
          {age && (
            <span className={age.stale ? 'market-age stale' : 'market-age'} title={market.fetchedAt}>
              {` · ${age.text}`}
            </span>
          )}
        </span>
      </div>
      {age?.stale && (
        <div className="market-stale">
          {t('common.market.stale', { days: age.days })}
        </div>
      )}
      <table className="market-table">
        <thead>
          <tr><th /><th>{t('common.market.model')}</th><th>{t('common.market.line')}</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k}>
              <td title={r.hint}>{r.k}</td>
              <td className="mono">{r.model}</td>
              <td className="mono">{r.market}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={`market-edge${big ? ' big' : ''}`}>
        {Math.abs(edge) < 0.5
          ? t('common.market.agree')
          : t('common.market.favors', { team: favors?.abbr ?? t(edge > 0 ? 'common.market.home' : 'common.market.away'), pts: fmt.num(Math.abs(edge), 1) })}
      </div>
      <div className="market-note">
        {t('common.market.note')}
      </div>
    </div>
  );
}
