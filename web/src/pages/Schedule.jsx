import React, { useEffect, useMemo, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { api, withOut } from '../lib/api.js';
import { TeamCell, Loading, ErrorBox, ProbBar, StatTile } from '../components/common.jsx';
import { fmtDate, restLabel, probColor, num, snapshotAge } from '../lib/format.js';

const TYPES = [
  { value: 'regular', label: '常规赛' },
  { value: 'preseason', label: '季前赛' },
  { value: 'all', label: '全部' },
];

export default function Schedule() {
  const { meta, teams, teamById, out, params, setAccent } = useApp();
  const [type, setType] = useState('regular');
  const [teamFilter, setTeamFilter] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState({ loading: true });

  // 筛选到某支球队时整站配色跟着走
  useEffect(() => {
    setAccent(teamFilter === 'all' ? null : teamById.get(Number(teamFilter)) ?? null);
    return () => setAccent(null);
  }, [teamFilter, teamById, setAccent]);

  useEffect(() => {
    let alive = true;
    setData((d) => ({ ...d, loading: true }));
    api.schedule(withOut({
      ...params,
      type,
      teamId: teamFilter === 'all' ? undefined : teamFilter,
      from: from || undefined,
      to: to || undefined,
    }, out))
      .then((d) => alive && setData({ loading: false, ...d }))
      .catch((error) => alive && setData({ loading: false, error }));
    return () => { alive = false; };
  }, [type, teamFilter, from, to, params, out]);

  // 盘口是快照，页面上要说清它有多旧——用户看到一条三周前的线却以为是当前的，
  // 比看不到盘口更容易被误导
  const withOdds = useMemo(() => (data.games ?? []).filter((g) => g.market), [data.games]);
  const oddsCount = withOdds.length;
  const oddsAge = oddsCount ? snapshotAge(withOdds[0].market.fetchedAt) : null;

  const byDate = useMemo(() => {
    if (!data.games) return [];
    const map = new Map();
    for (const g of data.games) {
      if (!map.has(g.date)) map.set(g.date, []);
      map.get(g.date).push(g);
    }
    return [...map.entries()];
  }, [data.games]);

  if (data.error) return <ErrorBox error={data.error} />;

  const games = data.games ?? [];
  const dateRange = games.length ? `${games[0].date} ~ ${games[games.length - 1].date}` : '—';
  const closeGames = games.filter((g) => Math.abs(g.prediction.homeWinProb - 0.5) < 0.06).length;

  return (
    <>
      <div className="page-head">
        <h1>{meta.targetSeason} 赛程</h1>
        <p>官方完整赛程，每场附模型预测胜率与比分。点击任意比赛进入详细预测。</p>
      </div>

      <div className="toolbar">
        <div className="field">
          <label>类型</label>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
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
          <label>起始日期</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label>结束日期</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <button className="btn" onClick={() => { setFrom(''); setTo(''); setTeamFilter('all'); }}>重置</button>
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile label="比赛场次" value={games.length} unit=" 场" />
        <StatTile label="比赛日" value={byDate.length} unit=" 天" />
        <StatTile label="日期范围" value={dateRange} />
        <StatTile label="势均力敌" value={closeGames} unit=" 场" hint="双方胜率差距在 12 个百分点以内" />
      </div>

      {data.loading ? <Loading /> : (
        <div className="card">
          <h2>
            赛程列表
            <span className="sub">
              胜率为主队获胜概率
              {oddsAge && ` · 盘口 ${oddsCount} 场，${oddsAge.text}`}
            </span>
          </h2>
          {oddsAge?.stale && (
            <div className="market-stale" style={{ marginBottom: 10 }}>
              盘口是 {oddsAge.days} 天前抓的，博彩商此后可能已经改线。以当前实际盘口为准。
            </div>
          )}
          <div className="table-wrap" style={{ maxHeight: 700, overflowY: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th className="left" style={{ width: 112 }}>日期</th>
                  <th className="left" style={{ width: 184 }}>客队</th>
                  <th className="left" style={{ width: 184 }}>主队</th>
                  <th style={{ width: 58 }}>休息</th>
                  <th style={{ width: 122 }}>主队胜率</th>
                  <th style={{ width: 94 }} title="已结束的比赛显示真实比分，悬停可看赛前预测">比分</th>
                  <th style={{ width: 62 }}>总分</th>
                  <th style={{ width: 96 }} title="博彩让分（主队），以及模型与它的分歧">盘口 / 分歧</th>
                  <th className="left" style={{ width: 170 }}>场馆 / 备注</th>
                </tr>
              </thead>
              <tbody>
                {byDate.map(([date, list]) => list.map((g, i) => (
                  <tr
                    key={g.gameId}
                    className="clickable"
                    onClick={() => go(`predict/${g.awayId}/${g.homeId}/${g.gameId}`)}
                  >
                    <td className="left sched-date">{i === 0 ? fmtDate(date) : ''}</td>
                    <td className="left"><TeamCell team={teamById.get(g.awayId)} size={20} showAbbr={false} /></td>
                    <td className="left"><TeamCell team={teamById.get(g.homeId)} size={20} showAbbr={false} /></td>
                    <td className="dim" style={{ fontSize: 10.5 }}>
                      {restLabel(g.prediction.restAway)}<br />{restLabel(g.prediction.restHome)}
                    </td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                        <ProbBar p={g.prediction.homeWinProb} width={52} />
                        <b className="mono" style={{ color: probColor(g.prediction.homeWinProb) }}>
                          {(g.prediction.homeWinProb * 100).toFixed(0)}%
                        </b>
                      </span>
                    </td>
                    <td className="mono">
                      {g.homeScore != null ? (
                        <span title={`赛前预测 ${g.prediction.awayScore.toFixed(0)} - ${g.prediction.homeScore.toFixed(0)}`}>
                          <b>{g.awayScore} - {g.homeScore}</b> <span className="chip">终</span>
                        </span>
                      ) : (
                        <>{g.prediction.awayScore.toFixed(0)} - {g.prediction.homeScore.toFixed(0)}</>
                      )}
                    </td>
                    <td className="mono dim">{num(g.prediction.total, 0)}</td>
                    <td className="mono" style={{ fontSize: 10.5 }}>
                      {g.market ? (
                        <>
                          {g.market.spread > 0 ? `+${g.market.spread}` : g.market.spread}
                          <br />
                          <span className={Math.abs(g.market.edge) >= 3 ? 'pos' : 'dim'}>
                            {g.market.edge > 0 ? `+${g.market.edge}` : g.market.edge}
                          </span>
                        </>
                      ) : <span className="dim">—</span>}
                    </td>
                    <td className="left dim" style={{ fontSize: 10.5 }}>
                      {g.label ? <span className="chip blue">{g.label}</span> : g.arena}
                    </td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
          {games.length === 0 && <div className="empty">没有符合条件的比赛</div>}
        </div>
      )}
    </>
  );
}
