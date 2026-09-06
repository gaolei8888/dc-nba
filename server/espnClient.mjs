/**
 * ESPN 公开接口客户端。
 *
 * 目前只用伤病一项：NBA 官方 stats 接口不提供结构化的伤病名单
 * （官方只发 PDF 伤病报告），ESPN 这个接口免费、无需鉴权、更新及时，
 * 且带有伤处、位置、预计复出日期。
 *
 * ESPN 用自己的球员 id，与 NBA 的 PLAYER_ID 不通用，靠姓名匹配。
 * 实测归一化后 75/75 全部命中。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const INJURIES_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';

/**
 * 姓名归一化：去重音符号、去 Jr./III 之类后缀、去标点。
 * 例如 "Nikola Jokić" 与 "Nikola Jokic"、"Jaren Jackson Jr." 与 "Jaren Jackson"。
 */
export const normalizeName = (s) => String(s ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/\b(jr|sr|ii|iii|iv|v)\.?$/i, '')
  .replace(/[^a-zA-Z ]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

async function get(url, { tries = 3, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => { setTimeout(r, 1200 * (i + 1)); });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`ESPN 请求失败 ${url}: ${lastErr?.message}`);
}

/** ESPN 的状态文案 -> 我们的三档 */
function normalizeStatus(raw) {
  const s = String(raw ?? '').toLowerCase();
  if (s.includes('out') || s.includes('injured reserve')) return 'out';
  if (s.includes('doubtful')) return 'doubtful';
  if (s.includes('day')) return 'dayToDay';
  if (s.includes('questionable')) return 'dayToDay';
  return 'unknown';
}

/**
 * 拉取全联盟伤病，并按姓名匹配到我们的球员。
 * @param {Array} players data/players.json 里的球员数组
 * @returns {object} 归一化后的伤病快照
 */
export async function fetchInjuries(players) {
  const payload = await get(INJURIES_URL);

  const byName = new Map();
  for (const p of players) byName.set(normalizeName(p.name), p);

  const rows = [];
  const unmatched = [];

  for (const team of payload.injuries ?? []) {
    for (const item of team.injuries ?? []) {
      const espnName = item.athlete?.displayName ?? item.athlete?.fullName ?? '';
      const player = byName.get(normalizeName(espnName));
      if (!player) {
        unmatched.push({ name: espnName, team: team.displayName });
        continue;
      }
      const d = item.details ?? {};
      rows.push({
        playerId: player.playerId,
        teamId: player.teamId,
        name: player.name,
        status: normalizeStatus(item.status),
        statusRaw: item.status ?? '',
        // GTD / OUT 之类的简写，界面上直接显示
        short: d.fantasyStatus?.abbreviation ?? '',
        type: d.type ?? '',
        detail: d.detail ?? '',
        side: d.side ?? '',
        location: d.location ?? '',
        returnDate: d.returnDate ?? null,
        since: item.date ?? null,
      });
    }
  }

  const counts = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return {
    source: 'ESPN',
    fetchedAt: new Date().toISOString(),
    espnTimestamp: payload.timestamp ?? null,
    counts,
    matched: rows.length,
    unmatched,
    players: rows.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
