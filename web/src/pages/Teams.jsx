import React, { useEffect, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import { TeamBadge, Loading, ErrorBox, Segmented } from '../components/common.jsx';
import { num, signed, signClass } from '../lib/format.js';

const CONF_CN = { East: '东部', West: '西部' };
const DIV_CN = {
  Atlantic: '大西洋', Central: '中部', Southeast: '东南',
  Northwest: '西北', Pacific: '太平洋', Southwest: '西南',
};

export default function Teams() {
  const { teams, meta, out, params } = useApp();
  const [rankings, setRankings] = useState(null);
  const [error, setError] = useState(null);
  const [groupBy, setGroupBy] = useState('conference');

  useEffect(() => {
    let alive = true;
    api.rankings(withOut(params, out))
      .then((r) => alive && setRankings(r))
      .catch((e) => alive && setError(e));
    return () => { alive = false; };
  }, [params, out]);

  if (error) return <ErrorBox error={error} />;
  if (!rankings) return <Loading />;

  const rankById = new Map(rankings.map((r) => [r.teamId, r]));

  const groups = {};
  for (const t of teams) {
    const key = groupBy === 'conference' ? CONF_CN[t.conference] : DIV_CN[t.division] ?? t.division;
    (groups[key] ??= []).push(t);
  }
  const order = groupBy === 'conference'
    ? ['东部', '西部']
    : ['大西洋', '中部', '东南', '西北', '太平洋', '西南'];

  return (
    <>
      <div className="page-head">
        <h1>球队</h1>
        <p>30 支球队的 {meta.priorSeason} 赛季表现与 {meta.targetSeason} 实力评级，点击进入球队详情。</p>
      </div>

      <div className="toolbar">
        <Segmented
          value={groupBy}
          onChange={setGroupBy}
          options={[{ value: 'conference', label: '按分区' }, { value: 'division', label: '按赛区' }]}
        />
      </div>

      {order.filter((k) => groups[k]).map((key) => (
        <div className="card" key={key}>
          <h2>{key} <span className="sub">{groups[key].length} 队</span></h2>
          <div className="grid cols-3">
            {groups[key]
              .slice()
              .sort((a, b) => (rankById.get(b.teamId)?.total ?? 0) - (rankById.get(a.teamId)?.total ?? 0))
              .map((t) => <TeamCard key={t.teamId} team={t} rank={rankById.get(t.teamId)} />)}
          </div>
        </div>
      ))}
    </>
  );
}

function TeamCard({ team, rank }) {
  return (
    <div
      className="stat-tile"
      style={{ cursor: 'pointer', borderLeft: `3px solid ${team.color}` }}
      onClick={() => go(`team/${team.teamId}`)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <TeamBadge team={team} size={34} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 650 }}>{team.cn}</div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            {team.full} · 上季 {team.wins}-{team.losses}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className={`mono ${signClass(rank?.total)}`} style={{ fontWeight: 700, fontSize: 16 }}>
            {signed(rank?.total, 1)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>联盟第 {rank?.rank}</div>
        </div>
      </div>
      <div className="divider" style={{ margin: '10px 0 8px' }} />
      <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-faint)' }}>
        <span>Elo <b className="mono" style={{ color: 'var(--text-dim)' }}>{num(team.elo, 0)}</b></span>
        <span>进攻 <b className="mono" style={{ color: 'var(--text-dim)' }}>{num(team.adv.offRtg)}</b></span>
        <span>防守 <b className="mono" style={{ color: 'var(--text-dim)' }}>{num(team.adv.defRtg)}</b></span>
        <span>节奏 <b className="mono" style={{ color: 'var(--text-dim)' }}>{num(team.adv.pace)}</b></span>
      </div>
    </div>
  );
}
