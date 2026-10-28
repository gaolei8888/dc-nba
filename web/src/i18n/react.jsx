import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { SOURCE_LANG } from './core.js';
import { createMsgT } from './msg.js';
import { createFormat, TIMEZONES } from './fmt.js';
import { locales } from './registry.js';
import { readPrefs, writePrefs, resolvePrefs } from '../lib/prefs.js';

const I18nCtx = createContext(null);
export const useI18n = () => useContext(I18nCtx);

const warn = (msg) => {
  if (import.meta.env?.DEV) console.warn(msg);
};

const langs = Object.entries(locales).map(([id, l]) => ({ id, short: l.meta.short, name: l.meta.name }));

export function I18nProvider({ children }) {
  // ?lang= 只作用于本次加载：初始化时解析，不写存储
  const [state, setState] = useState(() => {
    const stored = readPrefs();
    const r = resolvePrefs({
      stored,
      search: window.location.search,
      navigatorLanguages: navigator.languages?.length ? navigator.languages : [navigator.language],
      locales,
    });
    return { lang: r.lang, explicitTz: r.tzFollowsLang ? null : r.tz };
  });
  const { lang, explicitTz } = state;
  const meta = locales[lang].meta;
  const tz = explicitTz ?? meta.defaultTz;

  const setLang = useCallback((next) => {
    if (!Object.hasOwn(locales, next)) return;
    setState((s) => ({ ...s, lang: next }));
    try { writePrefs(localStorage, { lang: next }); } catch { /* 忽略 */ }
  }, []);
  const setTz = useCallback((next) => {
    const v = TIMEZONES.some((z) => z.iana === next) ? next : null;
    setState((s) => ({ ...s, explicitTz: v }));
    try { writePrefs(localStorage, { tz: v }); } catch { /* 忽略 */ }
  }, []);

  const value = useMemo(() => {
    const fmt = createFormat({ locale: locales[lang], fallback: locales[SOURCE_LANG], tz });
    // t 额外带 msg 格式化器：服务端嵌套消息（{verdict, msg}）用 renderMsg(m, t) 渲染
    const t = createMsgT({
      dict: locales[lang], fallback: locales[SOURCE_LANG], lang, formatters: fmt.formatters, warn,
    });
    return {
      lang, tz, tzFollowsLang: explicitTz === null, setLang, setTz, t, fmt, langs, timezones: TIMEZONES,
    };
  }, [lang, tz, explicitTz, setLang, setTz]);

  useEffect(() => {
    document.documentElement.lang = meta.htmlLang;
    document.title = value.t('app.title');
  }, [meta, value]);

  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}
