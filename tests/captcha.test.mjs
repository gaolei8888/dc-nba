import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptchaStore, needsCaptcha, CAPTCHA_ALPHABET, FONT } from '../server/captcha.mjs';

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

test('默认生成：SVG 无 <text>、4 条字符 path、4–6 条干扰线，id 不重复；字母表正确', () => {
  const s = createCaptchaStore();
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    const a = s.issue(0);
    ids.add(a.id);
    const svg = svgOf(a);
    assert.equal(svg.includes('<text'), false);
    assert.equal(/>[^<\s]+</.test(svg), false); // 无任何字符数据节点
    assert.equal((svg.match(/<path [^>]*class="g"/g) ?? []).length, 4);
    const lines = (svg.match(/<path [^>]*class="n"/g) ?? []).length;
    assert.ok(lines >= 4 && lines <= 6, `干扰线 ${lines}`);
  }
  assert.equal(ids.size, 50);
  assert.equal(CAPTCHA_ALPHABET, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789');
});

test('字母表每个字符都有非空笔画，且渲染出非空 path', () => {
  assert.deepEqual(Object.keys(FONT).sort(), [...CAPTCHA_ALPHABET].sort());
  const s = createCaptchaStore();
  for (const ch of CAPTCHA_ALPHABET) {
    assert.ok(FONT[ch].length > 0 && FONT[ch].every((l) => l.length >= 2));
    const svg = svgOf(s.issue(0, { text: ch.repeat(4) }));
    const d = [...svg.matchAll(/<path [^>]*class="g" d="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(d.length, 4);
    assert.ok(d.every((x) => x.length > 10 && x.startsWith('M')));
  }
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

test('noteLimited：一小时内 needsCaptcha 为 true，之后为 false；有界', () => {
  const s = createCaptchaStore({ max: 2 });
  const base = { ipSendsLastHour: 0, ipLimitedAt: null, siteToday: 0, cap: 500, ip: '1.1.1.1', store: s };
  const now = 10_000_000;
  assert.equal(needsCaptcha({ ...base, now }), false);
  s.noteLimited('1.1.1.1', now);
  assert.equal(needsCaptcha({ ...base, now: now + 3_599_000 }), true);
  assert.equal(needsCaptcha({ ...base, now: now + 3_601_000 }), false);
  assert.equal(needsCaptcha({ ...base, ip: '2.2.2.2', now }), false);
  s.noteLimited('2.2.2.2', now); s.noteLimited('3.3.3.3', now);
  assert.equal(s.limitedSize(), 2);
  assert.equal(s.limitedAt('1.1.1.1', now), null); // 最旧的被挤掉
  s.noteLimited(null, now);
  assert.equal(s.limitedSize(), 2);
});
