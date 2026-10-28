import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  candidates, decisionInstant, flipName, isS3Missing, parseReportText, reportName, toEt,
} from '../server/injuryReport.mjs';
import {
  matchName, nameIndex, playRates, reportAdj, rotValue, tipMinutes,
} from '../server/injuryLab.mjs';

const fixture = (y) => fs.readFileSync(new URL(`./fixtures/injury-report-${y}.txt`, import.meta.url), 'utf8');

// ---------------------------------------------------------------- 文件名与决策时点

test('决策时点换成美东：冬令时 9:00 / 17:30，夏令时 10:00 / 18:30', () => {
  assert.deepEqual(toEt(decisionInstant('2022-01-14', '22')), { date: '2022-01-14', min: 9 * 60 });
  assert.deepEqual(toEt(decisionInstant('2022-01-14', '0630')), { date: '2022-01-14', min: 17 * 60 + 30 });
  assert.deepEqual(toEt(decisionInstant('2022-04-01', '22')), { date: '2022-04-01', min: 10 * 60 });
  assert.deepEqual(toEt(decisionInstant('2022-04-01', '0630')), { date: '2022-04-01', min: 18 * 60 + 30 });
});

test('文件名：旧版只到小时（标 :30），新版到 15 分钟；12 点是 PM、0 点是 12AM', () => {
  assert.equal(reportName('2022-01-14', 17 * 60 + 30, 'hour'), '2022-01-14_05PM');
  assert.equal(reportName('2026-01-14', 17 * 60, 'minute'), '2026-01-14_05_00PM');
  assert.equal(reportName('2026-01-14', 12 * 60 + 15, 'minute'), '2026-01-14_12_15PM');
  assert.equal(reportName('2026-01-14', 30, 'hour'), '2026-01-14_12AM');
  assert.throws(() => reportName('2022-01-14', 17 * 60, 'hour'));
});

test('候选报告：决策时点之前（含）从近到远，旧版每小时的 :30，新版每 15 分钟，可跨过午夜', () => {
  const at = decisionInstant('2022-01-14', '22');   // 美东 9:00
  assert.deepEqual(candidates(at, 'hour', 3).map((c) => c.name), ['2022-01-14_08AM', '2022-01-14_07AM', '2022-01-14_06AM']);
  assert.deepEqual(candidates(decisionInstant('2026-01-14', '0630'), 'minute', 2).map((c) => c.name),
    ['2026-01-14_05_30PM', '2026-01-14_05_15PM']);
  const early = Date.parse('2022-01-14T05:10:00Z');   // 美东 0:10
  assert.deepEqual(candidates(early, 'hour', 2).map((c) => c.name), ['2022-01-13_11PM', '2022-01-13_10PM']);
  assert.deepEqual(candidates(early, 'minute', 2).map((c) => c.name), ['2022-01-14_12_00AM', '2022-01-13_11_45PM']);
});

test('S3 不存在的对象（403 AccessDenied XML）认作没有；Akamai 拦截页不算', () => {
  assert.equal(isS3Missing({ status: 403, text: '<?xml version="1.0"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>' }), true);
  assert.equal(isS3Missing({ status: 403, text: '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD>Reference #18.abc</HTML>' }), false);
  assert.equal(isS3Missing({ status: 200, text: '<Error><Code>AccessDenied</Code></Error>' }), false);
});

// ---------------------------------------------------------------- 解析（三个赛季的真实样本）

for (const [y, asOf, n, nys, statuses] of [
  ['2022', '01/14/22 05:30 PM', 130, 11, { Out: 110, Questionable: 16, Available: 2, Probable: 2 }],
  ['2024', '01/14/24 05:30 PM', 125, 6, { Available: 14, Out: 91, Questionable: 13, Doubtful: 1, Probable: 6 }],
  ['2026', '01/14/26 05:00 PM', 111, 12, { Out: 79, Probable: 12, Questionable: 14, Doubtful: 3, Available: 3 }],
]) {
  test(`解析 ${y} 样本：行数、状态分布、未交名单与粗数一致`, () => {
    const text = fixture(y);
    const r = parseReportText(text);
    assert.equal(r.asOf, asOf);
    assert.equal(r.rows.length, n);
    // 粗数：带状态词的行数 = 球员行数（折行的原因不带状态）
    assert.equal(text.split('\n').filter((l) => /\s(Out|Doubtful|Questionable|Probable|Available)(\s|$)/.test(l)).length, n);
    assert.equal(r.notSubmitted.length, nys);
    const by = {};
    for (const x of r.rows) by[x.status] = (by[x.status] ?? 0) + 1;
    assert.deepEqual(by, statuses);
    assert.ok(r.rows.every((x) => x.gameDate && x.matchup && x.team && x.player.includes(',')));
  });
}

test('解析：比赛/球队往下沿用、跨页沿用，折行原因里的球员行照样认出', () => {
  const r = parseReportText(fixture('2026'));
  const get = (p) => r.rows.find((x) => x.player === p);
  // 原因折了三行，球员在中间那行
  assert.deepEqual(get('Embiid, Joel'), {
    gameDate: '2026-01-14', gameTime: '07:00 (ET)', matchup: 'CLE@PHI', team: 'Philadelphia 76ers', player: 'Embiid, Joel', status: 'Probable',
  });
  // 第 2 页开头没有比赛和球队格：沿用第 1 页最后的 TOR@IND / Toronto Raptors
  assert.equal(get('Quickley, Immanuel').team, 'Toronto Raptors');
  assert.equal(get('Quickley, Immanuel').matchup, 'TOR@IND');
  // 球队名和折行原因的第二行在同一行
  assert.equal(get('Haliburton, Tyrese').team, 'Indiana Pacers');
  // 第二天（01/15）的比赛也在同一份报告里
  assert.equal(r.rows.find((x) => x.player === 'Clarke, Brandon').gameDate, '2026-01-15');
  assert.ok(r.notSubmitted.some((x) => x.team === 'Phoenix Suns' && x.matchup === 'PHX@DET'));
  assert.ok(r.notSubmitted.some((x) => x.team === 'Houston Rockets' && x.matchup === 'OKC@HOU'));
});

test('解析：队名和球员名之间只剩一个空格时把队名拆出来，不记到对手头上', () => {
  const text = [
    '01/14/2026   07:00 (ET)   CLE@PHI   Cleveland Cavaliers         Strus, Max               Out              Injury',
    '                                    Philadelphia 76ers Embiid, Joel             Probable         Injury',
  ].join('\n');
  const r = parseReportText(text);
  assert.deepEqual(r.rows.map((x) => [x.team, x.player]), [['Cleveland Cavaliers', 'Strus, Max'], ['Philadelphia 76ers', 'Embiid, Joel']]);
});

test('flipName：Last, First -> First Last，后缀跟着姓走', () => {
  assert.equal(flipName('Carey Jr., Vernon'), 'Vernon Carey Jr.');
  assert.equal(flipName("Moore, E'Twaun"), "E'Twaun Moore");
});

// ---------------------------------------------------------------- 实验纯逻辑

test('开赛时间：12 点中午，其余（含 10:30 西部夜场）下午', () => {
  assert.equal(tipMinutes('07:00 (ET)'), 19 * 60);
  assert.equal(tipMinutes('03:30 (ET)'), 15 * 60 + 30);
  assert.equal(tipMinutes('12:00 (ET)'), 12 * 60);
  assert.equal(tipMinutes('10:30 (ET)'), 22 * 60 + 30);
  assert.equal(tipMinutes(undefined), null);
});

test('rotValue：按分钟填满 240，不够的用替补水平补，/48', () => {
  const val = new Map([[1, 5], [2, 0]]);
  assert.equal(rotValue([{ id: 1, m: 48 }, { id: 2, m: 192 }], val), 5);
  // 只有 48 分钟：其余 192 分钟按 repl=-2
  assert.equal(rotValue([{ id: 1, m: 48 }], val), (5 * 48 - 2 * 192) / 48);
  // 超过 240 的部分不计，没有值的按 unknownV
  assert.equal(rotValue([{ id: 3, m: 240 }, { id: 1, m: 10 }], val), -1 * 240 / 48);
});

test('reportAdj：Out 的人分钟乘 p≈0、没上报告的按 1、只罚不奖', () => {
  const usual = [{ id: 1, m: 36 }, { id: 2, m: 204 }];
  const val = new Map([[1, 6], [2, 0]]);
  const p = { Out: 0, Questionable: 0.5 };
  assert.equal(reportAdj(usual, () => undefined, p, val), 0);
  assert.equal(reportAdj(usual, (id) => (id === 1 ? 'Out' : undefined), p, val), (-2 * 36 - 6 * 36) / 48);
  assert.equal(reportAdj(usual, (id) => (id === 1 ? 'Questionable' : undefined), p, val), (-2 * 18 - 6 * 18) / 48);
  // 坏球员缺阵会让值变高，但只罚不奖：记 0
  assert.equal(reportAdj(usual, (id) => (id === 1 ? 'Out' : undefined), p, new Map([[1, -6], [2, 0]])), 0);
});

test('matchName：全名（去重音/后缀）、重名取本队、对不上就在本队找姓+名首字母', () => {
  const people = [
    { id: 1, name: 'Nikola Jokić' }, { id: 2, name: 'Vernon Carey Jr.' },
    { id: 3, name: 'Marcus Morris Sr.' }, { id: 4, name: 'Marcus Morris' },
    { id: 5, name: 'Cameron Thomas' }, { id: 6, name: 'Herbert Jones' },
  ];
  const idx = nameIndex(people);
  const nameOf = (i) => people.find((p) => p.id === i)?.name;
  assert.equal(matchName('Jokic, Nikola', idx, new Set(), nameOf), 1);
  assert.equal(matchName('Carey Jr., Vernon', idx, new Set(), nameOf), 2);
  assert.equal(matchName('Morris, Marcus', idx, new Set([4]), nameOf), 4);
  assert.equal(matchName('Morris, Marcus', idx, new Set(), nameOf), null);
  assert.equal(matchName('Thomas, Cam', idx, new Set([5]), nameOf), 5);
  assert.equal(matchName('Jones, Herb', idx, new Set([5]), nameOf), null);
});

test('playRates：按权重算出场率，带 0.5/1 平滑', () => {
  const r = playRates([
    { status: 'Out', played: false, w: 1 }, { status: 'Out', played: false, w: 1 },
    { status: 'Questionable', played: true, w: 2 }, { status: 'Questionable', played: false, w: 1 },
  ], (o) => o.w);
  assert.equal(r.Out.n, 2);
  assert.equal(r.Out.p, 0.5 / 3);
  assert.equal(r.Questionable.p, 2.5 / 4);
  assert.equal(r.Probable.p, 0.5);
});
