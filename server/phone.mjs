// 手机号规范化（E.164）与脱敏：纯函数，无 I/O。

// 顺序固定；显示名走 i18n 键 country.<iso>
export const COUNTRIES = [
  { cc: '86', iso: 'CN' }, { cc: '1', iso: 'US' }, { cc: '852', iso: 'HK' }, { cc: '853', iso: 'MO' },
  { cc: '886', iso: 'TW' }, { cc: '65', iso: 'SG' }, { cc: '44', iso: 'GB' }, { cc: '81', iso: 'JP' },
  { cc: '82', iso: 'KR' }, { cc: '61', iso: 'AU' },
];

const INVALID = { ok: false, code: 'auth.phoneInvalid' };

// 校验去掉区号后的本地号码，合法返回规范化后的本地号，否则 null
function validLocal(cc, local) {
  if (!/^\d+$/.test(local)) return null;
  if (cc === '86') return /^1[3-9]\d{9}$/.test(local) ? local : null;
  if (cc === '1') return /^[2-9]\d{2}[2-9]\d{6}$/.test(local) ? local : null;
  const n = local.replace(/^0/, ''); // 去掉国内长途前缀 0
  const total = cc.length + n.length;
  return total >= 8 && total <= 15 ? n : null;
}

export function normalizePhone(cc, input) {
  if (!COUNTRIES.some((c) => c.cc === cc)) return INVALID;
  let s = String(input ?? '').replace(/[\s\-().]/g, '');
  if (!s) return INVALID;
  let intl = false;
  if (s.startsWith('+')) { s = s.slice(1); intl = true; }
  else if (s.startsWith('00')) { s = s.slice(2); intl = true; }
  if (!/^\d+$/.test(s)) return INVALID;
  let local;
  if (intl) {
    if (!s.startsWith(cc)) return INVALID; // 区号必须与所选一致
    local = validLocal(cc, s.slice(cc.length));
  } else {
    // 无 +：以所选区号开头且剥掉后合规则剥掉，否则按本地号处理
    local = (s.startsWith(cc) ? validLocal(cc, s.slice(cc.length)) : null) ?? validLocal(cc, s);
  }
  return local ? { ok: true, e164: `+${cc}${local}` } : INVALID;
}

function ccOf(e164) {
  const digits = String(e164).replace(/^\+/, '');
  let best = null;
  for (const c of COUNTRIES) {
    if (digits.startsWith(c.cc) && (!best || c.cc.length > best.length)) best = c.cc;
  }
  return best;
}

export function isMainland(e164) {
  return ccOf(e164) === '86';
}

export function maskPhone(e164) {
  const digits = String(e164).replace(/^\+/, '');
  const cc = ccOf(e164);
  if (cc === '86') return `${digits.slice(2, 5)}****${digits.slice(-4)}`;
  return `${cc ? `+${cc} ` : '+'}****${digits.slice(-4)}`;
}

export function countriesFor(overseasOn) {
  return overseasOn ? COUNTRIES : COUNTRIES.filter((c) => c.cc === '86');
}
