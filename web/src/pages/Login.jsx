import React, { useEffect, useRef, useState } from 'react';
import { useApp, go } from '../App.jsx';
import { useI18n } from '../i18n/react.jsx';
import { api } from '../lib/api.js';
import { ApiError, errorText } from '../lib/apiError.js';

/** 把译文里的占位标记换成 JSX 节点（用于同意条款里的两个链接） */
function rich(text, nodes) {
  const parts = text.split(/(\u0001|\u0002)/);
  return parts.map((p, i) => (Object.hasOwn(nodes, p) ? <React.Fragment key={i}>{nodes[p]}</React.Fragment> : p));
}

/**
 * 手机号 + 短信验证码登录（新号码验证即注册，无密码）。
 * 错误一律按服务端 code 翻译；图形验证只在服务端要求时出现（428 / 400 带 captcha）。
 * err.body 可能含图形验证载荷：只取 captcha 字段用于显示，绝不整体打印。
 */
export default function Login({ returnTo }) {
  const ctx = useApp();
  const { accounts, session, login, logout } = ctx;
  const { t, meta } = useI18n();
  const countries = accounts.countries?.length ? accounts.countries : [{ cc: '86', iso: 'CN' }];
  // 默认区号：语言给的默认值；不在列表里（如海外关闭）时回退 +86
  const defaultCc = countries.some((c) => c.cc === meta.defaultCc) ? meta.defaultCc : '86';
  const [cc, setCc] = useState(defaultCc);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [left, setLeft] = useState(0); // 重发倒计时（秒）
  const [captcha, setCaptcha] = useState(null); // { id, image }
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { kind: 'err' | 'ok', text }
  const codeRef = useRef(null);
  const target = returnTo || 'board';

  // 列表变化（meta 晚到、海外开关）后当前区号不在列表里 → 回到默认
  useEffect(() => {
    if (!countries.some((c) => c.cc === cc)) setCc(defaultCc);
  }, [countries, cc, defaultCc]);

  useEffect(() => {
    if (left <= 0) return undefined;
    const id = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [left]);

  if (!accounts.enabled) {
    return (
      <div className="login-page">
        <div className="card"><div className="empty">{t('auth.unavailableUi')}</div></div>
      </div>
    );
  }

  if (session) {
    return (
      <div className="login-page">
        <div className="card">
          <p>{t('auth.loggedInAs', { phone: session.user?.phone ?? '' })}</p>
          <div className="login-row">
            <button className="btn primary" onClick={() => go(target)}>{t('auth.back')}</button>
            <button className="btn" onClick={logout}>{t('auth.logout')}</button>
          </div>
        </div>
      </div>
    );
  }

  const showErr = (e) => setMsg({ kind: 'err', text: errorText(e, t) });

  // 服务端附带的新图形验证：只取 id 与 image
  const takeCaptcha = (e) => {
    const c = e instanceof ApiError ? e.body?.captcha : null;
    if (c && typeof c.id === 'string' && typeof c.image === 'string') {
      setCaptcha({ id: c.id, image: c.image });
      setAnswer('');
    }
  };

  const refreshCaptcha = async () => {
    try {
      const c = await api.authCaptcha();
      setCaptcha({ id: c.id, image: c.image });
      setAnswer('');
    } catch (e) {
      showErr(e);
    }
  };

  const sendCode = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const body = { cc, phone, consent };
      if (captcha) Object.assign(body, { captchaId: captcha.id, captchaAnswer: answer.trim() });
      const r = await api.authCode(body);
      setCaptcha(null);
      setAnswer('');
      setLeft(Number(r.resendAfterSec) || 60);
      setMsg({ kind: 'ok', text: t('auth.codeSent', { min: Math.round((Number(r.ttlSec) || 300) / 60) }) });
      codeRef.current?.focus();
    } catch (e) {
      takeCaptcha(e);
      if (e instanceof ApiError && e.code === 'auth.cooldown' && Number(e.params?.sec) > 0) setLeft(Number(e.params.sec));
      showErr(e);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (ev) => {
    ev.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      // 当前档案的 cloud 若已是账号档案，就不当匿名令牌带上
      const anonToken = ctx.cloud?.token && ctx.cloud.account !== true ? ctx.cloud.token : undefined;
      const r = await api.authVerify({
        cc, phone, code: code.trim(), consent, consentVersion: accounts.consentVersion,
        anonToken, profileName: ctx.profileName,
      });
      login(r);
      go(target);
    } catch (e) {
      showErr(e);
    } finally {
      setBusy(false);
    }
  };

  const agree = rich(t('auth.agree', { terms: '\u0001', privacy: '\u0002' }), {
    '\u0001': <a href="#/terms">{t('auth.terms')}</a>,
    '\u0002': <a href="#/privacy">{t('auth.privacy')}</a>,
  });

  return (
    <div className="login-page">
      <div className="page-head">
        <h1>{t('auth.title')}</h1>
        <p>{t('auth.newNumberHint')}</p>
      </div>

      <form className="card login-form" onSubmit={verify}>
        <label className="login-field">
          <span>{t('auth.country')}</span>
          <span className="login-row">
            <select value={cc} onChange={(e) => setCc(e.target.value)} disabled={countries.length < 2}>
              {countries.map((c) => <option key={c.cc} value={c.cc}>{`${t(`country.${c.iso}`)} +${c.cc}`}</option>)}
            </select>
            {!accounts.overseas && <span className="note login-hint">{t('auth.overseasSoon')}</span>}
          </span>
        </label>

        <label className="login-field">
          <span>{t('auth.phone')}</span>
          <input
            type="tel" inputMode="tel" autoComplete="tel-national" value={phone}
            placeholder={t('auth.phonePlaceholder')} onChange={(e) => setPhone(e.target.value)}
          />
        </label>

        {t('auth.smsZhOnly') && <p className="note login-hint">{t('auth.smsZhOnly')}</p>}

        {captcha && (
          <div className="login-field">
            <span>{t('auth.captchaLabel')}</span>
            <span className="login-row">
              <img src={captcha.image} alt={t('auth.captchaAlt')} width={150} height={44} className="login-captcha" />
              <button type="button" className="btn" onClick={refreshCaptcha}>{t('auth.captchaRefresh')}</button>
            </span>
            <input
              type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={8}
              value={answer} onChange={(e) => setAnswer(e.target.value)} aria-label={t('auth.captchaLabel')}
            />
          </div>
        )}

        <label className="login-consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>{agree}</span>
        </label>

        <div className="login-field">
          <span>{t('auth.code')}</span>
          <span className="login-row">
            <input
              ref={codeRef} type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={code} placeholder={t('auth.codePlaceholder')} aria-label={t('auth.code')}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <button
              type="button" className="btn"
              disabled={!consent || left > 0 || busy || !phone.trim() || (captcha && !answer.trim())}
              onClick={sendCode}
            >
              {left > 0 ? t('auth.resendIn', { sec: left }) : t('auth.getCode')}
            </button>
          </span>
        </div>

        {msg && <div className={msg.kind === 'err' ? 'err' : 'note'} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.text}</div>}

        <button type="submit" className="btn primary login-submit" disabled={busy || !consent || code.length < 6 || !phone.trim()}>
          {t('auth.submit')}
        </button>
      </form>
    </div>
  );
}
