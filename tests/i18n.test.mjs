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

test('locales：每种语言的键集合与 zh 一致、占位符一致', () => {
  const base = flattenKeys(locales.zh);
  for (const [code, loc] of Object.entries(locales)) {
    if (code === 'zh') continue;
    const cur = flattenKeys(loc);
    const missing = [...base.keys()].filter((k) => !cur.has(k));
    const extra = [...cur.keys()].filter((k) => !base.has(k));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${code} 键不一致`);
    for (const [k, ph] of base) {
      assert.deepEqual([...cur.get(k)].sort(), [...ph].sort(), `${code} 占位符不一致：${k}`);
    }
  }
});

test('locales：en 的值里没有中文字符', () => {
  const re = /[㐀-鿿＀-￯　-〿]/;
  const walk = (n, p) => {
    for (const [k, v] of Object.entries(n)) {
      if (!p && k === 'meta') continue;
      if (typeof v === 'string') assert.ok(!re.test(v), `en 含中文：${p}${k}`);
      else walk(v, `${p}${k}.`);
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
    assert.ok(['America/New_York', 'Asia/Shanghai'].includes(loc.meta.defaultTz));
  }
});
