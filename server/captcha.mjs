/**
 * 自写 SVG 字符图形验证（零依赖）。
 *  - 4 个字符取自去掉易混淆字符（I/L/O/0/1）的字母表，用 crypto.randomInt 选。
 *  - SVG 不含任何 <text>/字符数据：每个字符用内置笔画字体（10×14 网格的折线）画成 <path>，
 *    深色、≥2px，随机旋转 ±25°、缩放、偏移并对每个点做轻微抖动；另加 4–6 条浅色细（1px）贝塞尔干扰线，画在字符后面。
 *    字符 <path> 按随机顺序写入 DOM，按出现顺序读不出答案。
 *  - 答案只存 sha256(大写)；内存 Map，2 分钟有效、一次性（答错也作废）；
 *    issue 时先清过期，再按 max 丢最旧，保证有界。
 *  - 不做持久化：本服务是单容器单进程，内存即可；重启后全部失效，用户重新取一张即可。
 */
import crypto from 'node:crypto';

export const CAPTCHA_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LEN = 4;
const W = 150;
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

/** 字符笔画：深色；干扰线：浅色低饱和，二者拉开对比，干扰线不会被当成笔画 */
const color = () => `rgb(${rnd(20, 110)},${rnd(20, 110)},${rnd(20, 110)})`;
const lightColor = () => `rgb(${rnd(150, 210)},${rnd(150, 210)},${rnd(150, 210)})`;

/** 笔画字体：10×14 网格（y 向下），每个字符是若干条折线 */
export const FONT = {
  A: [[[0,14],[5,0],[10,14]], [[2,9],[8,9]]],
  B: [[[0,0],[0,14],[7,14],[9.5,11],[9.5,9.5],[7,7],[0,7]], [[0,0],[7,0],[9.5,2.5],[9.5,4.5],[7,7]]],
  C: [[[10,3],[7,0],[3,0],[0,3],[0,11],[3,14],[7,14],[10,11]]],
  D: [[[0,0],[0,14],[6,14],[10,10],[10,4],[6,0],[0,0]]],
  E: [[[10,0],[0,0],[0,14],[10,14]], [[0,7],[7,7]]],
  F: [[[10,0],[0,0],[0,14]], [[0,7],[7,7]]],
  G: [[[10,3],[7,0],[3,0],[0,3],[0,11],[3,14],[7,14],[10,11],[10,8],[5,8]]],
  H: [[[0,0],[0,14]], [[10,0],[10,14]], [[0,7],[10,7]]],
  J: [[[10,0],[10,11],[7,14],[3,14],[0,11]]],
  K: [[[0,0],[0,14]], [[10,0],[0,8]], [[3,6],[10,14]]],
  M: [[[0,14],[0,0],[5,8],[10,0],[10,14]]],
  N: [[[0,14],[0,0],[10,14],[10,0]]],
  P: [[[0,14],[0,0],[7,0],[10,3],[10,5],[7,8],[0,8]]],
  Q: [[[3,0],[7,0],[10,3],[10,11],[7,14],[3,14],[0,11],[0,3],[3,0]], [[6,10],[10,14]]],
  R: [[[0,14],[0,0],[7,0],[10,3],[10,5],[7,8],[0,8]], [[5,8],[10,14]]],
  S: [[[10,2],[7,0],[3,0],[0,3],[1,6],[9,8],[10,11],[7,14],[3,14],[0,12]]],
  T: [[[0,0],[10,0]], [[5,0],[5,14]]],
  U: [[[0,0],[0,11],[3,14],[7,14],[10,11],[10,0]]],
  V: [[[0,0],[5,14],[10,0]]],
  W: [[[0,0],[2.5,14],[5,6],[7.5,14],[10,0]]],
  X: [[[0,0],[10,14]], [[10,0],[0,14]]],
  Y: [[[0,0],[5,7],[10,0]], [[5,7],[5,14]]],
  Z: [[[0,0],[10,0],[0,14],[10,14]]],
  2: [[[0,3],[3,0],[7,0],[10,3],[9,6],[0,14],[10,14]]],
  3: [[[0,2],[3,0],[7,0],[10,3],[7,6],[4,7],[7,8],[10,11],[7,14],[3,14],[0,12]]],
  4: [[[8,14],[8,0],[0,10],[10,10]]],
  5: [[[10,0],[1,0],[0,7],[6,6],[10,9],[10,11],[7,14],[3,14],[0,12]]],
  6: [[[9,1],[5,0],[1,4],[0,10],[3,14],[7,14],[10,11],[10,9],[7,7],[3,7],[0,10]]],
  7: [[[0,0],[10,0],[4,14]]],
  8: [[[5,7],[1,5],[1,2],[3,0],[7,0],[9,2],[9,5],[5,7],[0,10],[0,12],[3,14],[7,14],[10,12],[10,10],[5,7]]],
  9: [[[1,13],[5,14],[9,10],[10,4],[7,0],[3,0],[0,3],[0,5],[3,7],[7,7],[10,4]]],
};

const jit = () => (crypto.randomInt(-40, 41)) / 100; // ±0.4 格

/** 一个字符 → <path>：以字形中心 (5,7) 为原点缩放、旋转，再平移到 (cx,cy)，逐点抖动 */
function glyphPath(ch, cx, cy) {
  const k = rnd(13, 17) / 10; // 缩放上限 1.7：旋转后字宽 ≤ 槽宽，相邻字不粘连
  const a = (rnd(-25, 25) * Math.PI) / 180;
  const sin = Math.sin(a);
  const cos = Math.cos(a);
  const d = FONT[ch].map((line) => line.map(([x, y], i) => {
    const px = (x - 5 + jit()) * k;
    const py = (y - 7 + jit()) * k;
    const X = cx + px * cos - py * sin;
    const Y = cy + px * sin + py * cos;
    return `${i ? 'L' : 'M'}${X.toFixed(1)} ${Y.toFixed(1)}`;
  }).join('')).join('');
  return `<path class="g" d="${d}" stroke="${color()}" stroke-width="${rnd(22, 28) / 10}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
}

function renderSvg(text) {
  const slot = W / (text.length + 1);
  const glyphs = [...text].map((ch, i) => glyphPath(ch, slot * (i + 1) + rnd(-2, 2), H / 2 + rnd(-3, 3)));
  const noise = [];
  for (let i = 0, n = rnd(4, 6); i < n; i++) {
    noise.push(`<path class="n" d="M${rnd(0, W)} ${rnd(0, H)} C${rnd(0, W)} ${rnd(0, H)} ${rnd(0, W)} ${rnd(0, H)} ${rnd(0, W)} ${rnd(0, H)}" stroke="${lightColor()}" stroke-width="1" fill="none"/>`);
  }
  // 干扰线全部画在字符后面（先画），不遮字
  const parts = shuffle(glyphs);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#f3f4f6"/>${noise.join('')}${parts.join('')}</svg>`;
}

/**
 * @param {{ttlMs?: number, max?: number}} [opts]
 * issue(now, { text }) 的 text 仅供测试；生产不传。
 */
export function createCaptchaStore({ ttlMs = 120_000, max = 5000 } = {}) {
  /** @type {Map<string, {hash: Buffer, exp: number}>} Map 保持插入顺序，首项即最旧 */
  const store = new Map();
  /** ip → 最近一次触发限频的时间；同样按插入序有界（重新记录时先删后插，保持首项最旧） */
  const limited = new Map();

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
    /**
     * 记录某 IP 触发了发送限频。契约：路由层只要因「IP / 号码限频」拒绝了一次发送，就调用一次
     * noteLimited(ip, now)；之后一小时内该 IP 会被要求先过图形验证（经 limitedAt / needsCaptcha 读取）。
     */
    noteLimited(ip, now) {
      if (!ip) return;
      limited.delete(ip);
      for (const [k, t] of limited) { // 先清一小时前的
        if (now - t >= HOUR_MS) limited.delete(k); else break;
      }
      while (limited.size >= max) limited.delete(limited.keys().next().value);
      limited.set(ip, now);
    },
    /** 该 IP 最近一小时内最后一次触发限频的时间；没有或已过一小时返回 null */
    limitedAt(ip, now) {
      const t = limited.get(ip);
      return t !== undefined && now - t < HOUR_MS ? t : null;
    },
    limitedSize: () => limited.size,
  };
}

/**
 * 是否需要先过图形验证：该 IP 一小时内已成功请求 ≥2 次（即第 3 次起）、
 * 该 IP 一小时内触发过任何发送限频（ipLimitedAt，或 store.noteLimited 记录的）、或全站今日已发到上限的一半。
 */
export function needsCaptcha({ ipSendsLastHour, ipLimitedAt, siteToday, cap, now, store, ip }) {
  // 调用方可直接传 ipLimitedAt，或传 store + ip 由 store.noteLimited 的记录兜底
  ipLimitedAt ??= store && ip ? store.limitedAt(ip, now) : null;
  if (ipSendsLastHour >= 2) return true;
  if (ipLimitedAt != null && now - ipLimitedAt < HOUR_MS) return true;
  return siteToday >= cap / 2;
}
