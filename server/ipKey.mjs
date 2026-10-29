/**
 * 限频用的 IP 分组键：凡是「按 IP」限频 / 记账的地方（sms_sends 的 IP 计数、在途占位、图形验证的限频记录）都用它。
 *
 *  - IPv4：原样（整个地址一个桶）。
 *  - IPv4 映射的 IPv6（::ffff:a.b.c.d / ::ffff:xxxx:xxxx）：归成点分 IPv4，与直接的 IPv4 写法算同一个。
 *  - 其余 IPv6：按 /64 前缀分组——一户宽带 / 一台机器通常分到整个 /64，逐地址计数等于没限。
 *    键形如 `2001:db8:1:2::/64`（小写、去前导 0），同一前缀的各种写法归一。
 *  - 空值 → null；认不出的串原样返回（不抛，宁可按原串单独计数）。
 *
 * 只用作计数键；库里（sms_sends.ip）仍存请求的原始 IP。
 */
import net from 'node:net';

/** 把 IPv6 展开成 8 段数字；失败返回 null */
function v6Groups(s) {
  let tail = [];
  // 末尾内嵌 IPv4（如 ::ffff:1.2.3.4）：换成两段 16 位
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    if (!net.isIPv4(m[2])) return null;
    const o = m[2].split('.').map(Number);
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    s = m[1].endsWith('::') ? m[1] : m[1].slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x) => (x === '' ? [] : x.split(':').map((g) => parseInt(g, 16)));
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - rest.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  const all = [...head, ...Array(Math.max(fill, 0)).fill(0), ...rest, ...tail];
  return all.length === 8 && all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : null;
}

export function ipKey(ip) {
  if (ip === null || ip === undefined || ip === '') return null;
  const raw = String(ip).trim();
  const s = raw.replace(/%.*$/, ''); // 去掉 zone id（fe80::1%eth0）
  if (net.isIPv4(s)) return s;
  if (!net.isIPv6(s)) return raw;
  const g = v6Groups(s.toLowerCase());
  if (!g) return raw;
  // IPv4 映射：::ffff:0:0/96
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}
