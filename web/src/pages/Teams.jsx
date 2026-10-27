import React, { useEffect, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import { TeamLogo, Loading, ErrorBox, Segmented } from '../components/common.jsx';
import { num, signed, signClass, CONF_CN, DIV_CN, DIV_ORDER } from '../lib/format.js';
import { teamPalette } from '../lib/color.js';

export default function Teams() {
  const { teams, meta, out, params, dark, setAccent } = useApp();
  const [rankings, setRankings] = useState(null);
  const [error, setError] = useState(null);
  const [groupBy, setGroupBy] = useState('conference');

  useEffect(() => { setAccent(null); }, [setAccent]);

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
  const order = groupBy === 'conference' ? ['东部', '西部'] : DIV_ORDER;

  return (
    <>
      <div className="page-head">
        <h1>球队</h1>
        <p>30 支球队的 {(meta.displayCurrent ? meta.targetSeason : meta.priorSeason)} 赛季表现与 {meta.targetSeason} 实力评级，点击进入球队详情。</p>
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
              .map((t) => (
                <TeamCard key={t.teamId} team={t} rank={rankById.get(t.teamId)} dark={dark} />
              ))}
          </div>
        </div>
      ))}
    </>
  );
}

function TeamCard({ team, rank, dark }) {
  const { meta } = useApp();
  const p = teamPalette(team, dark);
  return (
    <div
      className="team-card"
      style={{ '--tc': p.base, '--tc-soft': p.soft, '--tc-line': p.line }}
      onClick={() => go(`team/${team.teamId}`)}
    >
      <div className="row">
        <TeamLogo team={team} size={40} />
        <div style={{ minWidth: 0 }}>
          <div className="nm">{team.cn}</div>
          <div className="sub">{team.full} · {meta.displayCurrent ? '本季' : '上季'} {team.wins}-{team.losses}</div>
        </div>
        <div className="val">
          <b className={signClass(rank?.total)}>{signed(rank?.total, 1)}</b>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>联盟第 {rank?.rank}</div>
        </div>
      </div>
      <div className="foot">
        <span>Elo <b className="mono">{num(team.elo, 0)}</b></span>
        <span>进攻 <b className="mono">{num(team.adv.offRtg)}</b></span>
        <span>防守 <b className="mono">{num(team.adv.defRtg)}</b></span>
        <span>
          更迭{' '}
          <b className={`mono ${signClass(rank?.turnoverAdj)}`}>{signed(rank?.turnoverAdj, 1)}</b>
        </span>
      </div>
    </div>
  );
}
