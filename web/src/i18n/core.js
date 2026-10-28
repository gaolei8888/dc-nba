// 翻译核心：纯函数，不依赖浏览器或 Vite（node 可直接导入）。
export const SOURCE_LANG = 'zh';
export const UNMATCHED_LANG = 'en';

const PLURAL_CATS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
// 复数叶子：键全是 CLDR 类别、含 other、值全是字符串；否则视为普通命名空间
export const isPlural = (v) => {
  if (!v || typeof v !== 'object') return false;
  const ks = Object.keys(v);
  return ks.includes('other') && ks.every((k) => PLURAL_CATS.has(k) && typeof v[k] === 'string');
};

// 按点号路径查键；返回字符串、复数对象或 undefined
export function lookup(dict, key) {
  let cur = dict;
  const parts = String(key).split('.');
  if (parts[0] === 'meta') return undefined;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  if (typeof cur === 'string' || isPlural(cur)) return cur;
  return undefined;
}

// {name} 或 {name, fmt}；缺参数保留占位，未知格式化器输出原值
export function interpolate(template, params = {}, formatters = {}) {
  return String(template).replace(/\{\s*(\w+)\s*(?:,\s*(\w+)\s*)?\}/g, (whole, name, fmt) => {
    if (!params || params[name] === undefined || params[name] === null) return whole;
    const v = params[name];
    if (fmt && typeof formatters?.[fmt] === 'function') return formatters[fmt](v, params);
    return String(v);
  });
}

function pickForm(entry, params, intl) {
  if (typeof entry === 'string') return entry;
  const count = params?.count;
  if (typeof count === 'number') {
    let cat = 'other';
    try { cat = new Intl.PluralRules(intl || 'en-US').select(count); } catch { /* 用 other */ }
    if (typeof entry[cat] === 'string') return entry[cat];
  }
  return entry.other;
}

// 格式化器由调用方传入，核心不引入格式化模块
export function createT({ dict, fallback, lang, formatters = {}, warn } = {}) {
  const warned = new Set();
  const once = (msg) => {
    if (warned.has(msg)) return;
    warned.add(msg);
    if (warn) warn(msg);
  };
  return function t(key, params) {
    let entry = lookup(dict || {}, key);
    let intl = dict?.meta?.intl;
    if (entry === undefined) {
      entry = lookup(fallback || {}, key);
      intl = fallback?.meta?.intl;
      if (entry === undefined) {
        once(`[i18n] 缺少键 ${key}（${lang}）`);
        return key;
      }
      once(`[i18n] ${lang} 缺译文，回退中文：${key}`);
    }
    return interpolate(pickForm(entry, params, intl), params, formatters);
  };
}

const PLACEHOLDER = /\{\s*(\w+)\s*(?:,\s*\w+\s*)?\}/g;

// 键 → 占位符名集合；跳过 meta；复数叶子取各形式并集
export function flattenKeys(dict) {
  const out = new Map();
  const names = (s) => new Set([...s.matchAll(PLACEHOLDER)].map((m) => m[1]));
  const walk = (node, path) => {
    for (const [k, v] of Object.entries(node)) {
      if (!path && k === 'meta') continue;
      const p = path ? `${path}.${k}` : k;
      if (typeof v === 'string') out.set(p, names(v));
      else if (isPlural(v)) {
        const u = new Set();
        for (const s of Object.values(v)) if (typeof s === 'string') for (const n of names(s)) u.add(n);
        out.set(p, u);
      } else if (v && typeof v === 'object') walk(v, p);
    }
  };
  walk(dict, '');
  return out;
}

export function detectLang({ search, stored, navigatorLanguages = [], locales }) {
  const valid = (l) => (typeof l === 'string' && Object.hasOwn(locales, l) ? l : null);
  const q = new URLSearchParams(search || '').get('lang');
  const fromQ = valid(q) || valid(q && q.toLowerCase());
  if (fromQ) return fromQ;
  const fromStored = valid(stored);
  if (fromStored) return fromStored;
  for (const nl of navigatorLanguages) {
    const primary = String(nl).toLowerCase().split(/[-_]/)[0];
    for (const [code, loc] of Object.entries(locales)) {
      if ((loc.meta?.match || []).some((m) => primary === m.toLowerCase())) return code;
    }
  }
  return UNMATCHED_LANG;
}
