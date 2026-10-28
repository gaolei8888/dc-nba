# 用户系统（手机号验证码登录 · 锁定预测总表与模拟投注 · 预留会员等级）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **前置依赖：多语言计划 `docs/superpowers/plans/2026-10-29-i18n.md` 必须先落地。** 本计划假定它已提供：前端翻译函数 `t(key, params)`（当前语言取自 i18n 的上下文 / hook，下文写作 `useI18n()`，以 i18n 计划的实际导出名为准）、中英两份语言文件（下文写作 `<zh 语言文件>` / `<en 语言文件>`，路径以 i18n 计划为准）、服务端「消息键 + 参数」`{ code, params }` 由前端渲染的约定，以及 CI 里「两份语言文件键一致」的测试。本计划新增的所有界面文字与服务端错误码，都以键的形式加进这两份文件。若 i18n 计划的错误形状保留了中文 `error` 回退字段，本计划的新接口一并带上。

> **与 i18n 计划对齐后的实际名称（执行时以此为准）：** 前端 `useI18n()` 来自 `web/src/i18n/react.jsx`；语言文件 `web/src/i18n/locales/zh.js` / `en.js`（`<zh 语言文件>` / `<en 语言文件>` 即此）；接口错误用 `web/src/lib/apiError.js` 的 `ApiError` / `errorText`；服务端消息用 `server/messages.mjs` 的 `msg` / `codedError` / `sendError`；命名空间 `auth.*`、`lock.*`、`legal.*`、`err.*` 已在 i18n 计划中预留。**偏好形状统一用 i18n 计划 `web/src/lib/prefs.js` 的 `{ lang, tz }`**：下文账号偏好里的 `locale` 即 `lang`、`timeZone`（作为偏好字段名时）即 `tz`——存库列名、接口字段名都用 `lang` / `tz`；`tz = null` 表示「跟语言走」。

**Goal:** 手机号 + 短信验证码登录（登录即注册），预测总表页的汇总统计、影子模式与模拟投注只对登录用户开放（服务端强制），未登录看预告；账号绑定一个玩家档案；预留会员等级。

**Architecture:** 服务端新增几个可注入 SQLite 句柄的纯模块（号码规范化、验证码与限频、账号与会话、权限判断与预告裁剪、短信发送器、图形验证），由一个 `express.Router` 工厂挂到 `/api/auth`；`server/index.mjs` 只做接线：`trust proxy`、身份解析（排行榜令牌或会话令牌）、三个被锁接口按 `can(user, feature)` 返回完整数据或预告。前端新增会话存储、登录页、协议页、预告组件，改侧栏与 Board.jsx。凭证全部走 `Authorization: Bearer`，不用 cookie。

**Tech Stack:** Node 22 ESM、Express 4、`node:sqlite`、`node:crypto`（TC3-HMAC-SHA256 签名、随机数、哈希）、全局 `fetch`；React 18 + Vite；`node:test`。**不新增依赖。**

**Spec:** `docs/superpowers/specs/2026-10-29-user-system-design.md`（依据 `docs/superpowers/specs/2026-10-29-i18n-design.md`）

## Global Constraints

- 不新增 npm 依赖（腾讯云 / Twilio 直接 HTTP，签名用 `node:crypto`）。
- 验证码 6 位，`crypto.randomInt` 生成；有效期 **5 分钟**；只存哈希；验证成功或**错 5 次**即作废。
- 同一号码 **60 秒**一次、每天最多 **10 次**；同一 IP 每小时 **5**、每天 **20**（设计决定，`SMS_IP_HOURLY` / `SMS_IP_DAILY` 可配）；全站每日 **500** 条（`SMS_DAILY_CAP` 可配），超限停发、写服务器日志、`/api/health` 报警。「每天」一律按北京时间自然日。
- 发送失败如实返回失败，不存验证码。
- 手机号按 E.164 存，`users.phone_e164 UNIQUE`。
- 会话：Bearer 令牌，服务端只存 SHA-256 哈希，**30 天**到期，退出即失效。
- 一个账号对应一个玩家档案；登录时绑定浏览器当前档案；账号已有档案则以账号的为准、不并入本机匿名记录。
- 会员等级字段 `tier`（今天全部 `free`）+ `tier_expires_at`；服务端唯一权限入口 `can(user, feature)`。
- 被锁的只有预测总表页调用的三个接口：`/api/predictions/summary`、`/api/paper`、`/api/shadow`（Board.jsx 实际调用的全部接口，已核对：`api.predictionBoard`、`api.paper`、`api.shadow`）；`/api/schedule`、`/api/gameday`、`/api/predict`、`/api/live` 等不变。
- 被锁接口对未登录请求只返回预告字段（服务端裁剪，不是前端隐藏）。
- 预告按钮文案固定：「登录后查看完整战绩统计与模拟投注」；不得写「登录后查看今晚的预测」。
- 海外号默认关闭（`ENABLE_OVERSEAS_SMS` 不为 `"1"`）；关闭时区号只有 +86，并显示「海外号即将开放」。
- 短信只发中文（腾讯云已审批模板）；Twilio Verify 文字由 Twilio 生成。
- 预测、账本、影子模式、定时任务与登录无关，代码路径不改。
- 不登录也能照常玩人机对赌与排行榜。
- 密钥只从环境变量读；不进仓库、不进镜像、不打印。日志里手机号一律脱敏，验证码只在非 production 的 console 发送器里打印。
- 新表 `CREATE TABLE IF NOT EXISTS`，加法迁移；不覆盖服务器 `docker-compose.yml` 与 `data-db/`。
- 中文注释、中文提交信息、`node:test`；部署走 `deploy/README.md`，上线前打回滚标签 + 备份数据库。

## Review Focus

- 同一号码不同写法（空格、短横、粘贴的 `+86` / `0086` / `86` 前缀）必须落到同一个 E.164、同一个账号 → Task 1 测试 `normalizePhone：各种写法归一`。
- 连点「获取验证码」或两个标签页同时发：只发一条短信，另一条返回冷却 → Task 2 测试 `同一号码并发请求只发一条`。
- 腾讯云 HTTP 200 但 `SendStatusSet[0].Code` 不是 `Ok`（如 `LimitExceeded.PhoneNumberDailyLimit`）：算失败、不存码、告诉用户失败 → Task 5 测试 `HTTP 200 但 Code 非 Ok 算失败` + Task 2 测试 `发送失败不存码`。
- 会话在浏览预测总表时过期 / 在别处退出：接口返回预告（`reason: 'session'`）而不是报错，前端清掉本地会话、显示登录按钮 → Task 7 测试 `失效会话按未登录处理并标出 reason` + Task 10 步骤。
- 账号已有档案，本机当前档案也有自己的排行榜身份：不合并，本机匿名档案原样保留，另起/切到账号档案 → Task 3 测试 `账号已有档案时不并入` + Task 9 测试 `attachAccount：账号档案与本机档案不同时新建本地档案`。

---

## 开工前要用户确认的事（不阻塞写代码，阻塞上线）

1. **模板 1417875 的第二个参数是什么。** dc_classroom 传 `[code, '1']`，但它把验证码缓存 300 秒（`RegisterController.groovy` `cacheService.cache(..., 300)`）。若模板正文是「验证码 {1}，{2} 分钟内有效」，那 dc_classroom 的短信一直在说「1 分钟内有效」，与实际 5 分钟不符。本计划把第二个参数做成 `TENCENT_SMS_PARAM2`，**默认 `"5"`（假定是分钟数，与我们 5 分钟一致）**。请在腾讯云短信控制台 → 国内短信 → 正文模板 → 1417875 看正文：是分钟数就保持 `"5"`；是别的含义（如产品名）就按含义设置；若模板只有一个变量则改成只传一个（`TENCENT_SMS_PARAM2=""` 表示不传）。
2. **腾讯云密钥是否已轮换**（旧密钥曾提交到 Gitee）。上线前在 访问管理 → API 密钥管理 确认在用密钥的创建时间晚于泄漏、旧密钥已禁用/删除。
3. **预告露出哪些数字**（Task 4 的建议，用户可改）：预测总表露出总结第一句（含本季已结束场数与准确率区间）、已结束场数、剩余场数；模拟投注露出历史回测注数与赛季、账本已记录场数；影子模式只露出「有/没有」。注意总结第一句本身含准确率——这是 spec「页面顶部的一句话总结」允许的，但若希望更保守，改成只露出场数即可（改 `teaserBoard` 一处）。
4. **协议文本**（Task 11 起草的中英文《用户协议》《隐私政策》）需用户审定；公司主体、联系方式、数据保存期限由用户填写确认。

## 图形验证：决定

首版就做，**自写 SVG 字符验证码，不用第三方**，按需出现：

- 何时要：该 IP 最近 1 小时已成功请求过 ≥ 2 次验证码（即第 3 次起）；或该 IP 最近 1 小时触发过任何发送限频；或全站当日已发 ≥ 上限的 50%（250 条，压力模式下所有人都要）。
- 形式：4 位字符（字母表 `ABCDEFGHJKMNPQRSTUVWXYZ23456789`，去掉易混的 0/O/1/I/L），服务端画成带干扰线与随机偏移的 SVG，以 `data:image/svg+xml;base64,…` 交给 `<img>`；内存保存答案哈希，**2 分钟**有效、一次性、不分大小写。
- 理由：零依赖、零费用、不必再开通云服务；挡的是低成本脚本刷量，配合按号码 / IP / 全站三层上限已够首版。它挡不住 OCR，若日后真被刷（`/api/health` 报警、`sms_sends` 里出现大量不同号码），把 `createCaptchaStore` 换成腾讯云天御验证码（同一个腾讯云账号）实现同一接口即可，路由不用改。

---

## File Structure

服务端（`server/`，保持现有平铺结构）：

| 文件 | 职责 |
| --- | --- |
| `server/phone.mjs`（新） | 区号表、号码规范化成 E.164、脱敏显示 |
| `server/db.mjs`（改） | 新增导出 `ACCOUNT_SCHEMA`（users / sessions / login_codes / sms_sends）；`initDb` 加法执行它；新增 `playerById` |
| `server/loginCodes.mjs`（新） | 生成 / 校验验证码，号码·IP·全站三层限频，短信发送日志与当日统计 |
| `server/accounts.mjs`（新） | 账号查找或新建、会话签发 / 校验 / 吊销、绑定玩家档案、偏好、对外显示的账号字段、协议版本 |
| `server/entitlements.mjs`（新） | 等级 → 功能表、`can()`、`gate()`、三个接口的预告裁剪 |
| `server/sms.mjs`（新） | `SmsSender` 接口说明、console / disabled 发送器、按环境变量组装、按号码选发送器 |
| `server/smsTencent.mjs`（新） | TC3-HMAC-SHA256 签名与腾讯云 SendSms 发送器 |
| `server/smsTwilio.mjs`（新） | Twilio Verify 发送器（默认关闭） |
| `server/captcha.mjs`（新） | SVG 图形验证的签发 / 校验，与「是否需要」的判断 |
| `server/authRoutes.mjs`（新） | `/api/auth/*` 路由工厂与 `userFromRequest` |
| `server/index.mjs`（改） | `trust proxy`、身份解析、挂路由、三个接口加锁、`/api/meta` 与 `/api/health` 字段 |

前端（`web/src/`）：

| 文件 | 职责 |
| --- | --- |
| `web/src/lib/session.js`（新） | 本地会话读写（`dc-nba:session.v1`）、鉴权头 |
| `web/src/lib/api.js`（改） | 认证接口；三个被锁接口带会话头；错误对象保留 `code/params/status` |
| `web/src/lib/profiles.js`（改） | `attachAccount` / `detachAccount`：账号与本地档案的对应 |
| `web/src/App.jsx`（改） | 会话进上下文、侧栏登录区与锁标、新路由 `login` / `terms` / `privacy` |
| `web/src/pages/Login.jsx`（新） | 登录 / 注册页 |
| `web/src/pages/Legal.jsx`（新）+ `web/src/legal/zh.js`、`web/src/legal/en.js`（新） | 协议与隐私政策页及中英文草稿 |
| `web/src/components/LockedTeaser.jsx`（新）、`web/src/components/common.jsx`（改，加 `LockIcon`） | 预告与锁标 |
| `web/src/pages/Board.jsx`（改） | 三处被锁数据的预告渲染、`bet` 标签锁标 |
| `web/src/styles.css`（改） | 模糊遮挡与锁标样式 |
| `<zh 语言文件>` / `<en 语言文件>`（改） | 本计划全部键 |

测试（`tests/`）：`phone`、`loginCodes`、`accounts`、`entitlements`、`smsTencent`、`smsTwilio`、`captcha`、`authRoutes`、`profilesAccount`，各一个 `*.test.mjs`。

部署与文档：`docker-compose.yml`（仓库版：`ENABLE_ACCOUNTS: "0"` 与注释）、`.dockerignore`（加 `.env`）、`deploy/README.md`（新节「用户系统」）、`README.md`（改「为什么没有账号密码」一节）。

---

### Task 1: 号码规范化与脱敏

**Files:**
- Create: `server/phone.mjs`
- Test: `tests/phone.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `COUNTRIES: Array<{ cc: string, iso: string }>`，顺序固定：`86 CN, 1 US, 852 HK, 853 MO, 886 TW, 65 SG, 44 GB, 81 JP, 82 KR, 61 AU`（显示名走 i18n 键 `country.<iso>`）
  - `normalizePhone(cc: string, input: string) → { ok: true, e164: string } | { ok: false, code: 'auth.phoneInvalid' }`
  - `isMainland(e164: string) → boolean`
  - `maskPhone(e164: string) → string`
  - `countriesFor(overseasOn: boolean) → Array<{cc, iso}>`（关闭时只有 `86`）

- [ ] **Step 1: 写失败测试**

```js
import { normalizePhone, maskPhone, isMainland, countriesFor, COUNTRIES } from '../server/phone.mjs';

test('normalizePhone：各种写法归一', () => {
  for (const s of ['13800138000', '138 0013 8000', '138-0013-8000', '+86 138 0013 8000', '0086 13800138000', '8613800138000', '(138)00138000']) {
    assert.deepEqual(normalizePhone('86', s), { ok: true, e164: '+8613800138000' }, s);
  }
  assert.deepEqual(normalizePhone('1', '(202) 555-0147'), { ok: true, e164: '+12025550147' });
  assert.deepEqual(normalizePhone('44', '07700 900123'), { ok: true, e164: '+447700900123' }); // 去掉国内长途前缀 0
});

test('normalizePhone：非法号码', () => {
  for (const [cc, s] of [['86', '12800138000'], ['86', '1380013800'], ['86', '138001380001'], ['86', 'abc'], ['86', ''],
    ['1', '1025550147'], ['86', '+1 2025550147'], ['999', '12345678'], ['44', '1234567890123456']]) {
    assert.deepEqual(normalizePhone(cc, s), { ok: false, code: 'auth.phoneInvalid' }, `${cc} ${s}`);
  }
});

test('maskPhone：大陆号 138****8000，其他号保留区号与末四位', () => {
  assert.equal(maskPhone('+8613800138000'), '138****8000');
  assert.equal(maskPhone('+12025550147'), '+1 ****0147');
  assert.equal(maskPhone('+447700900123'), '+44 ****0123');
});

test('isMainland 与 countriesFor', () => {
  assert.equal(isMainland('+8613800138000'), true);
  assert.equal(isMainland('+85291234567'), false);
  assert.deepEqual(countriesFor(false), [{ cc: '86', iso: 'CN' }]);
  assert.equal(countriesFor(true).length, COUNTRIES.length);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/phone.test.mjs`
Expected: FAIL，`Cannot find module '../server/phone.mjs'`

- [ ] **Step 3: 实现 `server/phone.mjs`**

规则：去掉空格、`-`、`(`、`)`、`.`；`+` 或 `00` 开头视为带国际区号，必须与所选 `cc` 一致后剥掉，不一致即非法；无 `+` 但以所选 `cc` 开头且剥掉后长度合规（仅 +86：13 位以 `86` 开头）也剥掉。+86：`/^1[3-9]\d{9}$/`；+1（北美编号计划）：`/^[2-9]\d{2}[2-9]\d{6}$/`；其余：剥掉一个前导 `0`，全数字，`cc` 在 `COUNTRIES` 里，E.164 总位数 8–15。`maskPhone` 用 `COUNTRIES` 最长前缀匹配取区号。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/phone.test.mjs`
Expected: `# pass 4`、`# fail 0`

- [ ] **Step 5: 提交**

```bash
git add server/phone.mjs tests/phone.test.mjs
git commit -m "用户系统：手机号规范化为 E.164 与脱敏显示（大陆 / 北美 / 常见海外区号）"
```

---

### Task 2: 账号库表 + 验证码与三层限频

**Files:**
- Modify: `server/db.mjs`（`LIVE_SCHEMA` 之后加 `ACCOUNT_SCHEMA`；`initDb` 里 `db.exec(LIVE_SCHEMA)` 之后加 `db.exec(ACCOUNT_SCHEMA)`；加 `playerById`）
- Create: `server/loginCodes.mjs`
- Test: `tests/loginCodes.test.mjs`

**Interfaces:**
- Consumes: Task 1 `maskPhone`（日志用）
- Produces:
  - `db.ACCOUNT_SCHEMA: string`，表：
    - `users(id TEXT PK, phone_e164 TEXT NOT NULL UNIQUE, player_id TEXT UNIQUE, tier TEXT NOT NULL DEFAULT 'free', tier_expires_at TEXT, locale TEXT, time_zone TEXT, consent_version TEXT NOT NULL, consent_at TEXT NOT NULL, created_at TEXT NOT NULL, last_login_at TEXT NOT NULL)`
    - `sessions(token_hash TEXT PK, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, last_seen TEXT)` + `idx_sessions_user`
    - `login_codes(e164 TEXT PK, provider TEXT NOT NULL, code_hash TEXT, salt TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)`
    - `sms_sends(id INTEGER PRIMARY KEY AUTOINCREMENT, e164 TEXT NOT NULL, ip TEXT, at TEXT NOT NULL, provider TEXT NOT NULL, ok INTEGER NOT NULL, provider_id TEXT, error TEXT)` + 索引 `(at)`、`(e164, at)`、`(ip, at)`；触发器 `sms_sends_no_delete` / `sms_sends_no_update`（`RAISE(ABORT, 'sms_sends 只追加…')`，与现有只追加表同一写法）
  - `db.playerById(id: string) → { id, name } | null`
  - `loginCodes.mjs`：
    - 常量 `CODE_TTL_MS = 300_000`、`MAX_ATTEMPTS = 5`、`RESEND_MS = 60_000`、`PHONE_DAILY = 10`、`DEFAULT_LIMITS = { ipHourly: 5, ipDaily: 20, siteDaily: 500 }`
    - `limitsFromEnv(env) → { ipHourly, ipDaily, siteDaily }`（读 `SMS_IP_HOURLY` / `SMS_IP_DAILY` / `SMS_DAILY_CAP`，非正整数回退默认）
    - `newCode() → string`（6 位，`String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')`）
    - `bjDayStart(now: number) → string`（北京自然日 00:00 的 UTC ISO）
    - `checkSendAllowed(h, { e164, ip, now, limits }) → { ok: true, ipSendsLastHour: number, siteToday: number } | { ok: false, status: 429 | 503, code: 'auth.cooldown' | 'auth.phoneDailyLimit' | 'auth.ipLimit' | 'auth.smsDailyCap', params?: { sec } }`
    - `requestCode(h, { e164, ip, now, limits, sender }) → Promise<{ ok: true, resendAfterSec: 60, ttlSec: 300 } | { ok: false, status, code, params? }>`
    - `verifyCode(h, { e164, code, now, sender }) → Promise<{ ok: true } | { ok: false, code: 'auth.codeInvalid' | 'auth.codeExpired' | 'auth.codeLocked', params?: { left } }>`
    - `smsStats(h, { now, limits }) → { sentToday, failedToday, cap, capReached, lastFailureAt }`
  - `sender` 形状见 Task 5 的 `SmsSender`：`{ id, ownsCode?, send(e164, code|null), check?(e164, code) }`

- [ ] **Step 1: 写失败测试**

测试用 `new DatabaseSync(':memory:')` + `h.exec(ACCOUNT_SCHEMA)`；假发送器 `fake({ fail, delayMs })` 记下每次 `send(e164, code)` 的参数，`fail` 时返回 `{ ok: false, error: 'boom' }`。`T0 = Date.parse('2026-10-29T02:00:00Z')`（北京 10:00）。

```js
test('newCode：6 位数字字符串，保留前导 0，0–9 都会出现', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) { const c = newCode(); assert.match(c, /^\d{6}$/); for (const ch of c) seen.add(ch); }
  assert.equal(seen.size, 10);
});

test('bjDayStart：按北京自然日', () => {
  assert.equal(bjDayStart(Date.parse('2026-10-29T15:59:00Z')), '2026-10-28T16:00:00.000Z');
  assert.equal(bjDayStart(Date.parse('2026-10-29T16:00:00Z')), '2026-10-29T16:00:00.000Z');
});

test('发送成功：库里只有哈希，5 分钟有效，60 秒内同号再发被拒', async () => {
  const s = fake(); const h = fresh();
  assert.deepEqual(await requestCode(h, { e164: P, ip: IP, now: T0, limits: DEFAULT_LIMITS, sender: s }), { ok: true, resendAfterSec: 60, ttlSec: 300 });
  const row = h.prepare('SELECT * FROM login_codes WHERE e164 = ?').get(P);
  assert.notEqual(row.code_hash, s.calls[0].code);
  assert.equal(JSON.stringify(row).includes(s.calls[0].code), false);
  assert.equal(Date.parse(row.expires_at) - T0, 300_000);
  const again = await requestCode(h, { e164: P, ip: IP, now: T0 + 59_000, limits: DEFAULT_LIMITS, sender: s });
  assert.deepEqual(again, { ok: false, status: 429, code: 'auth.cooldown', params: { sec: 1 } });
  assert.equal(s.calls.length, 1);
});

test('同一号码每天最多 10 次；北京次日清零', async () => { /* 10 次每次间隔 61s 成功，第 11 次 auth.phoneDailyLimit；now 推到北京次日 00:00:01 再发成功 */ });
test('同一 IP 每小时 5 次、每天 20 次（不同号码）', async () => { /* 第 6 个号码同小时 → auth.ipLimit 429；分散到多小时后第 21 次 → auth.ipLimit */ });
test('全站每日上限：达到 siteDaily 后停发、返回 503 auth.smsDailyCap，smsStats.capReached = true', async () => { /* limits.siteDaily = 3 */ });

test('发送失败不存码，如实返回失败，并记入 sms_sends', async () => {
  const h = fresh();
  const r = await requestCode(h, { e164: P, ip: IP, now: T0, limits: DEFAULT_LIMITS, sender: fake({ fail: true }) });
  assert.deepEqual(r, { ok: false, status: 502, code: 'auth.smsFailed' });
  assert.equal(h.prepare('SELECT COUNT(*) n FROM login_codes').get().n, 0);
  assert.deepEqual(h.prepare('SELECT ok, error FROM sms_sends').get(), { ok: 0, error: 'boom' });
});

test('同一号码并发请求只发一条', async () => {
  const s = fake({ delayMs: 30 }); const h = fresh();
  const [a, b] = await Promise.all([1, 2].map(() => requestCode(h, { e164: P, ip: IP, now: T0, limits: DEFAULT_LIMITS, sender: s })));
  assert.equal(s.calls.length, 1);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  assert.equal((a.ok ? b : a).code, 'auth.cooldown');
});

test('验证：正确即作废；错 5 次作废；过期', async () => {
  // 正确码 → { ok: true }，再用同码 → auth.codeExpired（行已删除，统一说「已失效，请重新获取」）
  // 错码第 1–4 次 → { ok:false, code:'auth.codeInvalid', params:{ left: 4..1 } }；第 5 次 → auth.codeLocked，之后正确码也 auth.codeExpired
  // now = T0 + 300_001 → auth.codeExpired
});

test('新发的码顶替旧码并清零错误次数', async () => { /* 错 3 次后 61s 再发，新码验证成功，旧码无效 */ });

test('sms_sends 只追加：不能删、不能改', () => {
  const h = fresh();
  h.prepare("INSERT INTO sms_sends (e164, ip, at, provider, ok) VALUES ('+8613800138000', '1.2.3.4', '2026-10-29T00:00:00.000Z', 'fake', 1)").run();
  assert.throws(() => h.exec('DELETE FROM sms_sends'), /只追加/);
  assert.throws(() => h.exec('UPDATE sms_sends SET ok = 0'), /只追加/);
});

test('ownsCode 的发送器（Twilio Verify）：不生成码，校验交给 sender.check，本地仍管 5 分钟与 5 次', async () => {
  // send 收到 code === null；login_codes.code_hash 为 NULL、provider = 'twilio'；check 返回 ok:false 5 次后 auth.codeLocked
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/loginCodes.test.mjs`
Expected: FAIL，`Cannot find module '../server/loginCodes.mjs'`

- [ ] **Step 3: 实现 `ACCOUNT_SCHEMA`、`playerById` 与 `server/loginCodes.mjs`**

- 哈希：`sha256(salt + ':' + e164 + ':' + code)`，`salt = crypto.randomBytes(16).toString('hex')`，比较用 `crypto.timingSafeEqual`。
- 限频全部按 `sms_sends` 计数（重启不丢），**每次调用发送器都记一行、都计入限额**（成功失败都算，失败也花了接口调用，且防止对失败路径狂刷）；号码冷却看该号最近一行的 `at`。
- 并发：模块内 `const inflight = new Set()`（按 e164），检查 + 发送期间占位；已占位直接返回 `auth.cooldown`（`sec: 60`）。
- 日志：失败与触顶 `console.warn('!! [sms] …')`，号码用 `maskPhone`，绝不打印验证码。全站触顶每个北京日只打一次。
- `smsStats.capReached = sentToday >= cap`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/loginCodes.test.mjs && npm test`
Expected: 新文件全过；全量 `# fail 0`（`initDb` 加表不影响既有测试）

- [ ] **Step 5: 提交**

```bash
git add server/db.mjs server/loginCodes.mjs tests/loginCodes.test.mjs
git commit -m "用户系统：账号库表（加法迁移）与验证码——6 位加密随机、5 分钟、只存哈希、错 5 次作废；号码 60 秒/日 10 次、IP 时 5/日 20、全站日 500"
```

---

### Task 3: 账号、会话与玩家档案绑定

**Files:**
- Create: `server/accounts.mjs`
- Test: `tests/accounts.test.mjs`

**Interfaces:**
- Consumes: Task 2 `ACCOUNT_SCHEMA`；Task 1 `maskPhone`
- Produces:
  - `CONSENT_VERSION = '2026-10-29'`、`SESSION_TTL_MS = 30 * 24 * 3600e3`
  - `findOrCreateUser(h, { e164, consentVersion, now }) → { user, created: boolean }`（已存在则更新 `last_login_at`、`consent_version`、`consent_at`）
  - `createSession(h, userId, now) → { token: string, expiresAt: string }`（令牌 `crypto.randomBytes(32).toString('base64url')`，库里只存 sha256）
  - `sessionUser(h, token, now) → user | null`（未吊销且 `expires_at > now`；`last_seen` 距上次 ≥ 10 分钟才写）
  - `revokeSession(h, token, now) → boolean`
  - `bindPlayer(h, { userId, anonPlayerId, profileName, players }) → { playerId: string | null, outcome: 'kept' | 'bound' | 'created' | 'none' }`，`players` = `{ create(name) → { id, name } } | null`
  - `setPrefs(h, userId, { locale, timeZone }) → boolean`（`locale` 只收 i18n 支持的语言，今天 `'zh' | 'en'`；`timeZone` 用 `new Intl.DateTimeFormat('en', { timeZone })` 校验，抛错即拒）
  - `publicUser(user) → { id, phone: string /* 脱敏 */, tier, tierExpiresAt, locale, timeZone }`

- [ ] **Step 1: 写失败测试**

```js
test('同一 E.164 只有一个账号；再次登录更新 last_login_at', () => {
  const h = fresh();
  const a = findOrCreateUser(h, { e164: P, consentVersion: CONSENT_VERSION, now: T0 });
  const b = findOrCreateUser(h, { e164: P, consentVersion: CONSENT_VERSION, now: T0 + 1000 });
  assert.equal(a.created, true); assert.equal(b.created, false);
  assert.equal(a.user.id, b.user.id);
  assert.equal(a.user.tier, 'free');
  assert.equal(h.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
});

test('会话：库里只存哈希，30 天到期，吊销即失效', () => {
  const { user } = findOrCreateUser(h, …);
  const s = createSession(h, user.id, T0);
  assert.equal(Date.parse(s.expiresAt) - T0, 30 * 24 * 3600e3);
  assert.equal(h.prepare('SELECT COUNT(*) n FROM sessions WHERE token_hash = ?').get(s.token).n, 0);
  assert.equal(sessionUser(h, s.token, T0 + 1000).id, user.id);
  assert.equal(sessionUser(h, s.token, T0 + 30 * 24 * 3600e3), null);
  assert.equal(revokeSession(h, s.token, T0 + 2000), true);
  assert.equal(sessionUser(h, s.token, T0 + 3000), null);
  assert.equal(sessionUser(h, 'garbage', T0), null);
});

test('绑定：账号没有档案时绑定浏览器当前匿名档案', () => {
  assert.deepEqual(bindPlayer(h, { userId: u.id, anonPlayerId: 'pA', profileName: '玩家 1', players }), { playerId: 'pA', outcome: 'bound' });
});
test('账号已有档案时不并入', () => {
  // 先绑 pA，再以 anonPlayerId: 'pB' 登录 → { playerId: 'pA', outcome: 'kept' }；players.create 没被调用
});
test('匿名档案已属于别的账号时不抢，改为新建', () => { /* 用户 2 带 'pA' → outcome 'created'，新 id ≠ 'pA' */ });
test('当前档案没有排行榜身份：按档案名新建并绑定；排行榜关闭（players = null）时 outcome none', () => {});
test('setPrefs：只收 zh/en 与合法 IANA 时区', () => {
  assert.equal(setPrefs(h, u.id, { locale: 'en', timeZone: 'America/New_York' }), true);
  assert.equal(setPrefs(h, u.id, { locale: 'fr' }), false);
  assert.equal(setPrefs(h, u.id, { timeZone: 'Mars/Base' }), false);
});
test('publicUser 不含完整手机号', () => {
  const p = publicUser(u);
  assert.equal(p.phone, '138****8000');
  assert.equal(JSON.stringify(p).includes('13800138000'), false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/accounts.test.mjs`
Expected: FAIL，`Cannot find module '../server/accounts.mjs'`

- [ ] **Step 3: 实现 `server/accounts.mjs`**

`bindPlayer` 判定顺序：账号已有 `player_id` → `kept`；`anonPlayerId` 存在且没被别的账号占用 → `bound`；`players` 可用 → `create(profileName || '玩家')` 后绑定 → `created`；否则 `none`。占用检查依赖 `users.player_id UNIQUE`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/accounts.test.mjs`
Expected: 全部通过，`# fail 0`

- [ ] **Step 5: 提交**

```bash
git add server/accounts.mjs tests/accounts.test.mjs
git commit -m "用户系统：账号（E.164 唯一、预留等级）、30 天 Bearer 会话（只存哈希、退出即失效）、绑定玩家档案（已有以账号为准）"
```

---

### Task 4: 权限判断与预告裁剪

**Files:**
- Create: `server/entitlements.mjs`
- Test: `tests/entitlements.test.mjs`

**Interfaces:**
- Consumes: 用户行（Task 3 的 `user` 形状：`tier`、`tier_expires_at`）
- Produces:
  - `FEATURES = ['board.stats', 'board.paper']`（`board.stats` 管 `/api/predictions/summary` 与 `/api/shadow`；`board.paper` 管 `/api/paper`）
  - `TIER_FEATURES = { free: ['board.stats', 'board.paper'] }`
  - `effectiveTier(user, now) → string`（非 `free` 且已过期 → `free`；未知等级 → `free`）
  - `can(user, feature, now = Date.now()) → boolean`（`user` 为 null → false）
  - `gate(feature, { accountsOn: boolean, user, state: 'none' | 'valid' | 'invalid', now }) → { allowed: boolean, reason: null | 'anonymous' | 'session' | 'tier' }`
  - `teaserBoard(full) → { locked: true, seasonYear, summary: [full.summary[0]], teaser: { completed: full.overall.n, remaining: full.upcomingDist.n } }`
  - `teaserPaper(full) → { locked: true, teaser: { backtestBets, seasons, ledgerCaptured } }`
  - `teaserShadow(full) → { available: boolean, locked: true }`
  - 路由层把 `reason` 合进预告：`{ ...teaserX(full), reason }`

- [ ] **Step 1: 写失败测试**

```js
test('今天所有登录用户（free）都能看预测总表与模拟投注；未登录不能', () => {
  assert.equal(can({ tier: 'free' }, 'board.stats'), true);
  assert.equal(can({ tier: 'free' }, 'board.paper'), true);
  assert.equal(can(null, 'board.stats'), false);
  assert.equal(can({ tier: 'free' }, 'nope'), false);
});
test('等级到期回落 free；未知等级按 free', () => {
  assert.equal(effectiveTier({ tier: 'pro', tier_expires_at: '2026-10-01T00:00:00Z' }, Date.parse('2026-10-29T00:00:00Z')), 'free');
  assert.equal(effectiveTier({ tier: 'weird' }, 0), 'free');
});
test('gate：账号功能关闭时一律放行（现状不变）；失效会话 reason = session', () => {
  assert.deepEqual(gate('board.stats', { accountsOn: false, user: null, state: 'none', now: 0 }), { allowed: true, reason: null });
  assert.deepEqual(gate('board.stats', { accountsOn: true, user: null, state: 'none', now: 0 }), { allowed: false, reason: 'anonymous' });
  assert.deepEqual(gate('board.stats', { accountsOn: true, user: null, state: 'invalid', now: 0 }), { allowed: false, reason: 'session' });
  assert.deepEqual(gate('board.paper', { accountsOn: true, user: { tier: 'free' }, state: 'valid', now: 0 }), { allowed: true, reason: null });
});
test('teaserBoard 只留预告字段', () => {
  const full = buildBoard(GAMES, { teamName: String });   // 复用 predictionBoard.test 的造数方式
  const t = teaserBoard({ seasonYear: 2026, ...full });
  assert.deepEqual(Object.keys(t).sort(), ['locked', 'seasonYear', 'summary', 'teaser']);
  assert.deepEqual(t.summary, [full.summary[0]]);
  assert.deepEqual(t.teaser, { completed: full.overall.n, remaining: full.upcomingDist.n });
  for (const k of ['overall', 'completed', 'upcoming', 'byTeam', 'misses', 'market', 'baselines']) assert.equal(k in t, false, k);
});
test('teaserPaper 不含 ROI、盈亏、注单、结论', () => {
  const t = teaserPaper({ backtest: { headline: { bets: 812, seasons: ['2023-24', '2024-25'], roi: -0.03, verdict: 'x', curve: [] }, table: [] },
    ledger: { available: true, captured: 12, rules: [{ units: 1 }], open: [{}] } });
  assert.deepEqual(t, { locked: true, teaser: { backtestBets: 812, seasons: ['2023-24', '2024-25'], ledgerCaptured: 12 } });
  assert.deepEqual(teaserPaper({ backtest: null, ledger: { available: false } }), { locked: true, teaser: { backtestBets: null, seasons: [], ledgerCaptured: null } });
});
test('teaserShadow 只说有没有', () => {
  assert.deepEqual(teaserShadow({ available: true, variants: [{}], progress: 3 }), { available: true, locked: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/entitlements.test.mjs`
Expected: FAIL，`Cannot find module '../server/entitlements.mjs'`

- [ ] **Step 3: 实现 `server/entitlements.mjs`**

`summary[0]` 原样转发（i18n 之后它可能是字符串或 `{ code, params }`，这里不关心形状）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/entitlements.test.mjs`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add server/entitlements.mjs tests/entitlements.test.mjs
git commit -m "用户系统：统一权限入口 can(user, feature)（按等级配置，今天 free 全开）与三个被锁接口的预告裁剪"
```

---

### Task 5: 短信发送器（腾讯云 TC3 签名 / Twilio Verify / console / disabled）

**Files:**
- Create: `server/sms.mjs`、`server/smsTencent.mjs`、`server/smsTwilio.mjs`
- Test: `tests/smsTencent.test.mjs`、`tests/smsTwilio.test.mjs`

**Interfaces:**
- Consumes: Task 1 `isMainland`、`maskPhone`；Task 2 `CODE_TTL_MS`
- Produces:
  - `SmsSender`（JSDoc typedef 写在 `server/sms.mjs`）：`{ id: string, ownsCode?: boolean, send(e164: string, code: string | null) → Promise<{ ok: true, providerId: string } | { ok: false, error: string }>, check?(e164: string, code: string) → Promise<{ ok: boolean, error?: string }> }`
    > 与 spec 给的 `send(e164, code)` 一致；Twilio Verify 由 Twilio 自己生成验证码，所以它 `ownsCode: true`、`send` 收到 `null`，验证走 `check`。这是对接口的唯一扩展。
  - `smsTencent.mjs`：
    - `tc3Sign({ secretId, secretKey, service, host, action, version, region, timestamp: number /* 秒 */, payload: string }) → Record<string, string>`（返回完整请求头：`Authorization`、`Content-Type: application/json; charset=utf-8`、`Host`、`X-TC-Action`、`X-TC-Timestamp`、`X-TC-Version`、`X-TC-Region`）
    - `createTencentSender({ secretId, secretKey, sdkAppId = '1400683809', signName = '上海磊宁科技有限公司', templateId = '1417875', region = 'ap-guangzhou', param2 = '5', fetchImpl = fetch, nowSec = () => Math.floor(Date.now() / 1000), timeoutMs = 8000 }) → SmsSender`（`id: 'tencent'`；POST `https://sms.tencentcloudapi.com/`，Action `SendSms`，Version `2021-01-11`；body `{ PhoneNumberSet: [e164], SmsSdkAppId, SignName, TemplateId, TemplateParamSet: param2 === '' ? [code] : [code, param2] }`）
  - `smsTwilio.mjs`：`createTwilioVerifySender({ accountSid, authToken, serviceSid, fetchImpl = fetch, timeoutMs = 8000 }) → SmsSender`（`id: 'twilio'`、`ownsCode: true`；`send` POST `https://verify.twilio.com/v2/Services/{serviceSid}/Verifications`，表单 `To`、`Channel=sms`，Basic 认证；`check` POST `…/VerificationCheck`，表单 `To`、`Code`）
  - `sms.mjs`：
    - `consoleSender(log = console) → SmsSender`（`id: 'console'`，打印 `[sms:console] 138****8000 验证码 123456`）
    - `disabledSender(reason: string) → SmsSender`（`send` 恒返回 `{ ok: false, error: reason }`）
    - `createSenders(env = process.env, { fetchImpl = fetch, log = console } = {}) → { mainland: SmsSender, overseas: SmsSender | null, overseasOn: boolean, describe: { mainland: string, overseas: string } }`
    - `pickSender(senders, e164) → { sender: SmsSender } | { code: 'auth.overseasClosed' }`
  - 读取的环境变量：`TENCENT_SMS_SECRET_ID`、`TENCENT_SMS_SECRET_KEY`、`TENCENT_SMS_SDK_APP_ID`、`TENCENT_SMS_SIGN_NAME`、`TENCENT_SMS_TEMPLATE_ID`、`TENCENT_SMS_REGION`、`TENCENT_SMS_PARAM2`、`SMS_PROVIDER`、`ENABLE_OVERSEAS_SMS`、`TWILIO_ACCOUNT_SID`、`TWILIO_AUTH_TOKEN`、`TWILIO_VERIFY_SERVICE_SID`、`NODE_ENV`。（dc_classroom 的 `TENCENT_SMS_APP_KEY` 是旧版 SDK 用的，API 3.0 不需要，不读。）

- [ ] **Step 1: 写失败测试（`tests/smsTencent.test.mjs`）**

```js
test('tc3Sign：与腾讯云官方签名示例一致', () => {
  // 取腾讯云 API 3.0「签名方法 v3」文档（https://cloud.tencent.com/document/api/382/52072 或通用的 cvm 示例）里的示例：
  // SecretId / SecretKey / Timestamp / payload / 期望 Authorization 逐字抄进来，不要自己算期望值
  const headers = tc3Sign(DOC_EXAMPLE.input);
  assert.equal(headers.Authorization, DOC_EXAMPLE.authorization);
});

test('发送：请求体与模板参数', async () => {
  const calls = [];
  const s = createTencentSender({ secretId: 'id', secretKey: 'key', nowSec: () => 1761700000,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return okResp({ Response: { SendStatusSet: [{ Code: 'Ok', SerialNo: 'sn1' }], RequestId: 'r1' } }); } });
  assert.deepEqual(await s.send('+8613800138000', '012345'), { ok: true, providerId: 'sn1' });
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { PhoneNumberSet: ['+8613800138000'], SmsSdkAppId: '1400683809', SignName: '上海磊宁科技有限公司', TemplateId: '1417875', TemplateParamSet: ['012345', '5'] });
  assert.equal(calls[0].url, 'https://sms.tencentcloudapi.com/');
  assert.equal(calls[0].init.headers['X-TC-Action'], 'SendSms');
  assert.equal(calls[0].init.headers['X-TC-Version'], '2021-01-11');
  assert.equal(calls[0].init.headers['X-TC-Region'], 'ap-guangzhou');
});

test('HTTP 200 但 Code 非 Ok 算失败', async () => {
  const s = sender(okResp({ Response: { SendStatusSet: [{ Code: 'LimitExceeded.PhoneNumberDailyLimit', Message: '…' }], RequestId: 'r' } }));
  const r = await s.send('+8613800138000', '123456');
  assert.equal(r.ok, false); assert.match(r.error, /LimitExceeded\.PhoneNumberDailyLimit/);
});
test('Response.Error（如签名错误）算失败', async () => { /* { Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message } } } → ok:false */ });
test('网络错误 / 超时算失败，不抛', async () => { /* fetchImpl 抛 AbortError → { ok:false, error: /timeout|abort/i } */ });
test('param2 为空字符串时只传验证码', async () => { /* TemplateParamSet: ['123456'] */ });
test('错误信息里不带密钥', async () => { /* 失败时 r.error 不包含 secretKey 字符串 */ });
```

`tests/smsTwilio.test.mjs`：

```js
test('Twilio Verify：send 不带我们的码，status=pending 算成功', async () => {
  // fetchImpl 收到 url 以 /v2/Services/VAxxx/Verifications 结尾，body 'To=%2B12025550147&Channel=sms'，Authorization 'Basic ' + base64('ACxx:tok')
  // 回 201 { sid: 'VE1', status: 'pending' } → { ok: true, providerId: 'VE1' }；s.ownsCode === true
});
test('check：approved 才算通过', async () => { /* status 'approved' → ok true；'pending' → ok false；404 → ok false */ });
test('createSenders：海外默认关闭，+86 以外 pickSender 返回 auth.overseasClosed', () => {
  const s = createSenders({ NODE_ENV: 'production' });
  assert.equal(s.overseasOn, false); assert.equal(s.overseas, null);
  assert.deepEqual(pickSender(s, '+12025550147'), { code: 'auth.overseasClosed' });
  assert.equal(pickSender(s, '+8613800138000').sender.id, 'disabled');  // 没配密钥：如实失败而不是假装发了
});
test('createSenders：console 发送器只在非 production', () => {
  assert.equal(createSenders({ SMS_PROVIDER: 'console', NODE_ENV: 'development' }).mainland.id, 'console');
  assert.equal(createSenders({ SMS_PROVIDER: 'console', NODE_ENV: 'production' }).mainland.id, 'disabled');
  assert.equal(createSenders({ TENCENT_SMS_SECRET_ID: 'a', TENCENT_SMS_SECRET_KEY: 'b' }).mainland.id, 'tencent');
});
test('createSenders：ENABLE_OVERSEAS_SMS=1 但缺 Twilio 变量时仍视为关闭', () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/smsTencent.test.mjs tests/smsTwilio.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现三个文件**

`tc3Sign` 按官方步骤：CanonicalRequest（`POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:<host>\nx-tc-action:<action 小写>\n\ncontent-type;host;x-tc-action\n<sha256(payload)>`）→ StringToSign（`TC3-HMAC-SHA256\n<timestamp>\n<UTC 日期>/<service>/tc3_request\n<sha256(CanonicalRequest)>`）→ 派生 `kDate = HMAC('TC3' + secretKey, date)`、`kService`、`kSigning = HMAC(kService, 'tc3_request')` → `Authorization: TC3-HMAC-SHA256 Credential=<secretId>/<date>/<service>/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=<hex>`。超时用 `AbortSignal.timeout(timeoutMs)`。成功判定：无 `Response.Error` 且 `SendStatusSet[0].Code === 'Ok'`；`providerId = SerialNo ?? RequestId`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/smsTencent.test.mjs tests/smsTwilio.test.mjs`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add server/sms.mjs server/smsTencent.mjs server/smsTwilio.mjs tests/smsTencent.test.mjs tests/smsTwilio.test.mjs
git commit -m "用户系统：短信发送器——腾讯云 SendSms（node:crypto 自签 TC3，按 SendStatusSet 判成败）、Twilio Verify（默认关闭）、开发用 console"
```

---

### Task 6: 图形验证

**Files:**
- Create: `server/captcha.mjs`
- Test: `tests/captcha.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `CAPTCHA_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'`
  - `createCaptchaStore({ ttlMs = 120_000, max = 5000 } = {}) → { issue(now: number) → { id: string, image: string /* data:image/svg+xml;base64,… */, answer?: never }, verify(id: string, answer: string, now: number) → boolean, size() → number }`；测试钩子：`issue(now, { text })` 允许指定文字（仅测试用参数，生产不传）
  - `needsCaptcha({ ipSendsLastHour: number, ipLimitedAt: number | null, siteToday: number, cap: number, now: number }) → boolean`

- [ ] **Step 1: 写失败测试**

```js
test('verify：一次性、不分大小写、2 分钟过期', () => {
  const s = createCaptchaStore();
  const a = s.issue(0, { text: 'K7PQ' });
  assert.match(a.image, /^data:image\/svg\+xml;base64,/);
  assert.equal(Buffer.from(a.image.split(',')[1], 'base64').toString().includes('K7PQ'), false); // 不以明文出现在 SVG 里（逐字符 <path>/分散 <text>，不可整串搜到）
  assert.equal(s.verify(a.id, 'k7pq', 1000), true);
  assert.equal(s.verify(a.id, 'K7PQ', 1000), false);
  const b = s.issue(0, { text: 'ABCD' });
  assert.equal(s.verify(b.id, 'ABCD', 120_001), false);
  const c = s.issue(0, { text: 'ABCD' });
  assert.equal(s.verify(c.id, 'ABCE', 1), false);
  assert.equal(s.verify(c.id, 'ABCD', 2), false);   // 答错一次即作废
});
test('容量上限：超过 max 先丢最旧的', () => {});
test('needsCaptcha：第 3 次起、触发过限频、全站过半时需要', () => {
  const base = { ipSendsLastHour: 0, ipLimitedAt: null, siteToday: 0, cap: 500, now: 10_000_000 };
  assert.equal(needsCaptcha(base), false);
  assert.equal(needsCaptcha({ ...base, ipSendsLastHour: 2 }), true);
  assert.equal(needsCaptcha({ ...base, ipLimitedAt: base.now - 3_599_000 }), true);
  assert.equal(needsCaptcha({ ...base, ipLimitedAt: base.now - 3_601_000 }), false);
  assert.equal(needsCaptcha({ ...base, siteToday: 250 }), true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/captcha.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `server/captcha.mjs`**

字符用 `crypto.randomInt` 选；SVG 每个字符独立 `<text>`，随机旋转 ±25°、随机字号与纵向偏移，加 4–6 条随机贝塞尔干扰线；内存 `Map<id, { hash, exp }>`，答案存 sha256(大写)。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/captcha.test.mjs`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add server/captcha.mjs tests/captcha.test.mjs
git commit -m "用户系统：自写 SVG 图形验证（零依赖），同一 IP 第 3 次起、触发限频后一小时内、全站过半时出现"
```

---

### Task 7: `/api/auth` 路由与请求身份

**Files:**
- Create: `server/authRoutes.mjs`
- Test: `tests/authRoutes.test.mjs`

**Interfaces:**
- Consumes: Task 1 `normalizePhone`、`countriesFor`；Task 2 `checkSendAllowed`、`requestCode`、`verifyCode`；Task 3 全部；Task 5 `pickSender`；Task 6 `createCaptchaStore`、`needsCaptcha`
- Produces:
  - `createAuthRouter({ h, senders, captcha, limits, clock = Date.now, rateLimit = (opts) => (req, res, next) => next(), players = null }) → express.Router`，`players` = `{ authenticate(token) → { id, name } | null, create(name) → { id, name }, byId(id) → { id, name } | null } | null`
  - `userFromRequest(h, req, now) → { user: object | null, state: 'none' | 'valid' | 'invalid' }`（读 `Authorization: Bearer`；`h` 为 null → `{ user: null, state: 'none' }`）
  - 路由（挂在 `/api/auth`，错误一律 `{ code, params? }` + 对应 HTTP 状态）：
    - `POST /captcha` → `{ id, image }`
    - `POST /code` body `{ cc, phone, consent: true, captchaId?, captchaAnswer? }` → `200 { ok: true, resendAfterSec: 60, ttlSec: 300 }`；`400 auth.phoneInvalid | auth.consentRequired | auth.overseasClosed`；`428 auth.captchaRequired`（带 `{ captcha: { id, image } }`，省一次往返）；`400 auth.captchaWrong`（同样附新图）；`429/503/502` 透传 Task 2 的码；`rateLimit({ max: 20, windowMs: 600_000 })`
    - `POST /verify` body `{ cc, phone, code, consent: true, consentVersion, anonToken?, profileName? }` → `200 { token, expiresAt, user: publicUser, player: { id, name } | null, outcome }`；失败透传 Task 2 的码；`consentVersion !== CONSENT_VERSION` → `400 auth.consentRequired`；`rateLimit({ max: 30, windowMs: 600_000 })`
    - `GET /me`（会话）→ `{ user: publicUser, player }`；无效 → `401 auth.sessionInvalid`
    - `POST /logout`（会话）→ `{ ok: true }`（令牌无效也回 `ok: true`，幂等）
    - `POST /prefs`（会话）body `{ locale?, timeZone? }` → `{ ok }`；非法 → `400 auth.prefsInvalid`
  - `h` 为 null（库打不开）时所有路由 `503 auth.unavailable`。

- [ ] **Step 1: 写失败测试**

测试起一个真 Express：`const app = express(); app.use(express.json()); app.use('/api/auth', createAuthRouter(deps)); const srv = app.listen(0)`，用 `fetch` 打；`deps.h` 为 `:memory:` 库，`senders` 用 Task 5 的 `{ mainland: fakeSender, overseas: null, overseasOn: false }`，`clock` 可调。另挂一个演示被锁接口，验证 `userFromRequest` + `gate` + 预告的组合与 index.mjs 的接法一致：

```js
app.get('/locked', (req, res) => {
  const { user, state } = userFromRequest(deps.h, req, clock());
  const g = gate('board.paper', { accountsOn: true, user, state, now: clock() });
  res.json(g.allowed ? FULL_PAPER : { ...teaserPaper(FULL_PAPER), reason: g.reason });
});
```

```js
test('完整流程：发码 → 验证 → 新号自动建号 → 会话可看被锁内容 → 退出后回到预告', async () => {
  assert.deepEqual((await post('/api/auth/code', { cc: '86', phone: '138 0013 8000', consent: true })).body, { ok: true, resendAfterSec: 60, ttlSec: 300 });
  const code = fakeSender.calls[0].code;
  const v = await post('/api/auth/verify', { cc: '86', phone: '13800138000', code, consent: true, consentVersion: CONSENT_VERSION });
  assert.equal(v.status, 200);
  assert.equal(v.body.user.phone, '138****8000');
  assert.equal(v.body.user.tier, 'free');
  assert.equal((await get('/locked', v.body.token)).body.ledger.captured, 12);
  await post('/api/auth/logout', {}, v.body.token);
  assert.deepEqual((await get('/locked', v.body.token)).body, { locked: true, reason: 'session', teaser: { backtestBets: 812, seasons: ['2023-24', '2024-25'], ledgerCaptured: 12 } });
});
test('未登录访问被锁接口只拿到预告', async () => { /* 无 Authorization → reason 'anonymous'，body 无 ledger/backtest 键 */ });
test('失效会话按未登录处理并标出 reason', async () => { /* 随便一个 Bearer → 200，reason 'session'；clock 推过 30 天后用旧令牌同样 */ });
test('没勾同意：发码与验证都拒绝 auth.consentRequired；协议版本不对也拒绝', async () => {});
test('海外号关闭：+1 号码 400 auth.overseasClosed，发送器没被调用', async () => {});
test('第 3 次发码要求图形验证（428 带图），答对才发', async () => {
  // 三个不同号码、同一 IP、间隔 61s：前两次 200；第 3 次 428 { code:'auth.captchaRequired', captcha:{ id, image } }
  // 用 deps.captcha 的测试钩子拿到答案后带 captchaId/captchaAnswer 重发 → 200
});
test('发送失败：502 auth.smsFailed，之后用任何码验证都是 auth.codeExpired', async () => {});
test('没配密钥（disabled 发送器）：503 auth.smsUnavailable，sms_sends 无新行', async () => {});
test('登录时绑定当前匿名档案；账号已有档案时 outcome kept', async () => {
  // players 假实现：authenticate('anonTok') → { id: 'pA', name: '小明' }
  // 第一次 verify 带 anonToken 'anonTok' → outcome 'bound'，player.id 'pA'
  // 另一台设备（anonToken 'otherTok' → pB）登录同一号码 → outcome 'kept'，player.id 'pA'
});
test('prefs：登录后可存语言与时区，/me 返回', async () => {});
test('库不可用：h = null 时 503 auth.unavailable', async () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/authRoutes.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `server/authRoutes.mjs`**

- `/code` 处理顺序：校验 consent → `normalizePhone` → `pickSender`（选中的是 `disabled` 发送器 → `503 auth.smsUnavailable`，不调用、不记 `sms_sends`）→ `checkSendAllowed`（不通过时把该 IP 记进路由内 `limitedIps: Map<ip, at>`）→ `needsCaptcha`（输入来自 `checkSendAllowed` 返回的 `ipSendsLastHour` / `siteToday` 与 `limitedIps`）→ 需要时校验 `captchaId/captchaAnswer` → `requestCode`。
- IP 一律用 `req.ip`（`trust proxy` 在 index.mjs 设置）。
- `/verify` 成功：`findOrCreateUser` → `bindPlayer`（`anonPlayerId = players?.authenticate(anonToken)?.id`，注意 `authenticate` 会刷新 last_seen，可接受）→ `createSession` → 返回；`player` 用 `players?.byId(playerId)`。
- 日志 `console.log('[auth] 新账号 138****8000')` 之类只用脱敏号码。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/authRoutes.test.mjs && npm test`
Expected: 全部通过，全量 `# fail 0`

- [ ] **Step 5: 提交**

```bash
git add server/authRoutes.mjs tests/authRoutes.test.mjs
git commit -m "用户系统：/api/auth 路由（发码、验证即注册、退出、偏好）与请求身份解析，按需图形验证"
```

---

### Task 8: 接进 `server/index.mjs`：真实 IP、身份、三个接口加锁、开关与健康检查

**Files:**
- Modify: `server/index.mjs`（`const app = express()` 之后 L137；`requireAuth` L172–183；`/api/meta` L193–231；`/api/predictions/summary` L376–396；`/api/paper` L402–409；`/api/shadow` L412–425；`livePlayerId` L506–515；`/api/health` L749–766；底部开关区 L832–850）
- Modify: `server/db.mjs`（若 Task 2 未做：`initDb` 执行 `ACCOUNT_SCHEMA`）

**Interfaces:**
- Consumes: Task 3 `sessionUser`；Task 4 `gate`、`teaserBoard`、`teaserPaper`、`teaserShadow`；Task 5 `createSenders`；Task 6 `createCaptchaStore`；Task 7 `createAuthRouter`、`userFromRequest`；Task 2 `limitsFromEnv`、`smsStats`；Task 1 `countriesFor`
- Produces（前端依赖）：
  - `/api/meta` → `features.accounts: { enabled: boolean, overseas: boolean, countries: Array<{cc, iso}>, consentVersion: string }`
  - 三个被锁接口在锁定时返回 `{ locked: true, reason, … }`（Task 4 形状），放行时与现在完全相同；两种情况都带 `Vary: Authorization`、`Cache-Control: private, no-store`
  - `/api/health` → 新增 `sms: smsStats(...) & { mainland: 'tencent'|'console'|'disabled', overseas: 'twilio'|'off' }`、`alarms: string[]`（全站触顶时含 `'sms.dailyCapReached'`）、`proxy: { ip: req.ip, cookieSeen: boolean }`；**HTTP 状态与 `ok` 不因报警改变**（容器健康检查走 `/api/meta`，`deploy/refresh.sh` 的回滚看容器健康，不能被短信报警触发回滚）
  - 会话令牌也能当玩家身份：`requireAuth` 与 `livePlayerId` 改用 `resolvePlayer(token) = db.authenticate(token) ?? 账号会话对应的玩家`

- [ ] **Step 1: 改代码**

1. `app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal')`——链路是 访客 → Traefik → works-gateway(nginx, 私网) → 容器，只信任私网跳，`req.ip` 取最右边第一个公网地址，伪造的 `X-Forwarded-For` 左端无效。注释写明：现有 `rateLimit` 的按 IP 计数也因此从「所有访客共用一个桶」变成真正按人。
2. 开关：`const ACCOUNTS_ON = process.env.ENABLE_ACCOUNTS === '1'`；`accountsDb = ACCOUNTS_ON ? (LEADERBOARD_ON && db.isEnabled() ? db.handle() : db.openWith(db.ACCOUNT_SCHEMA, '用户系统')) : null`。开着但库打不开 → 被锁接口按未登录处理（宁可锁住也不漏），`features.accounts.enabled = false`，前端显示「登录暂不可用」。
3. `players` 适配：`LEADERBOARD_ON && db.isEnabled()` 时 `{ authenticate: db.authenticate, create: (n) => db.createPlayer(n), byId: db.playerById }`，否则 `null`。
4. 在 `ACCOUNTS_ON && accountsDb` 时 `app.use('/api/auth', createAuthRouter({ h: accountsDb, senders, captcha, limits, clock, rateLimit, players }))`；否则 `app.use('/api/auth', (req, res) => res.status(503).json({ code: 'auth.unavailable' }))`。挂在 `app.listen` 之前即可（静态兜底 `app.get('*')` 对 `/api/` 调 `next()`）。
5. 三个接口：`const gateFor = (feature, req) => gate(feature, { accountsOn: ACCOUNTS_ON, ...userFromRequest(accountsDb, req, clock()), now: clock() })`。
   - summary：把现有生产函数抽成 `boardFull(params, out)`，用 `cached('predBoard', key, …)` 缓存对象；放行走原 `sendCached(res, req, 'predBoard|…', () => boardFull(...))`（预压缩路径不变）；锁定 `res.json({ ...teaserBoard(await boardFull(...)), reason })`。
   - paper、shadow 同理（`shadowCache` 不变，锁定时用它的结果裁剪）。
6. `resolvePlayer` 替换 `requireAuth` 里的 `db.authenticate(token)` 和 `livePlayerId` 里排行榜分支的 `db.authenticate(...)`；`x-local-profile` 分支不动。
7. 启动日志：`用户系统：开启｜关闭；国内短信 tencent｜console｜disabled；海外 off｜twilio`，不打印任何密钥。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: `# fail 0`

- [ ] **Step 3: 本地冒烟（账号关闭 = 现状）**

Run: `ENABLE_LEADERBOARD=0 PORT=5199 node server/index.mjs &` 然后 `curl -s localhost:5199/api/paper | head -c 200; curl -s localhost:5199/api/meta | grep -o '"accounts":{[^}]*}'`
Expected: `/api/paper` 与改动前一样有 `backtest` / `ledger`；`accounts` 里 `"enabled":false`

- [ ] **Step 4: 本地冒烟（账号开启）**

Run: `ENABLE_LEADERBOARD=0 ENABLE_ACCOUNTS=1 SMS_PROVIDER=console DB_PATH=/tmp/dcnba-auth.db PORT=5199 node server/index.mjs`，另一终端：
```bash
curl -s localhost:5199/api/paper                       # → {"locked":true,"reason":"anonymous","teaser":{...}}
curl -s localhost:5199/api/predictions/summary | head -c 300   # → locked，summary 只有一句
curl -s -XPOST localhost:5199/api/auth/code -H 'content-type: application/json' -d '{"cc":"86","phone":"13800138000","consent":true}'
# 服务端日志出现 [sms:console] 138****8000 验证码 XXXXXX
curl -s -XPOST localhost:5199/api/auth/verify -H 'content-type: application/json' -d '{"cc":"86","phone":"13800138000","code":"XXXXXX","consent":true,"consentVersion":"2026-10-29"}'
curl -s localhost:5199/api/paper -H "authorization: Bearer <token>" | head -c 200   # → 完整数据
curl -s localhost:5199/api/health | grep -o '"proxy":{[^}]*}'                         # → "ip":"::1" 或 "127.0.0.1"
curl -s localhost:5199/api/health -H 'X-Forwarded-For: 9.9.9.9' | grep -o '"ip":"[^"]*"'   # → "ip":"9.9.9.9"（本机回环被信任，属预期）
```
Expected: 如注释所示

- [ ] **Step 5: 提交**

```bash
git add server/index.mjs server/db.mjs
git commit -m "用户系统接线：trust proxy 取真实访客 IP；ENABLE_ACCOUNTS 开关；预测总表/影子/模拟投注三个接口按 can() 返回全量或预告；会话令牌兼作玩家身份；健康检查报短信用量"
```

---

### Task 9: 前端会话、接口与档案对应

**Files:**
- Create: `web/src/lib/session.js`
- Modify: `web/src/lib/api.js`、`web/src/lib/profiles.js`（文件头「为什么不做服务端账号」注释改写为现状：可选账号 + 本地档案）、`web/src/lib/cloud.js`（注释）
- Test: `tests/profilesAccount.test.mjs`

**Interfaces:**
- Consumes: Task 7 路由与返回形状；Task 8 `features.accounts`
- Produces:
  - `session.js`：`SESSION_KEY = 'dc-nba:session.v1'`；`loadSession(now = Date.now()) → { token, expiresAt, user } | null`（过期即清除并返回 null）；`saveSession(s) → s`；`clearSession() → void`；`authHeaders(session) → { Authorization: string } | undefined`
  - `api.js`：`predictionBoard(params, token?)`、`paper(token?)`、`shadow(token?)`；`authCaptcha()`、`authCode(body)`、`authVerify(body)`、`authMe(token)`、`authLogout(token)`、`authPrefs(token, prefs)`；`json()` 抛出的 `Error` 带 `status`、`code`、`params`、`body`（i18n 计划若已改此处，沿用它的形状）
  - `profiles.js`：
    - `attachAccount(state, { player: { id, name } | null, token: string }) → state`：已有本地档案 `cloud.playerId === player.id` → 换上会话令牌、`cloud.account = true` 并切过去；否则若当前档案没有 `cloud` 或 `cloud.playerId === player.id` → 绑到当前档案；否则新建本地档案（名 = `player.name`）绑上并切过去；`player` 为 null → 原样返回
    - `detachAccount(state) → state`：去掉所有 `cloud.account === true` 的 `cloud`

- [ ] **Step 1: 写失败测试**（node 里没有 `localStorage`，`profiles.js` 的读写已 try/catch，可直接测纯逻辑）

```js
import { attachAccount, detachAccount } from '../web/src/lib/profiles.js';
const S = (profiles, activeId) => ({ version: 1, activeId, profiles });

test('attachAccount：当前档案未入榜 → 绑到当前档案', () => {
  const s = attachAccount(S([{ id: 'l1', name: '玩家 1' }], 'l1'), { player: { id: 'pA', name: '玩家 1' }, token: 'sess' });
  assert.deepEqual(s.profiles[0].cloud, { playerId: 'pA', token: 'sess', name: '玩家 1', account: true });
  assert.equal(s.activeId, 'l1');
});
test('attachAccount：账号档案与本机档案不同时新建本地档案', () => {
  const s = attachAccount(S([{ id: 'l1', name: '我', cloud: { playerId: 'pB', token: 't' } }], 'l1'), { player: { id: 'pA', name: '小明' }, token: 'sess' });
  assert.equal(s.profiles.length, 2);
  assert.deepEqual(s.profiles[0].cloud, { playerId: 'pB', token: 't' });          // 本机匿名档案原样
  assert.equal(s.profiles.find((p) => p.id === s.activeId).cloud.playerId, 'pA');
});
test('attachAccount：本机已有该账号的档案 → 换令牌并切过去', () => {});
test('detachAccount：只去掉账号档案的 cloud', () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/profilesAccount.test.mjs`
Expected: FAIL，`attachAccount` 未导出

- [ ] **Step 3: 实现**

`attachAccount` 内部用已有的 `createProfile` / `saveProfiles`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/profilesAccount.test.mjs && npm run check`
Expected: 测试通过；`check-jsx` 无未解析组件

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/session.js web/src/lib/api.js web/src/lib/profiles.js web/src/lib/cloud.js tests/profilesAccount.test.mjs
git commit -m "用户系统前端：本地会话、认证接口、被锁接口带会话头；登录后账号档案与本地档案的对应规则"
```

---

### Task 10: 登录页、侧栏登录区与锁标、预测总表预告

**Files:**
- Create: `web/src/pages/Login.jsx`、`web/src/components/LockedTeaser.jsx`
- Modify: `web/src/App.jsx`（NAV L29–41、上下文 L108–178、路由 L196–208、侧栏「当前玩家」L246–266）、`web/src/pages/Board.jsx`（TABS L8–13、`ShadowCard` L215–258、`PaperBetting` L288–292、`Board` L488–583）、`web/src/components/common.jsx`（加 `LockIcon`）、`web/src/styles.css`、`<zh 语言文件>`、`<en 语言文件>`

**Interfaces:**
- Consumes: Task 9 全部；Task 8 `features.accounts`；i18n `t(key, params)`
- Produces:
  - 上下文新增：`accounts`（= `meta.features.accounts`）、`session`、`login(verifyResult)`（`saveSession` + `setProf(attachAccount)`，若账号有 `locale/timeZone` 则套用到 i18n）、`logout()`（`api.authLogout` 失败也继续；`clearSession` + `setProf(detachAccount)`）、`onSessionInvalid()`（= 本地 `logout` 不调接口）
  - 路由：`#/login`、`#/login/<returnTo>`（登录成功 `go(returnTo)`，默认 `board`）
  - `LockedTeaser({ summary?: Array, stats?: Array<{ label, value }>, onLogin }) → JSX`
  - `LockIcon({ size = 12 }) → JSX`（内联 SVG，`aria-label={t('lock.badge')}`）

- [ ] **Step 1: 语言键**（`<zh 语言文件>` / `<en 语言文件>`，键名按 i18n 计划的分组规范，下列为建议）

| 键 | zh | en |
| --- | --- | --- |
| `auth.loginOrRegister` | 登录 / 注册 | Sign in / Sign up |
| `auth.title` | 手机号登录 | Sign in with your phone |
| `auth.newNumberHint` | 新号码验证后自动注册，无需密码 | New numbers are registered automatically. No password needed. |
| `auth.country` / `auth.phone` / `auth.code` | 国家 / 地区 · 手机号 · 验证码 | Country / region · Phone number · Code |
| `auth.getCode` / `auth.resendIn` | 获取验证码 · {sec} 秒后可重发 | Send code · Resend in {sec}s |
| `auth.submit` | 登录 | Sign in |
| `auth.agree` | 我已阅读并同意《用户协议》和《隐私政策》 | I have read and agree to the Terms of Service and Privacy Policy |
| `auth.overseasSoon` | 海外号即将开放 | Overseas numbers coming soon |
| `auth.smsZhOnly` | — | The text message is sent in Chinese. |
| `auth.captchaLabel` / `auth.captchaRefresh` | 请输入图中字符 · 换一张 | Enter the characters shown · New image |
| `auth.loggedInAs` | 已登录 {phone} | Signed in as {phone} |
| `auth.logout` | 退出 | Sign out |
| `auth.unavailableUi` | 登录暂不可用 | Sign-in is unavailable right now |
| `auth.phoneInvalid` | 手机号格式不对 | That phone number doesn't look right |
| `auth.overseasClosed` | 目前只支持中国大陆手机号，海外号即将开放 | Only mainland China numbers are supported for now. Overseas numbers coming soon. |
| `auth.consentRequired` | 请先阅读并勾选同意《用户协议》和《隐私政策》 | Please agree to the Terms of Service and Privacy Policy first |
| `auth.captchaRequired` / `auth.captchaWrong` | 请先完成图形验证 · 图形验证不对，请再试一次 | Please complete the image check · That didn't match. Try again. |
| `auth.cooldown` | 发送太频繁，请 {sec} 秒后再试 | Too many requests. Try again in {sec}s. |
| `auth.phoneDailyLimit` | 这个号码今天收验证码次数已达上限，请明天再试 | This number has reached today's limit. Try again tomorrow. |
| `auth.ipLimit` | 当前网络请求验证码过于频繁，请稍后再试 | Too many requests from your network. Try again later. |
| `auth.smsDailyCap` | 今日短信发送量已达上限，请明天再试 | We've hit today's text message limit. Try again tomorrow. |
| `auth.smsFailed` | 短信发送失败，请稍后重试 | We couldn't send the text message. Try again later. |
| `auth.smsUnavailable` / `auth.unavailable` | 短信服务暂不可用 · 登录服务暂不可用 | Text messages are unavailable · Sign-in is unavailable |
| `auth.codeInvalid` | 验证码不对，还可以再试 {left} 次 | Wrong code. {left} attempts left. |
| `auth.codeExpired` | 验证码已失效，请重新获取 | That code has expired. Request a new one. |
| `auth.codeLocked` | 错误次数过多，验证码已失效，请重新获取 | Too many wrong attempts. Request a new code. |
| `auth.sessionInvalid` | 登录已过期，请重新登录 | Your session has expired. Please sign in again. |
| `auth.prefsInvalid` | 语言或时区设置无效 | Invalid language or time zone |
| `lock.cta` | 登录后查看完整战绩统计与模拟投注 | Sign in to see the full track record and paper betting |
| `lock.badge` | 登录后可见 | Members only |
| `lock.note` | 每场比赛的预测在「赛程」「今日比赛」「比赛预测」页照常公开 | Game-by-game predictions stay free on Schedule, Today and Predict. |
| `lock.completed` / `lock.remaining` / `lock.backtestBets` / `lock.ledgerCaptured` | 已结束 {n} 场 · 剩余 {n} 场 · 历史回测 {n} 注 · 本季已记录 {n} 场 | {n} games played · {n} remaining · {n} backtest bets · {n} games logged this season |
| `country.CN` … `country.AU` | 中国大陆、美国 / 加拿大、中国香港、中国澳门、中国台湾、新加坡、英国、日本、韩国、澳大利亚 | China (mainland), US / Canada, Hong Kong, Macau, Taiwan, Singapore, UK, Japan, South Korea, Australia |

（`lock.cta` 中文为 spec 固定文案，不得改写成「今晚的预测」。）

- [ ] **Step 2: 实现**

- 侧栏：`accounts.enabled` 时，在「当前玩家」盒子里 `管理档案` 按钮下方：未登录 →「登录 / 注册」按钮 `go('login')`；已登录 → `t('auth.loggedInAs', { phone: session.user.phone })` + 「退出」。`accounts.enabled` 为假时不显示任何登录元素（现状）。NAV 的 `board` 项在 `accounts.enabled && !session` 时标签后加 `<LockIcon />`。
- Login.jsx：区号下拉来自 `accounts.countries`，默认中文 `86`、英文 `1`（`1` 不在列表时回退 `86`）；`!accounts.overseas` 时下拉只有 +86，旁边 `t('auth.overseasSoon')`；英文界面显示 `auth.smsZhOnly`；同意框未勾选时「获取验证码」禁用（服务端另有校验）；倒计时取服务端 `resendAfterSec`，收到 `auth.cooldown` 用 `params.sec`；收到 428 时显示 `captcha.image`（`<img>`），重发时带 `captchaId/captchaAnswer`；验证码框 `inputMode="numeric" autoComplete="one-time-code" maxLength={6}`；验证时带 `anonToken = ctx.cloud?.token`（若当前档案的 cloud 已是账号档案则不带）、`profileName = ctx.profileName`、`consentVersion = accounts.consentVersion`；成功 → `ctx.login(result)` → `go(returnTo)`。错误一律 `t(err.code, err.params)`。
- Board.jsx：三个请求带 `session?.token`，并把 `session?.token` 加进 `useEffect` 依赖；响应 `locked` 且 `reason === 'session'` → `ctx.onSessionInvalid()`。`data.locked` 时 `Board` 渲染：页头 → 总结卡（只有 `data.summary` 那一句）→ 两个 StatTile（`lock.completed`、`lock.remaining`）→ Segmented（`bet` 标签带锁标）→ 对 `stats/done/next` 显示 `<LockedTeaser>`，对 `bet` 渲染 `PaperBetting`（它自己拿到锁定响应后显示带 `backtestBets / ledgerCaptured` 的 `LockedTeaser`）。`ShadowCard` 锁定时不渲染。未锁定时一切与现在一致。`bet` 标签锁标条件同侧栏。
- LockedTeaser：下层是**静态假骨架**（几行灰条、一个假曲线，`filter: blur(6px)`、`aria-hidden`、`pointer-events: none`）——服务端没给真数据，模糊的不是真内容；上层居中按钮 `t('lock.cta')` → `onLogin`，下方小字 `t('lock.note')`。
- styles.css：`.locked-wrap`、`.locked-blur`、`.locked-cta`、`.nav-lock`，深浅色都用现有 CSS 变量。

- [ ] **Step 3: 构建与检查**

Run: `npm run build && npm test`
Expected: 构建成功（含 `check-jsx`）；测试 `# fail 0`（含 i18n 的中英键一致性测试）

- [ ] **Step 4: 本地手动验收**（Task 8 Step 4 的服务端 + `npm run dev`，中英各走一遍）

- 未登录：侧栏「预测总表」有锁标；页内只有一句总结、两个场数、模糊骨架与按钮「登录后查看完整战绩统计与模拟投注」；「模拟投注」标签有锁标；DevTools 网络面板里 `/api/paper` 响应没有 `ledger.rules` / `backtest.table`。
- 「赛程」「今日比赛」「比赛预测」不登录照常显示每场预测；人机对赌不登录照常能玩。
- 登录（console 发送器的码）→ 回到预测总表，完整内容可见；侧栏显示 `138****8000 · 退出`。
- 退出 → 回到预告；在另一个标签页退出后刷新本页 → 预告，侧栏回到「登录 / 注册」，没有报错框。
- 英文界面：区号只有 +86 且显示 "Overseas numbers coming soon"；错误提示全是英文。

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/Login.jsx web/src/components/LockedTeaser.jsx web/src/components/common.jsx web/src/App.jsx web/src/pages/Board.jsx web/src/styles.css <zh 语言文件> <en 语言文件>
git commit -m "用户系统前端：登录 / 注册页（区号、同意协议、60 秒重发、按需图形验证）、侧栏登录区与锁标、预测总表与模拟投注预告"
```

---

### Task 11: 《用户协议》《隐私政策》（中英文草稿）与同意

**Files:**
- Create: `web/src/legal/zh.js`、`web/src/legal/en.js`、`web/src/pages/Legal.jsx`
- Modify: `web/src/App.jsx`（路由 `terms`、`privacy`）、`web/src/pages/Login.jsx`（同意文字里两处链接到 `#/terms`、`#/privacy`）

**Interfaces:**
- Consumes: i18n 当前语言；Task 3 `CONSENT_VERSION`（前端常量与之相同：`'2026-10-29'`，写在两份 legal 文件的 `version` 字段）
- Produces: `legal/<lang>.js` 默认导出 `{ version: '2026-10-29', terms: { title, sections: Array<{ h: string, p: string[] }> }, privacy: { title, sections } }`；加一种语言 = 加一个文件，`Legal.jsx` 按语言取，缺失回退中文。

- [ ] **Step 1: 起草文本**（标注「草稿，待高磊审定」于每份文件顶部注释；正文不出现「草稿」字样以免上线忘改——改为审定前 `Legal.jsx` 顶部显示 `version` 与「最后更新」日期）

《用户协议》章节：服务说明（NBA 数据与模型预测，仅供娱乐与学习，**不构成任何投注建议**，「模拟投注」为虚拟记录、不涉及真实资金）；账号（手机号验证注册、一个号码一个账号、妥善保管设备）；使用规范（禁止批量注册、刷接口、抓取）；会员等级（现为免费，将来若收费会另行告知并单独同意）；免责与责任限制；协议变更；适用法律与争议解决（中华人民共和国法律，主体「上海磊宁科技有限公司」所在地法院——待用户确认）；联系方式（待填）。
《隐私政策》章节（按《个人信息保护法》的告知要素）：收集什么（手机号、登录 IP 与时间、验证码发送记录、玩家昵称与对赌记录、语言与时区偏好；不收集通讯录、定位等）；为什么收集（登录、防刷、跨设备同步战绩）；短信服务商（腾讯云短信；海外号开放后为 Twilio，涉及数据出境须单独告知——海外开放前补充）；存放地点与期限（中国境内服务器；账号存续期间，发送记录保留 180 天——待用户确认）；不出售、不向第三方提供（法定情形除外）；用户权利（查询、更正、注销账号——注销目前通过联系方式人工处理，待用户确认是否要做自助注销）；未成年人；政策变更；联系方式。英文版内容对应。

- [ ] **Step 2: 实现 `Legal.jsx` 与路由；登录页同意框旁两个链接新开 `#/terms` / `#/privacy`（同页跳转会丢失已输入号码，用 `target="_blank"`）**

- [ ] **Step 3: 构建**

Run: `npm run build`
Expected: 成功

- [ ] **Step 4: 手动检查**：`#/terms`、`#/privacy` 中英文都能打开；登录页不勾同意无法获取验证码；用 curl 不带 `consent` 调 `/api/auth/code` → `400 {"code":"auth.consentRequired"}`。

- [ ] **Step 5: 提交**

```bash
git add web/src/legal web/src/pages/Legal.jsx web/src/App.jsx web/src/pages/Login.jsx
git commit -m "用户系统：《用户协议》《隐私政策》中英文初稿（待审定）与登录前必选的同意"
```

---

### Task 12: 部署文档、开关与上线

**Files:**
- Modify: `docker-compose.yml`（仓库版）、`.dockerignore`、`deploy/README.md`、`README.md`（「玩家档案：为什么没有账号密码」一节）

**Interfaces:**
- Consumes: Task 5 / Task 8 的环境变量名
- Produces: 服务器上线步骤与回滚步骤（文档）

- [ ] **Step 1: 仓库 `docker-compose.yml`**：`environment` 加 `ENABLE_ACCOUNTS: "0"` 与注释（「手机号登录会在公网收集手机号；是否上线由高磊决定；密钥放服务器 .env，不进仓库」），下面以注释形式列出全部变量名（无值）。

- [ ] **Step 2: `.dockerignore` 加 `.env`**（构建阶段 `COPY . .` 会把它带进 builder 层）。

- [ ] **Step 3: `deploy/README.md` 新节「用户系统（2026-10-29 起）」**，内容：

1. 开关与变量（写进**服务器上那份** `docker-compose.yml` 的 `environment`，手工加行，**不要用仓库版覆盖**）：

```yaml
      ENABLE_ACCOUNTS: "1"
      TENCENT_SMS_SECRET_ID: ${TENCENT_SMS_SECRET_ID}
      TENCENT_SMS_SECRET_KEY: ${TENCENT_SMS_SECRET_KEY}
      # 以下非机密，代码里有同样的默认值，写出来是为了一眼看清
      TENCENT_SMS_SDK_APP_ID: "1400683809"
      TENCENT_SMS_SIGN_NAME: 上海磊宁科技有限公司
      TENCENT_SMS_TEMPLATE_ID: "1417875"
      TENCENT_SMS_REGION: ap-guangzhou
      TENCENT_SMS_PARAM2: "5"          # 模板第二个变量；按控制台模板正文确认（见计划「开工前要用户确认的事」1）
      SMS_DAILY_CAP: "500"
      SMS_IP_HOURLY: "5"
      SMS_IP_DAILY: "20"
      ENABLE_OVERSEAS_SMS: "0"
      # 开通 Twilio 后再加：TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_VERIFY_SERVICE_SID: ${...}
```

   密钥值放 `/home/dev/work/works/dc-nba/.env`（`chmod 600`，compose 自动读取），不进仓库、不进镜像、不贴聊天。
2. 上线前检查清单：腾讯云在用密钥已轮换（旧密钥曾进 Gitee）；模板 1417875 正文与 `TENCENT_SMS_PARAM2` 一致；签名与模板仍为「已通过」；短信套餐余量；在腾讯云控制台另设发送频率限制与余额告警作为第二道防线；协议文本已审定。
3. 上线步骤：

```bash
ssh dev@gpu.tzspace.cn 'docker exec dc-nba node scripts/backup-db.mjs'                                   # 库备份（VACUUM INTO，不用 cp）
ssh dev@gpu.tzspace.cn 'docker tag dc-nba-dc-nba:latest dc-nba-dc-nba:pre-$(date +%m%d)'                 # 回滚点
# 服务器上手工编辑 docker-compose.yml 加上面那几行、写好 .env
git archive HEAD server scripts deploy web docs package.json package-lock.json Dockerfile .dockerignore README.md | ssh dev@gpu.tzspace.cn 'tar -x -m -C /home/dev/work/works/dc-nba'
ssh dev@gpu.tzspace.cn 'cd /home/dev/work/works/dc-nba && docker compose build && docker compose up -d'
```
   避开 cron 时段（北京 06:30 / 14:30 / 22:00 与本机 23:00 全量推送）。
4. 上线验证：

```bash
curl -s https://ai.tzspace.cn/works/dc-nba/api/meta | grep -o '"accounts":{[^}]*}'        # enabled:true, overseas:false
curl -s https://ai.tzspace.cn/works/dc-nba/api/health -H 'Cookie: probe=1' | grep -o '"proxy":{[^}]*}'
curl -s ifconfig.me                                                                      # proxy.ip 必须等于它；否则按 IP 限频无效，回到 TRUST_PROXY 排查（works-gateway nginx 是否透传 X-Forwarded-For）
curl -s https://ai.tzspace.cn/works/dc-nba/api/paper | head -c 200                      # locked:true
curl -s https://ai.tzspace.cn/works/dc-nba/api/health | grep -o '"sms":{[^}]*}'          # mainland:"tencent"
```
   `proxy.cookieSeen` 顺带核实 profiles.js / README 的「网关双向剥离 Cookie」：为 `false` 即属实（本方案用 Bearer，结论不影响实现，只更新文档措辞）。然后用自己手机真实登录一次，确认短信正文里的有效期与 5 分钟一致。
5. 运维变化：`/api/paper`、`/api/shadow` 匿名只回预告，查账本与影子改用 `docker exec dc-nba node scripts/ledger.mjs show` / `node scripts/shadow.mjs show`（更新本文件里提到 `/api/shadow` 的那行）。`/api/health` 的 `alarms` 出现 `sms.dailyCapReached` 表示当日停发；目前没有任何东西主动推送这条报警（见下方「已知缺口」）。
6. 回滚：`docker tag dc-nba-dc-nba:pre-MMDD dc-nba-dc-nba:latest && docker compose up -d --no-build`；新表是加法迁移，旧镜像不读它们，不用动库。只想关掉登录、保留新代码：服务器 compose 改 `ENABLE_ACCOUNTS: "0"` 后 `docker compose up -d`（三个接口恢复全公开）。

- [ ] **Step 4: README.md「为什么没有账号密码」改写**：现在有可选的手机号账号（无密码），本地多档案与存档码仍在；三条理由里「容器不挂卷」已过时（排行榜早已挂卷），改成现状描述。

- [ ] **Step 5: 全量验证与提交**

Run: `npm test && npm run build`
Expected: `# fail 0`；构建成功

```bash
git add docker-compose.yml .dockerignore deploy/README.md README.md
git commit -m "用户系统部署文档：服务器 compose 需手工加的环境变量、上线前密钥轮换与模板核对、真实 IP 与 Cookie 核验、回滚；仓库默认关闭"
```

---

## 已知缺口（不在本计划内，需用户决定）

- **报警没人收**：`/api/health` 的 `alarms` 与服务器日志 `!! [sms]` 只是记录，没有推送渠道。若要通知，可在 `deploy/refresh.sh`（每天三次）收尾时读 `/api/health` 写进 `refresh.log`，或接企业微信 / 邮件——改 refresh.sh 要避开 cron 时段。
- **注销账号**：spec 未要求；隐私政策写「联系我们人工处理」。若要自助注销，另起任务（删除 users 行与 sessions；`sms_sends` 只追加，按保留期清理需要单独设计）。
- **`sms_sends` 保留期**：只追加、每天最多约 500 行，体量不是问题；隐私政策里写的保留期（建议 180 天）需要配一个清理方式，届时要放开只追加触发器的删除条件（例如只允许删 180 天前的行）。
