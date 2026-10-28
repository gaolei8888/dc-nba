// 语言与时区偏好：本地存储 + 解析。纯模块，node 可直接导入。
// 对外形状 { lang, tz }；tz === null 表示「跟语言走」。用户系统上线后账号直接存这两个字段。
import { detectLang } from '../i18n/core.js';
import { TIMEZONES } from '../i18n/fmt.js';

export const PREF_KEYS = { lang: 'dc-nba:lang', tz: 'dc-nba:tz' };

const defaultStorage = () => {
  try { return globalThis.localStorage; } catch { return undefined; }
};

/** 读本地偏好；任何异常（隐私模式、被禁用）都返回两个 null */
export function readPrefs(storage = defaultStorage()) {
  const out = { lang: null, tz: null };
  for (const k of ['lang', 'tz']) {
    try { out[k] = storage?.getItem(PREF_KEYS[k]) ?? null; } catch { out[k] = null; }
  }
  return out;
}

/** 写偏好；null 即删除，异常吞掉；未出现的字段不动 */
export function writePrefs(storage, prefs) {
  for (const k of ['lang', 'tz']) {
    if (!(k in (prefs || {}))) continue;
    try {
      if (prefs[k] === null || prefs[k] === undefined) storage.removeItem(PREF_KEYS[k]);
      else storage.setItem(PREF_KEYS[k], prefs[k]);
    } catch { /* 存储不可用时静默 */ }
  }
}

/** 合并存储、?lang=、浏览器语言，得到最终语言与时区；非法时区视为未设置 */
export function resolvePrefs({ stored = {}, search = '', navigatorLanguages = [], locales }) {
  const lang = detectLang({ search, stored: stored?.lang, navigatorLanguages, locales });
  const valid = TIMEZONES.some((z) => z.iana === stored?.tz);
  const tzFollowsLang = !valid;
  const tz = valid ? stored.tz : locales[lang].meta.defaultTz;
  return { lang, tz, tzFollowsLang };
}
