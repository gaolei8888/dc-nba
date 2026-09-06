import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api } from '../lib/api.js';
import {
  TeamCell, PlayerHeadshot, Loading, ErrorBox, Segmented, StatTile,
} from '../components/common.jsx';
import PlayerTable from '../components/PlayerTable.jsx';
import { num, rate } from '../lib/format.js';

const POS_FILTERS = [
  { value: 'all', label: '全部位置' },
  { value: 'G', label: '后卫' },
  { value: 'F', label: '前锋' },
  { value: 'C', label: '中锋' },
];

export default function Players() {
  const { teams, teamById, meta, setAccent } = useApp();
  const [all, setAll] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('base');
  const [q, setQ] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');
  const [posFilter, setPosFilter] = useState('all');
  const [minGp, setMinGp] = useState(20);
  const [rosterOnly, setRosterOnly] = useState(true);

  useEffect(() => { setAccent(null); }, [setAccent]);

  useEffect(() => {
    api.players().then(setAll).catch(setError);
  }, []);

  // 选中某支球队时，整站配色跟着走
  useEffect(() => {
    setAccent(teamFilter === 'all' ? null : teamById.get(Number(teamFilter)) ?? null);
  }, [teamFilter, teamById, setAccent]);

  const rows = useMemo(() => {
    if (!all) return [];
    const kw = q.trim().toLowerCase();
    return all.filter((p) => {
      if (rosterOnly && !p.onRoster) return false;
      if (teamFilter !== 'all' && p.teamId !== Number(teamFilter)) return false;
      if (posFilter !== 'all' && !(p.pos ?? '').includes(posFilter)) return false;
      if ((p.gp ?? 0) < minGp) return false;
      if (kw && !p.name.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [all, q, teamFilter, posFilter, minGp, rosterOnly]);

  if (error) return <ErrorBox error={error} />;
  if (!all) return <Loading />;

  const leader = (get) => [...rows].sort((a, b) => (get(b) ?? -99) - (get(a) ?? -99))[0];
  const topScorer = leader((p) => p.base?.pts);
  const topPie = leader((p) => p.adv?.pie);
  const topImpact = [...rows].sort((a, b) => (a.outCostPts ?? 0) - (b.outCostPts ?? 0))[0];

  return (
    <>
      <div className="page-head">
        <h1>球员数据</h1>
        <p>
          {meta.priorSeason} 赛季场均基础数据与高阶数据，共 {all.length} 人；
          名单归属已按 {meta.targetSeason} 最新阵容更新。
        </p>
      </div>

      <div className="toolbar">
        <div className="field">
          <label>搜索</label>
          <input
            type="search"
            placeholder="球员姓名"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ minWidth: 170 }}
          />
        </div>
        <div className="field">
          <label>球队</label>
          <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} style={{ minWidth: 150 }}>
            <option value="all">全部球队</option>
            {[...teams].sort((a, b) => a.cn.localeCompare(b.cn, 'zh')).map((t) => (
              <option key={t.teamId} value={t.teamId}>{t.cn}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>位置</label>
          <select value={posFilter} onChange={(e) => setPosFilter(e.target.value)}>
            {POS_FILTERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label>最少出场</label>
          <input
            type="number" min="0" max="82" value={minGp}
            onChange={(e) => setMinGp(Number(e.target.value) || 0)}
            style={{ width: 84 }}
          />
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 0' }}>
            <input type="checkbox" checked={rosterOnly} onChange={(e) => setRosterOnly(e.target.checked)} />
            <span style={{ fontSize: 12.5 }}>仅现役名单</span>
          </label>
        </div>
        <div className="field" style={{ marginLeft: 'auto' }}>
          <label>&nbsp;</label>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[{ value: 'base', label: '基础数据' }, { value: 'adv', label: '高阶数据' }]}
          />
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile label="筛选结果" value={rows.length} unit=" 人" />
        <PlayerTile label="得分王" player={topScorer} value={topScorer && `${num(topScorer.base?.pts)} 分`} />
        <PlayerTile label="PIE 最高" player={topPie} value={topPie && rate(topPie.adv?.pie)} />
        <PlayerTile
          label="缺阵影响最大"
          player={topImpact}
          value={topImpact && `${num(topImpact.outCostPts, 1)} 分/场`}
        />
      </div>

      <div className="card">
        <h2>
          {mode === 'base' ? '基础数据' : '高阶数据'}
          <span className="sub">点击表头排序 · 点击行进入所属球队</span>
        </h2>
        <PlayerTable
          rows={rows}
          mode={mode}
          maxHeight={640}
          onRowClick={(p) => go(`team/${p.teamId}`)}
          nameColumn={{
            key: 'name', label: '球员', align: 'left', width: 216,
            render: (p) => (
              <span className="player-cell">
                <PlayerHeadshot player={p} size={28} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.name}
                  {p.priorTeamAbbr && p.priorTeamAbbr !== p.teamAbbr && (
                    <span className="chip accent" style={{ marginLeft: 6 }}>转自 {p.priorTeamAbbr}</span>
                  )}
                </span>
              </span>
            ),
          }}
          extraColumns={[
            {
              key: 'teamAbbr', label: '球队', align: 'left', width: 142,
              render: (p) => <TeamCell team={teamById.get(p.teamId)} size={20} showAbbr={false} />,
            },
            { key: 'posCn', label: '位置', align: 'left', width: 72, render: (p) => <span className="dim">{p.posCn || '—'}</span> },
            { key: 'age', label: '年龄', width: 44, render: (p) => num(p.age, 0) },
          ]}
        />
      </div>
    </>
  );
}

/** 带头像的球员数据块 */
function PlayerTile({ label, player, value }) {
  if (!player) return <StatTile label={label} value="—" />;
  return (
    <div className="tile">
      <div className="k">{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 7 }}>
        <PlayerHeadshot player={player} size={34} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontWeight: 700, fontSize: 14, letterSpacing: '-.2px',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {player.name}
          </div>
          <div className="mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {player.teamAbbr} · {value}
          </div>
        </div>
      </div>
    </div>
  );
}
