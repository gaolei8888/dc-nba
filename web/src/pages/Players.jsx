import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api } from '../lib/api.js';
import {
  TeamCell, PlayerHeadshot, Loading, ErrorBox, Segmented, StatTile, DataTable, Th,
} from '../components/common.jsx';
import PlayerTable, { modeOptions } from '../components/PlayerTable.jsx';
import { num, rate } from '../lib/format.js';
import { useI18n } from '../i18n/react.jsx';

const POS_FILTERS = ['all', 'G', 'F', 'C'];

export default function Players() {
  const { teams, teamById, meta, setAccent } = useApp();
  const { t, fmt } = useI18n();
  const [all, setAll] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('base');
  const [q, setQ] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');
  const [posFilter, setPosFilter] = useState('all');
  // 默认门槛随赛季进度：本季取出场最少球队的已赛场次（封顶 20），上季数据仍为 20；用户改过就以用户为准
  const [userMinGp, setMinGp] = useState(null);
  const minGp = userMinGp ?? (meta.displayCurrent ? Math.min(20, ...teams.map((tm) => tm.wins + tm.losses)) : 20);
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
        <h1>{t('players.title')}</h1>
        <p>
          {t('players.intro', {
            season: meta.displayCurrent ? meta.targetSeason : meta.priorSeason,
            total: all.length,
            target: meta.targetSeason,
          })}
        </p>
      </div>

      <div className="toolbar">
        <div className="field">
          <label>{t('players.search')}</label>
          <input
            type="search"
            placeholder={t('players.searchPh')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ minWidth: 170 }}
          />
        </div>
        <div className="field">
          <label>{t('players.team')}</label>
          <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} style={{ minWidth: 150 }}>
            <option value="all">{t('players.allTeams')}</option>
            {fmt.sortTeams(teams).map((tm) => (
              <option key={tm.teamId} value={tm.teamId}>{fmt.teamName(tm)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>{t('players.pos')}</label>
          <select value={posFilter} onChange={(e) => setPosFilter(e.target.value)}>
            {POS_FILTERS.map((v) => <option key={v} value={v}>{v === 'all' ? t('players.allPos') : fmt.pos(v)}</option>)}
          </select>
        </div>
        <div className="field">
          <label>{t('players.minGp')}</label>
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
            <span style={{ fontSize: 12.5 }}>{t('players.rosterOnly')}</span>
          </label>
        </div>
        <div className="field" style={{ marginLeft: 'auto' }}>
          <label>&nbsp;</label>
          <Segmented
            value={mode}
            onChange={setMode}
            options={modeOptions(t)}
          />
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile label={t('players.tile.results')} value={rows.length} unit={t('players.tile.unit', { count: rows.length })} />
        <PlayerTile label={t('players.tile.scorer')} player={topScorer} value={topScorer && t('players.tile.pts', { v: num(topScorer.base?.pts) })} />
        <PlayerTile label={t('players.tile.pie')} player={topPie} value={topPie && rate(topPie.adv?.pie)} />
        <PlayerTile
          label={t('players.tile.outCost')}
          player={topImpact}
          value={topImpact && t('players.tile.perGame', { v: num(topImpact.outCostPts, 1) })}
        />
      </div>

      {mode === 'adv' && <ImpactValidation impact={meta.impact} />}

      <div className="card">
        <h2>
          {t('players.cardTitle', { mode: t(`playerTable.mode.${mode}`) })}
          <span className="sub">{t('players.cardSub')}</span>
        </h2>
        <PlayerTable
          rows={rows}
          mode={mode}
          maxHeight={640}
          onRowClick={(p) => go(`team/${p.teamId}`)}
          nameColumn={{
            key: 'name', label: t('players.player'), align: 'left', width: 216,
            render: (p) => (
              <span className="player-cell">
                <PlayerHeadshot player={p} size={28} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.name}
                  {p.priorTeamAbbr && p.priorTeamAbbr !== p.teamAbbr && (
                    <span className="chip accent" style={{ marginLeft: 6 }}>{t('players.from', { team: p.priorTeamAbbr })}</span>
                  )}
                </span>
              </span>
            ),
          }}
          extraColumns={[
            {
              key: 'teamAbbr', label: t('players.team'), align: 'left', width: 142,
              render: (p) => <TeamCell team={teamById.get(p.teamId)} size={20} showAbbr={false} />,
            },
            { key: 'posCn', label: t('players.pos'), align: 'left', width: 72, render: (p) => <span className="dim">{p.pos ? fmt.pos(p.pos) : '—'}</span> },
            { key: 'age', label: t('players.age'), width: 44, render: (p) => num(p.age, 0) },
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

/**
 * IMP 的验证成绩。
 *
 * 验收标准是「用第 N 季的数据预测第 N+1 季的真实表现」——不是同赛季。
 * 同赛季的比法有两个毛病：IMP 里含当季 APM，等于拿目标的一部分预测目标；
 * 而且不对题，这个应用本来就是拿上赛季预测下赛季。
 *
 * 把各个候选指标一起列出来，包括 IMP 输的那些格子。
 * 「对标盘口」那页也是这么处理自己的短处的——只报好数字的指标不值得信。
 */
export function ImpactValidation({ impact }) {
  const { t } = useI18n();
  const v = impact?.validation;
  if (!v?.perPair?.length) return null;
  const names = v.candidates ?? Object.keys(v.average ?? {});
  const avg = v.average ?? {};
  const best = (row) => Math.max(...names.map((n) => row[n] ?? -9));
  const wins = v.perPair.filter((row) => (row.IMP ?? -9) >= best(row)).length;
  // 候选指标名来自数据文件（含中文括注），显示时按代号翻成当前语言；纯 ASCII 的（IMP、PIE）原样
  const candLabel = (n) => {
    if (/^[\x00-\x7f]+$/.test(n)) return n;
    if (n.startsWith('IMP')) return t('players.impact.cand.impPre');
    if (n.startsWith('SPM')) return t('players.impact.cand.spm');
    if (n.startsWith('APM')) return t('players.impact.cand.apm');
    return t('players.impact.cand.netRtg');
  };

  return (
    <div className="card">
      <h2>
        {t('players.impact.title')}
        <span className="sub">{t('players.impact.criterion')}</span>
      </h2>

      <div className="grid cols-3" style={{ marginBottom: 12 }}>
        <StatTile
          abbr="IMP" label={t('players.impact.avg')} value={(avg.IMP ?? 0).toFixed(3)}
          hint={t('players.impact.avgHint')}
        />
        <StatTile
          abbr="PIE" label={t('players.impact.same')} value={(avg.PIE ?? 0).toFixed(3)}
          hint={t('players.impact.sameHint')}
        />
        <StatTile
          abbr="W" label={t('players.impact.first')} value={`${wins} / ${v.perPair.length}`}
          hint={t('players.impact.firstHint')}
        />
      </div>

      <DataTable
        rows={v.perPair}
        rowKey={(r) => r.pair}
        initialSort={{ key: 'pair', dir: 'asc' }}
        columns={[
          { key: 'pair', label: t('players.impact.pair'), align: 'left', width: 132 },
          { key: 'n', label: t('players.impact.n'), width: 58 },
          ...names.map((n) => ({
            key: n,
            label: n === 'IMP' ? <Th abbr="IMP" label={t('players.impact.blend')} /> : candLabel(n),
            title: n === 'IMP' ? 'IMP' : candLabel(n),
            width: n === 'IMP' ? 76 : 112,
            render: (r) => {
              const val = r[n];
              if (val === null || val === undefined) return <span className="dim">—</span>;
              const isBest = val >= best(r);
              return isBest ? <b className="pos">{val.toFixed(3)}</b> : val.toFixed(3);
            },
          })),
        ]}
      />

      <p className="note" style={{ marginTop: 10 }}>
        {t('players.impact.n1.pre')}<b>{t('players.impact.n1.b1')}</b>{t('players.impact.n1.mid')}<b>{t('players.impact.n1.b2')}</b>
        {t('players.impact.n1.tail', {
          spm: Math.round((1 - (impact.blendW ?? 0.35)) * 100),
          apm: Math.round((impact.blendW ?? 0.35) * 100),
        })}
      </p>
      {v.shrink && (
        <p className="note">
          {t('players.impact.n2.pre')}<b>{t('players.impact.n2.b')}</b>{t('players.impact.n2.tail', { k: v.shrink.k, pivot: v.shrink.pivot })}
        </p>
      )}
      <p className="note">
        {t('players.impact.n3.pre')}<b>{t('players.impact.n3.b1')}</b>{t('players.impact.n3.mid')}<b>{t('players.impact.n3.b2')}</b>{t('players.impact.n3.tail')}
      </p>
      <p className="note">
        {t('players.impact.n4.pre')}<b>{t('players.impact.n4.b1')}</b>{t('players.impact.n4.mid')}<b>{t('players.impact.n4.b2')}</b>{t('players.impact.n4.tail')}
      </p>
    </div>
  );
}
