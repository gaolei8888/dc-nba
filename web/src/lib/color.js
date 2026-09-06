/**
 * 队色处理。
 *
 * 30 队官方主色里有极端值：篮网近乎纯黑 (#1D1D1B)、马刺是银灰 (#C4CED4)。
 * 直接拿来当强调色，前者在深色主题上糊成一团，后者在浅色主题上看不见。
 * 所以按主题把过暗/过亮的队色拉回可读区间，同时保留色相。
 */

const clamp = (v, lo = 0, hi = 255) => Math.max(lo, Math.min(hi, v));

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = ([r, g, b]) =>
  `#${[r, g, b].map((v) => Math.round(clamp(v)).toString(16).padStart(2, '0')).join('')}`;

/** WCAG 相对亮度，0（黑）~ 1（白） */
export function luminance(hex) {
  const srgb = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

/** 在两个颜色之间线性插值，amount=1 时完全变成 target */
export function mix(hex, target, amount) {
  const a = hexToRgb(hex);
  const b = hexToRgb(target);
  return rgbToHex(a.map((v, i) => v + (b[i] - v) * amount));
}

/** 压在该底色上的文字该用深色还是浅色 */
export const inkOn = (hex) => (luminance(hex) > 0.42 ? '#12161c' : '#ffffff');

export const rgba = (hex, alpha) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/**
 * 给一支球队生成整套主题变量。
 * @param {object} team 含 color / colorAlt
 * @param {boolean} dark 当前是否深色主题
 */
export function teamPalette(team, dark) {
  const base = team?.color ?? '#5b6472';
  const alt = team?.colorAlt ?? '#9aa3b0';

  // 强调色：深色主题下提亮过暗的队色，浅色主题下压暗过亮的队色
  const fix = (hex) => {
    const l = luminance(hex);
    if (dark && l < 0.16) return mix(hex, '#ffffff', 0.42);
    if (!dark && l > 0.55) return mix(hex, '#000000', 0.42);
    return hex;
  };

  const accent = fix(base);
  const accentAlt = fix(alt);

  return {
    base,
    alt,
    accent,
    accentAlt,
    ink: inkOn(base),
    inkAlt: inkOn(alt),
    /** 大面积头图渐变，始终用原始队色，文字颜色按平均亮度决定 */
    heroFrom: base,
    heroTo: mix(alt, base, 0.25),
    heroInk: inkOn(mix(base, alt, 0.5)),
    soft: rgba(accent, dark ? 0.18 : 0.12),
    softer: rgba(accent, dark ? 0.09 : 0.06),
    line: rgba(accent, dark ? 0.4 : 0.32),
  };
}

/** 把队色主题写成 CSS 自定义属性，挂在容器 style 上 */
export function teamVars(team, dark) {
  const p = teamPalette(team, dark);
  return {
    '--team': p.accent,
    '--team-alt': p.accentAlt,
    '--team-raw': p.base,
    '--team-soft': p.soft,
    '--team-softer': p.softer,
    '--team-line': p.line,
    '--team-ink': p.ink,
    '--hero-from': p.heroFrom,
    '--hero-to': p.heroTo,
    '--hero-ink': p.heroInk,
  };
}
