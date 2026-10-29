import React, { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './lib/api.js';
import { Loading, ErrorBox, LockIcon } from './components/common.jsx';
import { teamPalette } from './lib/color.js';
import {
  loadProfiles, ensureProfile, createProfile as createP, renameProfile as renameP,
  switchProfile as switchP, deleteProfile as deleteP, importProfile as importP,
  linkCloud as linkC, unlinkCloud as unlinkC, attachAccount, detachAccount,
} from './lib/profiles.js';
import { loadSession, saveSession, clearSession, SESSION_KEY, accountsDisabled } from './lib/session.js';
import { createCloudPlayer, renameCloud } from './lib/cloud.js';
import Dashboard from './pages/Dashboard.jsx';
import Teams from './pages/Teams.jsx';
import TeamDetail from './pages/TeamDetail.jsx';
import Players from './pages/Players.jsx';
import Schedule from './pages/Schedule.jsx';
import Predict from './pages/Predict.jsx';
import Simulate from './pages/Simulate.jsx';
import Play from './pages/Play.jsx';
import Profiles from './pages/Profiles.jsx';
import Today from './pages/Today.jsx';
import Board from './pages/Board.jsx';
import { useI18n } from './i18n/react.jsx';

// 登录页、协议 / 隐私政策（长文）与实验室（含独赢投注实验）按需加载：大多数访客用不到，不进主包，
// 主包回到 Vite 的 500 kB 提示线以下
const Login = lazy(() => import('./pages/Login.jsx'));
const Lab = lazy(() => import('./pages/Lab.jsx'));
const Legal = lazy(() => import('./pages/Legal.jsx'));

// ------------------------------------------------------------ 全局数据

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

const NAV = [
  { path: '', key: 'nav.overview', ico: '◈' },
  { path: 'teams', key: 'nav.teams', ico: '⬢' },
  { path: 'players', key: 'nav.players', ico: '⚇' },
  { path: 'today', key: 'nav.today', ico: '◷' },
  { path: 'schedule', key: 'nav.schedule', ico: '▤' },
  { path: 'board', key: 'nav.board', ico: '✓', locked: true },
  { path: 'predict', key: 'nav.predict', ico: '◎' },
  { path: 'simulate', key: 'nav.simulate', ico: '∿' },
  { path: 'play', key: 'nav.play', ico: '⚔' },
  { path: 'lab', key: 'nav.lab', ico: '⚗' },
  { path: 'profiles', key: 'nav.profiles', ico: '⚉' },
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
    return localStorage.getItem('dc-nba:theme') || 'dark';
  } catch {
    return 'dark';
  }
};

export default function App() {
  const { head, rest } = useHashRoute();
  const i18n = useI18n();
  const { t } = i18n;
  const [state, setState] = useState({ loading: true });
  // 全局缺阵名单：{ [teamId]: [playerId] }，各页面共享
  const [out, setOut] = useState({});
  // 模型参数覆盖
  const [params, setParams] = useState({});
  const [theme, setTheme] = useState(readTheme);
  // 当前主导配色的球队，决定背景光斑与卡片辉光
  const [accent, setAccent] = useState(null);
  // 玩家档案：身份只是"这台浏览器上的一个本地档案"，没有服务端账号
  const [prof, setProf] = useState(() => ensureProfile(loadProfiles(), t('profiles.defaultName', { n: 1 })));
  // 账号会话：只是 localStorage 里会话的镜像，真相以 loadSession() 为准
  const [session, setSession] = useState(() => loadSession());

  // 本地会话没了（过期、被锁接口判定失效、别的标签页退出）：界面回到未登录，去掉账号档案的 cloud
  const dropAccount = useCallback(() => {
    setSession(null);
    setProf((s2) => (s2.profiles.some((p) => p.cloud?.account === true) ? detachAccount(s2) : s2));
  }, []);
  /** 重新读一次本地会话，React 状态与之对齐；被锁接口每次返回后、启动时、别的标签页改动时调用 */
  const syncSession = useCallback(() => {
    const s2 = loadSession();
    if (!s2) dropAccount();
    else setSession((cur) => (cur?.token === s2.token ? cur : s2));
  }, [dropAccount]);
  useEffect(() => {
    syncSession();
    const on = (e) => { if (e.key === null || e.key === SESSION_KEY) syncSession(); };
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, [syncSession]);

  useEffect(() => {
    Promise.all([api.meta(), api.teams(), api.injuries().catch(() => ({ players: [] }))])
      .then(([meta, teams, injuries]) => setState({ loading: false, meta, teams, injuries }))
      .catch((error) => setState({ loading: false, error }));
  }, []);

  // 服务端说用户系统关着（含回滚关掉开关）：本地会话没用了，账号档案的 cloud.token 是会话令牌，
  // 留着调排行榜只会 401——清掉会话并去掉账号档案的 cloud；重新开启后再登录即可
  useEffect(() => {
    if (accountsDisabled(state.meta) && (loadSession() || prof.profiles.some((p) => p.cloud?.account === true))) {
      clearSession();
      dropAccount();
    }
  }, [state.meta, prof, dropAccount]);

  // 球队表交给 i18n（服务端消息里的队名占位符要用）；setTeams 稳定、teams 只在加载完成时变一次
  const { setTeams, setLang, setTz } = i18n;
  useEffect(() => { if (state.teams) setTeams(state.teams); }, [state.teams, setTeams]);

  // 主题写到 <html> 上，CSS 变量随之切换
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('dc-nba:theme', theme); } catch { /* 隐私模式下忽略 */ }
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
    const injuryList = state.injuries?.players ?? [];
    const injuryByPlayer = new Map(injuryList.map((i) => [i.playerId, i]));
    return {
      injuries: state.injuries ?? { players: [] },
      injuryByPlayer,
      /** 把 ESPN 标记为「确定缺阵」的球员一次性填进缺阵名单 */
      applyInjuries: (status = 'out') => setOut(() => {
        const next = {};
        for (const i of injuryList) {
          if (status === 'out' && i.status !== 'out') continue;
          (next[i.teamId] ??= []).push(i.playerId);
        }
        return next;
      }),
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

      // ---- 玩家档案
      profiles: prof.profiles,
      profileId: prof.activeId,
      profileName: prof.profiles.find((p) => p.id === prof.activeId)?.name ?? '',
      createProfile: (name) => setProf((s2) => createP(s2, name, t('profiles.defaultName', { n: s2.profiles.length + 1 }))),
      renameProfile: (id, name) => setProf((s2) => renameP(s2, id, name)),
      switchProfile: (id) => setProf((s2) => switchP(s2, id)),
      deleteProfile: (id) => setProf((s2) => deleteP(s2, id)),
      // 不能放进 setProf 的更新函数：坏存档码会抛错，在更新函数里抛会直接让整个应用白屏；
      // 这里同步抛给调用方（Profiles 页的 try/catch）显示具体原因
      importProfile: (code) => setProf(importP(prof, code, (n) => t('profiles.imported', { name: n }), t('profiles.defaultName'))),

      // ---- 排行榜（服务端可能未启用，这里全部容错）
      leaderboardOn: !!state.meta?.features?.leaderboard,
      leaderboardReasonCode: state.meta?.features?.leaderboardReasonCode ?? null,
      cloud: prof.profiles.find((p) => p.id === prof.activeId)?.cloud ?? null,
      /** 用当前档案名在服务端建一个玩家，把令牌绑回本地档案 */
      connectCloud: async () => {
        const me = prof.profiles.find((p) => p.id === prof.activeId);
        const created = await createCloudPlayer(me?.name ?? t('app.defaultPlayer'));
        setProf((s2) => linkC(s2, prof.activeId, {
          playerId: created.id, token: created.token, name: created.name,
        }));
        return created;
      },
      disconnectCloud: () => setProf((s2) => unlinkC(s2, prof.activeId)),
      // ---- 账号（手机号登录）。accounts 来自 /api/meta；enabled 为假时界面不出现任何登录元素
      accounts: state.meta?.features?.accounts ?? { enabled: false },
      session,
      /** 登录成功：只存服务端的 publicUser；账号的玩家档案对应到本地档案；账号有语言 / 时区偏好就套用 */
      login: (r) => {
        const s2 = saveSession({ token: r.token, expiresAt: r.expiresAt, user: r.user ?? null });
        setSession(s2);
        setProf((p2) => attachAccount(p2, { player: r.player ?? null, token: r.token }));
        if (r.user?.lang) setLang(r.user.lang);
        if (r.user?.tz) setTz(r.user.tz);
      },
      /** 退出：接口失败也照样清本地 */
      logout: async () => {
        const token = loadSession()?.token;
        if (token) await api.authLogout(token).catch(() => {});
        clearSession();
        dropAccount();
      },
      /** 服务端说会话失效：只清本地，不调接口 */
      onSessionInvalid: () => { clearSession(); dropAccount(); },
      syncSession,

      syncCloudName: async (name) => {
        const c = prof.profiles.find((p) => p.id === prof.activeId)?.cloud;
        if (c?.token) await renameCloud(c.token, name);
      },
    };
  }, [state, out, params, theme, prof, t, session, dropAccount, syncSession, setLang, setTz]);

  if (state.loading) {
    return <div className="loading" style={{ paddingTop: 120 }}>{t('app.loading')}</div>;
  }
  if (state.error) {
    return (
      <div className="main">
        <ErrorBox error={state.error} />
        <p className="note">
          {(() => {
            const [pre, post] = t('app.errorHint', { cmd: '\u0001' }).split('\u0001');
            return <>{pre}<code>npm run ingest</code>{post}</>;
          })()}
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
  else if (head === 'board') page = <Board />;
  else if (head === 'today') page = <Today initial={rest} />;
  else if (head === 'predict') page = <Predict initial={rest} />;
  else if (head === 'simulate') page = <Simulate />;
  else if (head === 'play') page = <Play />;
  else if (head === 'profiles') page = <Profiles />;
  else if (head === 'lab') page = <Suspense fallback={<Loading />}><Lab /></Suspense>;
  else if (head === 'login') page = <Suspense fallback={<Loading />}><Login returnTo={rest.join('/')} /></Suspense>;
  else if (head === 'terms' || head === 'privacy') page = <Suspense fallback={<Loading />}><Legal doc={head} /></Suspense>;
  else page = <Dashboard />;

  const activeKey = head === 'team' ? 'teams' : head;
  const showLock = !!ctx.accounts.enabled && !session;
  const loginTarget = `login/${head === 'login' ? rest.join('/') : [head, ...rest].filter(Boolean).join('/')}`;
  /**
   * 账号区：侧栏里一份；≤780px 侧栏隐藏时，主区顶部的窄条再放一份（只有登录 / 退出，不是导航菜单）。
   * accounts.enabled 为假时两处都不出现。
   */
  const accountUi = (where) => {
    if (!ctx.accounts.enabled) return null;
    if (session) {
      const who = t('auth.loggedInAs', { phone: session.user?.phone ?? '' });
      return (
        <div className={where === 'side' ? 'side-account' : 'mobile-account'}>
          <span title={who}>{who}</span>
          <button className={where === 'side' ? 'nav-item' : 'btn'} onClick={ctx.logout}>{t('auth.logout')}</button>
        </div>
      );
    }
    if (where === 'side') {
      return (
        <button
          className="btn primary"
          style={{ width: '100%', marginTop: 6, padding: '5px 8px', fontSize: 11.5 }}
          onClick={() => go(loginTarget)}
        >
          {t('auth.loginOrRegister')}
        </button>
      );
    }
    return (
      <div className="mobile-account">
        <button className="btn primary" onClick={() => go(loginTarget)}>{t('auth.loginOrRegister')}</button>
      </div>
    );
  };

  return (
    <AppCtx.Provider value={ctx}>
      <div className="glow-field" aria-hidden="true" />

      <div className="app">
        <nav className="sidebar">
          <div className="brand">
            <span className="dot">N</span>
            <span>{t('app.title')}</span>
          </div>
          {NAV.map((n) => (
            <button
              key={n.path}
              className={`nav-item ${activeKey === n.path ? 'active' : ''}`}
              onClick={() => go(n.path)}
            >
              <span className="ico">{n.ico}</span>
              {t(n.key)}
              {n.locked && showLock && <span className="nav-lock"><LockIcon /></span>}
            </button>
          ))}

          <div className="side-bottom" style={{ marginTop: 0 }}>
          <div className="side-box">
            <label title={t('app.healthyTip')}>
              <input
                type="checkbox"
                checked={!!params.assumeHealthy}
                onChange={(e) => setParams((p) => ({ ...p, assumeHealthy: e.target.checked ? 1 : 0 }))}
              />
              <span>{t('app.healthyLabel')}</span>
            </label>
            <p>{t('app.healthyNote')}</p>
          </div>

          <div className="side-box" style={{ marginTop: 'auto' }}>
            <div style={{ fontSize: 10.5, color: 'var(--text-faint)', letterSpacing: '.6px', marginBottom: 5 }}>
              {t('app.currentPlayer')}
            </div>
            <select
              value={prof.activeId ?? ''}
              onChange={(e) => ctx.switchProfile(e.target.value)}
              style={{ width: '100%', minWidth: 0, fontSize: 12.5, padding: '5px 7px' }}
            >
              {prof.profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button
              className="btn"
              style={{ width: '100%', marginTop: 6, padding: '5px 8px', fontSize: 11.5 }}
              onClick={() => go('profiles')}
            >
              {t('app.manageProfiles')}
            </button>
            {accountUi('side')}
          </div>

          {(ctx.injuries.players?.length ?? 0) > 0 && (
            <div className="side-box">
              <div style={{ fontSize: 12, fontWeight: 650, marginBottom: 6 }}>
                {t('app.injuryTitle')}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.6 }}>
                {t('app.injuryCounts', { out: ctx.injuries.counts?.out ?? 0, dtd: ctx.injuries.counts?.dayToDay ?? 0 })}
              </div>
              <button
                className="btn"
                style={{ width: '100%', marginTop: 7, padding: '6px 8px', fontSize: 12 }}
                onClick={() => ctx.applyInjuries('out')}
              >
                {t('app.applyOut')}
              </button>
              <p style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5, margin: '6px 0 0' }}>
                {t('app.injuryNote')}
              </p>
            </div>
          )}

          <div className="theme-switch">
            <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}>{t('app.themeDark')}</button>
            <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>{t('app.themeLight')}</button>
          </div>
          <div className="theme-switch" role="group" aria-label={t('app.langSwitch')}>
            {i18n.langs.map((l) => (
              <button key={l.id} className={i18n.lang === l.id ? 'on' : ''} onClick={() => i18n.setLang(l.id)}>{l.short}</button>
            ))}
          </div>
          <div className="theme-switch" role="group" aria-label={t('app.tzSwitch')}>
            {i18n.timezones.map((z) => (
              <button key={z.id} className={i18n.tz === z.iana ? 'on' : ''} onClick={() => i18n.setTz(z.iana)}>{t(`tz.short.${z.id}`)}</button>
            ))}
          </div>

          <div className="sidebar-foot">
            <div>{t('app.season', { season: state.meta.targetSeason })}</div>
            <div>{t('app.baseData', { season: state.meta.priorSeason })}</div>
            <div>{t('app.counts', { teams: state.meta.counts.teams, players: state.meta.counts.players })}</div>
            <div title={t('app.absorbedTip')}>
              {state.meta.gamesPlayedCurrent > 0
                ? t('app.absorbed', { count: state.meta.gamesPlayedCurrent })
                : t('app.preseason')}
            </div>
            {outCount > 0 && (
              <div style={{ marginTop: 6 }}>
                <span className="chip accent">{t('app.outCount', { count: outCount })}</span>{' '}
                <button
                  className="nav-item"
                  style={{ padding: '2px 0', width: 'auto', display: 'inline' }}
                  onClick={ctx.clearOut}
                >
                  {t('common.clear')}
                </button>
              </div>
            )}
          </div>
          </div>
        </nav>

        <main className="main">{accountUi('mobile')}{page}</main>
      </div>
    </AppCtx.Provider>
  );
}
