import React, { useEffect, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api } from '../lib/api.js';
import { DataTable, TeamCell, StatTile, TeamLogo, Loading, ErrorBox, Segmented } from '../components/common.jsx';
import { num, signed, signClass, pct100, probColor } from '../lib/format.js';
import { useI18n } from '../i18n/react.jsx';

export default function Simulate() {
  const { meta, teamById, out, params, setAccent } = useApp();
  const { t, fmt } = useI18n();
  const [sims, setSims] = useState(3000);
  const [conf, setConf] = useState('all');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);

  useEffect(() => { setAccent(null); }, [setAccent]);

  const run = (n = sims) => {
    setRunning(true);
    setError(null);
    api.simulate({ sims: n, out, params })
      .then(setData)
      .catch(setError)
      .finally(() => setRunning(false));
  };

  useEffect(() => { run(); /* eslint-disable-next-line */ }, [out, params]);

  const rows = (data?.teams ?? []).filter((r) => conf === 'all' || r.conference === conf);
  const best = data && [...data.teams].sort((a, b) => b.bestRecordPct - a.bestRecordPct)[0];

  return (
    <>
      <div className="page-head">
        <h1>{t('simulate.title')}</h1>
        <p>{t('simulate.intro', { season: meta.targetSeason })}</p>
      </div>

      <div className="toolbar">
        <div className="field">
          <label>{t('simulate.sims')}</label>
          <select value={sims} onChange={(e) => setSims(Number(e.target.value))}>
            {[1000, 3000, 5000, 10000].map((n) => (
              <option key={n} value={n}>{t('simulate.runs', { n: n.toLocaleString('en-US') })}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <button className="btn primary" disabled={running} onClick={() => run()}>
            {running ? t('simulate.running') : t('simulate.rerun')}
          </button>
        </div>
        <div className="field" style={{ marginLeft: 'auto' }}>
          <label>&nbsp;</label>
          <Segmented
            value={conf}
            onChange={setConf}
            options={[
              { value: 'all', label: t('simulate.all') },
              { value: 'East', label: fmt.conf('East') },
              { value: 'West', label: fmt.conf('West') },
            ]}
          />
        </div>
      </div>

      <ErrorBox error={error} />

      {!data ? <Loading text={t('simulate.loading')} /> : (
        <>
          <div className="grid cols-4" style={{ marginBottom: 14 }}>
            <StatTile label={t('simulate.sims')} value={data.sims.toLocaleString('en-US')} unit={t('simulate.tile.unitRuns', { count: data.sims })} />
            <StatTile label={t('simulate.tile.time')} value={data.ms} unit=" ms" />
            <div className="tile">
              <div className="k">{t('simulate.tile.best')}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 7 }}>
                <TeamLogo team={teamById.get(best.teamId)} size={32} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 720, fontSize: 14 }}>{fmt.teamName(teamById.get(best.teamId))}</div>
                  <div className="mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                    {pct100(best.bestRecordPct, 0)}
                  </div>
                </div>
              </div>
            </div>
            <StatTile
              label={t('simulate.tile.fifty')}
              value={data.teams.filter((r) => r.projWins >= 50).length}
              unit={t('simulate.tile.unitTeams', { count: data.teams.filter((r) => r.projWins >= 50).length })}
            />
          </div>

          <div className="card">
            <h2>
              {t('simulate.cardTitle', { scope: conf === 'all' ? t('simulate.all') : fmt.conf(conf) })}
              <span className="sub">{t('simulate.cardSub')}</span>
            </h2>
            <DataTable
              rows={rows}
              rowKey={(r) => r.teamId}
              initialSort={{ key: 'projWins', dir: 'desc' }}
              onRowClick={(r) => go(`team/${r.teamId}`)}
              columns={[
                {
                  key: 'cn', label: t('simulate.col.team'), align: 'left', width: 194,
                  value: (r) => fmt.teamName(teamById.get(r.teamId)),
                  render: (r) => <TeamCell team={teamById.get(r.teamId)} />,
                },
                { key: 'conference', label: t('simulate.col.conf'), width: 52, render: (r) => fmt.conf(r.conference) },
                {
                  key: 'strength', label: t('simulate.col.strength'), width: 64,
                  render: (r) => <span className={signClass(r.strength)}>{signed(r.strength, 1)}</span>,
                },
                {
                  key: 'projWins', label: t('simulate.col.record'), width: 94,
                  render: (r) => <b className="mono">{r.projWins.toFixed(1)}-{r.projLosses.toFixed(1)}</b>,
                },
                {
                  key: 'range', label: t('simulate.col.range'), width: 132,
                  value: (r) => r.winsHi - r.winsLo,
                  render: (r) => <WinRange lo={r.winsLo} hi={r.winsHi} mid={r.projWins} />,
                },
                { key: 'playoffPct', label: t('simulate.col.direct'), title: t('simulate.col.directTip'), width: 78, render: (r) => <Prob v={r.playoffPct} /> },
                { key: 'playinPct', label: t('simulate.col.playin'), title: t('simulate.col.playinTip'), width: 68, render: (r) => <Prob v={r.playinPct} /> },
                { key: 'postseasonPct', label: t('simulate.col.post'), width: 78, render: (r) => <Prob v={r.postseasonPct} /> },
                { key: 'topSeedPct', label: t('simulate.col.top'), width: 78, render: (r) => <Prob v={r.topSeedPct} /> },
                { key: 'bestRecordPct', label: t('simulate.col.best'), width: 78, render: (r) => <Prob v={r.bestRecordPct} /> },
              ]}
            />
          </div>

          <div className="card plain">
            <h2>{t('simulate.notes')}</h2>
            <p className="note">
              {t('simulate.note1', { sd: num(params.seasonNoiseSd ?? meta.defaultParams.seasonNoiseSd, 1) })}<br />
              {t('simulate.note2')}<br />
              {t('simulate.note3')}
            </p>
          </div>
        </>
      )}
    </>
  );
}

function Prob({ v }) {
  return (
    <span className="mono" style={{ color: v >= 50 ? probColor(v / 100) : 'var(--text-dim)' }}>
      {v.toFixed(1)}%
    </span>
  );
}

/** 胜场区间条 */
function WinRange({ lo, hi, mid }) {
  const min = 10;
  const max = 72;
  const x = (v) => ((v - min) / (max - min)) * 100;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%' }}>
      <span style={{
        position: 'relative', flex: 1, height: 7,
        background: 'var(--glass-3)', borderRadius: 4, minWidth: 66,
      }}
      >
        <span style={{
          position: 'absolute', left: `${x(lo)}%`, width: `${x(hi) - x(lo)}%`,
          top: 0, bottom: 0, background: 'var(--team-soft)',
          border: '1px solid var(--team-line)', borderRadius: 4,
        }}
        />
        <span style={{
          position: 'absolute', left: `${x(mid)}%`, width: 2, top: -2, bottom: -2,
          background: 'var(--team-raw)', boxShadow: '0 0 8px var(--team-raw)',
        }}
        />
      </span>
      <span className="mono dim" style={{ fontSize: 10.5, width: 42 }}>{lo}-{hi}</span>
    </span>
  );
}
