import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { interpolate, createT, detectLang, flattenKeys, lookup, SOURCE_LANG, UNMATCHED_LANG } from '../web/src/i18n/core.js';

const dir = path.resolve('web/src/i18n/locales');
const locales = {};
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
  locales[f.replace(/\.js$/, '')] = (await import(pathToFileURL(path.join(dir, f)).href)).default;
}

test('常量与 lookup', () => {
  assert.equal(SOURCE_LANG, 'zh');
  assert.equal(UNMATCHED_LANG, 'en');
  assert.equal(lookup({ a: { b: 'x' } }, 'a.b'), 'x');
  assert.equal(lookup({ a: { b: 'x' } }, 'a.c'), undefined);
  assert.equal(lookup({ a: { b: 'x' } }, 'a'), undefined);
});

test('interpolate：替换参数、格式化器、缺参数保留占位', () => {
  assert.equal(interpolate('已结束 {n} 场', { n: 3 }), '已结束 3 场');
  assert.equal(interpolate('准确率 {acc, pct1}', { acc: 0.6667 }, { pct1: (v) => `${(v * 100).toFixed(1)}%` }), '准确率 66.7%');
  assert.equal(interpolate('还剩 {n} 场', {}), '还剩 {n} 场');
  assert.equal(interpolate('{x, nope}', { x: 5 }, {}), '5');
});

test('createT：缺译文回退中文并只告警一次；中文也缺返回键名', () => {
  const warns = [];
  const zh = { a: { b: '中' } };
  const t = createT({ dict: { a: {} }, fallback: zh, lang: 'en', warn: (m) => warns.push(m) });
  assert.equal(t('a.b'), '中'); t('a.b');
  assert.equal(warns.length, 1);
  assert.equal(t('a.nope'), 'a.nope');
});

test('createT：格式化器由调用方传入', () => {
  const t = createT({ dict: { x: '{v, up}' }, fallback: {}, lang: 'en', formatters: { up: (v) => String(v).toUpperCase() } });
  assert.equal(t('x', { v: 'ab' }), 'AB');
});

test('createT：复数按 count 选 one / other', () => {
  const en = { meta: { intl: 'en-US' }, g: { one: '{count} game', other: '{count} games' } };
  const t = createT({ dict: en, fallback: { g: '{count} 场' }, lang: 'en' });
  assert.equal(t('g', { count: 1 }), '1 game');
  assert.equal(t('g', { count: 2 }), '2 games');
});

test('detectLang：?lang 优先，其次本地存储，再按 navigator（zh* → zh，其他 → en），非法值忽略', () => {
  assert.equal(detectLang({ search: '?lang=en', stored: 'zh', navigatorLanguages: ['zh-CN'], locales }), 'en');
  assert.equal(detectLang({ search: '', stored: 'zh', navigatorLanguages: ['en-US'], locales }), 'zh');
  assert.equal(detectLang({ stored: 'xx', navigatorLanguages: ['zh-TW', 'en'], locales }), 'zh');
  assert.equal(detectLang({ search: '?lang=xx', navigatorLanguages: ['fr-FR'], locales }), 'en');
  assert.equal(detectLang({ navigatorLanguages: ['fr-FR'], locales }), 'en');
  assert.equal(detectLang({ navigatorLanguages: [], locales }), 'en');
});

test('flattenKeys：占位符集合，跳过 meta，复数取并集', () => {
  const m = flattenKeys({ meta: { x: 'y' }, a: { b: '{n} {m, f}' }, g: { one: '{count} a', other: '{count} bs {z}' } });
  assert.deepEqual([...m.keys()].sort(), ['a.b', 'g']);
  assert.deepEqual([...m.get('a.b')].sort(), ['m', 'n']);
  assert.deepEqual([...m.get('g')].sort(), ['count', 'z']);
});

// 返回 { missing, extra, badPlaceholders }
function compareKeys(baseDict, otherDict) {
  const base = flattenKeys(baseDict);
  const cur = flattenKeys(otherDict);
  const missing = [...base.keys()].filter((k) => !cur.has(k));
  const extra = [...cur.keys()].filter((k) => !base.has(k));
  const badPlaceholders = [...base].filter(([k, ph]) => cur.has(k)
    && [...cur.get(k)].sort().join() !== [...ph].sort().join()).map(([k]) => k);
  return { missing, extra, badPlaceholders };
}
const CLEAN = { missing: [], extra: [], badPlaceholders: [] };

test('locales：每种语言的键集合与 zh 一致、占位符一致', () => {
  for (const [code, loc] of Object.entries(locales)) {
    if (code === 'zh') continue;
    assert.deepEqual(compareKeys(locales.zh, loc), CLEAN, `${code} 与 zh 不一致`);
  }
});

test('compareKeys：能检出缺键、多键、占位符不一致', () => {
  const r = compareKeys({ a: '{n}', b: 'x', c: '{p}' }, { a: '{m}', c: '{p}', d: 'y' });
  assert.deepEqual(r, { missing: ['b'], extra: ['d'], badPlaceholders: ['a'] });
});

test('isPlural：含 other 的普通命名空间不是复数叶子', () => {
  const dict = { filters: { all: '全部', other: '其他' }, g: { one: '{count} a', other: '{count} bs' } };
  const m = flattenKeys(dict);
  assert.deepEqual([...m.keys()].sort(), ['filters.all', 'filters.other', 'g']);
  assert.equal(lookup(dict, 'filters.all'), '全部');
  assert.equal(lookup(dict, 'filters.other'), '其他');
  assert.equal(typeof lookup(dict, 'g'), 'object');
  assert.equal(lookup(dict, 'filters'), undefined);
});

test('lookup：meta 不作为译文', () => {
  assert.equal(lookup({ meta: { intl: 'en-US' } }, 'meta.intl'), undefined);
});

test('createT：两个不同缺失键各告警一次', () => {
  const warns = [];
  const t = createT({ dict: {}, fallback: {}, lang: 'en', warn: (m) => warns.push(m) });
  t('x.one'); t('x.two'); t('x.one');
  assert.equal(warns.length, 2);
});

test('detectLang：?lang 大小写不敏感；主语言子标签精确匹配', () => {
  assert.equal(detectLang({ search: '?lang=EN', navigatorLanguages: ['zh-CN'], locales }), 'en');
  assert.equal(detectLang({ navigatorLanguages: ['enx', 'zh'], locales }), 'zh');
  assert.equal(detectLang({ navigatorLanguages: ['enx'], locales }), 'en');
  assert.equal(detectLang({ navigatorLanguages: ['zh_TW'], locales }), 'zh');
});

test('locales：en 的值里没有中文字符', () => {
  const re = /[㐀-鿿＀-￯　-〿]/;
  const walk = (n, p) => {
    for (const [k, v] of Object.entries(n)) {
      if (!p && k === 'meta') continue;
      if (typeof v === 'string') assert.ok(!re.test(v), `en 含中文：${p}${k}`);
      else if (v && typeof v === 'object') walk(v, `${p}${k}.`);
    }
  };
  walk(locales.en, '');
  assert.ok(flattenKeys(locales.en).size > 0);
});

test('locales：meta 字段齐全，defaultTz 是 TIMEZONES 之一', () => {
  for (const [code, loc] of Object.entries(locales)) {
    for (const f of ['name', 'short', 'intl', 'htmlLang', 'defaultTz', 'match']) {
      assert.ok(loc.meta?.[f], `${code}.meta.${f} 缺失`);
    }
    assert.ok(Array.isArray(loc.meta.match) && loc.meta.match.length > 0);
    // 组件里不按语言代码分支，行为差异由 meta 标志给出
    assert.equal(typeof loc.meta.thAbbrOnly, 'boolean', `${code}.meta.thAbbrOnly`);
    assert.ok(['full', 'abbr'].includes(loc.meta.teamSubName), `${code}.meta.teamSubName`);
    assert.ok(['America/New_York', 'Asia/Shanghai'].includes(loc.meta.defaultTz));
  }
});

// ---- 英文术语表 ----
function parseGlossary(md) {
  const rows = [];
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 4 || cells[0] === '中文' || /^-+$/.test(cells[0])) continue;
    const [zh, en, avoid, status] = cells;
    rows.push({ zh, en, avoid: avoid === '—' ? [] : avoid.split(/[,，]/).map((s) => s.trim()).filter(Boolean), status });
  }
  return rows;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function enLeaves() {
  const out = [];
  const walk = (o, p) => { for (const [k, v] of Object.entries(o)) { const key = p ? `${p}.${k}` : k; if (typeof v === 'string') out.push([key, v]); else if (v && typeof v === 'object') walk(v, key); } };
  walk(locales.en, '');
  return out;
}

test('术语表：表格结构、状态值、必含条目', () => {
  const rows = parseGlossary(fs.readFileSync('docs/i18n-glossary.md', 'utf8'));
  assert.ok(rows.length >= 30);
  for (const r of rows) {
    assert.ok(r.zh && r.en, `空单元格：${JSON.stringify(r)}`);
    assert.ok(['待确认', '已定'].includes(r.status), `${r.zh} 状态非法：${r.status}`);
  }
  assert.equal(new Set(rows.map((r) => r.zh)).size, rows.length, '中文列有重复');
  assert.ok(rows.some((r) => r.status === '待确认') && rows.some((r) => r.status === '已定'));
  const net = rows.find((r) => r.zh === '净效率');
  assert.ok(net.en.startsWith('Net Rating') && net.avoid.includes('Net Efficiency'));
  const honest = rows.find((r) => r.zh === '无证据表明模型能赢盘口');
  assert.equal(honest.en, 'No evidence the model beats the market');
});

function bannedHit(text, bad) {
  const cs = bad.startsWith('=');
  const w = cs ? bad.slice(1) : bad;
  return new RegExp(`\\b${escapeRe(w)}\\b`, cs ? '' : 'i').test(text);
}

test('术语匹配器自测：禁用写法命中，正确写法（相近大小写）不误伤', () => {
  assert.ok(bannedHit('Net Efficiency by team', 'Net Efficiency'));
  assert.ok(bannedHit('net efficiency', 'Net Efficiency'));
  assert.ok(bannedHit('The ELO score', '=ELO'));
  assert.ok(!bannedHit('Elo rating', '=ELO'));
  assert.ok(!bannedHit('Not backtested', 'back test'));
});

test('术语表：「避免」项首尾为字母或数字', () => {
  for (const r of parseGlossary(fs.readFileSync('docs/i18n-glossary.md', 'utf8'))) for (const bad of r.avoid) {
    const w = bad.replace(/^=/, '');
    assert.ok(/^[A-Za-z0-9].*[A-Za-z0-9]$/.test(w), `${r.zh} 的避免项「${bad}」首尾不是字母数字`);
  }
});

test('术语表：伤病状态五项齐全', () => {
  const rows = parseGlossary(fs.readFileSync('docs/i18n-glossary.md', 'utf8'));
  for (const s of ['Out', 'Doubtful', 'Questionable', 'Probable', 'Day-to-day']) assert.ok(rows.some((r) => r.en === s), s);
});

test('en 译文遵守术语表的「避免」列', () => {
  const rows = parseGlossary(fs.readFileSync('docs/i18n-glossary.md', 'utf8'));
  assert.ok(enLeaves().length > 30);
  for (const [key, text] of enLeaves()) for (const r of rows) for (const bad of r.avoid)
    assert.ok(!bannedHit(text, bad), `${key} 用了「${bad}」，术语表要求 ${r.en}`);
});
