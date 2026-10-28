import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api } from '../lib/api.js';
import { useI18n } from '../i18n/react.jsx';
import {
  TeamLogo, PlayerHeadshot, StatTile, Loading, ErrorBox, DataTable, InjuryBadge, MarketCompare,
} from '../components/common.jsx';
import { num, signed, signClass, rate } from '../lib/format.js';
import { inkOn } from '../lib/color.js';

// 参数名取 predict.param.<key>
const PARAM_FIELDS = [
  { key: 'homeAdv', min: 0, max: 6, step: 0.1 },
  { key: 'wElo', min: 0, max: 1, step: 0.05 },
  { key: 'wNet', min: 0, max: 1, step: 0.05 },
  { key: 'restWeight', min: 0, max: 3, step: 0.1 },
  { key: 'rosterWeight', min: 0, max: 2, step: 0.05 },
  { key: 'turnoverWeight', min: 0, max: 1.5, step: 0.05 },
  { key: 'spreadSd', min: 8, max: 16, step: 0.5 },
];

export default function Predict({ initial = [] }) {
  const { meta, teams, teamById, out, toggleOut, params, setParams, setAccent } = useApp();
  const { t, fmt } = useI18n();

  // 下拉框按当前语言排序；默认对阵仍取中文排序的前两队，保证中英文打开同一场
  const sorted = useMemo(() => fmt.sortTeams(teams), [teams, fmt]);
  const defaults = useMemo(() => [...teams].sort((a, b) => a.cn.localeCompare(b.cn, 'zh')), [teams]);
  const [awayId, setAwayId] = useState(() => Number(initial[0]) || defaults[0]?.teamId);
  const [homeId, setHomeId] = useState(() => Number(initial[1]) || defaults[1]?.teamId);
  const [gameId, setGameId] = useState(() => initial[2] ?? null);
  const [neutral, setNeutral] = useState(false);
  const [showParams, setShowParams] = useState(false);

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [rosters, setRosters] = useState({});
  const [matchups, setMatchups] = useState([]);

  const home = teamById.get(homeId);
  const away = teamById.get(awayId);

  // 背景光斑用主队配色
  useEffect(() => {
    if (home) setAccent(home);
    return () => setAccent(null);
  }, [home, setAccent]);

  // 路由变化（从赛程页点进来）时同步选择
  useEffect(() => {
    if (initial[0]) setAwayId(Number(initial[0]));
    if (initial[1]) setHomeId(Number(initial[1]));
    setGameId(initial[2] ?? null);
  }, [initial.join('/')]);

  // 拉取两队名单
  useEffect(() => {
    for (const id of [awayId, homeId]) {
      if (!id || rosters[id]) continue;
      api.players({ teamId: id, onRoster: 1 })
        .then((list) => setRosters((r) => ({
          ...r,
          [id]: list.sort((a, b) => (b.min ?? 0) - (a.min ?? 0)),
        })));
    }
  }, [awayId, homeId]);

  // 两队之间的对阵场次，供选择具体日期
  useEffect(() => {
    if (!awayId || !homeId) return;
    let alive = true;
    api.schedule({ type: 'all', teamId: homeId, predict: 0 })
      .then((d) => {
        if (!alive) return;
        setMatchups(d.games.filter(
          (g) => (g.homeId === homeId && g.awayId === awayId)
            || (g.homeId === awayId && g.awayId === homeId),
        ));
      });
    return () => { alive = false; };
  }, [awayId, homeId]);

  // 预测
  useEffect(() => {
    if (!awayId || !homeId || awayId === homeId) {
      setResult(null);
      setError(null);
      return;
    }
    let alive = true;
    setError(null);
    api.predict({ homeId, awayId, gameId, neutral, out, params })
      .then((r) => alive && setResult(r))
      .catch((e) => alive && setError(e));
    return () => { alive = false; };
  }, [awayId, homeId, gameId, neutral, out, params]);

  const sameTeams = !!awayId && awayId === homeId;
  const selectedGame = matchups.find((g) => g.gameId === gameId);
  const swap = () => { setAwayId(homeId); setHomeId(awayId); setGameId(null); };

  return (
    <>
      <div className="page-head">
        <h1>{t('predict.title')}</h1>
        <p>{t('predict.intro')}</p>
      </div>

      <div className="card">
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <div className="field">
            <label>{t('predict.away')}</label>
            <select
              value={awayId}
              onChange={(e) => { setAwayId(Number(e.target.value)); setGameId(null); }}
              style={{ minWidth: 168 }}
            >
              {sorted.map((tm) => <option key={tm.teamId} value={tm.teamId}>{fmt.teamName(tm)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>&nbsp;</label>
            <button className="btn" onClick={swap} title={t('predict.swap')}>⇄</button>
          </div>
          <div className="field">
            <label>{t('predict.home')}</label>
            <select
              value={homeId}
              onChange={(e) => { setHomeId(Number(e.target.value)); setGameId(null); }}
              style={{ minWidth: 168 }}
            >
              {sorted.map((tm) => <option key={tm.teamId} value={tm.teamId}>{fmt.teamName(tm)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{t('predict.game')}</label>
            <select
              value={gameId ?? ''}
              onChange={(e) => setGameId(e.target.value || null)}
              style={{ minWidth: 216 }}
            >
              <option value="">{t('predict.noGame')}</option>
              {matchups.map((g) => (
                <option key={g.gameId} value={g.gameId}>
                  {fmt.date(g.date)} · {g.awayAbbr} @ {g.homeAbbr}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>&nbsp;</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 0' }}>
              <input type="checkbox" checked={neutral} onChange={(e) => setNeutral(e.target.checked)} />
              <span style={{ fontSize: 12.5 }}>{t('predict.neutral')}</span>
            </label>
          </div>
          <div className="field" style={{ marginLeft: 'auto' }}>
            <label>&nbsp;</label>
            <button className="btn" onClick={() => setShowParams((v) => !v)}>
              {showParams ? t('predict.hideParams') : t('predict.showParams')}
            </button>
          </div>
        </div>

        {showParams && (
          <>
            <div className="divider" />
            <ParamPanel meta={meta} params={params} setParams={setParams} />
          </>
        )}
      </div>

      <ErrorBox error={error} />
      {sameTeams && <div className="err">{t('predict.sameTeams')}</div>}

      {!result ? <Loading /> : (
        <>
          <div className="card">
            <div className="matchup">
              <div className="side">
                <TeamLogo team={away} size={62} />
                <div className="nm">{fmt.teamName(away)}</div>
                <div className="rec">{away.wins}-{away.losses} · {t('predict.road')}</div>
                <div className="score" style={{ color: result.margin < 0 ? 'var(--text)' : 'var(--text-dim)' }}>
                  {result.awayScore.toFixed(0)}
                </div>
              </div>
              <div className="vs">
                <div>VS</div>
                {selectedGame && (
                  <div style={{ marginTop: 8, fontSize: 11.5 }}>
                    {fmt.date(selectedGame.date)}<br />
                    <span className="dim">{selectedGame.arena}</span>
                  </div>
                )}
              </div>
              <div className="side">
                <TeamLogo team={home} size={62} />
                <div className="nm">{fmt.teamName(home)}</div>
                <div className="rec">{home.wins}-{home.losses} · {neutral ? t('common.side.neutral') : t('predict.homeCourt')}</div>
                <div className="score" style={{ color: result.margin > 0 ? 'var(--text)' : 'var(--text-dim)' }}>
                  {result.homeScore.toFixed(0)}
                </div>
              </div>
            </div>

            {result.pregame && (
              <div className="note" style={{ marginTop: 14, textAlign: 'center' }}>
                <span className="chip">{t('predict.final')}</span>{' '}
                {t('predict.actual')}{' '}<b className="mono">{away.abbr} {result.actual.awayScore} - {result.actual.homeScore} {home.abbr}</b>
                {' · '}
                <span className={`chip ${result.hit ? 'hit' : 'miss'}`}>{result.hit ? t('predict.hit') : t('predict.miss')}</span>
                <br />
                {t('predict.pregameNote')}
              </div>
            )}

            <div style={{ marginTop: 18 }}>
              <div className="split-bar">
                <div style={{ width: `${result.awayWinProb * 100}%`, background: away.color, color: inkOn(away.color) }}>
                  {(result.awayWinProb * 100).toFixed(1)}%
                </div>
                <div style={{ width: `${result.homeWinProb * 100}%`, background: home.color, color: inkOn(home.color) }}>
                  {(result.homeWinProb * 100).toFixed(1)}%
                </div>
              </div>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                fontSize: 10.5, color: 'var(--text-faint)', marginTop: 5,
              }}
              >
                <span>{t('predict.winProb', { abbr: away.abbr })}</span>
                <span>{t('predict.winProb', { abbr: home.abbr })}</span>
              </div>
            </div>

            <div className="grid cols-4" style={{ marginTop: 16 }}>
              <StatTile label={t('predict.tile.margin')} value={signed(result.margin)} hint={t('predict.tile.marginHint')} />
              <StatTile
                label={t('predict.tile.spread')}
                value={result.spread > 0 ? `+${result.spread}` : `${result.spread}`}
                hint={t('predict.tile.spreadHint')}
              />
              <StatTile label={t('predict.tile.total')} value={num(result.total, 1)} />
              <StatTile
                label={t('predict.tile.rest')}
                value={`${fmt.rest(result.restAway)} / ${fmt.rest(result.restHome)}`}
                hint={t('predict.tile.restHint')}
              />
            </div>

            {result.market && (
              <div style={{ marginTop: 16 }}>
                <MarketCompare
                  market={result.market}
                  prediction={result}
                  home={home}
                  away={away}
                />
              </div>
            )}
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h2>{t('predict.breakdown')} <span className="sub">{t('predict.breakdownSum', { pts: signed(result.margin) })}</span></h2>
              <FactorChart factors={result.factors} />
              <div className="divider" />
              <DataTable
                rows={[
                  { k: t('predict.row.total'), h: result.strength.home.total, a: result.strength.away.total },
                  { k: t('predict.row.eloPts'), h: result.strength.home.eloPts, a: result.strength.away.eloPts },
                  { k: t('predict.row.netPts'), h: result.strength.home.netPts, a: result.strength.away.netPts },
                  { k: t('predict.row.turnoverAdj'), h: result.strength.home.turnoverAdj, a: result.strength.away.turnoverAdj },
                  { k: t('predict.row.rosterAdj'), h: result.strength.home.rosterAdj, a: result.strength.away.rosterAdj },
                  { k: t('predict.row.offRtg'), h: home.adv.offRtg, a: away.adv.offRtg },
                  { k: t('predict.row.defRtg'), h: home.adv.defRtg, a: away.adv.defRtg },
                  { k: t('predict.row.pace'), h: home.adv.pace, a: away.adv.pace },
                  { k: t('predict.row.tsPct'), h: home.adv.tsPct * 100, a: away.adv.tsPct * 100 },
                ]}
                rowKey={(r) => r.k}
                initialSort={{ key: 'k', dir: 'asc' }}
                columns={[
                  { key: 'k', label: t('predict.col.metric'), align: 'left', width: 176 },
                  { key: 'a', label: t('predict.col.away', { abbr: away.abbr }), width: 76, render: (r) => num(r.a, 2) },
                  { key: 'h', label: t('predict.col.home', { abbr: home.abbr }), width: 76, render: (r) => num(r.h, 2) },
                  {
                    key: 'd', label: t('predict.col.diff'), width: 76,
                    value: (r) => r.h - r.a,
                    render: (r) => <span className={signClass(r.h - r.a)}>{signed(r.h - r.a, 2)}</span>,
                  },
                ]}
              />
            </div>

            <div className="card">
              <h2>{t('predict.outTitle')} <span className="sub">{t('predict.outSub')}</span></h2>
              <div className="grid cols-2">
                <RosterPicker
                  team={away} roster={rosters[awayId]} out={out[awayId] ?? []}
                  onToggle={(pid) => toggleOut(awayId, pid)}
                />
                <RosterPicker
                  team={home} roster={rosters[homeId]} out={out[homeId] ?? []}
                  onToggle={(pid) => toggleOut(homeId, pid)}
                />
              </div>
              {(result.strength.home.missing.length > 0 || result.strength.away.missing.length > 0) && (
                <>
                  <div className="divider" />
                  <h2>{t('predict.outImpact')}</h2>
                  <DataTable
                    rows={[
                      ...result.strength.away.missing.map((m) => ({ ...m, team: away.abbr })),
                      ...result.strength.home.missing.map((m) => ({ ...m, team: home.abbr })),
                    ]}
                    rowKey={(r) => r.playerId}
                    initialSort={{ key: 'costPts', dir: 'asc' }}
                    columns={[
                      { key: 'team', label: t('predict.col.team'), align: 'left', width: 54 },
                      {
                        key: 'name', label: t('predict.col.player'), align: 'left', width: 172,
                        render: (r) => (
                          <span className="player-cell">
                            <PlayerHeadshot player={r} size={24} />
                            <span>{r.name}</span>
                          </span>
                        ),
                      },
                      { key: 'min', label: t('predict.col.min'), width: 72, render: (r) => num(r.min) },
                      { key: 'pie', label: 'PIE', width: 56, render: (r) => rate(r.pie) },
                      {
                        key: 'costPts', label: t('predict.col.cost'), width: 72,
                        render: (r) => <span className="neg">{num(r.costPts, 2)}</span>,
                      },
                    ]}
                  />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function FactorChart({ factors }) {
  const { t } = useI18n();
  const max = Math.max(1, ...factors.map((f) => Math.abs(f.value)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {factors.map((f) => (
        <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
          <div style={{ width: 88, color: 'var(--text-dim)', flex: 'none' }}>{t(`srv.predict.factor.${f.key}`)}</div>
          <div style={{ flex: 1, display: 'flex', height: 15, alignItems: 'center' }}>
            <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
              {f.value < 0 && (
                <div style={{
                  width: `${(Math.abs(f.value) / max) * 100}%`, height: 13,
                  background: 'var(--bad)', borderRadius: '3px 0 0 3px', opacity: .9,
                  boxShadow: '0 0 10px var(--bad)',
                }}
                />
              )}
            </div>
            <div style={{ width: 1, height: 15, background: 'var(--line)' }} />
            <div style={{ flex: 1 }}>
              {f.value > 0 && (
                <div style={{
                  width: `${(Math.abs(f.value) / max) * 100}%`, height: 13,
                  background: 'var(--good)', borderRadius: '0 3px 3px 0', opacity: .9,
                  boxShadow: '0 0 10px var(--good)',
                }}
                />
              )}
            </div>
          </div>
          <div className={`mono ${signClass(f.value)}`} style={{ width: 52, textAlign: 'right' }}>
            {signed(f.value, 2)}
          </div>
        </div>
      ))}
      <div className="legend" style={{ marginTop: 3 }}>
        <span><i style={{ background: 'var(--good)' }} />{t('predict.favorsHome')}</span>
        <span><i style={{ background: 'var(--bad)' }} />{t('predict.favorsAway')}</span>
      </div>
    </div>
  );
}

function RosterPicker({ team, roster, out, onToggle }) {
  const { t, fmt } = useI18n();
  if (!team) return null;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <TeamLogo team={team} size={22} />
        <b style={{ fontSize: 12.5 }}>{fmt.teamName(team)}</b>
        {out.length > 0 && <span className="chip accent">{t('app.outCount', { count: out.length })}</span>}
      </div>
      {!roster ? <Loading text={t('predict.loadingRoster')} /> : (
        <div className="scroll-y" style={{ maxHeight: 330, paddingRight: 4 }}>
          {roster.map((p) => (
            <label
              key={p.playerId}
              className="player-row"
              style={{
                padding: '3px 2px',
                borderBottom: '1px solid var(--line-2)',
                cursor: 'pointer',
                opacity: out.includes(p.playerId) ? 0.5 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={out.includes(p.playerId)}
                onChange={() => onToggle(p.playerId)}
              />
              <PlayerHeadshot player={p} size={24} />
              <span style={{
                flex: 1, fontSize: 12.5, minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              >
                {p.name}
                <InjuryBadge injury={p.injury} />
              </span>
              <span className="dim mono" style={{ fontSize: 10.5 }}>{t('predict.minutes', { min: num(p.min, 0) })}</span>
              <span
                className="mono"
                title={t('predict.outCostTip')}
                style={{
                  fontSize: 10.5, width: 38, textAlign: 'right',
                  color: p.outCostPts < -0.05 ? 'var(--warn)' : 'var(--text-faint)',
                }}
              >
                {p.outCostPts < -0.05 ? num(p.outCostPts, 1) : '≈0'}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function ParamPanel({ meta, params, setParams }) {
  const { t } = useI18n();
  const value = (k) => params[k] ?? meta.defaultParams[k];
  return (
    <div>
      <div className="grid cols-3">
        {PARAM_FIELDS.map((f) => (
          <div key={f.key} className="field">
            <label>{t(`predict.param.${f.key}`)} · <b className="mono">{num(value(f.key), 2)}</b></label>
            <input
              type="range"
              min={f.min} max={f.max} step={f.step}
              value={value(f.key)}
              onChange={(e) => setParams((p) => ({ ...p, [f.key]: Number(e.target.value) }))}
            />
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => setParams({})}>{t('predict.resetParams')}</button>
        <label title={t('predict.healthyTip')} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <input
            type="checkbox"
            checked={!!params.assumeHealthy}
            onChange={(e) => setParams((p) => ({ ...p, assumeHealthy: e.target.checked ? 1 : 0 }))}
          />
          {t('app.healthyLabel')}
        </label>
        <span className="note">{t('predict.paramsShared')}</span>
      </div>
    </div>
  );
}
