import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './lib/api.js';
import { Loading, ErrorBox } from './components/common.jsx';
import { teamPalette } from './lib/color.js';
import Dashboard from './pages/Dashboard.jsx';
import Teams from './pages/Teams.jsx';
import TeamDetail from './pages/TeamDetail.jsx';
import Players from './pages/Players.jsx';
import Schedule from './pages/Schedule.jsx';
import Predict from './pages/Predict.jsx';
import Simulate from './pages/Simulate.jsx';

// ------------------------------------------------------------ 全局数据

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

const NAV = [
  { path: '', label: '总览', ico: '◈' },
  { path: 'teams', label: '球队', ico: '⬢' },
  { path: 'players', label: '球员', ico: '⚇' },
  { path: 'schedule', label: '赛程', ico: '▤' },
  { path: 'predict', label: '比赛预测', ico: '◎' },
  { path: 'simulate', label: '赛季模拟', ico: '∿' },
];

/** 没有选中球队时的默认配色，用应用自身的强调色 */
const DEFAULT_ACCENT = { color: '#ff8a3d', colorAlt: '#c9481c', full: 'NBA' };

/** 极简 hash 路由：#/teams、#/team/1610612747 */
function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash.slice(2) || '');
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(2) || '');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const [head, ...rest] = hash.split('/');
  return { head, rest, hash };
}

export const go = (path) => { window.location.hash = `#/${path}`; };

const readTheme = () => {
  try {
    return localStorage.getItem('nba.theme') || 'dark';
  } catch {
    return 'dark';
  }
};

export default function App() {
  const { head, rest } = useHashRoute();
  const [state, setState] = useState({ loading: true });
  // 全局缺阵名单：{ [teamId]: [playerId] }，各页面共享
  const [out, setOut] = useState({});
  // 模型参数覆盖
  const [params, setParams] = useState({});
  const [theme, setTheme] = useState(readTheme);
  // 当前主导配色的球队，决定背景光斑与卡片辉光
  const [accent, setAccent] = useState(null);

  useEffect(() => {
    Promise.all([api.meta(), api.teams()])
      .then(([meta, teams]) => setState({ loading: false, meta, teams }))
      .catch((error) => setState({ loading: false, error }));
  }, []);

  // 主题写到 <html> 上，CSS 变量随之切换
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('nba.theme', theme); } catch { /* 隐私模式下忽略 */ }
  }, [theme]);

  // 队色写成 CSS 变量，整站的辉光、按钮、滑块都跟着变
  useEffect(() => {
    const team = accent ?? DEFAULT_ACCENT;
    const p = teamPalette(team, theme === 'dark');
    const root = document.documentElement.style;
    root.setProperty('--team', p.accent);
    root.setProperty('--team-raw', p.base);
    root.setProperty('--team-alt-raw', p.alt);
    root.setProperty('--team-soft', p.soft);
    root.setProperty('--team-line', p.line);
    root.setProperty('--team-ink', p.ink);
    root.setProperty('--glow-1', p.base);
    root.setProperty('--glow-2', p.alt);
  }, [accent, theme]);

  const ctx = useMemo(() => {
    const teams = state.teams ?? [];
    return {
      meta: state.meta,
      teams,
      teamById: new Map(teams.map((t) => [t.teamId, t])),
      out,
      setOut,
      /** 切换某位球员的缺阵状态 */
      toggleOut: (teamId, playerId) => setOut((prev) => {
        const cur = prev[teamId] ?? [];
        const next = cur.includes(playerId)
          ? cur.filter((id) => id !== playerId)
          : [...cur, playerId];
        const copy = { ...prev };
        if (next.length) copy[teamId] = next;
        else delete copy[teamId];
        return copy;
      }),
      clearOut: () => setOut({}),
      params,
      setParams,
      theme,
      dark: theme === 'dark',
      setTheme,
      /** 页面用它把整站配色切到某支球队 */
      setAccent,
    };
  }, [state, out, params, theme]);

  if (state.loading) {
    return <div className="loading" style={{ paddingTop: 120 }}>正在加载数据…</div>;
  }
  if (state.error) {
    return (
      <div className="main">
        <ErrorBox error={state.error} />
        <p className="note">
          若提示数据缺失，请先在项目目录执行 <code>npm run ingest</code> 抓取 NBA 数据，再启动服务。
        </p>
      </div>
    );
  }

  const outCount = Object.values(out).reduce((s, v) => s + v.length, 0);

  let page;
  if (head === 'team') page = <TeamDetail teamId={Number(rest[0])} />;
  else if (head === 'teams') page = <Teams />;
  else if (head === 'players') page = <Players />;
  else if (head === 'schedule') page = <Schedule />;
  else if (head === 'predict') page = <Predict initial={rest} />;
  else if (head === 'simulate') page = <Simulate />;
  else page = <Dashboard />;

  const activeKey = head === 'team' ? 'teams' : head;

  return (
    <AppCtx.Provider value={ctx}>
      <div className="glow-field" aria-hidden="true" />

      <div className="app">
        <nav className="sidebar">
          <div className="brand">
            <span className="dot">N</span>
            <span>NBA 预测中心</span>
          </div>
          {NAV.map((n) => (
            <button
              key={n.path}
              className={`nav-item ${activeKey === n.path ? 'active' : ''}`}
              onClick={() => go(n.path)}
            >
              <span className="ico">{n.ico}</span>
              {n.label}
            </button>
          ))}

          <div className="side-bottom">
          <div className="side-box">
            <label title="上赛季因伤缺阵的球星会被埋没。开启后按场均分钟 × 典型出勤(70 场)估算新赛季轮换，只对上赛季出场满 10 场的球员生效。">
              <input
                type="checkbox"
                checked={!!params.assumeHealthy}
                onChange={(e) => setParams((p) => ({ ...p, assumeHealthy: e.target.checked ? 1 : 0 }))}
              />
              <span>假设全员健康</span>
            </label>
            <p>不勾选则沿用上赛季实际出勤</p>
          </div>

          <div className="theme-switch">
            <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}>深色</button>
            <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>浅色</button>
          </div>

          <div className="sidebar-foot">
            <div>{state.meta.targetSeason} 赛季</div>
            <div>基准数据 {state.meta.priorSeason}</div>
            <div>{state.meta.counts.teams} 队 · {state.meta.counts.players} 人</div>
            {outCount > 0 && (
              <div style={{ marginTop: 6 }}>
                <span className="chip accent">{outCount} 人缺阵</span>{' '}
                <button
                  className="nav-item"
                  style={{ padding: '2px 0', width: 'auto', display: 'inline' }}
                  onClick={ctx.clearOut}
                >
                  清除
                </button>
              </div>
            )}
          </div>
          </div>
        </nav>

        <main className="main">{page}</main>
      </div>
    </AppCtx.Provider>
  );
}
