import React, { useMemo, useState } from 'react';
import { useApp } from '../App.jsx';
import { StatTile, DataTable, ErrorBox } from '../components/common.jsx';
import { pct } from '../lib/format.js';
import { exportProfile } from '../lib/profiles.js';
import { loadPlay, summarize } from '../lib/store.js';

export default function Profiles() {
  const {
    profiles, profileId, createProfile, renameProfile,
    switchProfile, deleteProfile, importProfile,
  } = useApp();

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
        <h1>玩家档案</h1>
        <p>
          在这台设备上创建多个玩家，各自独立存档、互不干扰。
          档案保存在浏览器本地，没有账号也没有密码——
          要带去别的设备，用下面的存档码导出再导入。
        </p>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile label="本机档案" value={profiles.length} unit=" 个" />
        <StatTile label="当前玩家" value={profiles.find((p) => p.id === profileId)?.name ?? '—'} />
        <StatTile label="已预测总场次" value={rows.reduce((a, r) => a + r.n, 0)} unit=" 场" />
        <StatTile
          label="本机最高积分"
          value={rows.length ? Math.max(...rows.map((r) => r.points)) : 0}
        />
      </div>

      <ErrorBox error={error} />

      <div className="card">
        <h2>档案列表 <span className="sub">点击切换当前玩家</span></h2>
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          initialSort={{ key: 'points', dir: 'desc' }}
          onRowClick={(r) => switchProfile(r.id)}
          columns={[
            {
              key: 'name', label: '玩家', align: 'left', width: 200,
              render: (r) => (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {r.active && <span className="chip accent">当前</span>}
                  <input
                    value={r.name}
                    onChange={(e) => renameProfile(r.id, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      background: 'transparent', border: '1px solid transparent',
                      padding: '2px 4px', minWidth: 0, width: 120, fontWeight: 650,
                    }}
                    title="点击可直接改名"
                  />
                </span>
              ),
            },
            { key: 'n', label: '已预测', width: 70 },
            {
              key: 'accuracy', label: '命中率', width: 76,
              render: (r) => (r.n ? pct(r.accuracy, 1) : '—'),
            },
            {
              key: 'points', label: '积分', width: 70,
              render: (r) => <b className={r.points > 0 ? 'pos' : r.points < 0 ? 'neg' : ''}>{r.points}</b>,
            },
            {
              key: 'lead', label: '对模型领先', width: 90,
              render: (r) => (r.n
                ? <span className={r.lead > 0 ? 'pos' : r.lead < 0 ? 'neg' : ''}>{r.lead > 0 ? `+${r.lead}` : r.lead}</span>
                : <span className="dim">—</span>),
            },
            {
              key: 'brier', label: 'Brier', width: 76,
              render: (r) => (r.n ? r.brier.toFixed(4) : '—'),
            },
            { key: 'bestStreak', label: '最佳连胜', width: 80 },
            {
              key: 'act', label: '操作', width: 150, align: 'left',
              value: () => 0,
              render: (r) => (
                <span style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn"
                    style={{ padding: '3px 9px', fontSize: 11 }}
                    onClick={() => setExported({ id: r.id, code: exportProfile(r.id, profiles) })}
                  >
                    导出
                  </button>
                  {confirmDelete === r.id ? (
                    <button
                      className="btn"
                      style={{ padding: '3px 9px', fontSize: 11, color: 'var(--bad)' }}
                      onClick={() => { deleteProfile(r.id); setConfirmDelete(null); }}
                    >
                      确认删除？
                    </button>
                  ) : (
                    <button
                      className="btn"
                      style={{ padding: '3px 9px', fontSize: 11 }}
                      disabled={profiles.length <= 1}
                      onClick={() => setConfirmDelete(r.id)}
                    >
                      删除
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
          <h2>新建玩家</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              placeholder="玩家名称"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { createProfile(newName); setNewName(''); } }}
              style={{ flex: 1 }}
            />
            <button
              className="btn primary"
              onClick={() => { createProfile(newName); setNewName(''); }}
            >
              创建
            </button>
          </div>
          <p className="note" style={{ marginTop: 10 }}>
            新档案从零开始：没有预测记录、没有积分。创建后会自动切换过去。
          </p>
        </div>

        <div className="card">
          <h2>存档码 <span className="sub">跨设备迁移</span></h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              placeholder="粘贴存档码后点导入"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn" disabled={!code.trim()} onClick={doImport}>导入</button>
          </div>
          {exported && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4 }}>
                「{profiles.find((p) => p.id === exported.id)?.name}」的存档码，全选复制：
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
          <p className="note" style={{ marginTop: 10 }}>
            导入会新建一个档案，不会覆盖现有的。存档码是明文 base64，不加密，
            只是为了避免手滑改坏内容。
          </p>
        </div>
      </div>

      <div className="card plain">
        <h2>为什么没有账号密码</h2>
        <p className="note">
          这个应用部署在 <code>/works/</code> 路径下，网关中间件会双向剥离 Cookie，
          传统会话根本用不了，只能把令牌放在 localStorage 里——安全性反而比
          httpOnly cookie 更差。<br />
          服务端目前是无状态的，数据快照只读、容器不挂卷；加账号就要加存储卷，
          随之而来的是备份、迁移、权限一整套负担。而存密码是要负安全责任的。<br />
          所以身份被刻意做成「这台浏览器上的一个本地档案」。
          <b>不同访客用各自的设备打开，本来就各玩各的，不需要登录。</b>
          需要跨用户排行榜时再上服务端，届时这里的档案结构可以直接复用。
        </p>
      </div>
    </>
  );
}
