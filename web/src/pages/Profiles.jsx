import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../App.jsx';
import { useI18n } from '../i18n/react.jsx';
import { StatTile, DataTable, ErrorBox, Loading, Segmented } from '../components/common.jsx';
import { pct } from '../lib/format.js';
import { exportProfile } from '../lib/profiles.js';
import { loadPlay, summarize } from '../lib/store.js';
import { fetchLeaderboard, pushPicks } from '../lib/cloud.js';

export default function Profiles() {
  const {
    profiles, profileId, createProfile, renameProfile,
    switchProfile, deleteProfile, importProfile,
    leaderboardOn, leaderboardReasonCode, cloud, connectCloud, disconnectCloud, meta,
  } = useApp();
  const { t } = useI18n();

  const [board, setBoard] = useState(null);
  const [busy, setBusy] = useState(false);
  // 上季回放（练习）与本季实战分榜
  const [lbMode, setLbMode] = useState('practice');

  const reloadBoard = () => {
    if (!leaderboardOn) return undefined;
    let alive = true;
    setBoard(null);
    // 快速切换两个榜时，晚到的旧响应不能盖掉当前榜
    fetchLeaderboard({ min: 1, mode: lbMode }).then((b) => alive && setBoard(b));
    return () => { alive = false; };
  };
  useEffect(reloadBoard, [leaderboardOn, cloud?.playerId, lbMode]);

  const [newName, setNewName] = useState('');
  const [code, setCode] = useState('');
  const [exported, setExported] = useState(null);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  /** 本机所有档案的战绩，用来做一个本地排行榜 */
  const rows = useMemo(() => profiles.map((p) => {
    const play = loadPlay(p.id);
    const s = summarize(Object.values(play.settled ?? {}));
    return {
      ...p,
      n: s.n,
      accuracy: s.accuracy,
      points: s.points,
      brier: s.brier,
      lead: s.points - s.modelPoints,
      bestStreak: s.bestStreak,
      active: p.id === profileId,
    };
  }), [profiles, profileId]);

  const totalN = rows.reduce((a, r) => a + r.n, 0);

  const doImport = () => {
    setError(null);
    try {
      importProfile(code);
      setCode('');
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>{t('profiles.title')}</h1>
        <p>{t('profiles.intro')}</p>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile label={t('profiles.tile.local')} value={profiles.length} unit={t('profiles.tile.localUnit', { count: profiles.length })} />
        <StatTile label={t('profiles.tile.current')} value={profiles.find((p) => p.id === profileId)?.name ?? '—'} />
        <StatTile label={t('profiles.tile.predicted')} value={totalN} unit={t('common.unit.games', { count: totalN })} />
        <StatTile
          label={t('profiles.tile.best')}
          value={rows.length ? Math.max(...rows.map((r) => r.points)) : 0}
        />
      </div>

      <ErrorBox error={error} />

      <div className="card">
        <h2>{t('profiles.list.title')} <span className="sub">{t('profiles.list.sub')}</span></h2>
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          initialSort={{ key: 'points', dir: 'desc' }}
          onRowClick={(r) => switchProfile(r.id)}
          columns={[
            {
              key: 'name', label: t('profiles.col.player'), align: 'left', width: 200,
              render: (r) => (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {r.active && <span className="chip accent">{t('profiles.col.current')}</span>}
                  <input
                    value={r.name}
                    onChange={(e) => renameProfile(r.id, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      background: 'transparent', border: '1px solid transparent',
                      padding: '2px 4px', minWidth: 0, width: 120, fontWeight: 650,
                    }}
                    title={t('profiles.col.renameTip')}
                  />
                </span>
              ),
            },
            { key: 'n', label: t('profiles.col.n'), width: 70 },
            {
              key: 'accuracy', label: t('profiles.col.acc'), width: 76,
              render: (r) => (r.n ? pct(r.accuracy, 1) : '—'),
            },
            {
              key: 'points', label: t('profiles.col.points'), width: 70,
              render: (r) => <b className={r.points > 0 ? 'pos' : r.points < 0 ? 'neg' : ''}>{r.points}</b>,
            },
            {
              key: 'lead', label: t('profiles.col.lead'), width: 90,
              render: (r) => (r.n
                ? <span className={r.lead > 0 ? 'pos' : r.lead < 0 ? 'neg' : ''}>{r.lead > 0 ? `+${r.lead}` : r.lead}</span>
                : <span className="dim">—</span>),
            },
            {
              key: 'brier', label: 'Brier', width: 76,
              render: (r) => (r.n ? r.brier.toFixed(4) : '—'),
            },
            { key: 'bestStreak', label: t('profiles.col.streak'), width: 80 },
            {
              key: 'act', label: t('profiles.col.act'), width: 150, align: 'left',
              value: () => 0,
              render: (r) => (
                <span style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn"
                    style={{ padding: '3px 9px', fontSize: 11 }}
                    onClick={() => setExported({ id: r.id, code: exportProfile(r.id, profiles) })}
                  >
                    {t('profiles.export')}
                  </button>
                  {confirmDelete === r.id ? (
                    <button
                      className="btn"
                      style={{ padding: '3px 9px', fontSize: 11, color: 'var(--bad)' }}
                      onClick={() => { deleteProfile(r.id); setConfirmDelete(null); }}
                    >
                      {t('profiles.confirmDelete')}
                    </button>
                  ) : (
                    <button
                      className="btn"
                      style={{ padding: '3px 9px', fontSize: 11 }}
                      disabled={profiles.length <= 1}
                      onClick={() => setConfirmDelete(r.id)}
                    >
                      {t('profiles.delete')}
                    </button>
                  )}
                </span>
              ),
            },
          ]}
        />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>{t('profiles.new.title')}</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              placeholder={t('profiles.new.placeholder')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { createProfile(newName); setNewName(''); } }}
              style={{ flex: 1 }}
            />
            <button
              className="btn primary"
              onClick={() => { createProfile(newName); setNewName(''); }}
            >
              {t('profiles.new.create')}
            </button>
          </div>
          <p className="note" style={{ marginTop: 10 }}>{t('profiles.new.note')}</p>
        </div>

        <div className="card">
          <h2>{t('profiles.code.title')} <span className="sub">{t('profiles.code.sub')}</span></h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              placeholder={t('profiles.code.placeholder')}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn" disabled={!code.trim()} onClick={doImport}>{t('profiles.code.import')}</button>
          </div>
          {exported && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4 }}>
                {t('profiles.code.exported', { name: profiles.find((p) => p.id === exported.id)?.name })}
              </div>
              <textarea
                readOnly
                value={exported.code}
                onFocus={(e) => e.target.select()}
                style={{
                  width: '100%', height: 70, fontSize: 11,
                  background: 'var(--glass-2)', color: 'var(--text)',
                  border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)',
                  padding: 8, fontFamily: 'ui-monospace, monospace', resize: 'vertical',
                }}
              />
            </div>
          )}
          <p className="note" style={{ marginTop: 10 }}>{t('profiles.code.note')}</p>
        </div>
      </div>

      {leaderboardOn ? (
        <div className="card">
          <h2>
            {t('profiles.lb.title')}
            <span className="sub">
              {board ? t('profiles.lb.counts', { players: board.counts?.players ?? 0, picks: board.counts?.picks ?? 0 }) : t('common.loading')}
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {cloud?.token ? (
                <>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      await pushPicks(cloud.token, loadPlay(profileId).settled);
                      reloadBoard();
                      setBusy(false);
                    }}
                  >
                    {busy ? t('profiles.lb.syncing') : t('profiles.lb.sync')}
                  </button>
                  {/* 账号档案：云端身份就是登录会话，在这里断开会与会话脱节——只能靠退出登录解除 */}
                  {cloud.account === true ? (
                    <span className="note" style={{ alignSelf: 'center' }}>{t('profiles.lb.accountLinked')}</span>
                  ) : (
                    <button className="btn" onClick={() => { disconnectCloud(); setBoard(null); }}>
                      {t('profiles.lb.disconnect')}
                    </button>
                  )}
                </>
              ) : (
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await connectCloud();
                      reloadBoard();
                    } catch (e) { setError(e); }
                    setBusy(false);
                  }}
                >
                  {t('profiles.lb.join')}
                </button>
              )}
            </span>
          </h2>

          <div style={{ marginBottom: 10 }}>
            <Segmented
              value={lbMode}
              onChange={setLbMode}
              options={[
                { value: 'season', label: t('profiles.lb.modeSeason', { season: meta.targetSeason }) },
                { value: 'practice', label: t('profiles.lb.modePractice', { season: meta.priorSeason }) },
              ]}
            />
          </div>

          <div className="warn-box">
            {t('profiles.lb.warn1')}<b>{t('profiles.lb.warnBold')}</b>{t('profiles.lb.warn2')}
          </div>

          {!board ? <Loading /> : (
            <DataTable
              rows={board.rows ?? []}
              rowKey={(r) => r.id}
              initialSort={{ key: 'points', dir: 'desc' }}
              columns={[
                {
                  key: 'rank', label: t('profiles.lb.rank'), width: 40,
                  value: () => 0,
                  render: (r, i) => <span className="dim">{i + 1}</span>,
                },
                {
                  key: 'name', label: t('profiles.col.player'), align: 'left', width: 180,
                  render: (r) => (
                    <span>
                      {r.name}
                      {r.id === cloud?.playerId && <span className="chip accent" style={{ marginLeft: 6 }}>{t('profiles.lb.you')}</span>}
                    </span>
                  ),
                },
                { key: 'n', label: t('profiles.lb.picks'), width: 80 },
                {
                  key: 'accuracy', label: t('profiles.col.acc'), width: 76,
                  value: (r) => (r.n ? r.correct / r.n : 0),
                  render: (r) => (r.n ? pct(r.correct / r.n, 1) : '—'),
                },
                {
                  key: 'points', label: t('profiles.col.points'), width: 74,
                  render: (r) => <b className={r.points > 0 ? 'pos' : r.points < 0 ? 'neg' : ''}>{r.points}</b>,
                },
                {
                  key: 'lead', label: t('profiles.col.lead'), width: 96,
                  value: (r) => r.points - r.model_points,
                  render: (r) => {
                    const d = r.points - r.model_points;
                    return <span className={d > 0 ? 'pos' : d < 0 ? 'neg' : ''}>{d > 0 ? `+${d}` : d}</span>;
                  },
                },
                { key: 'brier', label: 'Brier', width: 76, render: (r) => r.brier?.toFixed(4) ?? '—' },
              ]}
            />
          )}

          <p className="note" style={{ marginTop: 10 }}>
            {lbMode === 'season' ? (
              <>
                <b>{t('profiles.lb.seasonLead')}</b>{t('profiles.lb.seasonBody', { season: meta.targetSeason })}<br />
              </>
            ) : (
              <>
                <b>{t('profiles.lb.practiceLead')}</b>{t('profiles.lb.practiceBody', { season: meta.priorSeason })}<br />
              </>
            )}
            {t('profiles.lb.token1')}<b>{t('profiles.lb.tokenBold')}</b>{t('profiles.lb.token2')}<br />
            <b>{t('profiles.lb.noBackupLead')}</b>{t('profiles.lb.noBackupBody')}
          </p>
        </div>
      ) : (
        <div className="card plain">
          <h2>{t('profiles.off.title')}</h2>
          <p className="note">
            {leaderboardReasonCode ? t(leaderboardReasonCode) : t('profiles.off.fallback')}<br />
            {t('profiles.off.tail')}
          </p>
        </div>
      )}

      <div className="card plain">
        <h2>{t('profiles.why.title')}</h2>
        <p className="note">
          {t('profiles.why.p1a')}<code>/works/</code>{t('profiles.why.p1b')}<br />
          {t('profiles.why.p2')}<br />
          {t('profiles.why.p3a')}<b>{t('profiles.why.p3Bold')}</b>{t('profiles.why.p3b')}
        </p>
      </div>
    </>
  );
}
