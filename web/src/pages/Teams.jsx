import React, { useEffect, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import { TeamLogo, Loading, ErrorBox, Segmented } from '../components/common.jsx';
import { num, signed, signClass } from '../lib/format.js';
import { useI18n } from '../i18n/react.jsx';
import { teamPalette } from '../lib/color.js';

export default function Teams() {
  const { t, fmt } = useI18n();
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
  // 分组键用原始代码（East / Atlantic…），显示名由 fmt 按语言给出
  for (const tm of teams) {
    const key = groupBy === 'conference' ? tm.conference : tm.division;
    (groups[key] ??= []).push(tm);
  }
  const order = groupBy === 'conference' ? ['East', 'West'] : fmt.DIV_CODES;
  const groupName = groupBy === 'conference' ? fmt.conf : fmt.div;

  return (
    <>
      <div className="page-head">
        <h1>{t('teams.title')}</h1>
        <p>{t('teams.intro', { season: meta.displayCurrent ? meta.targetSeason : meta.priorSeason, target: meta.targetSeason })}</p>
      </div>

      <div className="toolbar">
        <Segmented
          value={groupBy}
          onChange={setGroupBy}
          options={[{ value: 'conference', label: t('teams.byConf') }, { value: 'division', label: t('teams.byDiv') }]}
        />
      </div>

      {order.filter((k) => groups[k]).map((key) => (
        <div className="card" key={key}>
          <h2>{groupName(key)} <span className="sub">{t('teams.teamCount', { count: groups[key].length })}</span></h2>
          <div className="grid cols-3">
            {groups[key]
              .slice()
              .sort((a, b) => (rankById.get(b.teamId)?.total ?? 0) - (rankById.get(a.teamId)?.total ?? 0))
              .map((tm) => (
                <TeamCard key={tm.teamId} team={tm} rank={rankById.get(tm.teamId)} dark={dark} />
              ))}
          </div>
        </div>
      ))}
    </>
  );
}

function TeamCard({ team, rank, dark }) {
  const { meta } = useApp();
  const { t, fmt } = useI18n();
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
          <div className="nm">{fmt.teamName(team)}</div>
          <div className="sub">{fmt.teamName(team) !== team.full && `${team.full} · `}{t(meta.displayCurrent ? 'teams.thisSeason' : 'teams.lastSeason')} {team.wins}-{team.losses}</div>
        </div>
        <div className="val">
          <b className={signClass(rank?.total)}>{signed(rank?.total, 1)}</b>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{t('teams.leagueRank', { rank: rank?.rank })}</div>
        </div>
      </div>
      <div className="foot">
        <span>Elo <b className="mono">{num(team.elo, 0)}</b></span>
        <span>{t('teams.offense')} <b className="mono">{num(team.adv.offRtg)}</b></span>
        <span>{t('teams.defense')} <b className="mono">{num(team.adv.defRtg)}</b></span>
        <span>
          {t('teams.turnover')}{' '}
          <b className={`mono ${signClass(rank?.turnoverAdj)}`}>{signed(rank?.turnoverAdj, 1)}</b>
        </span>
      </div>
    </div>
  );
}
