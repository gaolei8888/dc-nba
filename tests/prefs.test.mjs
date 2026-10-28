import test from 'node:test';
import assert from 'node:assert/strict';
import { PREF_KEYS, readPrefs, writePrefs, resolvePrefs } from '../web/src/lib/prefs.js';
import { locales } from '../web/src/i18n/registry.js';

const memStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
};
const bad = {
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); },
  removeItem() { throw new Error('denied'); },
};

test('键名固定', () => {
  assert.deepEqual(PREF_KEYS, { lang: 'dc-nba:lang', tz: 'dc-nba:tz' });
});

test('resolvePrefs：没选过时区时跟语言走', () => {
  const r = resolvePrefs({ stored: { lang: 'en', tz: null }, search: '', navigatorLanguages: ['zh-CN'], locales });
  assert.deepEqual(r, { lang: 'en', tz: 'America/New_York', tzFollowsLang: true });
});

test('resolvePrefs：显式时区不被语言覆盖', () => {
  assert.deepEqual(
    resolvePrefs({ stored: { lang: 'en', tz: 'Asia/Shanghai' }, locales }),
    { lang: 'en', tz: 'Asia/Shanghai', tzFollowsLang: false },
  );
});

test('resolvePrefs：切语言后显式时区保持，未设置时随语言变', () => {
  const tz = 'America/New_York';
  assert.equal(resolvePrefs({ stored: { lang: 'zh', tz }, locales }).tz, tz);
  assert.equal(resolvePrefs({ stored: { lang: 'en', tz }, locales }).tz, tz);
  assert.equal(resolvePrefs({ stored: { lang: 'zh', tz: null }, locales }).tz, 'Asia/Shanghai');
  assert.equal(resolvePrefs({ stored: { lang: 'en', tz: null }, locales }).tz, 'America/New_York');
});

test('resolvePrefs：非法时区当未设置', () => {
  const r = resolvePrefs({ stored: { lang: 'zh', tz: 'Mars/Base' }, locales });
  assert.equal(r.tz, 'Asia/Shanghai');
  assert.equal(r.tzFollowsLang, true);
});

test('resolvePrefs：非法语言回退到浏览器语言；?lang 优先于存储', () => {
  assert.equal(resolvePrefs({ stored: { lang: 'xx' }, navigatorLanguages: ['zh-TW'], locales }).lang, 'zh');
  assert.equal(resolvePrefs({ stored: { lang: 'zh' }, search: '?lang=en', locales }).lang, 'en');
  assert.equal(resolvePrefs({ stored: {}, navigatorLanguages: ['en-US'], locales }).lang, 'en');
});

test('readPrefs / writePrefs：storage 抛异常时不崩，返回 null', () => {
  assert.deepEqual(readPrefs(bad), { lang: null, tz: null });
  assert.doesNotThrow(() => writePrefs(bad, { lang: 'en', tz: null }));
});

test('readPrefs：没有 storage 时返回两个 null', () => {
  assert.deepEqual(readPrefs(undefined), { lang: null, tz: null });
});

test('writePrefs / readPrefs：往返，未出现的字段不动', () => {
  const s = memStorage();
  writePrefs(s, { lang: 'en', tz: 'Asia/Shanghai' });
  assert.deepEqual(readPrefs(s), { lang: 'en', tz: 'Asia/Shanghai' });
  writePrefs(s, { lang: 'zh' });
  assert.deepEqual(readPrefs(s), { lang: 'zh', tz: 'Asia/Shanghai' });
});

test('writePrefs：tz 为 null 时删除键', () => {
  const s = memStorage();
  writePrefs(s, { tz: 'Asia/Shanghai' });
  assert.equal(s.getItem('dc-nba:tz'), 'Asia/Shanghai');
  writePrefs(s, { tz: null });
  assert.equal(s.getItem('dc-nba:tz'), null);
});
