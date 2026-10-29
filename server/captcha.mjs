/**
 * 自写 SVG 字符图形验证（零依赖）。
 *  - 4 个字符取自去掉易混淆字符（I/L/O/0/1）的字母表，用 crypto.randomInt 选。
 *  - SVG：每个字符独立 <text>，随机旋转 ±25°、字号、纵向偏移；另加 4–6 条随机贝塞尔干扰线。
 *    <text> 按随机顺序写入 DOM，位置靠 x 决定阅读顺序，按出现顺序拼接读不出答案。
 *  - 答案只存 sha256(大写)；内存 Map，2 分钟有效、一次性（答错也作废）；
 *    issue 时先清过期，再按 max 丢最旧，保证有界。
 *  - 不做持久化：重启即全部失效，用户重新取一张即可。
 */
import crypto from 'node:crypto';

export const CAPTCHA_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LEN = 4;
const W = 120;
const H = 44;
const HOUR_MS = 3_600_000;

const rnd = (lo, hi) => crypto.randomInt(lo, hi + 1); // 含两端整数
const hash = (s) => crypto.createHash('sha256').update(String(s).toUpperCase()).digest();

function randomText() {
  let t = '';
  for (let i = 0; i < LEN; i++) t += CAPTCHA_ALPHABET[crypto.randomInt(CAPTCHA_ALPHABET.length)];
  return t;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const color = () => `rgb(${rnd(20, 140)},${rnd(20, 140)},${rnd(20, 140)})`;

function renderSvg(text) {
  const slot = W / (text.length + 1);
  const glyphs = [...text].map((ch, i) => {
    const x = Math.round(slot * (i + 1) + rnd(-4, 4));
    const y = rnd(28, 36);
    return `<text x="${x}" y="${y}" font-size="${rnd(24, 32)}" font-family="monospace,Arial,sans-serif" font-weight="bold" fill="${color()}" text-anchor="middle" transform="rotate(${rnd(-25, 25)} ${x} ${y - 8})">${ch}</text>`;
  });
  const noise = [];
  for (let i = 0, n = rnd(4, 6); i < n; i++) {
    noise.push(`<path class="n" d="M${rnd(0, W)} ${rnd(0, H)} C${rnd(0, W)} ${rnd(0, H)} ${rnd(0, W)} ${rnd(0, H)} ${rnd(0, W)} ${rnd(0, H)}" stroke="${color()}" stroke-width="${rnd(1, 2)}" fill="none"/>`);
  }
  // 干扰线夹在字符之间，部分线盖在字上
  const parts = shuffle(glyphs);
  const mid = Math.ceil(noise.length / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#f3f4f6"/>${noise.slice(0, mid).join('')}${parts.join('')}${noise.slice(mid).join('')}</svg>`;
}

/**
 * @param {{ttlMs?: number, max?: number}} [opts]
 * issue(now, { text }) 的 text 仅供测试；生产不传。
 */
export function createCaptchaStore({ ttlMs = 120_000, max = 5000 } = {}) {
  /** @type {Map<string, {hash: Buffer, exp: number}>} Map 保持插入顺序，首项即最旧 */
  const store = new Map();

  return {
    issue(now, { text } = {}) {
      for (const [k, v] of store) { // 过期的都在前面（同一 ttl，按插入即按到期顺序）
        if (v.exp < now) store.delete(k); else break;
      }
      while (store.size >= max) store.delete(store.keys().next().value);
      const t = text ?? randomText();
      const id = crypto.randomBytes(16).toString('hex');
      store.set(id, { hash: hash(t), exp: now + ttlMs });
      const image = `data:image/svg+xml;base64,${Buffer.from(renderSvg(t)).toString('base64')}`;
      return { id, image };
    },
    /** 一次性：无论对错，取到条目即删除 */
    verify(id, answer, now) {
      const e = store.get(id);
      if (!e) return false;
      store.delete(id);
      if (now > e.exp || typeof answer !== 'string') return false;
      return crypto.timingSafeEqual(e.hash, hash(answer.trim()));
    },
    size: () => store.size,
  };
}

/**
 * 是否需要先过图形验证：该 IP 一小时内已成功请求 ≥2 次（即第 3 次起）、
 * 该 IP 一小时内触发过任何发送限频、或全站今日已发到上限的一半。
 */
export function needsCaptcha({ ipSendsLastHour, ipLimitedAt, siteToday, cap, now }) {
  if (ipSendsLastHour >= 2) return true;
  if (ipLimitedAt != null && now - ipLimitedAt < HOUR_MS) return true;
  return siteToday >= cap / 2;
}
