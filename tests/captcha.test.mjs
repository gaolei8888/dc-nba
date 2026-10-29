import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptchaStore, needsCaptcha, CAPTCHA_ALPHABET } from '../server/captcha.mjs';

const svgOf = (a) => Buffer.from(a.image.split(',')[1], 'base64').toString();

test('verify：一次性、不分大小写、2 分钟过期', () => {
  const s = createCaptchaStore();
  const a = s.issue(0, { text: 'K7PQ' });
  assert.match(a.image, /^data:image\/svg\+xml;base64,/);
  assert.equal(svgOf(a).includes('K7PQ'), false);
  assert.equal('answer' in a, false);
  assert.equal(s.verify(a.id, 'k7pq', 1000), true);
  assert.equal(s.verify(a.id, 'K7PQ', 1000), false);
  const b = s.issue(0, { text: 'ABCD' });
  assert.equal(s.verify(b.id, 'ABCD', 120_001), false);
  const c = s.issue(0, { text: 'ABCD' });
  assert.equal(s.verify(c.id, 'ABCE', 1), false);
  assert.equal(s.verify(c.id, 'ABCD', 2), false); // 答错一次即作废
});

test('verify：未知 id / 非字符串入参 / 恰在过期边界', () => {
  const s = createCaptchaStore();
  assert.equal(s.verify('nope', 'ABCD', 0), false);
  const a = s.issue(0, { text: 'ABCD' });
  assert.equal(s.verify(a.id, undefined, 1), false);
  const b = s.issue(0, { text: 'ABCD' });
  assert.equal(s.verify(b.id, 'ABCD', 120_000), true);
});

test('默认生成：4 位、全在字母表内；SVG 含 4 个字符与 4–6 条干扰线，id 不重复', () => {
  const s = createCaptchaStore();
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    const a = s.issue(0);
    ids.add(a.id);
    const svg = svgOf(a);
    assert.equal((svg.match(/<text /g) ?? []).length, 4);
    const lines = (svg.match(/<path [^>]*class="n"/g) ?? []).length;
    assert.ok(lines >= 4 && lines <= 6, `干扰线 ${lines}`);
    for (const ch of (svg.match(/<text [^>]*>(.)<\/text>/g) ?? []).map((t) => t.at(-8))) {
      assert.ok(CAPTCHA_ALPHABET.includes(ch));
    }
  }
  assert.equal(ids.size, 50);
  assert.equal(CAPTCHA_ALPHABET, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789');
});

test('DOM 顺序不等于阅读顺序：按出现顺序拼接读不出答案', () => {
  const s = createCaptchaStore();
  let differs = 0;
  for (let i = 0; i < 40; i++) {
    const svg = svgOf(s.issue(0, { text: 'ABCD' }));
    const dom = [...svg.matchAll(/<text [^>]*>(.)<\/text>/g)].map((m) => m[1]).join('');
    if (dom !== 'ABCD') differs++;
  }
  assert.ok(differs > 20);
});

test('容量上限：超过 max 先丢最旧的', () => {
  const s = createCaptchaStore({ max: 3 });
  const ids = [0, 1, 2, 3].map((t) => s.issue(t, { text: 'ABCD' }).id);
  assert.equal(s.size(), 3);
  assert.equal(s.verify(ids[0], 'ABCD', 10), false);
  assert.equal(s.verify(ids[3], 'ABCD', 10), true);
});

test('过期条目在 issue 时清理，库不会无限增长', () => {
  const s = createCaptchaStore();
  for (let i = 0; i < 10; i++) s.issue(0);
  assert.equal(s.size(), 10);
  s.issue(200_000);
  assert.equal(s.size(), 1);
});

test('needsCaptcha：第 3 次起、触发过限频、全站过半时需要', () => {
  const base = { ipSendsLastHour: 0, ipLimitedAt: null, siteToday: 0, cap: 500, now: 10_000_000 };
  assert.equal(needsCaptcha(base), false);
  assert.equal(needsCaptcha({ ...base, ipSendsLastHour: 1 }), false);
  assert.equal(needsCaptcha({ ...base, ipSendsLastHour: 2 }), true);
  assert.equal(needsCaptcha({ ...base, ipLimitedAt: base.now - 3_599_000 }), true);
  assert.equal(needsCaptcha({ ...base, ipLimitedAt: base.now - 3_601_000 }), false);
  assert.equal(needsCaptcha({ ...base, siteToday: 249 }), false);
  assert.equal(needsCaptcha({ ...base, siteToday: 250 }), true);
  assert.equal(needsCaptcha({ ...base, siteToday: 100, cap: 200 }), true); // 随上限配置按比例
});
