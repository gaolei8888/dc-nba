import React, { useMemo, useState } from 'react';
import { probColor } from '../lib/format.js';

/** 球队色块徽标（NBA 官方 logo 需外链，这里用队色+缩写，离线也稳定） */
export function TeamBadge({ team, size = 26 }) {
  if (!team) return null;
  return (
    <span
      className="badge"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: `linear-gradient(140deg, ${team.color}, ${team.colorAlt})`,
      }}
      title={team.full}
    >
      {team.abbr}
    </span>
  );
}

/** 球队单元格：徽标 + 中文名 + 缩写 */
export function TeamCell({ team, onClick, showAbbr = true, size = 24 }) {
  if (!team) return <span className="dim">—</span>;
  return (
    <span
      className="team-cell"
      style={onClick ? { cursor: 'pointer' } : undefined}
      onClick={onClick}
    >
      <TeamBadge team={team} size={size} />
      <span className="nm">{team.cn}</span>
      {showAbbr && <span className="ab">{team.abbr}</span>}
    </span>
  );
}

export function StatTile({ label, value, unit, hint }) {
  return (
    <div className="stat-tile" title={hint}>
      <div className="k">{label}</div>
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
    const col = columns.find((c) => c.key === sort.key);
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
