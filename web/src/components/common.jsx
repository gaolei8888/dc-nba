import React, { useMemo, useState } from 'react';
import { probColor, snapshotAge } from '../lib/format.js';

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

/** 球队单元格：队标 + 中文名（+ 缩写） */
export function TeamCell({ team, onClick, showAbbr = true, size = 22 }) {
  if (!team) return <span className="dim">—</span>;
  return (
    <span
      className="team-cell"
      style={onClick ? { cursor: 'pointer' } : undefined}
      onClick={onClick}
    >
      <TeamLogo team={team} size={size} />
      <span className="nm">{team.cn}</span>
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

const INJURY_LABEL = { out: '缺阵', doubtful: '存疑', dayToDay: '每日观察', unknown: '伤病' };

/** 伤病徽标：鼠标悬停显示伤处与预计复出 */
export function InjuryBadge({ injury }) {
  if (!injury) return null;
  const parts = [injury.statusRaw, injury.side, injury.type, injury.detail]
    .filter(Boolean).join(' · ');
  const back = injury.returnDate ? `　预计复出 ${injury.returnDate}` : '';
  return (
    <span
      className={`chip ${injury.status === 'out' ? 'injury-out' : 'injury-dtd'}`}
      style={{ marginLeft: 6 }}
      title={parts + back}
    >
      {INJURY_LABEL[injury.status] ?? '伤病'}
    </span>
  );
}

/**
 * 表头标签：英文缩写在上、中文在下。
 * NBA 的缩写是通用语言，但中文用户仍需要一眼看懂，所以两个都留。
 */
export function Th({ abbr, cn }) {
  if (!abbr) return cn;
  return (
    <span className="th-label">
      <b>{abbr}</b>
      <i>{cn}</i>
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
        return String(x).localeCompare(String(y), 'zh') * dir;
      }
      return (x - y) * dir;
    });
  }, [rows, sort, columns]);

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
      {sorted.length === 0 && <div className="empty">没有符合条件的数据</div>}
    </div>
  );
}

export function Loading({ text = '加载中…' }) {
  return <div className="loading">{text}</div>;
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div className="err">{String(error.message ?? error)}</div>;
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
  if (!market) return null;
  const fmtLine = (v) => (v > 0 ? `+${v}` : `${v}`);
  // 盘口是抓取时的快照，博彩商随后可能改线。旧到一定程度就要显式警告：
  // 用户看到一条三周前的线却以为是当前的，比看不到盘口更糟。
  const age = snapshotAge(market.fetchedAt);
  const edge = market.edge ?? 0;
  const big = Math.abs(edge) >= 3;
  const favors = edge > 0 ? home : away;

  const rows = [
    {
      k: '让分（主队）',
      hint: '负数表示主队让分',
      model: fmtLine(prediction.spread),
      market: fmtLine(market.spread),
    },
    {
      k: '总分',
      model: prediction.total?.toFixed(1),
      market: market.total === null || market.total === undefined ? '—' : market.total.toFixed(1),
    },
    {
      k: '主队胜率',
      hint: market.homeProb === null ? '盘口未提供钱线' : '已去除抽水',
      model: `${(prediction.homeWinProb * 100).toFixed(0)}%`,
      market: market.homeProb === null || market.homeProb === undefined
        ? '—' : `${(market.homeProb * 100).toFixed(0)}%`,
    },
  ];

  return (
    <div className="market">
      <div className="market-head">
        <span className="market-title">盘口对照</span>
        <span className="dim">
          {market.provider ?? '博彩'}
          {market.openSpread !== null && market.openSpread !== undefined
            && market.openSpread !== market.spread
            && ` · 开盘 ${fmtLine(market.openSpread)}`}
          {age && (
            <span className={age.stale ? 'market-age stale' : 'market-age'} title={market.fetchedAt}>
              {` · ${age.text}`}
            </span>
          )}
        </span>
      </div>
      {age?.stale && (
        <div className="market-stale">
          这批盘口是 {age.days} 天前抓的，博彩商此后可能已经改线。以当前实际盘口为准。
        </div>
      )}
      <table className="market-table">
        <thead>
          <tr><th /><th>模型</th><th>盘口</th></tr>
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
          ? '模型与市场基本一致'
          : <>模型比市场更看好 <b>{favors?.abbr ?? (edge > 0 ? '主队' : '客队')}</b> {Math.abs(edge).toFixed(1)} 分</>}
      </div>
      <div className="market-note">
        盘口只作对照，不参与模型计算。回测显示跟着分歧下注的让分命中率是 49.1%，
        低于 52.38% 的打平线——分歧值得看，但不构成下注建议。
      </div>
    </div>
  );
}
