/**
 * 从 play-by-play 还原每一段的场上十人。
 *
 * 为什么要做这件事：`leaguedashlineups` 只给进攻方的五个人，
 * 算出来的 APM 没有对手调整——总在一起上场的球员分不开，
 * 强队的角色球员会被系统性抬高。真正的 RAPM 需要逐段的攻守双方阵容，
 * 只有 play-by-play 里有。
 *
 * 踩过的三个坑，都写在这里免得再踩：
 *  1. `playbyplayv2` 已经空返回（2 字节），只能用 v3。
 *  2. v3 的换人事件只带**下场**球员的 personId，上场的人只在
 *     "SUB: Nance Jr. FOR Johnson" 这句描述里。所以每场必须配一次
 *     box score，既拿姓名→ID 对照表，也拿分钟数对账。
 *  3. **节间换人不记事件**。第二节开场时场上已经换了人，PBP 里却没有
 *     任何记录。所以每节的开场五人必须单独推断，不能从上一节末尾顺延。
 *
 * 每节开场五人的推断规则：在这一节里，凡是「在自己第一次被换上之前」
 * 就出现过的球员（有任何事件，或者被换下），必定在开场时就在场上。
 * 推不出恰好 5 人就说明还原有问题，整场作废——宁可少几场也不要脏数据。
 */

const PERIOD_SEC = (p) => (p <= 4 ? 720 : 300);
const SUB_RE = /^SUB:\s*(.+?)\s+FOR\s+(.+?)\s*$/;

/** "PT11M43.00S" -> 该节剩余秒数 */
export function parseClock(s) {
  const m = /^PT(\d+)M([\d.]+)S$/.exec(s ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 比赛开始至今的绝对秒数 */
export function elapsed(period, clock) {
  let before = 0;
  for (let p = 1; p < period; p++) before += PERIOD_SEC(p);
  return before + (PERIOD_SEC(period) - (parseClock(clock) ?? 0));
}

/** "35:56" -> 秒。空字符串（未出场）返回 0。 */
export function parseMinutes(s) {
  if (!s) return 0;
  const m = /^(\d+):(\d+)/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/**
 * 归一化姓名：去掉变音符、后缀、点和空格。
 * PBP 描述写的是 "Matkovic"，名册里是 "Matković"——不脱变音符就对不上。
 */
const norm = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(Jr|Sr|II|III|IV|V)\b\.?/g, '')
  .replace(/[.\s'’-]/g, '')
  .toLowerCase();

/** 把 boxscoretraditionalv3 整理成还原阵容需要的东西 */
export function readBox(payload) {
  const g = payload?.boxScoreTraditional;
  if (!g) throw new Error('box score 结构异常');
  const side = (t) => ({
    teamId: t.teamId,
    tricode: t.teamTricode,
    players: t.players.map((p) => ({
      personId: p.personId,
      firstName: p.firstName,
      familyName: p.familyName,
      nameI: p.nameI,
      seconds: parseMinutes(p.statistics?.minutes),
    })),
  });
  return { gameId: g.gameId, home: side(g.homeTeam), away: side(g.awayTeam) };
}

/**
 * 换人描述里的名字 -> personId。
 * 同队重名时 NBA 写成 "K. Martin"（首字母+姓），所以 nameI 要先试；
 * 只按姓氏匹配会漏掉这一类，进而把真正上场的人误判成本节开场球员。
 * 还分不开就用「当前不在场上」消歧——换上来的人必然在场下。
 */
function resolveName(name, players, onCourt) {
  const want = String(name ?? '').trim();
  const pick = (list) => {
    if (list.length === 1) return list[0].personId;
    if (list.length > 1 && onCourt) {
      const off = list.filter((p) => !onCourt.has(p.personId));
      if (off.length === 1) return off[0].personId;
    }
    return null;
  };
  // 同队有两个 J. Green 时，NBA 会写成 "Ja. Green"——缩写不止一个字母，
  // 只能拿它去比对名（firstName）的开头。
  const m = /^([A-Za-z]{1,3})\.\s+(.+)$/.exec(want);
  const byPrefix = m
    ? players.filter((p) => norm(p.familyName) === norm(m[2])
      && norm(p.firstName).startsWith(norm(m[1])))
    : [];

  return pick(players.filter((p) => p.nameI === want))
    ?? pick(players.filter((p) => p.familyName === want))
    ?? pick(byPrefix)
    ?? pick(players.filter((p) => norm(p.nameI) === norm(want)))
    ?? pick(players.filter((p) => norm(p.familyName) === norm(want)))
    ?? null;
}

/**
 * 逐节推断开场五人。
 * @returns {{starters: Map<string, number[]>, problems: string[]}}
 *   key 形如 `${period}|${teamId}`
 */
export function inferPeriodStarters(actions, box) {
  const sides = new Map([[box.home.teamId, box.home], [box.away.teamId, box.away]]);
  const periods = [...new Set(actions.map((a) => a.period))].filter(Boolean).sort((a, b) => a - b);
  const starters = new Map();
  const problems = [];

  // 上一节结束时的场上五人。加时节只有 5 分钟，常有人从头打到尾且
  // 没有任何事件，靠事件推不出来——这时用上一节末尾的阵容补，
  // 因为加时开场绝大多数就是第四节的收官阵容。补得对不对由分钟数对账兜底。
  let prevEnd = new Map([...sides.keys()].map((t) => [t, new Set()]));

  for (const P of periods) {
    const started = new Map([...sides.keys()].map((t) => [t, new Set()]));
    const cameIn = new Map([...sides.keys()].map((t) => [t, new Set()]));
    const subs = [];

    for (const a of actions) {
      if (a.period !== P) continue;
      const side = sides.get(a.teamId);
      if (!side) continue;
      const S = started.get(a.teamId);
      const I = cameIn.get(a.teamId);
      if (a.actionType === 'Substitution') {
        const m = SUB_RE.exec(a.description ?? '');
        if (!m) { problems.push(`换人无法解析 P${P}: ${a.description}`); continue; }
        if (!I.has(a.personId)) S.add(a.personId);
        const inId = resolveName(m[1], side.players, null);
        if (inId === null) problems.push(`上场球员对不上 P${P}: ${a.description}`);
        else { I.add(inId); subs.push({ teamId: a.teamId, out: a.personId, in: inId }); }
      } else if (a.personId && !I.has(a.personId)) {
        S.add(a.personId);
      }
    }

    const end = new Map();
    for (const [tid, S] of started) {
      if (S.size < 5) {
        for (const id of prevEnd.get(tid) ?? []) {
          if (S.size >= 5) break;
          if (!S.has(id) && !cameIn.get(tid).has(id)) S.add(id);
        }
      }
      if (S.size !== 5) problems.push(`P${P} 队 ${tid} 推出 ${S.size} 人`);
      starters.set(`${P}|${tid}`, [...S].sort((a, b) => a - b));
      end.set(tid, new Set(S));
    }
    for (const s of subs) {
      const set = end.get(s.teamId);
      set.delete(s.out);
      set.add(s.in);
    }
    prevEnd = end;
  }
  return { starters, problems };
}

/**
 * 还原逐段阵容与得分/回合。
 *
 * 回合数用标准口径 FGA + 0.44×FTA − OREB + TOV。进攻篮板靠
 * 「抢板方 == 上一次投失方」判定——v3 不直接标进攻/防守篮板。
 */
export function buildStints(actions, box) {
  const { starters, problems } = inferPeriodStarters(actions, box);
  const warnings = [...problems];
  const sides = new Map([[box.home.teamId, box.home], [box.away.teamId, box.away]]);
  const HOME = box.home.teamId;
  const AWAY = box.away.teamId;
  const on = new Map([[HOME, new Set()], [AWAY, new Set()]]);

  const stints = [];
  const seconds = new Map();
  let cur = null;
  let score = { home: 0, away: 0 };
  let lastMissTeam = null;

  const open = (period, t) => ({
    period,
    start: t,
    home: [...on.get(HOME)].sort((a, b) => a - b),
    away: [...on.get(AWAY)].sort((a, b) => a - b),
    fga: { home: 0, away: 0 },
    fta: { home: 0, away: 0 },
    tov: { home: 0, away: 0 },
    oreb: { home: 0, away: 0 },
    pts: { home: 0, away: 0 },
    score0: { ...score },
  });

  const close = (t) => {
    if (!cur) return;
    const dur = Math.max(0, t - cur.start);
    cur.sec = dur;
    for (const s of ['home', 'away']) cur.pts[s] = score[s] - cur.score0[s];
    delete cur.score0;
    for (const s of ['home', 'away']) {
      for (const id of cur[s]) seconds.set(id, (seconds.get(id) ?? 0) + dur);
    }
    if (cur.home.length === 5 && cur.away.length === 5
      && (dur > 0 || cur.pts.home || cur.pts.away)) stints.push(cur);
    cur = null;
  };

  for (const a of actions) {
    const t = elapsed(a.period, a.clock);

    if (a.actionType === 'period') {
      close(t);
      if (a.subType === 'start') {
        for (const tid of [HOME, AWAY]) on.set(tid, new Set(starters.get(`${a.period}|${tid}`) ?? []));
        cur = open(a.period, t);
      }
      continue;
    }
    if (!cur) {
      for (const tid of [HOME, AWAY]) {
        if (!on.get(tid).size) on.set(tid, new Set(starters.get(`${a.period}|${tid}`) ?? []));
      }
      cur = open(a.period, t);
    }

    if (a.scoreHome !== '' && a.scoreHome != null) {
      score = { home: Number(a.scoreHome), away: Number(a.scoreAway) };
    }

    if (a.actionType === 'Substitution') {
      const m = SUB_RE.exec(a.description ?? '');
      const side = sides.get(a.teamId);
      if (!m || !side) continue;
      close(t);
      const set = on.get(a.teamId);
      const inId = resolveName(m[1], side.players, set);
      set.delete(a.personId);
      if (inId !== null) set.add(inId);
      if (set.size !== 5) warnings.push(`换人后场上 ${set.size} 人 @P${a.period} ${a.clock}`);
      cur = open(a.period, t);
      continue;
    }

    const s = a.teamId === HOME ? 'home' : a.teamId === AWAY ? 'away' : null;
    if (!s) continue;
    switch (a.actionType) {
      case 'Made Shot': cur.fga[s]++; lastMissTeam = null; break;
      case 'Missed Shot': cur.fga[s]++; lastMissTeam = a.teamId; break;
      case 'Free Throw': {
        const sub = a.subType ?? '';
        cur.fta[s]++;
        const isLast = /(\d+) of \1$/.test(sub) || /1 of 1/.test(sub);
        lastMissTeam = (isLast && /MISS/.test(a.description ?? '')) ? a.teamId : null;
        break;
      }
      case 'Turnover': cur.tov[s]++; lastMissTeam = null; break;
      case 'Rebound':
        if (lastMissTeam !== null && a.teamId === lastMissTeam) cur.oreb[s]++;
        lastMissTeam = null;
        break;
      default: break;
    }
  }
  const lastAct = actions[actions.length - 1];
  close(elapsed(lastAct?.period ?? 4, 'PT00M00.00S'));

  for (const st of stints) {
    st.poss = {
      home: st.fga.home + 0.44 * st.fta.home - st.oreb.home + st.tov.home,
      away: st.fga.away + 0.44 * st.fta.away - st.oreb.away + st.tov.away,
    };
  }
  return { stints, seconds, warnings };
}

/**
 * 逐人对账：还原出的出场时间 vs box score 分钟数。
 * 这是唯一能证明还原正确的东西——代码看着对不算数。
 * PBP 时钟与 box 分钟都取整过，允许每人差 tol 秒。
 */
export function checkMinutes(seconds, box, tol = 45) {
  const bad = [];
  for (const t of [box.home, box.away]) {
    for (const p of t.players) {
      const got = seconds.get(p.personId) ?? 0;
      if (Math.abs(got - p.seconds) > tol) {
        bad.push({ personId: p.personId, name: p.familyName, box: p.seconds, pbp: Math.round(got) });
      }
    }
  }
  return bad;
}
