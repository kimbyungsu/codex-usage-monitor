// 한도 창(limit window) 정규화·표시 회귀 시험 (vsce 패키징에는 포함되지 않음).
// 실행: npm run test:limits
// 시나리오는 실제로 관측된 서버 형태를 기준으로 한다.
//  - Codex: 5시간 창이 빠지면 주간 창이 primary 로 올라오고 secondary 는 null (2026-07-13~, 2026-09 일시 부활 후 재폐지)
//  - Claude: five_hour=null + limits[] 미터(weekly_all, weekly_scoped) (2026-10-30~ 일부 요금제)
const assert = require("assert");
const Module = require("module");
const path = require("path");

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return path.join(__dirname, "fake-vscode.js");
  return origResolve.call(this, request, ...rest);
};

const { windowsFromCodex, statusBarWindows, hasAccountFiveHour, windowLevel, forecastWindow, LimitWatch, acceptObservations } = require("../out/limits.js");
const { normalizeUsage } = require("../out/claudeApi.js");
const { limitLabel, t } = require("../out/i18n.js");
const { formatStatusBarText, formatTooltip, formatClaudeStatusBar, formatClaudeTooltip, claudePlanText } = require("../out/dashboard.js");
const { codexPlanLabel } = require("../out/usageService.js");

const T = t("ko");
const now = Date.now();
const H = 3_600_000;
const sec = (ms) => Math.floor(ms / 1000);
let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("ok -", name);
}

// ---------------- Codex ----------------

const weeklyOnly = {
  limitId: "codex",
  limitName: null,
  primary: { usedPercent: 46, windowDurationMins: 10080, resetsAt: sec(now + 3 * 24 * H) },
  secondary: null,
  planType: "prolite",
};
const both = {
  limitId: "codex",
  primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: sec(now + 2 * H) },
  secondary: { usedPercent: 46, windowDurationMins: 10080, resetsAt: sec(now + 3 * 24 * H) },
  planType: "prolite",
};

test("Codex 주간 단독(primary=주간): 주간으로 분류되고 5시간 자리로 가지 않음", () => {
  const ws = windowsFromCodex(weeklyOnly, null);
  assert.strictEqual(ws.length, 1);
  assert.strictEqual(ws[0].span, "weekly");
  assert.strictEqual(ws[0].id, "codex:weekly");
  assert.strictEqual(limitLabel(ws[0], T), "주간 한도");
  assert.strictEqual(hasAccountFiveHour(ws), false);
  const text = formatStatusBarText({ connected: true, connecting: false, limits: ws });
  // 5h 칸은 고정 + "없음", 주간 값은 7d 자리(0.8.2 버그: "5h 54% (…) · 7d ?")
  assert.ok(/^\$\(pulse\) Codex  5h 없음 · 7d 54% \(.+\)$/.test(text), text);
  assert.ok(!/5h \d/.test(text), "주간 값이 5h 자리에 오면 안 됨: " + text);
  const tip = formatTooltip({ connected: true, limits: ws, account: { type: "chatgpt", planType: "prolite" }, planLabel: codexPlanLabel("prolite") });
  assert.ok(tip.includes("주간 한도:"), tip);
  assert.ok(tip.includes(T.noFiveHour("Pro 100")), tip);
  assert.ok(tip.includes("Pro 100 요금제에"), tip);
  assert.ok(tip.includes("(Pro 100)"), tip);
});

test("Codex 5시간+주간: 짧은 창 → 긴 창 순, 상태바 두 창", () => {
  const ws = windowsFromCodex(both, null);
  assert.deepStrictEqual(ws.map((w) => w.span), ["5h", "weekly"]);
  const text = formatStatusBarText({ connected: true, connecting: false, limits: ws });
  assert.ok(/^\$\(pulse\) Codex  5h 80% \(.+\) · 7d 54% \(.+\)$/.test(text), text);
  assert.ok(!text.includes(T.noneShort), text);
  assert.ok(!formatTooltip({ connected: true, limits: ws }).includes(T.noFiveHour(null)));
});

test("Codex 위치가 뒤바뀌어도(primary=주간, secondary=5시간) 길이로 정렬", () => {
  const ws = windowsFromCodex({ ...both, primary: both.secondary, secondary: both.primary }, null);
  assert.deepStrictEqual(ws.map((w) => w.id), ["codex:5h", "codex:weekly"]);
});

test("Codex 길이 미상(0) 창: 'other' + 위치 키 + 일반 라벨", () => {
  const ws = windowsFromCodex({ limitId: "codex", primary: { usedPercent: 0, windowDurationMins: 0, resetsAt: sec(now + H) } }, null);
  assert.strictEqual(ws[0].span, "other");
  assert.strictEqual(ws[0].id, "codex:primary");
  assert.strictEqual(limitLabel(ws[0], T), T.genericLimit);
});

test("Codex 비표준 길이(3일) 창: 길이로 라벨", () => {
  const ws = windowsFromCodex({ limitId: "codex", primary: { usedPercent: 5, windowDurationMins: 4320 } }, null);
  assert.strictEqual(ws[0].id, "codex:4320m");
  assert.strictEqual(limitLabel(ws[0], T), "3일 한도");
});

test("Codex 모델 전용 버킷: 범위 표시명으로 뒤에 붙고, 기본 버킷 중복 없음, 상태바 제외", () => {
  const byId = {
    codex: both,
    codex_bengalfox: { limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark", primary: { usedPercent: 90, windowDurationMins: 300 } },
  };
  const ws = windowsFromCodex(both, byId);
  assert.deepStrictEqual(ws.map((w) => w.id), ["codex:5h", "codex:weekly", "codex_bengalfox:5h"]);
  assert.strictEqual(ws[2].scope, "GPT-5.3-Codex-Spark");
  assert.strictEqual(limitLabel(ws[2], T), "5시간 한도 · GPT-5.3-Codex-Spark");
  assert.deepStrictEqual(statusBarWindows(ws).map((w) => w.id), ["codex:5h", "codex:weekly"]);
});

test("Codex 요금제 표시명: 공식 표기, 미지의 값은 원문", () => {
  assert.strictEqual(codexPlanLabel("prolite"), "Pro 100");
  assert.strictEqual(codexPlanLabel("plus"), "Plus");
  assert.strictEqual(codexPlanLabel("some_new_plan"), "some_new_plan");
  assert.strictEqual(codexPlanLabel(null), null);
});

// ---------------- Claude ----------------

// 2026-11-02 실제 응답에서 한도 관련 필드만 발췌(코드명 필드는 의미 미상이라 무시 대상).
const claudeLive = {
  five_hour: null,
  seven_day: { utilization: 0, resets_at: "2026-11-09T12:59:59.572316+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: null,
  iguana_necktie: { utilization: 0, resets_at: "2026-11-05T07:59:00+00:00", limit_dollars: 250 },
  limits: [
    { kind: "weekly_all", group: "weekly", percent: 0, severity: "normal", resets_at: "2026-11-09T12:59:59.572316+00:00", scope: null, is_active: true },
    { kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resets_at: "2026-11-09T13:00:00+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
  ],
  extra_usage: { is_enabled: false },
};

test("Claude 실응답(5시간 null + limits[]): 주간 + 모델 전용 주간, 5시간 없음", () => {
  const plan = normalizeUsage(claudeLive);
  assert.deepStrictEqual(plan.windows.map((w) => w.id), ["weekly_all", "weekly_scoped:fable"]);
  assert.strictEqual(plan.windows[0].headline, true);
  assert.strictEqual(plan.windows[0].severity, "normal");
  assert.strictEqual(limitLabel(plan.windows[1], T), "주간 한도 · Fable");
  assert.strictEqual(hasAccountFiveHour(plan.windows), false);
  const state = { available: true, connecting: false, plan, subscriptionType: "max", rateLimitTier: "default_claude_max_20x", planDisplayName: "Ultra" };
  const text = formatClaudeStatusBar(state);
  assert.ok(/^\$\(hubot\) Claude  5h 없음 · 7d 100% \(.+\)$/.test(text), text);
  const tip = formatClaudeTooltip(state);
  assert.ok(tip.startsWith("Claude Ultra (max · default_claude_max_20x)"), tip);
  assert.ok(tip.includes("주간 한도 · Fable:"), tip);
  assert.ok(tip.includes(T.noFiveHour("Ultra")), tip);
});

test("Claude 구버전 서버(limits 없음): 고정 필드에서 5시간 → 주간 → 모델 전용 순", () => {
  const plan = normalizeUsage({
    five_hour: { utilization: 40, resets_at: new Date(now + H).toISOString() },
    seven_day: { utilization: 10, resets_at: new Date(now + 48 * H).toISOString() },
    seven_day_sonnet: { utilization: 5, resets_at: null },
  });
  assert.deepStrictEqual(plan.windows.map((w) => w.id), ["session", "weekly_all", "weekly_scoped:sonnet"]);
  assert.deepStrictEqual(plan.windows.map((w) => w.span), ["5h", "weekly", "weekly"]);
  const text = formatClaudeStatusBar({ plan });
  assert.ok(/5h 60% \(.+\) · 7d 90% \(/.test(text), text);
  assert.ok(!/Sonnet/.test(text), "모델 전용 창은(대표가 아니면) 상태바 제외: " + text);
});

test("Claude limits[]와 고정 필드가 같은 창이면 중복 없이 limits[] 행 우선", () => {
  const plan = normalizeUsage({
    five_hour: { utilization: 41, resets_at: null },
    seven_day: { utilization: 11, resets_at: null },
    limits: [
      { kind: "session", group: "session", percent: 42, severity: "warning", resets_at: null, scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 12, severity: "normal", resets_at: null, scope: null, is_active: false },
    ],
  });
  assert.deepStrictEqual(plan.windows.map((w) => [w.id, w.usedPercent]), [["session", 42], ["weekly_all", 12]]);
  assert.strictEqual(windowLevel(plan.windows[0]), 1, "서버 심각도(warning) 그대로");
});

test("Claude limits[]에 빠진 5시간 창은 고정 필드로 보충(맨 앞)", () => {
  const plan = normalizeUsage({
    five_hour: { utilization: 30, resets_at: null },
    limits: [{ kind: "weekly_all", group: "weekly", percent: 12, severity: "normal", resets_at: null, scope: null, is_active: true }],
  });
  assert.deepStrictEqual(plan.windows.map((w) => w.id), ["session", "weekly_all"]);
});

test("Claude 미지의 새 미터: 클라이언트 수정 없이 표시(그룹/종류로 분류)", () => {
  const plan = normalizeUsage({
    limits: [
      { kind: "monthly_all", group: "monthly", percent: 3, severity: "normal", resets_at: null, scope: null, is_active: false },
      { kind: "burst_pool", group: "burst", percent: 7, severity: "critical", resets_at: null, scope: { surface: { display_name: "Cowork" } }, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: null, severity: "normal", resets_at: null, scope: null, is_active: false },
    ],
  });
  assert.deepStrictEqual(plan.windows.map((w) => w.id), ["monthly_all", "burst_pool:cowork"], "percent 없는 행은 제외");
  assert.strictEqual(limitLabel(plan.windows[0], T), "월간 한도");
  assert.strictEqual(limitLabel(plan.windows[1], T), "burst pool · Cowork");
  assert.strictEqual(windowLevel(plan.windows[1]), 2);
  // 대표(is_active)인 모델/표면 전용 창은 상태바에도 오른다.
  assert.deepStrictEqual(statusBarWindows(plan.windows).map((w) => w.id), ["monthly_all", "burst_pool:cowork"]);
});

test("상태바 5h 칸은 서버 순서와 무관하게 맨 앞(부활 시 같은 자리)", () => {
  const plan = normalizeUsage({
    limits: [
      { kind: "weekly_all", group: "weekly", percent: 30, severity: "normal", resets_at: null, scope: null, is_active: true },
      { kind: "session", group: "session", percent: 10, severity: "normal", resets_at: null, scope: null, is_active: false },
    ],
  });
  const text = formatClaudeStatusBar({ plan });
  assert.ok(/^\$\(hubot\) Claude  5h 90% \(\?\) · 7d 70% \(\?\)$/.test(text), text);
});

test("Claude 미인증 Ultra처럼 서버가 5시간 창을 보고하면 요금제와 무관하게 표시", () => {
  const plan = normalizeUsage({ five_hour: { utilization: 25, resets_at: null }, seven_day: { utilization: 5, resets_at: null } });
  const text = formatClaudeStatusBar({ plan, planDisplayName: "Ultra" });
  assert.ok(text.startsWith("$(hubot) Claude  5h 75% "), text);
  assert.ok(!formatClaudeTooltip({ plan, planDisplayName: "Ultra" }).includes("5시간 한도: 없음"));
});

test("Claude 창이 하나도 없으면 상태바는 로컬 토큰으로 폴백", () => {
  const text = formatClaudeStatusBar({ plan: { windows: [] }, tokens: { lastSevenDays: { totalTokens: 1_500_000 } } });
  assert.ok(text.includes("Claude 7d 1.5M"), text);
});

test("요금제 표시: 서버 표시명이 없으면 내부 식별자", () => {
  assert.strictEqual(claudePlanText({ subscriptionType: "pro", rateLimitTier: null }), "pro");
  assert.strictEqual(claudePlanText({ subscriptionType: "max", rateLimitTier: "t", planDisplayName: "Ultra" }), "Ultra (max · t)");
});

// ---------------- 소진 예상(창 시작 이후 평균) ----------------
const { forecastText } = require("../out/i18n.js");
const claudeApiModule = require("../out/claudeApi.js");
// 서비스 시험이 fetchPlanUsage 를 가짜로 바꾸기 전에 실제 함수를 잡아 둔다.
const realFetchPlanUsage = claudeApiModule.fetchPlanUsage;
const realReadAccountInfo = claudeApiModule.readAccountInfo;
const MIN = 60_000;
const WEEK = 10080;

// 2026-11-12 실응답에서 주간 관련 필드만(서버 창 시작·산출 시각 포함).
const claudeWeeklyLive = {
  five_hour: null,
  seven_day: { utilization: 52, resets_at: "2026-11-16T13:00:00.206755+00:00" },
  limits: [
    { kind: "weekly_all", group: "weekly", percent: 52, severity: "normal", resets_at: "2026-11-16T13:00:00.206755+00:00", scope: null, is_active: true },
    { kind: "weekly_scoped", group: "weekly", percent: 11, severity: "normal", resets_at: "2026-11-16T13:00:00.206964+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
  ],
  seven_day_breakdown: { as_of: "2026-11-12T13:31:03.238172+00:00", window_started_at: "2026-11-09T13:00:00.206755+00:00", rows: [] },
};
const RECEIVED = Date.parse("2026-11-12T13:31:05Z");

test("실데이터: Claude 주간 52% → 창 평균 유지 시 11/15(일) 17:27:24 KST 무렵 소진, 리셋 전", () => {
  const plan = normalizeUsage(claudeWeeklyLive, RECEIVED);
  const w = plan.windows.find((x) => x.id === "weekly_all");
  assert.strictEqual(w.observedSource, "server");
  assert.strictEqual(w.windowStartMs, Date.parse("2026-11-09T13:00:00.206Z"));
  const f = forecastWindow(w, RECEIVED + MIN);
  assert.strictEqual(f.state, "before");
  assert.ok(Math.abs(f.etaMs - Date.parse("2026-11-15T08:27:24.498Z")) < 1000, new Date(f.etaMs).toISOString());
  assert.ok(f.etaMs < f.resetsAtMs);
  assert.ok(Math.abs(f.atReset - 120.467) < 0.01, String(f.atReset));
  const text = forecastText(f, false, "ko");
  assert.ok(text.includes("창 시작 이후 평균이 유지되면") && text.includes("일") && text.includes("리셋"), text);
});

test("서버 창 정보는 주간 전체 창에만 — 모델 전용 창에는 복사하지 않음", () => {
  const plan = normalizeUsage(claudeWeeklyLive, RECEIVED);
  const fable = plan.windows.find((x) => x.id === "weekly_scoped:fable");
  assert.strictEqual(fable.windowStartMs, undefined);
  assert.strictEqual(fable.observedSource, "received");
  assert.strictEqual(fable.observedAtMs, RECEIVED);
});

test("서버 창 정보가 서로 맞지 않으면(시작이 리셋−7일과 다름) 확인 대기 — 필드 없음과 구분", () => {
  const bad = JSON.parse(JSON.stringify(claudeWeeklyLive));
  bad.seven_day_breakdown.window_started_at = "2026-11-09T14:00:00Z";
  const w = normalizeUsage(bad, RECEIVED).windows.find((x) => x.id === "weekly_all");
  assert.strictEqual(forecastWindow(w, RECEIVED + MIN).state, "metaPending");
  const none = JSON.parse(JSON.stringify(claudeWeeklyLive));
  delete none.seven_day_breakdown;
  const w2 = normalizeUsage(none, RECEIVED).windows.find((x) => x.id === "weekly_all");
  assert.strictEqual(w2.observedSource, "received");
  assert.strictEqual(forecastWindow(w2, RECEIVED + MIN).state, "before", "없으면 리셋−7일로 계산");
});

const win = (o) => ({ id: "codex:weekly", span: "weekly", windowMins: WEEK, usedPercent: 0, ...o });

test("리셋 기준이 바뀌면 기억값 없이 즉시 새 기준으로 계산(Codex 조기 재시작)", () => {
  const O = Date.parse("2026-11-12T13:30:00Z"); // 22:30 KST
  const R1 = 1794871566e3; // 11/17 08:26 KST
  const a = forecastWindow(win({ usedPercent: 36, resetsAtMs: R1, observedAtMs: O }), O);
  assert.strictEqual(a.state, "safe");
  assert.ok(Math.abs(a.atReset - 97.446) < 0.01, String(a.atReset));
  // 같은 36% 인데 서버가 리셋을 2일 늦춰 보냄(창 시작도 2일 뒤로) → 경과가 짧아져 평균이 빨라짐
  const R2 = R1 + 2 * 24 * 60 * MIN;
  const b = forecastWindow(win({ usedPercent: 36, resetsAtMs: R2, observedAtMs: O }), O);
  assert.strictEqual(b.startMs, R2 - WEEK * MIN, "창 시작 = 최신 리셋 − 길이");
  assert.strictEqual(b.state, "before");
});

test("5시간 창 15분째 5% → 보고 반올림 범위 90~110% 걸침 = 경계", () => {
  const R = Date.parse("2026-11-12T18:00:00Z");
  const f = forecastWindow({ id: "s", span: "5h", windowMins: 300, usedPercent: 5, resetsAtMs: R, observedAtMs: R - 285 * MIN }, R - 280 * MIN);
  assert.strictEqual(f.state, "boundary");
  assert.ok(Math.abs(f.atResetLo - 90) < 1e-9 && Math.abs(f.atResetHi - 110) < 1e-9);
});

test("lo 가 정확히 100% 면 '리셋 전 소진'이 아니라 경계", () => {
  const R = Date.parse("2026-11-12T18:00:00Z");
  const f = forecastWindow({ id: "s", span: "5h", windowMins: 300, usedPercent: 5.5, resetsAtMs: R, observedAtMs: R - 285 * MIN }, R - 280 * MIN);
  assert.ok(Math.abs(f.atResetLo - 100) < 1e-9);
  assert.strictEqual(f.state, "boundary");
});

test("주간 창 초반이라도 빠른 소모(8시간에 80%)는 숨기지 않음", () => {
  const R = Date.parse("2026-11-19T00:00:00Z");
  const f = forecastWindow(win({ usedPercent: 80, resetsAtMs: R, observedAtMs: R - WEEK * MIN + 8 * 60 * MIN }), R - 6 * 24 * 60 * MIN);
  assert.strictEqual(f.state, "before");
});

test("상태 우선순위: 리셋 지남 → 100% 보고 → 계산 불가 → 보류 → 0% → 관측 시간 없음", () => {
  const R = Date.parse("2026-11-19T00:00:00Z");
  const O = R - 3 * 24 * 60 * MIN;
  assert.strictEqual(forecastWindow(win({ usedPercent: 50, resetsAtMs: R, observedAtMs: O }), R).state, "expired");
  assert.strictEqual(forecastWindow(win({ usedPercent: 100, resetsAtMs: null, windowMins: null, observedAtMs: O }), O).state, "reached", "100% 는 리셋·길이 없어도 사실로");
  assert.strictEqual(forecastWindow(win({ usedPercent: 50, resetsAtMs: R, windowMins: null, observedAtMs: O }), O).state, "unknown");
  assert.strictEqual(forecastWindow(win({ usedPercent: 50, resetsAtMs: R, observedAtMs: O }), O, { held: true }).state, "held");
  assert.strictEqual(forecastWindow(win({ usedPercent: 0, resetsAtMs: R, observedAtMs: O }), O).state, "idle");
  assert.strictEqual(forecastWindow(win({ usedPercent: 5, resetsAtMs: R, observedAtMs: R - WEEK * MIN }), O).state, "tooEarly", "창 시작 = 관측");
});

test("예상 소진 시각이 지났는데 100% 관측이 없으면 도달로 확정하지 않고 '새 관측 필요'", () => {
  const R = Date.parse("2026-11-19T00:00:00Z");
  const O = R - 4 * 24 * 60 * MIN;
  const f0 = forecastWindow(win({ usedPercent: 60, resetsAtMs: R, observedAtMs: O }), O);
  assert.strictEqual(f0.state, "before");
  const f = forecastWindow(win({ usedPercent: 60, resetsAtMs: R, observedAtMs: O }), f0.etaMs + MIN);
  assert.strictEqual(f.etaPassed, true);
  assert.ok(forecastText(f, false, "ko").includes("새 관측 필요"));
});

test("오래된 관측이면 '마지막 관측 … 기준'을 덧붙임", () => {
  const R = Date.parse("2026-11-19T00:00:00Z");
  const O = R - 3 * 24 * 60 * MIN;
  const f = forecastWindow(win({ usedPercent: 30, resetsAtMs: R, observedAtMs: O }), O);
  assert.ok(forecastText(f, true, "ko").includes("마지막 관측"));
  assert.ok(!forecastText(f, false, "ko").includes("마지막 관측"));
});

// ---------------- 같은 창 추적(리셋 기준 변화) ----------------

const R0 = Date.parse("2026-11-17T08:26:06Z");
const obs = (u, R, O) => win({ usedPercent: u, resetsAtMs: R, observedAtMs: O });

test("리셋 시각 몇 초 흔들림은 같은 창 — 샘플 이어짐, 보류 없음", () => {
  const wt = new LimitWatch();
  wt.observe([obs(30, R0, 1000)]);
  wt.observe([obs(31, R0 + 1000, 2000)]);
  wt.observe([obs(32, R0 - 4000, 3000)]);
  assert.strictEqual(wt.samplesFor(obs(32, R0, 3000)).length, 3);
  assert.strictEqual(wt.isHeld(obs(32, R0, 3000)), false);
});

test("조기 재시작(리셋 시각 크게 이동 + 사용률 하락)은 새 창 — 보류 아님, 이전 창 샘플과 잇지 않음", () => {
  const wt = new LimitWatch();
  wt.observe([obs(95, R0, 1000)]);
  const R1 = R0 + 136 * 60 * MIN;
  wt.observe([obs(2, R1, 2000)]);
  assert.strictEqual(wt.isHeld(obs(2, R1, 2000)), false);
  assert.strictEqual(wt.samplesFor(obs(2, R1, 2000)).length, 1);
});

test("두 기준이 번갈아 와도(9/9 실관측 형태) 서로를 복원으로 오해하지 않고 각자 기록 유지", () => {
  const wt = new LimitWatch();
  const RA = R0, RB = R0 + 22.91 * 60 * MIN;
  wt.observe([obs(36, RA, 1000)]);
  wt.observe([obs(15, RB, 2000)]);
  wt.observe([obs(36, RA, 3000)]);
  assert.strictEqual(wt.isHeld(obs(36, RA, 3000)), false);
  assert.strictEqual(wt.isHeld(obs(15, RB, 2000)), false);
  assert.strictEqual(wt.samplesFor(obs(36, RA, 3000)).length, 2);
});

test("같은 창에서 단계적 하락(50→49→48→47)도 누적으로 감지해 보류, 1%p 역행(12→11)은 보류 아님", () => {
  const wt = new LimitWatch();
  [50, 49, 48, 47].forEach((u, i) => wt.observe([obs(u, R0, 1000 + i)]));
  assert.strictEqual(wt.isHeld(obs(47, R0, 1004)), true);
  const wt2 = new LimitWatch();
  wt2.observe([obs(12, R0, 1000)]);
  wt2.observe([obs(11, R0, 2000)]);
  assert.strictEqual(wt2.isHeld(obs(11, R0, 2000)), false);
});

test("사용률 0%에서 리셋 시각이 조금씩 밀릴 때 허용 오차는 처음 본 기준과 비교(연쇄 비교 금지)", () => {
  const wt = new LimitWatch();
  [0, 30, 60, 90, 120, 150].forEach((sec, i) => wt.observe([obs(0, R0 + sec * 1000, 1000 + i)]));
  assert.strictEqual(wt.samplesFor(obs(0, R0, 1005)).length, 5, "R0+150초는 R0 기준 2분 밖 → 다른 창");
  assert.strictEqual(wt.samplesFor(obs(0, R0 + 150 * 1000, 1005)).length, 1);
});

test("늦게 도착한 옛 관측은 반영하지 않음 · clear() 는 전부 비움", () => {
  const wt = new LimitWatch();
  wt.observe([obs(40, R0, 5000)]);
  wt.observe([obs(10, R0, 4000)]);
  assert.strictEqual(wt.isHeld(obs(40, R0, 5000)), false);
  wt.clear();
  assert.strictEqual(wt.samplesFor(obs(40, R0, 5000)).length, 0);
});

test("같은 관측 시각·사용률이라도 최신 리셋·창 시작·충돌 정보는 새 응답 것을 씀(노후 시각만 유지)", () => {
  const wt = new LimitWatch();
  const first = acceptObservations(wt, undefined, [obs(50, R0, 1_000_000)], 5 * MIN);
  wt.observe(first);
  const moved = { ...obs(50, R0 + 90_000, 1_000_000), metaConflict: true };
  const again = acceptObservations(wt, first, [moved], 5 * MIN);
  assert.strictEqual(again[0].resetsAtMs, R0 + 90_000);
  assert.strictEqual(again[0].metaConflict, true);
  assert.strictEqual(again[0].staleAtMs, first[0].staleAtMs);
});

test("겹치는 기준 중 어느 쪽에서 보든 같은 창 하락이면 처음부터 보류(A 80@R → B 0@R+180초 → C 20@R+90초)", () => {
  const wt = new LimitWatch();
  wt.observe([obs(80, R0, 1000)]);
  wt.observe([obs(0, R0 + 180_000, 2000)]);
  wt.observe([obs(20, R0 + 90_000, 3000)]);
  assert.strictEqual(wt.isHeld(obs(20, R0 + 90_000, 3000)), true);
});

test("0%가 아닌 리셋 전 기록은 다른 기준을 여럿 봐도 지우지 않음(A 80 → 다른 기준 0% ×6 → A 20 = 보류)", () => {
  const wt = new LimitWatch();
  wt.observe([obs(80, R0, 1000)]);
  for (let i = 1; i <= 6; i++) wt.observe([obs(0, R0 + i * 10 * 60 * MIN, 1000 + i)]);
  wt.observe([obs(20, R0, 2000)]);
  assert.strictEqual(wt.isHeld(obs(20, R0, 2000)), true);
});

test("화면에서 잠시 빠졌던 미터의 옛 관측은 다시 받지 않음(목록에서 제외)", () => {
  const wt = new LimitWatch();
  const first = acceptObservations(wt, undefined, [obs(60, R0, 5000)], 5 * MIN);
  wt.observe(first);
  const back = acceptObservations(wt, [], [obs(20, R0, 4000)], 5 * MIN);
  assert.strictEqual(back.length, 0);
});

test("같은 관측 시각의 사용률 정정은 그래프 마지막 샘플도 바꾸고, 노후 시각은 늘리지 않음", () => {
  const wt = new LimitWatch();
  let shown = acceptObservations(wt, undefined, [obs(10, R0, 1_000_000 - MIN)], 5 * MIN);
  wt.observe(shown);
  shown = acceptObservations(wt, shown, [obs(20, R0, 1_000_000)], 5 * MIN);
  wt.observe(shown);
  const staleAt = shown[0].staleAtMs;
  shown = acceptObservations(wt, shown, [obs(30, R0, 1_000_000)], 20 * MIN);
  wt.observe(shown);
  assert.strictEqual(shown[0].usedPercent, 30);
  assert.strictEqual(shown[0].staleAtMs, staleAt);
  assert.deepStrictEqual(wt.samplesFor(shown[0]).map((x) => x.v), [10, 30]);
});

test("0%뿐인 기록이 지워져도 그 미터의 더 오래된 관측은 다시 받지 않음(A 0%@T → 다른 기준 0%×6 → 70%@T+10초 → A 0%@T−1분 거부)", () => {
  const T = 5_000_000;
  const wt = new LimitWatch();
  let shown = acceptObservations(wt, undefined, [obs(0, R0, T)], 5 * MIN);
  wt.observe(shown);
  for (let i = 1; i <= 6; i++) {
    shown = acceptObservations(wt, shown, [obs(0, R0 + i * 10 * 60 * MIN, T + i)], 5 * MIN);
    wt.observe(shown);
  }
  shown = acceptObservations(wt, shown, [obs(70, R0 + 7 * 10 * 60 * MIN, T + 10_000)], 5 * MIN);
  wt.observe(shown);
  shown = acceptObservations(wt, shown, [obs(0, R0, T - MIN)], 5 * MIN);
  assert.strictEqual(shown[0].usedPercent, 70);
  assert.strictEqual(shown[0].observedAtMs, T + 10_000);
});

test("기록 상한을 넘겨 보류 기록을 잃을 수 있으면 확인한 보류를 정상으로 되돌리지 않음(추적 정보 부족 → 보류)", () => {
  const wt = new LimitWatch();
  let o = 1000;
  wt.observe([obs(80, R0, (o += 1))]);
  wt.observe([obs(20, R0, (o += 1))]);
  for (let i = 1; i <= 41; i++) {
    const R = R0 + i * 10 * 60 * MIN;
    wt.observe([obs(80, R, (o += 1))]);
    wt.observe([obs(20, R, (o += 1))]);
  }
  assert.strictEqual(wt.isHeld(obs(20, R0, (o += 1))), true);
});

test("기준 교대 뒤 같은 옛 관측(A52@T)이 다시 와도 표시·노후 기한이 바뀌지 않음", () => {
  const T = 9_000_000;
  const wt = new LimitWatch();
  const RB = R0 + 22.91 * 60 * MIN;
  let shown = acceptObservations(wt, undefined, [obs(52, R0, T)], 5 * MIN);
  wt.observe(shown);
  shown = acceptObservations(wt, shown, [obs(20, RB, T + MIN)], 5 * MIN);
  wt.observe(shown);
  const bStale = shown[0].staleAtMs;
  shown = acceptObservations(wt, shown, [obs(52, R0, T)], 20 * MIN);
  assert.strictEqual(shown[0].usedPercent, 20, "옛 A는 받지 않음");
  assert.strictEqual(shown[0].staleAtMs, bStale, "노후 기한 그대로");
});

test("보류 뒤 다시 올라간 겹침 관측도 겹치는 보류 기록이 있으면 보류(A 80→20 · B@R+170초 0% · R+90초 80%)", () => {
  const wt = new LimitWatch();
  wt.observe([obs(80, R0, 1000)]);
  wt.observe([obs(20, R0, 2000)]);
  wt.observe([obs(0, R0 + 170_000, 3000)]);
  wt.observe([obs(80, R0 + 90_000, 4000)]);
  assert.strictEqual(wt.isHeld(obs(80, R0 + 90_000, 4000)), true);
});

test("리셋 시각이 없는 관측(100% 보고)도 최신 수락으로 남아, 그보다 오래된 값이 덮지 않음", () => {
  const T = 7_000_000;
  const wt = new LimitWatch();
  let shown = acceptObservations(wt, undefined, [obs(40, R0, T)], 5 * MIN);
  wt.observe(shown);
  shown = acceptObservations(wt, shown, [{ ...obs(100, null, T + 2 * MIN), resetsAtMs: null }], 5 * MIN);
  wt.observe(shown);
  shown = acceptObservations(wt, shown, [obs(50, R0, T + MIN)], 5 * MIN);
  assert.strictEqual(shown[0].usedPercent, 100);
});

test("기록 상한 초과 보류는 '추적 정보 부족'으로 따로 표시, 0%뿐인 기록은 상한에 세지 않음", () => {
  const wt = new LimitWatch();
  let o = 1000;
  for (let i = 0; i < 35; i++) wt.observe([obs(10, R0 + i * 10 * 60 * MIN, (o += 1))]);
  for (let i = 0; i < 6; i++) wt.observe([obs(0, R0 + (100 + i) * 10 * 60 * MIN, (o += 1))]);
  assert.strictEqual(wt.isHeld(obs(10, R0, (o += 1))), false, "사용 기록 35 + 0% 6 은 상한 초과 아님");
  for (let i = 35; i < 45; i++) wt.observe([obs(10, R0 + i * 10 * 60 * MIN, (o += 1))]);
  const w = obs(10, R0, (o += 1));
  assert.strictEqual(wt.holdReason(w), "tracking");
  const f = forecastWindow({ ...w, resetsAtMs: R0 }, (o += 1), { heldReason: "tracking" });
  assert.strictEqual(f.state, "held");
  assert.ok(forecastText(f, false, "ko").includes("추적 기록이 부족"), forecastText(f, false, "ko"));
  assert.ok(!forecastText(f, false, "ko").includes("사용률이 내려감"));
});

test("서버가 정한 재시도 대기(Retry-After)는 줄이지 않음 — 초·HTTP 날짜 모두", () => {
  assert.strictEqual(claudeApiModule.parseRetryAfterMs({ "retry-after": "1800" }), 1_800_000);
  const now = Date.parse("2026-11-12T10:00:00Z");
  assert.strictEqual(claudeApiModule.parseRetryAfterMs({ "retry-after": "Thu, 12 Nov 2026 10:45:00 GMT" }, now), 45 * MIN);
  assert.strictEqual(claudeApiModule.parseRetryAfterMs({}), 60_000);
});

test("사용 기록 40개에 새 0% 기록이 더해져도 지우거나 '추적 정보 부족' 보류를 만들지 않음", () => {
  const wt = new LimitWatch();
  let o = 1000;
  for (let i = 0; i < 40; i++) wt.observe([obs(10, R0 + i * 10 * 60 * MIN, (o += 1))]);
  wt.observe([obs(0, R0 + 500 * 10 * 60 * MIN, (o += 1))]);
  const back = obs(10, R0, (o += 1));
  assert.strictEqual(wt.holdReason(back), null);
  wt.observe([back]);
  assert.strictEqual(wt.samplesFor(back).length, 2, "원래 기준 기록이 남아 있음");
});

// ---------------- 서비스 흐름(순서·세대·대기) ----------------
const { EventEmitter } = require("events");
const claudeApi = require("../out/claudeApi.js");
const codexClient = require("../out/codexClient.js");
const { ClaudeService } = require("../out/claudeService.js");
const { withViews } = require("../out/dashboard.js");
const { UsageService } = require("../out/usageService.js");
const output = { appendLine() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("until: 조건이 시간 안에 충족되지 않음");
    await sleep(1);
  }
};
const { LimitHistoryStore, historyAccountKey, appendPoint, mergeChartSamples, thinKeepEnds, chartSeries } = require("../out/limitHistory.js");
const HOUR = 3600e3;
const histWin = (R, u, O, id = "weekly_all") => ({ id, span: "weekly", windowMins: WEEK, kind: "weekly_all", usedPercent: u, resetsAtMs: R, observedAtMs: O, observedSource: "received" });
const withHistDir = async (fn) => {
  const fs = require("fs");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cum-hist-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};


test("미터 표시는 관측 시각상 뒤로 가지 않음(서버 산출 시각 역행 거부 · 기준이 바뀐 창도 더 새 관측만)", () => {
  const wt = new LimitWatch();
  const prev = acceptObservations(wt, undefined, [obs(60, R0, 2000)], 5 * MIN);
  wt.observe(prev);
  assert.strictEqual(acceptObservations(wt, prev, [obs(52, R0, 1000)], 5 * MIN)[0].usedPercent, 60);
  assert.strictEqual(acceptObservations(wt, prev, [obs(5, R0 + 40 * 60 * MIN, 3000)], 5 * MIN)[0].usedPercent, 5, "기준이 바뀐 창의 더 새 관측은 받음");
  assert.strictEqual(acceptObservations(wt, prev, [obs(5, R0 + 40 * 60 * MIN, 1000)], 5 * MIN)[0].usedPercent, 60, "기준이 바뀌었어도 더 오래된 관측은 거부");
});

test("두 기준이 번갈아 올 때도 기준별 최신성 유지(A52@T → B20@T+1 → A51@T−1 는 거부)", () => {
  const wt = new LimitWatch();
  const RB = R0 + 22.91 * 60 * MIN;
  let shown = acceptObservations(wt, undefined, [obs(52, R0, 10_000)], 5 * MIN);
  wt.observe(shown);
  shown = acceptObservations(wt, shown, [obs(20, RB, 11_000)], 5 * MIN);
  wt.observe(shown);
  shown = acceptObservations(wt, shown, [obs(51, R0, 9_000)], 5 * MIN);
  assert.strictEqual(shown[0].usedPercent, 20, "이미 본 A보다 오래된 A(51)는 표시에 쓰지 않음");
});

test("노후 시각은 창마다 관측 때 고정 — 같은 관측을 다시 받아도 늘리지 않음", () => {
  const wt = new LimitWatch();
  const first = acceptObservations(wt, undefined, [obs(30, R0, 1_000_000)], 5 * MIN);
  assert.strictEqual(first[0].staleAtMs, 1_000_000 + 5 * MIN);
  wt.observe(first);
  const again = acceptObservations(wt, first, [obs(30, R0, 1_000_000)], 50 * MIN);
  assert.strictEqual(again[0].staleAtMs, 1_000_000 + 5 * MIN);
});

test("창마다 노후 판정: 서버 산출 시각이 60분 전인 주간 창만 '마지막 관측' 표시", () => {
  const nowT = RECEIVED + 60 * MIN;
  const plan = normalizeUsage(
    { ...claudeWeeklyLive, seven_day_breakdown: { as_of: new Date(nowT - 60 * MIN).toISOString(), window_started_at: "2026-11-09T13:00:00.206755+00:00" } },
    nowT,
  );
  const wt = new LimitWatch();
  const shown = acceptObservations(wt, undefined, plan.windows, 5 * MIN);
  const views = withViews(shown, {}, { failing: false }, nowT);
  const weekly = views.find((v) => v.id === "weekly_all");
  const fable = views.find((v) => v.id === "weekly_scoped:fable");
  assert.ok(weekly.forecastText.includes("마지막 관측"), weekly.forecastText);
  assert.ok(!fable.forecastText.includes("마지막 관측"), fable.forecastText);
});

test("허용 범위가 겹쳐도 보류가 풀리지 않음(R0 80→20 보류, R0+180초 0%, R0+90초 20%)", () => {
  const wt = new LimitWatch();
  wt.observe([obs(80, R0, 1000)]);
  wt.observe([obs(20, R0, 2000)]);
  wt.observe([obs(0, R0 + 180_000, 3000)]);
  wt.observe([obs(20, R0 + 90_000, 4000)]);
  assert.strictEqual(wt.isHeld(obs(20, R0 + 90_000, 4000)), true);
});

test("다른 기준을 여럿 본 뒤 돌아와도 리셋 전 보류 기록은 남음", () => {
  const wt = new LimitWatch();
  wt.observe([obs(80, R0, 1000)]);
  wt.observe([obs(20, R0, 2000)]);
  for (let i = 1; i <= 6; i++) wt.observe([obs(5, R0 + i * 10 * 60 * MIN, 2000 + i)]);
  assert.strictEqual(wt.isHeld(obs(20, R0, 3000)), true);
});

test("경계 상태에서도 예상 시각이 지나면 '새 관측 필요', 리셋 지남·100% 보고에도 창 좌표 유지", () => {
  const R = Date.parse("2026-11-12T18:00:00Z");
  const w5 = { id: "s", span: "5h", windowMins: 300, usedPercent: 5.5, resetsAtMs: R, observedAtMs: R - 285 * MIN };
  const f0 = forecastWindow(w5, R - 284 * MIN);
  assert.strictEqual(f0.state, "boundary");
  const f = forecastWindow(w5, f0.etaMs + MIN);
  assert.strictEqual(f.etaPassed, true);
  assert.ok(forecastText(f, false, "ko").includes("새 관측 필요"));
  const ex = forecastWindow(w5, R + MIN);
  assert.strictEqual(ex.state, "expired");
  assert.strictEqual(ex.startMs, R - 300 * MIN);
  const full = forecastWindow({ ...w5, usedPercent: 100 }, R - 200 * MIN);
  assert.strictEqual(full.state, "reached");
  assert.strictEqual(full.startMs, R - 300 * MIN);
});

test("서버 창 정보가 있는데 해석이 안 되면(형식 오류) 정보 없음이 아니라 확인 대기", () => {
  const bad = JSON.parse(JSON.stringify(claudeWeeklyLive));
  bad.seven_day_breakdown = { as_of: "invalid", window_started_at: "invalid" };
  const w = normalizeUsage(bad, RECEIVED).windows.find((x) => x.id === "weekly_all");
  assert.strictEqual(w.metaConflict, true);
  assert.strictEqual(forecastWindow(w, RECEIVED + MIN).state, "metaPending");
});

async function serviceTests() {
  const atest = async (name, fn) => {
    await fn();
    passed += 1;
    console.log("ok -", name);
  };

  const weeklyUsage = (u, O) => ({
    usage: {
      windows: [{ id: "weekly_all", span: "weekly", windowMins: WEEK, kind: "weekly_all", usedPercent: u, resetsAtMs: R0, observedAtMs: O, observedSource: "received" }],
      extraUsage: null,
    },
    subscriptionType: "max",
    loginKey: "login-test", // 같은 로그인(토큰) 구간
  });
  // 조회 전·대기 중 판단이 실제 로그인 파일을 읽지 않게: 기본은 위와 같은 로그인 구간.
  const defaultLoginKey = () => "login-test";
  claudeApi.readLoginKey = defaultLoginKey;

  await atest("Claude: 겹친 조회는 하나로 합쳐 순서대로(오래된 응답이 새 값을 덮지 않음)", async () => {
    let calls = 0;
    const gates = [deferred(), deferred()];
    claudeApi.fetchPlanUsage = async () => {
      const i = calls++;
      await gates[i].promise;
      return weeklyUsage(i === 0 ? 52 : 60, 1000 + i);
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const svc = new ClaudeService(output);
    const p1 = svc.refreshPlan(true);
    const p2 = svc.refreshPlan(true);
    assert.strictEqual(calls, 1, "진행 중엔 새로 부르지 않음");
    gates[0].resolve();
    await p1;
    await p2;
    await sleep(5);
    assert.strictEqual(calls, 2, "끝난 뒤 1회 재실행");
    gates[1].resolve();
    await sleep(5);
    assert.strictEqual(svc.currentState.plan.windows[0].usedPercent, 60);
    svc.dispose();
  });

  await atest("Claude: 429 대기 중에는 합쳐진 후속 요청·수동 새로고침도 서버를 부르지 않음", async () => {
    let calls = 0;
    const gate = deferred();
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      await gate.promise;
      return { rateLimited: true, retryAfterMs: 600_000 };
    };
    const svc = new ClaudeService(output);
    const p1 = svc.refreshPlan(true);
    svc.refreshPlan(true); // 합쳐짐
    gate.resolve();
    await p1;
    await sleep(5);
    assert.strictEqual(calls, 1);
    await svc.refreshPlan(true);
    assert.strictEqual(calls, 1, "대기 시각 전 수동 새로고침도 호출 안 함");
    svc.dispose();
  });

  await atest("Claude: 같은 계정이면 다시 조회·재구성해도 복원 보류 유지, 실제 계정이 바뀌면 초기화", async () => {
    let u = 80;
    let identity = "acct-A";
    let o = 1000;
    claudeApi.fetchPlanUsage = async () => weeklyUsage(u, (o += 1000));
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity });
    const svc = new ClaudeService(output);
    await svc.refreshPlan(true);
    u = 20;
    await svc.refreshPlan(true);
    assert.strictEqual(svc.currentState.holds.weekly_all, true);
    await svc.refreshPlan(true);
    assert.strictEqual(svc.currentState.holds.weekly_all, true, "같은 계정 재조회 후에도 보류");
    identity = "acct-B";
    await svc.refreshPlan(true);
    assert.strictEqual(svc.currentState.holds.weekly_all, false, "계정 변경 시 이전 기록 폐기");
    svc.dispose();
  });

  await atest("Claude: 조회 중 계정이 바뀌면 그 응답은 버리고 새 계정으로 다시 조회(이전 계정 값·기록이 섞이지 않음)", async () => {
    let calls = 0;
    let identity = "acct-A";
    const gate = deferred();
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      if (calls === 1) {
        await gate.promise;
        return weeklyUsage(80, 5000);
      }
      return weeklyUsage(10, 4000);
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity });
    const svc = new ClaudeService(output);
    const p1 = svc.refreshPlan(true);
    identity = "acct-B";
    gate.resolve();
    await p1;
    await sleep(10);
    assert.strictEqual(calls, 2, "버린 뒤 재조회");
    assert.strictEqual(svc.currentState.plan.windows[0].usedPercent, 10, "새 계정 값(더 이른 서버 시각이어도)");
    assert.strictEqual(svc.currentState.holds.weekly_all, false, "80→10 을 복원으로 오인하지 않음");
    svc.dispose();
  });

  // 종료 뒤 재예약 여부를 보기 위해 긴 타이머 생성을 센다(즉시 실행 타이머는 무시).
  const countLongTimers = async (fn) => {
    const orig = global.setTimeout;
    let n = 0;
    global.setTimeout = (cb, ms, ...a) => {
      if (ms >= 1000) n += 1;
      return orig(cb, ms, ...a);
    };
    try {
      await fn();
    } finally {
      global.setTimeout = orig;
    }
    return n;
  };

  await atest("Claude: 종료(dispose) 뒤 도착한 응답은 반영·재예약하지 않음", async () => {
    const gate = deferred();
    claudeApi.fetchPlanUsage = async () => {
      await gate.promise;
      return weeklyUsage(33, 7000);
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const svc = new ClaudeService(output);
    const p1 = svc.refreshPlan(true);
    svc.dispose();
    const timers = await countLongTimers(async () => {
      gate.resolve();
      await p1;
      await sleep(5);
    });
    assert.strictEqual(svc.currentState.plan, undefined);
    assert.strictEqual(timers, 0);
  });

  await atest("Claude: 조회 중 계정이 바뀌어 응답을 버려도 서버 대기(10분)는 지키고 그동안 '계정 확인 중' 표시", async () => {
    let calls = 0;
    let identity = "acct-A";
    const gate = deferred();
    const seen = [];
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      if (calls === 1) {
        await gate.promise;
        return { rateLimited: true, retryAfterMs: 600_000 };
      }
      return weeklyUsage(15, 9000);
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity });
    const svc = new ClaudeService(output);
    svc.onDidChange = () => ({ dispose() {} });
    const origSet = svc.setState.bind(svc);
    svc.setState = (patch) => {
      if (patch.planAccountChecking) seen.push("checking");
      origSet(patch);
    };
    const p1 = svc.refreshPlan(true);
    identity = "acct-B";
    gate.resolve();
    await p1;
    await sleep(10);
    assert.strictEqual(calls, 1, "서버 대기 전에는 새 계정도 조회하지 않음");
    assert.ok(svc.planNextAllowedAt - Date.now() > 9 * MIN, "버린 응답의 대기도 보존");
    assert.ok(seen.includes("checking"), "확인 중 표시");
    assert.strictEqual(svc.currentState.planAccountChecking, true, "대기 동안 확인 중 유지");
    svc.dispose();
  });

  await atest("Claude: 조회 시작 전에 이미 계정이 바뀌었으면 응답을 기다리는 동안 '계정 확인 중' 표시", async () => {
    let identity = "acct-A";
    let calls = 0;
    const gate = deferred();
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      if (calls === 2) await gate.promise;
      return weeklyUsage(calls === 1 ? 80 : 15, 1000 * calls);
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity });
    const svc = new ClaudeService(output);
    await svc.refreshPlan(true); // A 80%
    identity = "acct-B";
    const p2 = svc.refreshPlan(true);
    await sleep(5);
    assert.strictEqual(svc.currentState.planAccountChecking, true, "대기 중 확인 표시");
    gate.resolve();
    await p2;
    assert.strictEqual(svc.currentState.planAccountChecking, false);
    assert.strictEqual(svc.currentState.plan.windows[0].usedPercent, 15);
    svc.dispose();
  });

  // 시작 도중 종료 시험용: 주기 타이머(setInterval) 생성 수를 센다.
  const countIntervals = async (fn) => {
    const orig = global.setInterval;
    let n = 0;
    global.setInterval = (...a) => {
      n += 1;
      return orig(...a);
    };
    try {
      await fn();
    } finally {
      global.setInterval = orig;
    }
    return n;
  };

  await atest("Claude: 시작 도중 종료하면 주기 타이머·파일 감시를 만들지 않음", async () => {
    const gate = deferred();
    claudeApi.fetchPlanUsage = async () => {
      await gate.promise;
      return weeklyUsage(10, 1000);
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const svc = new ClaudeService(output);
    let watched = 0;
    svc.setupWatcher = () => (watched += 1);
    const n = await countIntervals(async () => {
      const started = svc.start();
      await sleep(5);
      svc.dispose();
      gate.resolve();
      await started;
    });
    assert.strictEqual(n, 0);
    assert.strictEqual(watched, 0);
  });

  await atest("Claude: 서버가 30분 대기를 요구하면 그 시각 전에는 수동 새로고침도 부르지 않음", async () => {
    let calls = 0;
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      return { rateLimited: true, retryAfterMs: 30 * MIN };
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const svc = new ClaudeService(output);
    await svc.refreshPlan(true);
    assert.ok(svc.planNextAllowedAt - Date.now() > 25 * MIN, "대기 시각이 서버 요구(30분)만큼");
    await svc.refreshPlan(true);
    assert.strictEqual(calls, 1);
    svc.dispose();
  });

  // 임시 설정 폴더 + 가짜 https(토큰·사용량 응답을 원하는 때까지 멈춰 둘 수 있음)로 실제 fetchPlanUsage 를 실행한다.
  const withFakeClaudeServer = async (fn) => {
    const fs = require("fs");
    const os = require("os");
    const https = require("https");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cum-creds-"));
    const credFile = path.join(dir, ".credentials.json");
    // 시험이 Claude Code 역할로 쓰는 것은 원래 함수로 — 아래 감시는 확장 쪽 쓰기만 잡는다.
    const realWriteFileSync = fs.writeFileSync;
    const write = (c) => realWriteFileSync(credFile, JSON.stringify({ claudeAiOauth: c }));
    const read = () => JSON.parse(fs.readFileSync(credFile, "utf8")).claudeAiOauth;
    const gates = { token: null, usage: null };
    const cfg = { tokenStatus: 200, usageStatus: 200, retryAfter: undefined, counts: { token: 0, usage: 0 } };
    const origRequest = https.request;
    https.request = (opts, cb) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.destroy = () => {};
      req.end = async () => {
        let body;
        let status;
        if (opts.path.includes("/oauth/token")) {
          cfg.counts.token += 1;
          if (gates.token) await gates.token.promise;
          if (cfg.onToken) await cfg.onToken(cfg.counts.token);
          status = cfg.tokenStatus;
          const n = cfg.counts.token;
          body = JSON.stringify({
            access_token: n === 1 ? "A-new" : `A-new${n}`,
            refresh_token: cfg.keepRefresh ? "A-rt" : n === 1 ? "A-rt2" : `A-rt${n + 1}`,
            expires_in: 3600,
          });
        } else {
          cfg.counts.usage += 1;
          if (gates.usage) await gates.usage.promise;
          status = cfg.usageStatuses && cfg.usageStatuses.length ? cfg.usageStatuses.shift() : cfg.usageStatus;
          const u = opts.headers.Authorization === "Bearer B-tok" ? 15 : 80;
          body = JSON.stringify({ seven_day: { utilization: u, resets_at: new Date(R0).toISOString() } });
        }
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = status === 429 && cfg.retryAfter ? { "retry-after": cfg.retryAfter } : {};
        cb(res);
        res.emit("data", body);
        res.emit("end");
      };
      return req;
    };
    // 확장이 자격증명 폴더(와 그 옆 잠금 경로)에 무언가를 쓰거나 만들거나 지우면 기록한다.
    const extWrites = [];
    const touches = (target) => {
      try {
        return String(target).startsWith(dir);
      } catch {
        return false;
      }
    };
    const syncNames = ["writeFileSync", "appendFileSync", "renameSync", "copyFileSync", "mkdirSync", "rmdirSync", "rmSync", "unlinkSync", "utimesSync", "openSync"];
    const cbNames = ["writeFile", "appendFile", "rename", "copyFile", "mkdir", "rmdir", "rm", "unlink", "utimes"];
    const promiseNames = ["writeFile", "appendFile", "rename", "copyFile", "mkdir", "rmdir", "rm", "unlink", "utimes", "open"];
    const saved = { fs: {}, promises: {} };
    for (const name of [...syncNames, ...cbNames]) {
      saved.fs[name] = fs[name];
      fs[name] = function (target, ...rest) {
        const flags = name === "openSync" ? String(rest[0] ?? "r") : "w";
        if (touches(target) && flags !== "r") extWrites.push(`${name} ${path.basename(String(target))}`);
        return saved.fs[name].call(this, target, ...rest);
      };
    }
    for (const name of promiseNames) {
      saved.promises[name] = fs.promises[name];
      fs.promises[name] = function (target, ...rest) {
        const flags = name === "open" ? String(rest[0] ?? "r") : "w";
        if (touches(target) && flags !== "r") extWrites.push(`promises.${name} ${path.basename(String(target))}`);
        return saved.promises[name].call(this, target, ...rest);
      };
    }
    const restoreFs = () => {
      Object.assign(fs, saved.fs);
      Object.assign(fs.promises, saved.promises);
    };
    try {
      await fn({ dir, write, read, gates, cfg, credFile });
      assert.deepStrictEqual(extWrites, [], "확장은 Claude 자격증명 폴더에 아무것도 쓰지 않음");
      assert.strictEqual(cfg.counts.token, 0, "확장은 토큰 갱신 요청을 보내지 않음");
    } finally {
      restoreFs();
      https.request = origRequest;
      try {
        fs.chmodSync(credFile, 0o666);
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  await atest("Claude 사용량 조회 중 계정이 A→B→A로 오가도 그 조회는 버림(다른 계정 값이 섞이지 않음)", async () => {
    await withFakeClaudeServer(async ({ dir, write, gates }) => {
      write({ accessToken: "A-tok", refreshToken: "A-rt", expiresAt: Date.now() + 3600_000 });
      gates.usage = deferred();
      const done = realFetchPlanUsage({ configDirOverride: dir });
      await sleep(5);
      write({ accessToken: "B-tok", refreshToken: "B-rt", expiresAt: Date.now() + 3600_000 });
      write({ accessToken: "A-tok2", refreshToken: "A-rt2", expiresAt: Date.now() + 3600_000 }); // 다시 A 로그인(새 토큰)
      gates.usage.resolve();
      const r = await done;
      assert.strictEqual(r.credentialsChanged, true);
    });
  });

  await atest("Claude 자격증명이 그대로면 정상 조회", async () => {
    await withFakeClaudeServer(async ({ dir, write }) => {
      write({ accessToken: "B-tok", refreshToken: "B-rt", expiresAt: Date.now() + 3600_000 });
      const r = await realFetchPlanUsage({ configDirOverride: dir });
      assert.strictEqual(r.credentialsChanged, undefined);
      assert.strictEqual(r.usage.windows[0].usedPercent, 15);
    });
  });

  await atest("같은 계정 토큰이 바뀌는 사이 사용량 조회가 429(30분)면 값은 버리되 대기는 보존", async () => {
    await withFakeClaudeServer(async ({ dir, write, gates, cfg }) => {
      write({ accessToken: "A-tok", refreshToken: "A-rt", expiresAt: Date.now() + 3600_000 });
      cfg.usageStatus = 429;
      cfg.retryAfter = "1800";
      gates.usage = deferred();
      const done = realFetchPlanUsage({ configDirOverride: dir });
      await sleep(5);
      write({ accessToken: "A-tok2", refreshToken: "A-rt2", expiresAt: Date.now() + 3600_000 }); // CLI 가 같은 계정 토큰 갱신
      gates.usage.resolve();
      const r = await done;
      assert.strictEqual(r.credentialsChanged, true);
      assert.strictEqual(r.rateLimited, true);
      assert.strictEqual(r.retryAfterMs, 1_800_000);
    });
    let calls = 0;
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      if (calls > 10) return new Promise(() => {}); // 결함 시 무한 재조회로 시험이 멈추지 않게 더 진행하지 않음
      await sleep(1); // 매번 양보해 결함이 있으면 시간 안에 호출 수로 드러나게
      return { credentialsChanged: true, rateLimited: true, retryAfterMs: 30 * MIN };
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const svc = new ClaudeService(output);
    await svc.refreshPlan(true);
    await sleep(20);
    assert.strictEqual(calls, 1, "대기 시각 전 재조회 없음");
    assert.ok(svc.planNextAllowedAt - Date.now() > 25 * MIN);
    svc.dispose();
  });

  await atest("토큰이 만료돼 있으면 서버를 부르지 않고(갱신 요청·사용량 조회 0회) '기다림'으로 돌려줌 — 파일은 그대로", async () => {
    await withFakeClaudeServer(async ({ dir, write, read, cfg }) => {
      write({ accessToken: "A-old", refreshToken: "A-rt", expiresAt: Date.now() - 1000 });
      const r = await realFetchPlanUsage({ configDirOverride: dir });
      assert.strictEqual(r.tokenExpired, true);
      assert.strictEqual(r.error, undefined, "오류가 아니라 기다림");
      assert.strictEqual(cfg.counts.usage, 0, "만료된 토큰으로 서버를 부르지 않음");
      assert.strictEqual(read().accessToken, "A-old");
    });
  });

  await atest("만료가 임박한 토큰도 갱신하지 않고 그대로 조회(갱신 요청 0회)", async () => {
    await withFakeClaudeServer(async ({ dir, write, cfg }) => {
      write({ accessToken: "A-tok", refreshToken: "A-rt", expiresAt: Date.now() + 1000 });
      const r = await realFetchPlanUsage({ configDirOverride: dir });
      assert.strictEqual(r.usage.windows[0].usedPercent, 80);
      assert.strictEqual(cfg.counts.usage, 1);
    });
  });

  await atest("사용량 조회가 401(서버가 토큰을 받지 않음)이면 갱신하지 않고 '기다림' — 오류 알림 아님", async () => {
    await withFakeClaudeServer(async ({ dir, write, read, cfg }) => {
      write({ accessToken: "A-tok", refreshToken: "A-rt", expiresAt: Date.now() + 3600_000 });
      cfg.usageStatus = 401;
      const r = await realFetchPlanUsage({ configDirOverride: dir });
      assert.strictEqual(r.tokenExpired, true);
      assert.strictEqual(r.error, undefined);
      assert.strictEqual(cfg.counts.usage, 1, "다시 시도하지 않음");
      assert.strictEqual(read().accessToken, "A-tok");
    });
  });

  await atest("조회 도중 Claude Code가 같은 계정 토큰을 바꿔도 확장은 파일을 건드리지 않고 그 조회만 버림", async () => {
    await withFakeClaudeServer(async ({ dir, write, read, gates, cfg }) => {
      write({ accessToken: "A-tok", refreshToken: "A-rt", expiresAt: Date.now() + 3600_000 });
      gates.usage = deferred();
      const done = realFetchPlanUsage({ configDirOverride: dir });
      await until(() => cfg.counts.usage === 1);
      write({ accessToken: "A-tok2", refreshToken: "A-rt2", expiresAt: Date.now() + 3600_000 });
      gates.usage.resolve();
      const r = await done;
      assert.strictEqual(r.credentialsChanged, true);
      assert.strictEqual(read().accessToken, "A-tok2", "Claude Code 가 쓴 토큰 그대로");
    });
  });

  await atest("Claude 서비스: 조회 도중 자격증명이 바뀌었다는 결과면 값·대기 없이 '계정 확인 중' 후 곧바로 재조회", async () => {
    let calls = 0;
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      return calls === 1 ? { credentialsChanged: true } : weeklyUsage(15, 9000 + calls);
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const svc = new ClaudeService(output);
    let checked = false;
    const origSet = svc.setState.bind(svc);
    svc.setState = (patch) => {
      if (patch.planAccountChecking) checked = true;
      origSet(patch);
    };
    await svc.refreshPlan(true);
    await sleep(10);
    assert.strictEqual(calls, 2);
    assert.ok(checked);
    assert.strictEqual(svc.currentState.plan.windows[0].usedPercent, 15);
    assert.strictEqual(svc.currentState.planAccountChecking, false);
    svc.dispose();
  });

  await atest("Claude 서비스: 토큰 만료로 기다리는 동안 마지막 값을 두고 오류 대신 '마지막 확인 시각'만 차분히 — 다시 받으면 해제", async () => {
    const { formatWhen } = require("../out/i18n.js");
    let mode = "ok";
    let calls = 0;
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      return mode === "ok" ? weeklyUsage(40 + calls, 1000 + calls) : { tokenExpired: true };
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const svc = new ClaudeService(output);
    await svc.refreshPlan(true);
    const lastRefresh = svc.currentState.lastPlanRefresh;
    const shown = svc.currentState.plan.windows[0].usedPercent;
    const interval = svc.planIntervalMs;
    mode = "expired";
    await svc.refreshPlan(true);
    let s = svc.currentState;
    assert.strictEqual(s.plan.windows[0].usedPercent, shown, "마지막 값 유지");
    assert.strictEqual(s.planError, undefined, "오류 알림 없음");
    assert.strictEqual(s.planFailing, true, "마지막 관측 기준임을 표시");
    assert.ok(s.planWaiting && s.planWaiting.includes(formatWhen(lastRefresh)), s.planWaiting);
    assert.strictEqual(svc.planIntervalMs, interval, "조회 간격을 늘리지 않음");
    assert.ok(formatClaudeTooltip(s).includes(s.planWaiting), "툴팁에 차분한 한 줄");
    mode = "ok";
    await svc.refreshPlan(true);
    s = svc.currentState;
    assert.strictEqual(s.planWaiting, undefined, "다시 받으면 해제");
    assert.strictEqual(s.planFailing, false);
    svc.dispose();
  });

  await atest("Claude 서비스: 자격증명 파일이 바뀌면(Claude Code 토큰 갱신·다른 계정 로그인) 다음 주기를 기다리지 않고 곧바로 다시 조회 — 다른 파일 변경은 무시", async () => {
    const fs = require("fs");
    const os = require("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cum-watch-"));
    const credFile = path.join(dir, ".credentials.json");
    fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: "A", refreshToken: "r", expiresAt: Date.now() - 1000 } }));
    const prevEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    let calls = 0;
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      return { tokenExpired: true };
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const svc = new ClaudeService(output);
    try {
      await svc.start();
      const base = calls;
      fs.writeFileSync(path.join(dir, "history.jsonl"), "x\n"); // 같은 폴더의 다른 파일
      await sleep(1500);
      assert.strictEqual(calls, base, "다른 파일 변경으로는 조회하지 않음");
      fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: "A2", refreshToken: "r2", expiresAt: Date.now() + 3600_000 } }));
      await until(() => calls > base, 5000);
    } finally {
      svc.dispose();
      if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const credsJson = (token) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `${token}-r`, expiresAt: Date.now() + 3600_000 } });

  await atest("Claude 서비스: 시작할 때 설정 폴더가 없어도(첫 로그인 전) 폴더가 생기고 로그인하면 곧바로 조회하고, 이후 토큰 변경에도 곧바로 조회", async () => {
    const fs = require("fs");
    const os = require("os");
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cum-nodir-"));
    const dir = path.join(parent, "claude-cfg");
    const credFile = path.join(dir, ".credentials.json");
    const prevEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    let calls = 0;
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      return { tokenExpired: true };
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const svc = new ClaudeService(output);
    try {
      await svc.start();
      const base0 = calls;
      fs.writeFileSync(path.join(parent, "unrelated.txt"), "x"); // 상위 폴더의 다른 항목 변경
      await sleep(1300);
      assert.strictEqual(calls, base0, "설정 폴더가 아직 없으면 상위 폴더의 다른 변경으로는 조회하지 않음");
      const base = calls;
      fs.mkdirSync(dir); // Claude Code 첫 로그인: 폴더 생성 → 로그인 파일 저장
      fs.writeFileSync(credFile, credsJson("A"));
      await until(() => calls > base, 5000);
      await sleep(1300); // 첫 로그인 반응(1초 묶음)이 끝나기를 기다림
      const afterLogin = calls;
      fs.writeFileSync(credFile, credsJson("A2")); // 이후 Claude Code 의 토큰 변경
      await until(() => calls > afterLogin, 5000);
    } finally {
      svc.dispose();
      if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevEnv;
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  await atest("Claude 서비스: 자격증명 감시 설치가 처음에 실패해도 다음 정기 조회 때 다시 걸어, 이후 변경에 곧바로 조회", async () => {
    const fs = require("fs");
    const os = require("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cum-rewatch-"));
    const credFile = path.join(dir, ".credentials.json");
    fs.writeFileSync(credFile, credsJson("A"));
    const prevEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    let calls = 0;
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      return { tokenExpired: true };
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const origWatch = fs.watch;
    let failOnce = true;
    fs.watch = function (target, ...rest) {
      if (failOnce && String(target) === dir) {
        failOnce = false;
        throw new Error("시험: 감시 설치 실패");
      }
      return origWatch.call(this, target, ...rest);
    };
    const svc = new ClaudeService(output);
    try {
      await svc.start();
      assert.strictEqual(failOnce, false, "설치 실패 상황이 실제로 만들어짐");
      fs.watch = origWatch;
      const base = calls;
      fs.writeFileSync(credFile, credsJson("A2"));
      await sleep(1500);
      assert.strictEqual(calls, base, "감시가 없는 동안엔 자동 조회 없음(복구 전 상태)");
      await svc.refreshPlan(); // 정기 조회 1회 → 감시 복구
      const afterPoll = calls;
      fs.writeFileSync(credFile, credsJson("A3"));
      await until(() => calls > afterPoll, 5000);
    } finally {
      fs.watch = origWatch;
      svc.dispose();
      if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 대소문자 구분 여부는 OS 이름이 아니라 실제 임시 폴더로 확인한다(볼륨·폴더마다 다를 수 있음).
  const caseInsensitiveFs = (() => {
    const fs = require("fs");
    const os = require("os");
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), "cum-CaseProbe-"));
    try {
      const base = path.basename(probe);
      return fs.existsSync(path.join(path.dirname(probe), base.toUpperCase())) && fs.existsSync(path.join(path.dirname(probe), base.toLowerCase()));
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  })();

  // 시험용 홈 폴더(기본 설정 폴더 ~/.claude 와 홈의 .claude.json 을 흉내).
  const withTempHome = async (fn) => {
    const fs = require("fs");
    const os = require("os");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cum-home-"));
    const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    try {
      await fn(home);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  await atest("대소문자를 구분하지 않는 폴더: 기본 설정 폴더를 대소문자만 다르게 적어도 같은 대상으로 보고 홈의 계정 정보를 읽음", async () => {
    if (!caseInsensitiveFs) return;
    const fs = require("fs");
    await withTempHome(async (home) => {
      fs.mkdirSync(path.join(home, ".claude"));
      fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acct-1", organizationUuid: "org-1", planDisplayName: "Ultra" } }));
      assert.ok(claudeApiModule.samePath(path.join(home, ".CLAUDE"), path.join(home, ".claude")));
      assert.ok(!claudeApiModule.samePath(path.join(home, ".claude-2"), path.join(home, ".claude")));
      const info = realReadAccountInfo(path.join(home, ".CLAUDE"));
      assert.strictEqual(info.identity, "acct-1/org-1");
      assert.strictEqual(info.planDisplayName, "Ultra");
    });
  });

  await atest("대소문자를 구분하지 않는 폴더: 설정 폴더를 대소문자만 다르게 적은 상태에서 A→B 계정 전환(B 서버 산출 시각이 30초 이전)도 B 값으로 바뀌고 A 기록과 섞이지 않음", async () => {
    if (!caseInsensitiveFs) return;
    const fs = require("fs");
    await withTempHome(async (home) => {
      fs.mkdirSync(path.join(home, ".claude"));
      const writeAccount = (acct) => fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: acct, organizationUuid: "org", planDisplayName: "Ultra" } }));
      writeAccount("acct-A");
      process.env.CLAUDE_CONFIG_DIR = path.join(home, ".CLAUDE");
      claudeApi.readAccountInfo = realReadAccountInfo;
      let next = weeklyUsage(80, 10_000);
      claudeApi.fetchPlanUsage = async () => next;
      const svc = new ClaudeService(output);
      try {
        await svc.refreshPlan(true);
        assert.strictEqual(svc.currentState.plan.windows[0].usedPercent, 80);
        await sleep(20); // 계정 정보 파일 수정 시각이 달라지도록
        writeAccount("acct-B");
        next = weeklyUsage(20, 10_000 - 30_000);
        await svc.refreshPlan(true);
        await sleep(10);
        assert.strictEqual(svc.currentState.plan.windows[0].usedPercent, 20, "B 계정 값 표시(A 의 80% 가 남지 않음)");
        assert.ok(!svc.currentState.holds?.weekly_all, "A 기록과 비교한 '사용률 하락' 보류가 아님");
      } finally {
        svc.dispose();
      }
    });
  });

  await atest("대소문자를 구분하는 볼륨처럼 '.CLAUDE' 가 기본 폴더와 다른 대상이면 홈의 계정 정보를 붙이지 않음(이름 글자가 아니라 실제 대상으로 판단)", async () => {
    const fs = require("fs");
    await withTempHome(async (home) => {
      fs.mkdirSync(path.join(home, ".claude"));
      fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acct-1", organizationUuid: "org-1" } }));
      const other = path.join(home, ".CLAUDE");
      if (!caseInsensitiveFs) fs.mkdirSync(other); // 실제로 대소문자를 구분하는 볼륨이면 진짜 다른 폴더를 만든다
      const origStat = fs.statSync;
      // 대소문자를 구분하지 않는 폴더에서는 '.CLAUDE' 가 '.claude' 와 같은 대상이므로, 구분하는 볼륨처럼 다른 대상 번호를 준다.
      fs.statSync = function (target, opts) {
        const st = origStat.call(this, target, opts);
        if (caseInsensitiveFs && opts && opts.bigint && path.resolve(String(target)) === path.resolve(other)) {
          return { ...st, ino: st.ino + 1n };
        }
        return st;
      };
      try {
        assert.ok(!claudeApiModule.samePath(other, path.join(home, ".claude")), "다른 대상");
        assert.strictEqual(realReadAccountInfo(other).identity, null, "다른 폴더에 기본 폴더의 계정 식별을 붙이지 않음");
      } finally {
        fs.statSync = origStat;
      }
    });
  });

  await atest("Claude 서비스: 계정 정보 파일이 없는 다른 설정 폴더로 바꾸면(같은 계정인지 확인 불가) 이전 계정 값·기록을 버리고 새 폴더 값만 표시", async () => {
    const fs = require("fs");
    const os = require("os");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cum-switch-"));
    const dirA = path.join(root, "a");
    const dirB = path.join(root, "b");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    fs.writeFileSync(path.join(dirA, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acct-A", organizationUuid: "org", planDisplayName: "A-Plan" } }));
    const prevEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dirA;
    claudeApi.readAccountInfo = realReadAccountInfo;
    let next = weeklyUsage(80, 10_000);
    claudeApi.fetchPlanUsage = async () => next;
    const svc = new ClaudeService(output);
    try {
      await svc.refreshPlan(true);
      assert.strictEqual(svc.currentState.plan.windows[0].usedPercent, 80);
      process.env.CLAUDE_CONFIG_DIR = dirB; // 계정 정보 파일 없음
      next = { ...weeklyUsage(20, 10_000 - 30_000), subscriptionType: "B-type", rateLimitTier: "B-tier" }; // 서버 산출 시각이 30초 이전
      await svc.refreshPlan(true);
      await sleep(10);
      const s = svc.currentState;
      assert.strictEqual(s.plan.windows[0].usedPercent, 20, "새 폴더 값(이전 계정 80% 가 남지 않음)");
      assert.ok(!s.holds?.weekly_all, "이전 계정 기록과 비교한 '사용률 하락' 보류가 아님");
      assert.strictEqual(s.planDisplayName, null, "이전 계정 요금제 표시명(A-Plan)을 붙이지 않음");
      assert.strictEqual(s.subscriptionType, "B-type");
      assert.strictEqual(s.rateLimitTier, "B-tier");
      // 같은 폴더에서 계정 정보를 잠시 못 읽은 것만으로는 버리지 않는다(다음 조회에서 같은 폴더 값 유지).
      next = weeklyUsage(21, 20_000);
      await svc.refreshPlan(true);
      assert.strictEqual(svc.currentState.plan.windows[0].usedPercent, 21);
    } finally {
      svc.dispose();
      if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevEnv;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await atest("Claude 서비스: 만료된 A 로 시작(사용량 못 받음) → 계정 정보 없는 B 폴더 → 다시 A 폴더로 돌아와도 각 단계의 값·계정 정보가 그 폴더 것과만 일치", async () => {
    const fs = require("fs");
    const os = require("os");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cum-owner-"));
    const dirA = path.join(root, "a");
    const dirB = path.join(root, "b");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    fs.writeFileSync(path.join(dirA, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acct-A", organizationUuid: "org", planDisplayName: "A-Plan" } }));
    fs.writeFileSync(path.join(dirA, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "A", refreshToken: "Ar", expiresAt: Date.now() - 1000, subscriptionType: "A-type" } }));
    fs.writeFileSync(path.join(dirB, ".credentials.json"), credsJson("B"));
    const prevEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dirA;
    claudeApi.readAccountInfo = realReadAccountInfo;
    let aReady = false;
    claudeApi.fetchPlanUsage = async () => {
      if (process.env.CLAUDE_CONFIG_DIR === dirB) return { ...weeklyUsage(20, 10_000), subscriptionType: "B-type", rateLimitTier: "B-tier" };
      return aReady ? { ...weeklyUsage(80, 10_000 - 30_000), subscriptionType: "A-type" } : { tokenExpired: true, subscriptionType: "A-type" };
    };
    const svc = new ClaudeService(output);
    try {
      await svc.start(); // A 만료 — 사용량 없음
      assert.strictEqual(svc.currentState.planDisplayName, "A-Plan");
      assert.ok(!svc.currentState.plan);
      process.env.CLAUDE_CONFIG_DIR = dirB; // 계정 정보 없는 B 폴더에서 첫 성공
      await svc.refreshPlan(true);
      let s = svc.currentState;
      assert.strictEqual(s.plan.windows[0].usedPercent, 20);
      assert.strictEqual(s.planDisplayName, null, "A 의 표시명이 B 값에 붙지 않음");
      assert.strictEqual(s.subscriptionType, "B-type");
      process.env.CLAUDE_CONFIG_DIR = dirA; // A 로그인이 갱신된 뒤 A 폴더로 복귀(서버 산출 시각은 B 보다 30초 이전)
      aReady = true;
      await svc.refreshPlan(true);
      await sleep(10);
      s = svc.currentState;
      assert.strictEqual(s.plan.windows[0].usedPercent, 80, "A 값(B 의 20% 가 남지 않음)");
      assert.strictEqual(s.planDisplayName, "A-Plan");
      assert.ok(!s.holds?.weekly_all, "B 기록과 비교한 하락 보류 아님");
      assert.strictEqual(s.planFailing, false);
    } finally {
      svc.dispose();
      if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevEnv;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await atest("Claude 서비스: 같은 설정 폴더를 다르게 적기만 하면(계정 정보 없음) 계정 변경이 아니므로 '사용률 하락' 보류가 유지됨", async () => {
    const fs = require("fs");
    const os = require("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cum-alias-"));
    const prevEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    claudeApi.readAccountInfo = () => ({ planDisplayName: null, identity: null });
    let next = weeklyUsage(80, 10_000);
    claudeApi.fetchPlanUsage = async () => next;
    const svc = new ClaudeService(output);
    try {
      await svc.refreshPlan(true);
      next = weeklyUsage(20, 20_000); // 같은 창에서 하락 → 보류
      await svc.refreshPlan(true);
      assert.strictEqual(svc.currentState.holds.weekly_all, true, "하락 보류");
      process.env.CLAUDE_CONFIG_DIR = dir + path.sep + "."; // 같은 폴더, 다른 표기
      assert.ok(claudeApiModule.samePath(process.env.CLAUDE_CONFIG_DIR, dir));
      next = weeklyUsage(21, 30_000);
      await svc.refreshPlan(true);
      const s = svc.currentState;
      assert.strictEqual(s.holds.weekly_all, true, "같은 폴더라 보류 유지");
      assert.strictEqual(s.planAccountChecking, false, "계정 확인 중으로 바뀌지 않음");
    } finally {
      svc.dispose();
      if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await atest("Claude 서비스: 계정이 바뀌면(식별이 다름) 이전 계정의 요금제 표시명·구독 유형·마지막 확인 시각을 이어 쓰지 않음", async () => {
    let account = { planDisplayName: "A-Plan", identity: "acct-A" };
    claudeApi.readAccountInfo = () => account;
    let next = { ...weeklyUsage(80, 10_000), subscriptionType: "A-type", rateLimitTier: "A-tier" };
    claudeApi.fetchPlanUsage = async () => next;
    const svc = new ClaudeService(output);
    try {
      await svc.refreshPlan(true);
      assert.strictEqual(svc.currentState.planDisplayName, "A-Plan");
      account = { planDisplayName: null, identity: "acct-B" };
      next = { tokenExpired: true }; // 새 계정 토큰이 아직 만료 상태
      await svc.refreshPlan(true);
      const s = svc.currentState;
      assert.strictEqual(s.planDisplayName, null, "A-Plan 이 남지 않음");
      assert.strictEqual(s.subscriptionType, null);
      assert.strictEqual(s.rateLimitTier, null);
      assert.ok(!s.plan, "A 값 표시 없음");
      assert.strictEqual(s.lastPlanRefresh, undefined, "A 의 마지막 확인 시각을 쓰지 않음");
      assert.ok(s.planWaiting && !/\d/.test(s.planWaiting), "마지막 확인 시각 없이 기다림 문구: " + s.planWaiting);
    } finally {
      svc.dispose();
    }
  });

  await atest("Claude 서비스: 로그인 파일이 바뀐 뒤 같은 폴더의 다른 파일이 계속 바뀌어도 재조회가 밀리지 않음(처음 예약대로 약 1초 뒤)", async () => {
    const fs = require("fs");
    const os = require("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cum-noisy-"));
    const credFile = path.join(dir, ".credentials.json");
    fs.writeFileSync(credFile, credsJson("A"));
    const prevEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    let calls = 0;
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      return { tokenExpired: true };
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const svc = new ClaudeService(output);
    let noisy;
    try {
      await svc.start();
      const base = calls;
      fs.writeFileSync(credFile, credsJson("A2"));
      let n = 0;
      noisy = setInterval(() => fs.writeFileSync(path.join(dir, "history.jsonl"), `x${n++}\n`), 200);
      const t0 = Date.now();
      await until(() => calls > base, 4000);
      assert.ok(Date.now() - t0 < 2500, `무관한 변경이 이어지는 동안에도 곧바로 조회(${Date.now() - t0}ms)`);
    } finally {
      clearInterval(noisy);
      svc.dispose();
      if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await atest("Claude 서비스: 폴더가 없음을 확인한 직후·감시를 걸기 직전에 폴더와 로그인 파일이 생겨도 곧바로 조회하고 이후 토큰 변경에도 곧바로 조회", async () => {
    const fs = require("fs");
    const os = require("os");
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cum-race-"));
    const dir = path.join(parent, "claude-cfg");
    const credFile = path.join(dir, ".credentials.json");
    const prevEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    let calls = 0;
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      return { tokenExpired: true };
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const origWatch = fs.watch;
    let injected = false;
    fs.watch = function (target, ...rest) {
      if (!injected && String(target) === parent) {
        injected = true; // 폴더가 없다고 확인한 뒤, 상위 폴더 감시가 걸리기 직전에 Claude Code 가 로그인을 마침
        fs.mkdirSync(dir);
        fs.writeFileSync(credFile, credsJson("A"));
      }
      return origWatch.call(this, target, ...rest);
    };
    const svc = new ClaudeService(output);
    try {
      await svc.start();
      const base = calls;
      assert.ok(injected, "경합 상황이 실제로 만들어짐");
      await until(() => calls > base, 5000);
      await sleep(1300);
      const afterLogin = calls;
      fs.writeFileSync(credFile, credsJson("A2"));
      await until(() => calls > afterLogin, 5000);
    } finally {
      fs.watch = origWatch;
      svc.dispose();
      if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevEnv;
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  await atest("Claude 서비스: 로그인 파일 감시를 거는 바로 그 사이에 로그인 파일이 바뀌어도(신호를 못 받아도) 곧바로 조회", async () => {
    const fs = require("fs");
    const os = require("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cum-gap-"));
    const credFile = path.join(dir, ".credentials.json");
    fs.writeFileSync(credFile, credsJson("A"));
    const prevEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    let calls = 0;
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      return { tokenExpired: true };
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const origWatch = fs.watch;
    let injected = false;
    fs.watch = function (target, ...rest) {
      if (!injected && String(target) === dir) {
        injected = true; // 시작 조회가 끝나고 감시가 걸리기 직전에 Claude Code 가 토큰을 바꿈
        fs.writeFileSync(credFile, credsJson("A2-longer-token"));
      }
      return origWatch.call(this, target, ...rest);
    };
    const svc = new ClaudeService(output);
    try {
      await svc.start();
      const base = calls;
      assert.ok(injected, "경합 상황이 실제로 만들어짐");
      await until(() => calls > base, 5000);
    } finally {
      fs.watch = origWatch;
      svc.dispose();
      if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await atest("대소문자를 구분하지 않는 폴더: 설정에 적힌 폴더 이름과 실제로 생긴 폴더 이름의 대소문자가 달라도 생성 신호를 받아 곧바로 조회", async () => {
    if (!caseInsensitiveFs) return;
    const fs = require("fs");
    const os = require("os");
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cum-case-"));
    const dir = path.join(parent, "ClaudeCfg");
    const prevEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    let calls = 0;
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      return { tokenExpired: true };
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const svc = new ClaudeService(output);
    try {
      await svc.start();
      const base = calls;
      fs.mkdirSync(path.join(parent, "claudecfg")); // 실제 생성 이름은 소문자
      fs.writeFileSync(path.join(parent, "claudecfg", ".credentials.json"), credsJson("A"));
      await until(() => calls > base, 5000);
    } finally {
      svc.dispose();
      if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevEnv;
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  await atest("Claude 서비스: 다시 켜도(새 확장 인스턴스) 같은 계정의 저장된 값을 이어 그리고, 다른 계정·식별 없는 값은 잇지 않음", async () => {
    const fs = require("fs");
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      let identity = "acct-A";
      let next = null;
      claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity });
      claudeApi.fetchPlanUsage = async () => next;
      const usageAt = (u, O) => ({ usage: { windows: [histWin(R, u, O)], extraUsage: null }, subscriptionType: "max" });
      const s1 = new LimitHistoryStore(dir, "w1");
      const svc1 = new ClaudeService(output, s1);
      next = usageAt(30, now - 2 * HOUR);
      await svc1.refreshPlan(true);
      svc1.dispose();
      s1.dispose();
      const s2 = new LimitHistoryStore(dir, "w2"); // VS Code 를 다시 켬
      const svc2 = new ClaudeService(output, s2);
      next = usageAt(35, now - HOUR);
      await svc2.refreshPlan(true);
      assert.deepStrictEqual(svc2.currentState.samples.weekly_all.map((p) => p.v), [30, 35], "저장된 30 에 이어 35");
      svc2.dispose();
      s2.dispose();
      identity = "acct-B"; // 다른 계정
      const s3 = new LimitHistoryStore(dir, "w3");
      const svc3 = new ClaudeService(output, s3);
      next = usageAt(5, now - 30 * MIN);
      await svc3.refreshPlan(true);
      assert.deepStrictEqual(svc3.currentState.samples.weekly_all.map((p) => p.v), [5], "A 의 기록을 잇지 않음");
      svc3.dispose();
      s3.dispose();
      identity = null; // 계정 식별 없음
      const s4 = new LimitHistoryStore(dir, "w4");
      const svc4 = new ClaudeService(output, s4);
      next = usageAt(50, now - 10 * MIN);
      await svc4.refreshPlan(true);
      assert.deepStrictEqual(svc4.currentState.samples.weekly_all.map((p) => p.v), [50], "저장된 값과 잇지 않음");
      svc4.dispose();
      s4.dispose();
      assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith("limit-history-w4")), "식별 없는 값은 저장하지 않음");
    });
  });

  await atest("Claude 서비스: 어느 계정인지 모르던 값(식별 없이 받음) 뒤에 B 식별이 확인되면 이전 값을 버리고 B 값만 — 모르던 값을 B 기록으로 저장하지 않음", async () => {
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      let identity = null;
      let next = null;
      claudeApi.readAccountInfo = () => ({ planDisplayName: null, identity });
      claudeApi.fetchPlanUsage = async () => next;
      const usageAt = (u, O) => ({ usage: { windows: [histWin(R, u, O)], extraUsage: null }, subscriptionType: "max" });
      const store = new LimitHistoryStore(dir, "w");
      const svc = new ClaudeService(output, store);
      next = usageAt(80, now - HOUR); // 식별 없이 받은 값(실제로는 A 계정)
      await svc.refreshPlan(true);
      identity = "acct-B"; // 같은 폴더에서 B 로 로그인, 계정 정보도 확인됨
      next = usageAt(20, now - HOUR - 30_000); // B 의 서버 산출 시각이 30초 이르다
      await svc.refreshPlan(true);
      let st = svc.currentState;
      assert.strictEqual(st.plan.windows[0].usedPercent, 20, "B 값 표시(모르던 80% 를 이어 쓰지 않음)");
      assert.ok(!st.holds?.weekly_all, "모르던 값과 비교한 하락 보류 아님");
      svc.dispose();
      store.dispose();
      const store2 = new LimitHistoryStore(dir, "w2"); // 다시 켬
      const svc2 = new ClaudeService(output, store2);
      next = usageAt(21, now);
      await svc2.refreshPlan(true);
      st = svc2.currentState;
      assert.deepStrictEqual(st.samples.weekly_all.map((p) => p.v), [20, 21], "B 의 기록에 80 이 없음");
      svc2.dispose();
      store2.dispose();
    });
  });

  await atest("Claude 서비스: A 확인 → 식별 없이 받은 값(실제 B) → 다시 A 확인이면, 식별 없이 받은 값을 A 것으로 잇지 않음(실선·하락 보류 모두)", async () => {
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      let identity = "acct-A";
      let next = null;
      claudeApi.readAccountInfo = () => ({ planDisplayName: null, identity });
      claudeApi.fetchPlanUsage = async () => next;
      const usageAt = (u, O) => ({ usage: { windows: [histWin(R, u, O)], extraUsage: null }, subscriptionType: "max" });
      const store = new LimitHistoryStore(dir, "w");
      const svc = new ClaudeService(output, store);
      next = usageAt(10, now - 3 * HOUR);
      await svc.refreshPlan(true);
      identity = null; // B 로 바뀌었지만 계정 정보를 읽지 못함
      next = usageAt(80, now - 2 * HOUR);
      await svc.refreshPlan(true);
      identity = "acct-A"; // 다시 A
      next = usageAt(20, now - HOUR);
      await svc.refreshPlan(true);
      const st = svc.currentState;
      assert.deepStrictEqual(st.samples.weekly_all.map((p) => p.v).filter((v) => v === 80), [], "B 의 80 이 A 실선에 없음");
      assert.ok(!st.holds?.weekly_all, "B 의 80 과 비교한 하락 보류 아님");
      assert.strictEqual(st.plan.windows[0].usedPercent, 20);
      svc.dispose();
      store.dispose();
    });
  });

  await atest("Claude 서비스: 계정을 모르던 상태에서 올라간 요금제 정보(사용량 없음)를 나중에 확인된 다른 계정에 이어 쓰지 않음", async () => {
    let identity = null;
    let info = { planDisplayName: "A-Plan", identity: null };
    claudeApi.readAccountInfo = () => ({ ...info, identity });
    let next = { tokenExpired: true, subscriptionType: "A-sub", rateLimitTier: "A-tier" };
    claudeApi.fetchPlanUsage = async () => next;
    const svc = new ClaudeService(output);
    await svc.refreshPlan(true);
    assert.strictEqual(svc.currentState.planDisplayName, "A-Plan");
    identity = "acct-B";
    info = { planDisplayName: null };
    next = { usage: { windows: [histWin(Date.now() + 24 * HOUR, 20, Date.now())], extraUsage: null } };
    await svc.refreshPlan(true);
    const st = svc.currentState;
    assert.strictEqual(st.plan.windows[0].usedPercent, 20);
    assert.strictEqual(st.planDisplayName, null, "A-Plan 을 붙이지 않음");
    assert.strictEqual(st.subscriptionType, null, "A-sub 를 붙이지 않음");
    assert.strictEqual(st.rateLimitTier, null, "A-tier 를 붙이지 않음");
    svc.dispose();
  });

  await atest("Claude 서비스: 계정 정보를 잠시 못 읽은 응답이 옛 관측뿐(거부)이거나 빈 목록이면 주인 계정을 그대로 둬 — A 가 다시 확인돼도 하락 보류 유지", async () => {
    const now = Date.now();
    const R = now + 2 * 24 * HOUR;
    let identity = "acct-A";
    let next = null;
    claudeApi.readAccountInfo = () => ({ planDisplayName: "A-Plan", identity });
    claudeApi.fetchPlanUsage = async () => next;
    const usageAt = (u, O) => ({ usage: { windows: [histWin(R, u, O)], extraUsage: null }, subscriptionType: "max" });
    const T = now - 3 * HOUR;
    const svc = new ClaudeService(output);
    next = usageAt(80, T);
    await svc.refreshPlan(true);
    next = usageAt(20, T + MIN); // 같은 창에서 하락 → 보류
    await svc.refreshPlan(true);
    assert.strictEqual(svc.currentState.holds.weekly_all, true);
    identity = null; // 계정 정보 일시 누락
    next = usageAt(80, T); // 옛 관측 재수신(거부됨)
    await svc.refreshPlan(true);
    next = { usage: { windows: [], extraUsage: null }, subscriptionType: "max" }; // 빈 목록
    await svc.refreshPlan(true);
    identity = "acct-A"; // 복구
    next = usageAt(21, T + 2 * MIN);
    await svc.refreshPlan(true);
    const st = svc.currentState;
    assert.strictEqual(st.plan.windows[0].usedPercent, 21);
    assert.strictEqual(st.holds.weekly_all, true, "같은 계정이므로 하락 보류 유지(계정 변경으로 오인해 초기화하지 않음)");
    svc.dispose();
  });

  await atest("Claude 서비스: 확인된 A 를 보는 중 계정 정보를 읽을 수 없는 다른 로그인의 만료 응답이 와도 A 의 요금제 정보를 덮지 않고, A 로 돌아와도 섞이지 않음", async () => {
    const now = Date.now();
    const R = now + 2 * 24 * HOUR;
    let info = { planDisplayName: "A-Plan", identity: "acct-A" };
    let next = { usage: { windows: [histWin(R, 10, now - HOUR)], extraUsage: null }, subscriptionType: "A-sub", rateLimitTier: "A-tier" };
    claudeApi.readAccountInfo = () => info;
    claudeApi.fetchPlanUsage = async () => next;
    const svc = new ClaudeService(output);
    await svc.refreshPlan(true);
    info = { planDisplayName: null, identity: null }; // 같은 폴더에서 다른 로그인(B) — 계정 정보 없음, 토큰 만료
    next = { tokenExpired: true, subscriptionType: "B-sub", rateLimitTier: "B-tier" };
    await svc.refreshPlan(true);
    let st = svc.currentState;
    assert.strictEqual(st.plan.windows[0].usedPercent, 10, "A 사용량 유지");
    assert.deepStrictEqual([st.planDisplayName, st.subscriptionType, st.rateLimitTier], ["A-Plan", "A-sub", "A-tier"], "B 정보로 덮지 않음");
    assert.ok(!formatClaudeTooltip(st).includes("B-sub"), formatClaudeTooltip(st));
    info = { planDisplayName: "A-Plan", identity: "acct-A" }; // A 로 돌아옴(응답에 구독 정보 없음)
    next = { usage: { windows: [histWin(R, 11, now)], extraUsage: null } };
    await svc.refreshPlan(true);
    st = svc.currentState;
    assert.deepStrictEqual([st.subscriptionType, st.rateLimitTier], ["A-sub", "A-tier"], "B 정보가 남지 않음");
    svc.dispose();
  });

  await atest("Claude 서비스: 식별 없이 받은 사용량을 보는 중(주인 미확정) 계정 정보를 읽을 수 없는 다른 로그인의 만료 응답이 와도 그 요금제 정보를 붙이지 않음 — 처음(보여 줄 것 없음)엔 응답 정보를 씀", async () => {
    const now = Date.now();
    const R = now + 2 * 24 * HOUR;
    let info = { planDisplayName: "A-Plan", identity: null };
    let next = { usage: { windows: [histWin(R, 10, now - HOUR)], extraUsage: null }, subscriptionType: "A-sub", rateLimitTier: "A-tier", loginKey: "kA" };
    claudeApi.readAccountInfo = () => info;
    claudeApi.fetchPlanUsage = async () => next;
    const svc = new ClaudeService(output);
    await svc.refreshPlan(true);
    let st = svc.currentState;
    assert.deepStrictEqual([st.plan.windows[0].usedPercent, st.planDisplayName, st.subscriptionType, st.rateLimitTier], [10, "A-Plan", "A-sub", "A-tier"]);
    info = { planDisplayName: "B-Plan", identity: null }; // 같은 폴더에서 다른 로그인(B) — 식별 없음, 토큰 만료
    next = { tokenExpired: true, subscriptionType: "B-sub", rateLimitTier: "B-tier", loginKey: "kB" };
    await svc.refreshPlan(true);
    st = svc.currentState;
    assert.strictEqual(st.plan.windows[0].usedPercent, 10, "표시 중인 사용량 유지");
    assert.deepStrictEqual([st.planDisplayName, st.subscriptionType, st.rateLimitTier], ["A-Plan", "A-sub", "A-tier"], "B 정보를 붙이지 않음");
    assert.deepStrictEqual(st.samples.weekly_all.map((p) => p.v), [10]);
    svc.dispose();
    // 처음(보여 줄 사용량도 확인된 계정도 없음)엔 식별 없는 만료 응답의 정보를 그대로 쓴다.
    claudeApi.readAccountInfo = () => ({ planDisplayName: "C-Plan", identity: null });
    claudeApi.fetchPlanUsage = async () => ({ tokenExpired: true, subscriptionType: "C-sub", rateLimitTier: "C-tier" });
    const fresh = new ClaudeService(output);
    await fresh.refreshPlan(true);
    st = fresh.currentState;
    assert.deepStrictEqual([st.planDisplayName, st.subscriptionType, st.rateLimitTier], ["C-Plan", "C-sub", "C-tier"]);
    fresh.dispose();
  });

  await atest("Claude 서비스: 확인된 A 80% 를 보는 중 식별 없는 새 값 20%(실제 B)가 오면 그 순간부터 A 와 잇지 않음 — 실선에 80 없음·하락 보류 없음·A 요금제 정보 없음", async () => {
    const now = Date.now();
    const R = now + 2 * 24 * HOUR;
    let info = { planDisplayName: "A-Plan", identity: "acct-A" };
    let next = { usage: { windows: [histWin(R, 80, now - 2 * HOUR)], extraUsage: null }, subscriptionType: "A-sub", rateLimitTier: "A-tier" };
    claudeApi.readAccountInfo = () => info;
    claudeApi.fetchPlanUsage = async () => next;
    const svc = new ClaudeService(output);
    await svc.refreshPlan(true);
    info = { planDisplayName: null, identity: null };
    next = { usage: { windows: [histWin(R, 20, now - HOUR)], extraUsage: null }, subscriptionType: "B-sub", rateLimitTier: "B-tier" };
    await svc.refreshPlan(true);
    const st = svc.currentState;
    assert.strictEqual(st.plan.windows[0].usedPercent, 20);
    assert.deepStrictEqual(st.samples.weekly_all.map((p) => p.v), [20], "A 의 80 과 잇지 않음");
    assert.ok(!st.holds?.weekly_all, "A 의 80 과 비교한 하락 보류 아님");
    assert.deepStrictEqual([st.planDisplayName, st.subscriptionType, st.rateLimitTier], [null, "B-sub", "B-tier"], "A-Plan 을 이어 쓰지 않음");
    svc.dispose();
  });

  await atest("Claude 서비스: 확인된 A 를 보는 중 누구 것인지 알 수 없는 응답(식별 없는 만료·옛 관측)은 A 의 실선(저장 기록 포함)·사용량 부가 정보를 바꾸지 않음", async () => {
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      let identity = "acct-A";
      let next = null;
      claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity });
      claudeApi.fetchPlanUsage = async () => next;
      const extraA = { isEnabled: true, usedCredits: 5, monthlyLimit: 100, currency: "USD" };
      const old = new LimitHistoryStore(dir, "old");
      const oldSvc = new ClaudeService(output, old);
      next = { usage: { windows: [histWin(R, 12, now - 5 * HOUR)], extraUsage: extraA }, subscriptionType: "max" };
      await oldSvc.refreshPlan(true);
      oldSvc.dispose();
      old.dispose();
      const store = new LimitHistoryStore(dir, "now");
      const svc = new ClaudeService(output, store);
      next = { usage: { windows: [histWin(R, 20, now - 2 * HOUR)], extraUsage: extraA }, subscriptionType: "max" };
      await svc.refreshPlan(true);
      assert.deepStrictEqual(svc.currentState.samples.weekly_all.map((p) => p.v), [12, 20]);
      identity = null;
      next = { tokenExpired: true, subscriptionType: "other" }; // 식별 없는 만료
      await svc.refreshPlan(true);
      let st = svc.currentState;
      assert.deepStrictEqual(st.samples.weekly_all.map((p) => p.v), [12, 20], "A 의 실선 그대로");
      assert.strictEqual(st.subscriptionType, "max");
      next = { usage: { windows: [histWin(R, 90, now - 3 * HOUR)], extraUsage: { isEnabled: true, usedCredits: 77, monthlyLimit: 100, currency: "USD" } }, subscriptionType: "other" }; // 식별 없는 옛 관측
      await svc.refreshPlan(true);
      st = svc.currentState;
      assert.strictEqual(st.plan.windows[0].usedPercent, 20);
      assert.deepStrictEqual(st.plan.extraUsage, extraA, "다른 응답의 부가 사용량을 붙이지 않음");
      assert.deepStrictEqual(st.samples.weekly_all.map((p) => p.v), [12, 20]);
      assert.strictEqual(st.subscriptionType, "max");
      svc.dispose();
      store.dispose();
    });
  });

  await atest("Claude 서비스: 계정 정보를 계속 읽지 못하는 환경(주인 미확정)에서 같은 로그인(토큰) 구간이면 이어 그리고 하락 보류도 동작 — 토큰이 바뀌면 처음부터, 저장은 안 함", async () => {
    await withHistDir(async (dir) => {
      const fs = require("fs");
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      claudeApi.readAccountInfo = () => ({ planDisplayName: null, identity: null });
      let next = null;
      claudeApi.fetchPlanUsage = async () => next;
      const store = new LimitHistoryStore(dir, "w");
      const svc = new ClaudeService(output, store);
      const at = (u, O, loginKey) => ({ usage: { windows: [histWin(R, u, O)], extraUsage: null }, loginKey });
      next = at(30, now - 3 * HOUR, "kA");
      await svc.refreshPlan(true);
      next = at(40, now - 2 * HOUR, "kA");
      await svc.refreshPlan(true);
      next = at(10, now - HOUR, "kA");
      await svc.refreshPlan(true);
      let st = svc.currentState;
      assert.deepStrictEqual(st.samples.weekly_all.map((p) => p.v), [30, 40, 10]);
      assert.strictEqual(st.holds.weekly_all, true);
      next = at(5, now, "kB"); // 토큰이 바뀜(갱신이든 다른 로그인이든 구분 불가)
      await svc.refreshPlan(true);
      st = svc.currentState;
      assert.deepStrictEqual(st.samples.weekly_all.map((p) => p.v), [5], "이전 로그인 구간 값과 잇지 않음");
      assert.ok(!st.holds.weekly_all, "이전 구간과 비교한 하락 보류 아님");
      svc.dispose();
      store.dispose();
      assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".json") && fs.readFileSync(path.join(dir, f), "utf8").includes(",30]")), "식별 없는 값은 저장하지 않음");
    });
  });

  await atest("Claude 서비스: 식별 없는 A 토큰의 80% 를 보던 중 두 조회 사이에 토큰이 바뀌고(B) 식별 없는 새 20% 가 오면 잇지 않음 — 실선·하락 보류·A 요금제 정보 모두", async () => {
    const now = Date.now();
    const R = now + 2 * 24 * HOUR;
    let info = { planDisplayName: "A-Plan", identity: null };
    let next = { usage: { windows: [histWin(R, 80, now - HOUR)], extraUsage: null }, subscriptionType: "A-sub", rateLimitTier: "A-tier", loginKey: "kA" };
    claudeApi.readAccountInfo = () => info;
    claudeApi.fetchPlanUsage = async () => next;
    claudeApi.readLoginKey = () => "kA";
    const svc = new ClaudeService(output);
    try {
      await svc.refreshPlan(true);
      info = { planDisplayName: null, identity: null };
      claudeApi.readLoginKey = () => "kB"; // 두 조회 사이에 B 로 로그인
      next = { usage: { windows: [histWin(R, 20, now)], extraUsage: null }, subscriptionType: "B-sub", rateLimitTier: "B-tier", loginKey: "kB" };
      await svc.refreshPlan(true);
      const st = svc.currentState;
      assert.deepStrictEqual(st.samples.weekly_all.map((p) => p.v), [20], "A 의 80 과 잇지 않음");
      assert.ok(!st.holds.weekly_all, "A 의 80 과 비교한 하락 보류 아님");
      assert.deepStrictEqual([st.planDisplayName, st.subscriptionType, st.rateLimitTier], [null, "B-sub", "B-tier"], "A-Plan 을 붙이지 않음");
      assert.strictEqual(st.planAccountChecking, false, "새 주인의 값을 받았으므로 확인 중 해제");
    } finally {
      svc.dispose();
      claudeApi.readLoginKey = defaultLoginKey;
    }
  });

  await atest("Claude 서비스: 식별 없는 값을 보던 중 누구 것인지 모르는 응답(만료)이 오면 값은 그대로 — 같은 토큰이면 그대로 두고, 토큰이 바뀌었으면 '계정 확인 중'", async () => {
    const now = Date.now();
    const R = now + 2 * 24 * HOUR;
    let next = { usage: { windows: [histWin(R, 10, now - HOUR)], extraUsage: null }, subscriptionType: "A-sub", loginKey: "kA" };
    claudeApi.readAccountInfo = () => ({ planDisplayName: null, identity: null });
    claudeApi.fetchPlanUsage = async () => next;
    claudeApi.readLoginKey = () => "kA"; // 조회 직전 확인은 계속 A 토큰을 본다
    const svc = new ClaudeService(output);
    try {
      await svc.refreshPlan(true);
      next = { tokenExpired: true, subscriptionType: "A-sub", loginKey: "kA" };
      await svc.refreshPlan(true);
      assert.strictEqual(svc.currentState.planAccountChecking, false, "같은 토큰의 만료는 확인 중 아님");
      // 조회 직전 확인 때는 아직 A 토큰이었는데(token 그대로) 조회에 쓰인 건 B 토큰 — 응답의 지문으로도 판단해야 함.
      next = { tokenExpired: true, subscriptionType: "B-sub", loginKey: "kB" };
      await svc.refreshPlan(true);
      const st = svc.currentState;
      assert.strictEqual(st.plan.windows[0].usedPercent, 10, "값은 그대로");
      assert.strictEqual(st.subscriptionType, "A-sub", "그 응답 정보를 붙이지 않음");
      assert.strictEqual(st.planAccountChecking, true, "지금 로그인의 값이 아닐 수 있음을 알림");
      next = { usage: { windows: [histWin(R, 5, now)], extraUsage: null }, subscriptionType: "B-sub", loginKey: "kB" }; // 이어서 B 토큰의 새 값
      await svc.refreshPlan(true);
      const st2 = svc.currentState;
      assert.deepStrictEqual(st2.samples.weekly_all.map((p) => p.v), [5], "만료 응답을 거쳤어도 A 토큰 구간 값과 잇지 않음");
      assert.ok(!st2.holds.weekly_all);
      assert.strictEqual(st2.planAccountChecking, false);
    } finally {
      svc.dispose();
      claudeApi.readLoginKey = defaultLoginKey;
    }
  });

  await atest("Claude 서비스: 서버 대기(429) 중에도 주인 미확정 값에서 계정 식별이 확인되거나 토큰이 바뀌면 서버를 부르지 않고 '계정 확인 중'을 켬", async () => {
    for (const change of ["identity", "token"]) {
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      let info = { planDisplayName: "A-Plan", identity: null };
      let token = "kA";
      let calls = 0;
      let next = { usage: { windows: [histWin(R, 80, now - HOUR)], extraUsage: null }, subscriptionType: "A-sub", loginKey: "kA" };
      claudeApi.readAccountInfo = () => info;
      claudeApi.readLoginKey = () => token;
      claudeApi.fetchPlanUsage = async () => {
        calls += 1;
        return next;
      };
      const svc = new ClaudeService(output);
      try {
        await svc.refreshPlan(true);
        next = { rateLimited: true, retryAfterMs: 1_800_000, subscriptionType: "A-sub", loginKey: "kA" };
        await svc.refreshPlan(true);
        assert.strictEqual(calls, 2);
        assert.strictEqual(svc.currentState.planAccountChecking, false, "같은 로그인의 429 는 확인 중 아님");
        if (change === "identity") info = { planDisplayName: "B-Plan", identity: "acct-B" };
        else token = "kB";
        await svc.refreshPlan(true);
        assert.strictEqual(calls, 2, `${change}: 대기 중엔 서버를 부르지 않음`);
        assert.strictEqual(svc.currentState.planAccountChecking, true, `${change}: 계정 확인 중`);
        assert.strictEqual(svc.currentState.plan.windows[0].usedPercent, 80);
      } finally {
        svc.dispose();
        claudeApi.readLoginKey = defaultLoginKey;
      }
    }
  });

  await atest("Claude 서비스: 사용량 없이 요금제 정보만 표시 중(첫 조회 429)이어도 대기 중 다른 계정이 확인되면 서버를 부르지 않고 '계정 확인 중'(툴팁에도)", async () => {
    let info = { planDisplayName: "A-Plan", identity: "acct-A" };
    let calls = 0;
    const next = { rateLimited: true, retryAfterMs: 1_800_000, subscriptionType: "A-sub", rateLimitTier: "A-tier", loginKey: "kA" };
    claudeApi.readAccountInfo = () => info;
    claudeApi.readLoginKey = () => "kA";
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      return next;
    };
    const svc = new ClaudeService(output);
    try {
      await svc.refreshPlan(true);
      let st = svc.currentState;
      assert.ok(!st.plan, "사용량 없음");
      assert.deepStrictEqual([st.planDisplayName, st.subscriptionType], ["A-Plan", "A-sub"]);
      assert.strictEqual(st.planAccountChecking, false);
      info = { planDisplayName: "B-Plan", identity: "acct-B" };
      claudeApi.readLoginKey = () => "kB";
      await svc.refreshPlan(true);
      st = svc.currentState;
      assert.strictEqual(calls, 1, "대기 중엔 서버를 부르지 않음");
      assert.strictEqual(st.planAccountChecking, true, "요금제 정보만 있어도 계정 확인 중");
      assert.ok(formatClaudeTooltip(st).includes(T.fcAccountChecking), formatClaudeTooltip(st));
    } finally {
      svc.dispose();
      claudeApi.readLoginKey = defaultLoginKey;
    }
  });

  await atest("Claude 서비스: 확인된 A 의 만료 상태(요금제 정보만)에서 다른 토큰의 식별 없는 만료 응답이 오면 A 정보는 그대로 두되 '계정 확인 중' — B 가 확인되면 B 정보로 바꾸고 해제", async () => {
    let info = { planDisplayName: "A-Plan", identity: "acct-A" };
    let next = { tokenExpired: true, subscriptionType: "A-sub", rateLimitTier: "A-tier", loginKey: "kA" };
    claudeApi.readAccountInfo = () => info;
    claudeApi.readLoginKey = () => "kA"; // 조회 직전 확인은 A 토큰 — 응답의 지문으로 판단해야 함
    claudeApi.fetchPlanUsage = async () => next;
    const svc = new ClaudeService(output);
    try {
      await svc.refreshPlan(true);
      assert.strictEqual(svc.currentState.planAccountChecking, false);
      info = { planDisplayName: null, identity: null };
      next = { tokenExpired: true, subscriptionType: "B-sub", rateLimitTier: "B-tier", loginKey: "kB" };
      await svc.refreshPlan(true);
      let st = svc.currentState;
      assert.deepStrictEqual([st.planDisplayName, st.subscriptionType, st.rateLimitTier], ["A-Plan", "A-sub", "A-tier"], "A 정보 그대로");
      assert.strictEqual(st.planAccountChecking, true, "사용량 없이 요금제 정보만 있어도 계정 확인 중");
      assert.ok(formatClaudeTooltip(st).includes(T.fcAccountChecking), formatClaudeTooltip(st));
      info = { planDisplayName: "B-Plan", identity: "acct-B" };
      await svc.refreshPlan(true);
      st = svc.currentState;
      assert.deepStrictEqual([st.planDisplayName, st.subscriptionType, st.rateLimitTier], ["B-Plan", "B-sub", "B-tier"]);
      assert.strictEqual(st.planAccountChecking, false, "B 의 응답으로 정해졌으니 해제");
      assert.ok(!formatClaudeTooltip(st).includes(T.fcAccountChecking));
    } finally {
      svc.dispose();
      claudeApi.readLoginKey = defaultLoginKey;
    }
  });

  await atest("Claude 서비스: 식별 없이 요금제 정보만 보던 중(주인 미확정·만료) 다른 토큰의 식별 없는 만료 응답이 오면 그 정보를 그대로 두고 '계정 확인 중'(툴팁에도)", async () => {
    let next = { tokenExpired: true, subscriptionType: "A-sub", rateLimitTier: "A-tier", loginKey: "kA" };
    let info = { planDisplayName: "A-Plan", identity: null };
    claudeApi.readAccountInfo = () => info;
    claudeApi.readLoginKey = () => "kA";
    claudeApi.fetchPlanUsage = async () => next;
    const svc = new ClaudeService(output);
    try {
      await svc.refreshPlan(true);
      let st = svc.currentState;
      assert.deepStrictEqual([st.planDisplayName, st.subscriptionType, st.rateLimitTier, st.planAccountChecking], ["A-Plan", "A-sub", "A-tier", false]);
      info = { planDisplayName: "B-Plan", identity: null };
      next = { tokenExpired: true, subscriptionType: "B-sub", rateLimitTier: "B-tier", loginKey: "kB" };
      await svc.refreshPlan(true);
      st = svc.currentState;
      assert.deepStrictEqual([st.planDisplayName, st.subscriptionType, st.rateLimitTier], ["A-Plan", "A-sub", "A-tier"], "누구 것인지 모르는 응답의 정보로 바꾸지 않음");
      assert.strictEqual(st.planAccountChecking, true);
      assert.ok(formatClaudeTooltip(st).includes(T.fcAccountChecking), formatClaudeTooltip(st));
    } finally {
      svc.dispose();
      claudeApi.readLoginKey = defaultLoginKey;
    }
  });

  await atest("Claude 서비스: 식별 없는 주인과 같은 토큰의 응답은 새 사용량이 없어도 그 주인의 응답 — 요금제 정보 갱신·확인 중 아님, 자격 증명이 계속 없을 때도 켜지 않음", async () => {
    let next = { tokenExpired: true, subscriptionType: "A-sub", rateLimitTier: "A-tier", loginKey: "kA" };
    let info = { planDisplayName: "A-Plan", identity: null };
    claudeApi.readAccountInfo = () => info;
    claudeApi.readLoginKey = () => "kA";
    claudeApi.fetchPlanUsage = async () => next;
    const svc = new ClaudeService(output);
    try {
      await svc.refreshPlan(true);
      info = { planDisplayName: "A-Plan2", identity: null };
      next = { tokenExpired: true, subscriptionType: "A-sub2", rateLimitTier: "A-tier2", loginKey: "kA" };
      await svc.refreshPlan(true);
      let st = svc.currentState;
      assert.deepStrictEqual([st.planDisplayName, st.subscriptionType, st.rateLimitTier], ["A-Plan2", "A-sub2", "A-tier2"], "같은 로그인 구간이면 그 주인의 정보로 갱신");
      assert.strictEqual(st.planAccountChecking, false);
    } finally {
      svc.dispose();
    }
    // 자격 증명 파일이 없는 상태가 이어지면(지문 없음 → 없음) 같은 구간 — 확인 중을 켜지 않는다.
    claudeApi.readLoginKey = () => null;
    claudeApi.readAccountInfo = () => ({ planDisplayName: "N-Plan", identity: null });
    claudeApi.fetchPlanUsage = async () => ({ error: "no credentials" });
    const none = new ClaudeService(output);
    try {
      await none.refreshPlan(true);
      await none.refreshPlan(true);
      await none.refreshPlan(true);
      let st = none.currentState;
      assert.strictEqual(st.planDisplayName, "N-Plan");
      assert.ok(!st.planAccountChecking, "바뀐 로그인이 없으니 확인 중 아님");
      claudeApi.fetchPlanUsage = async () => ({ rateLimited: true, retryAfterMs: 30 * MIN });
      await none.refreshPlan(true);
      await none.refreshPlan(true); // 서버 대기 중 — 조회 없이 계정 변경만 확인
      st = none.currentState;
      assert.ok(st.planRateLimited, "서버 대기 중");
      assert.ok(!st.planAccountChecking, "대기 중 확인도 같은 기준(자격 증명 없음이 이어짐 = 바뀐 로그인 없음)");
    } finally {
      none.dispose();
      claudeApi.readLoginKey = defaultLoginKey;
    }
  });

  await atest("Claude 서비스: 다른 창의 기록 파일에 깨진 점(null·문자열·빈 배열)이 있어도 정상 사용량 반영·다음 조회 예약이 멈추지 않고, 쓸 수 있는 점만 실선에 잇는다", async () => {
    await withHistDir(async (dir) => {
      const fs = require("fs");
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      const acctKey = historyAccountKey("claude", "acct-A");
      fs.mkdirSync(dir, { recursive: true });
      const entry = { account: acctKey, id: "weekly_all", len: WEEK, R0: R, rMin: R, rMax: R, points: [null, [now - HOUR, 15], ["x", 3], [], [now - 2 * HOUR, 12], [now - 30 * 60_000, NaN]] };
      const broken = [{ account: acctKey, id: "weekly_all", len: WEEK, R0: "bad", rMin: R, rMax: R, points: [[now - 3 * HOUR, 99]] }, null, 7];
      fs.writeFileSync(path.join(dir, "limit-history-other-1.json"), JSON.stringify({ v: 1, pid: process.pid, entries: [entry, ...broken] }));
      claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
      claudeApi.fetchPlanUsage = async () => ({ usage: { windows: [histWin(R, 20, now)], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" });
      const store = new LimitHistoryStore(dir, "this-window");
      const svc = new ClaudeService(output, store);
      try {
        await svc.refreshPlan(true);
        const st = svc.currentState;
        assert.strictEqual(st.connecting, false, "조회 반영이 끝까지 진행됨");
        assert.strictEqual(st.plan.windows[0].usedPercent, 20);
        assert.deepStrictEqual(st.samples.weekly_all.map((p) => p.v), [12, 15, 20], "깨진 점·기록은 빼고 시각순으로 이음");
        let scheduled = 0;
        claudeApi.fetchPlanUsage = async () => {
          scheduled += 1;
          return { usage: { windows: [histWin(R, 21, Date.now())], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" };
        };
        await svc.refreshPlan(true);
        assert.strictEqual(scheduled, 1, "다음 조회도 정상");
        assert.strictEqual(svc.currentState.plan.windows[0].usedPercent, 21);
      } finally {
        svc.dispose();
        store.dispose();
      }
    });
  });

  await atest("이력 저장소: 자기 파일의 깨진 점은 읽을 때 걸러져 이어 기록되고, 기록·읽기 중 예외는 밖으로 내지 않는다(기록만 건너뜀·로그)", async () => {
    await withHistDir(async (dir) => {
      const fs = require("fs");
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      const acct = historyAccountKey("claude", "acct-A");
      fs.writeFileSync(
        path.join(dir, `limit-history-me-${process.pid}.json`),
        JSON.stringify({ v: 1, pid: process.pid, entries: [{ account: acct, id: "weekly_all", len: WEEK, R0: R, rMin: R, rMax: R, points: [[now - HOUR, 15], null, [now - 2 * HOUR, 12]] }] }),
      );
      const logs = [];
      const store = new LimitHistoryStore(dir, "me", Date.now, (m) => logs.push(m));
      try {
        store.record(acct, [histWin(R, 20, now)], () => R);
        assert.deepStrictEqual(store.pointsFor(acct, histWin(R, 20, now), 0, now + 1).map((p) => p.v), [12, 15, 20]);
        assert.doesNotThrow(() =>
          store.record(acct, [histWin(R, 21, now + 1)], () => {
            throw new Error("anchor boom");
          }),
        );
        assert.ok(logs.some((m) => m.includes("anchor boom")), logs.join("|"));
        const weird = {
          ...histWin(R, 20, now),
          get resetsAtMs() {
            throw new Error("read boom");
          },
        };
        assert.deepStrictEqual(store.pointsFor(acct, weird, 0, now + 1), []);
        assert.ok(logs.some((m) => m.includes("read boom")), logs.join("|"));
      } finally {
        store.dispose();
      }
    });
  });

  await atest("Claude 서비스: 같은 서비스에서 계정 식별을 이번엔 확인하지 못하면(기억해 둔 이전 식별이 있어도) 저장 기록을 합치지 않고 지금 기억하는 값만", async () => {
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      let identity = "acct-A";
      let next = null;
      claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity });
      claudeApi.fetchPlanUsage = async () => next;
      const usageAt = (u, O) => ({ usage: { windows: [histWin(R, u, O)], extraUsage: null }, subscriptionType: "max" });
      const old = new LimitHistoryStore(dir, "old");
      const oldSvc = new ClaudeService(output, old);
      next = usageAt(12, now - 5 * HOUR);
      await oldSvc.refreshPlan(true);
      oldSvc.dispose();
      old.dispose();
      const store = new LimitHistoryStore(dir, "now");
      const svc = new ClaudeService(output, store);
      next = usageAt(20, now - 2 * HOUR);
      await svc.refreshPlan(true);
      assert.deepStrictEqual(svc.currentState.samples.weekly_all.map((p) => p.v), [12, 20], "식별이 확인될 땐 저장 기록과 이음");
      identity = null; // 같은 폴더에서 이번엔 식별을 읽지 못함
      next = usageAt(21, now - HOUR);
      await svc.refreshPlan(true);
      assert.deepStrictEqual(svc.currentState.samples.weekly_all.map((p) => p.v), [21], "저장 기록(12)도 확인된 A 의 지금 값(20)도 잇지 않음");
      svc.dispose();
      store.dispose();
    });
  });

  await atest("Claude: 아주 긴 서버 대기(30일)도 타이머는 하루 이하로 나눠 걸고 1ms 반복이 없음", async () => {
    claudeApi.fetchPlanUsage = async () => ({ rateLimited: true, retryAfterMs: 30 * 24 * 60 * MIN });
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
    const delays = [];
    const orig = global.setTimeout;
    global.setTimeout = (cb, ms, ...a) => {
      delays.push(ms);
      return orig(cb, Math.min(ms, 50), ...a); // 실제로는 짧게 돌려 반복 여부를 본다
    };
    const svc = new ClaudeService(output);
    try {
      await svc.refreshPlan(true);
      await svc.refreshPlan(true);
      await sleep(200);
    } finally {
      global.setTimeout = orig;
      svc.dispose();
    }
    assert.ok(svc.planNextAllowedAt - Date.now() > 29 * 24 * 60 * MIN, "대기 시각은 30일 그대로");
    const big = delays.filter((d) => d >= 1000);
    assert.ok(big.length > 0 && big.every((d) => d <= 24 * 60 * MIN), JSON.stringify(big.slice(0, 5)));
    assert.ok(!delays.some((d) => d === 1), "1ms 재예약 없음");
  });

  await atest("Claude: 429 대기 중 계정을 바꾸면 서버는 부르지 않고 '계정 확인 중' 표시", async () => {
    let calls = 0;
    let identity = "acct-A";
    claudeApi.fetchPlanUsage = async () => {
      calls += 1;
      return calls === 1 ? weeklyUsage(80, 1000) : { rateLimited: true, retryAfterMs: 30 * MIN };
    };
    claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity });
    const svc = new ClaudeService(output);
    await svc.refreshPlan(true); // A 80%
    await svc.refreshPlan(true); // 429 · 30분
    identity = "acct-B";
    await svc.refreshPlan(true); // 대기 중
    assert.strictEqual(calls, 2, "대기 중엔 서버 미호출");
    assert.strictEqual(svc.currentState.planAccountChecking, true);
    svc.dispose();
  });

  // ---------------- 그래프용 사용률 기록(파란 실선: 창 시작부터 실제로 쓴 굴곡) ----------------
  // 서비스처럼 LimitWatch 가 창을 배정한 뒤 그 '처음 본 리셋 시각'으로 기록한다.
  const recordVia = (store, watch, account, w) => {
    watch.observe([w]);
    store.record(account, [w], (x) => watch.anchorFor(x));
  };

  test("사용률 기록: 같은 값이 이어지면 처음·마지막만 남기고, 같은 시각은 값 정정, 앞선 시각은 버림", () => {
    const pts = [];
    appendPoint(pts, 1, 10);
    appendPoint(pts, 2, 10);
    appendPoint(pts, 3, 10);
    appendPoint(pts, 4, 11);
    assert.deepStrictEqual(pts, [[1, 10], [3, 10], [4, 11]]);
    appendPoint(pts, 4, 12);
    assert.deepStrictEqual(pts[pts.length - 1], [4, 12]);
    appendPoint(pts, 2, 99);
    assert.strictEqual(pts.length, 3);
  });

  await atest("사용률 기록: 계정·창별로 저장하고, 다른 VS Code 창의 파일·다시 켠 뒤에도 합쳐 읽음 · 계정 식별 없으면 저장 안 함 · 계정 원문은 남기지 않음", async () => {
    const fs = require("fs");
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      const S = R - WEEK * MIN;
      const A = historyAccountKey("claude", "acct-A");
      const B = historyAccountKey("claude", "acct-B");
      const w1 = new LimitHistoryStore(dir, "win-1");
      const w2 = new LimitHistoryStore(dir, "win-2");
      const watch1 = new LimitWatch();
      const watch2 = new LimitWatch();
      recordVia(w1, watch1, A, histWin(R, 10, now - 5 * HOUR));
      recordVia(w1, watch1, A, histWin(R + 5000, 20, now - 4 * HOUR)); // 리셋 흔들림 5초 = 같은 창
      recordVia(w2, watch2, A, histWin(R, 30, now - 3 * HOUR)); // 다른 VS Code 창
      recordVia(w2, new LimitWatch(), B, histWin(R, 99, now - 2 * HOUR)); // 다른 계정
      recordVia(w1, watch1, A, histWin(R + 3 * HOUR, 1, now - 1 * HOUR)); // 리셋이 크게 바뀜 = 다른 창
      w1.record(null, [histWin(R, 77, now - 1000)], () => R); // 계정 식별 없음
      w1.flush();
      w2.flush();
      const restarted = new LimitHistoryStore(dir, "win-3"); // 다시 켠 뒤
      const values = (pts) => pts.sort((a, b) => a.ts - b.ts).map((p) => p.v);
      assert.deepStrictEqual(values(restarted.pointsFor(A, histWin(R, 0, now), S, now)), [10, 20, 30]);
      assert.deepStrictEqual(values(restarted.pointsFor(B, histWin(R, 0, now), S, now)), [99]);
      assert.deepStrictEqual(restarted.pointsFor(null, histWin(R, 0, now), S, now), []);
      assert.deepStrictEqual(values(restarted.pointsFor(A, histWin(R, 0, now), now - 3.5 * HOUR, now)), [30], "구간 밖 점은 제외");
      const raw = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
      assert.ok(!raw.includes("acct-A") && !raw.includes("acct-B"), "계정 식별 원문을 남기지 않음");
      assert.ok(!raw.includes(",77]"), "계정 식별이 없는 값은 저장하지 않음");
    });
  });

  await atest("사용률 기록: 같은 창의 리셋 흔들림(수 초)은 다른 VS Code 창 파일·다시 켠 뒤에도 잇고, 리셋이 밀리거나 경계에서 오가 어느 창인지 모호한 기록은 잇지 않음", async () => {
    await withHistDir(async (dir) => {
      const now = Date.now();
      const A = historyAccountKey("codex", "x");
      const S0 = now - 6 * 24 * HOUR;
      const values = (pts) => pts.map((p) => p.v).sort((a, b) => a - b);
      // ① 정상: 같은 창(리셋 4초 흔들림)을 두 VS Code 창이 저장 → 다시 켠 뒤 모두 이음
      const P = now + 3 * 24 * HOUR;
      const a1 = new LimitHistoryStore(dir, "a1");
      const a2 = new LimitHistoryStore(dir, "a2");
      recordVia(a1, new LimitWatch(), A, histWin(P, 10, now - 5 * HOUR));
      recordVia(a2, new LimitWatch(), A, histWin(P + 4000, 12, now - 4 * HOUR));
      a1.flush();
      a2.flush();
      assert.deepStrictEqual(values(new LimitHistoryStore(dir, "r1").pointsFor(A, histWin(P + 2000, 0, now), S0, now)), [10, 12]);
      // ② 지적 순서: 창 1 R₀ 10% → R₀+119초 11%(같은 창), 창 2 는 R₀+119초 11% 부터, 창 1 R₀+121초 1%(새 창) → R₀+119초 2%(새 창 유지)
      const R0 = now + 2 * 24 * HOUR;
      const s1 = new LimitHistoryStore(dir, "w1");
      const s2 = new LimitHistoryStore(dir, "w2");
      const watch1 = new LimitWatch();
      recordVia(s1, watch1, A, histWin(R0, 10, now - 4 * HOUR));
      recordVia(s1, watch1, A, histWin(R0 + 119_000, 11, now - 3 * HOUR));
      recordVia(s2, new LimitWatch(), A, histWin(R0 + 119_000, 11, now - 3 * HOUR));
      s2.flush();
      recordVia(s1, watch1, A, histWin(R0 + 121_000, 1, now - 2 * HOUR));
      const cur = histWin(R0 + 119_000, 2, now - HOUR);
      recordVia(s1, watch1, A, cur);
      assert.deepStrictEqual(watch1.samplesFor(cur).map((p) => p.v), [1, 2], "LimitWatch 는 새 창 샘플만");
      const stored = s1.pointsFor(A, cur, S0, now).map((p) => p.v);
      assert.ok(!stored.includes(11) && !stored.includes(10), `이전 창 점을 잇지 않음: ${stored}`);
      // ③ 리셋이 조금씩 밀린 경우(0→90→180초)도 이전 창 점을 잇지 않음
      const R1 = now + 4 * 24 * HOUR;
      const t1 = new LimitHistoryStore(dir, "t1");
      const t2 = new LimitHistoryStore(dir, "t2");
      const tw = new LimitWatch();
      recordVia(t1, tw, A, histWin(R1, 20, now - 4 * HOUR));
      recordVia(t1, tw, A, histWin(R1 + 90_000, 21, now - 3 * HOUR));
      recordVia(t2, new LimitWatch(), A, histWin(R1 + 90_000, 21, now - 3 * HOUR));
      t2.flush();
      const w3 = histWin(R1 + 180_000, 3, now - HOUR);
      recordVia(t1, tw, A, w3);
      const chain = t1.pointsFor(A, w3, S0, now).map((p) => p.v);
      assert.ok(!chain.includes(20) && !chain.includes(21), `이전 창 점을 잇지 않음: ${chain}`);
      // ④ 한 기록 안 리셋 시각이 넓게 퍼졌으면(Q ~ Q+110초) 지금 Q+130초에 잇지 않음
      const Q = now + 5 * 24 * HOUR;
      const q = new LimitHistoryStore(dir, "q");
      const qw = new LimitWatch();
      recordVia(q, qw, A, histWin(Q, 30, now - 3 * HOUR));
      recordVia(q, qw, A, histWin(Q + 110_000, 31, now - 2 * HOUR));
      q.flush();
      assert.deepStrictEqual(new LimitHistoryStore(dir, "r2").pointsFor(A, histWin(Q + 130_000, 0, now), S0, now), [], "모호 → 잇지 않음");
    });
  });

  await atest("사용률 기록: 다른 창 파일은 주인 프로세스가 끝났고 기록이 모두 지난 창일 때만 지우며, 한 번 읽어 둔 파일도 시간이 지나면 만료를 다시 따짐", async () => {
    const fs = require("fs");
    const { spawnSync } = require("child_process");
    await withHistDir(async (dir) => {
      let clock = Date.now();
      const now = clock;
      const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid; // 이미 끝난 프로세스 번호
      const A = historyAccountKey("codex", "x");
      const entry = (R, ts, v) => ({ account: A, id: "weekly_all", len: WEEK, R0: R, rMin: R, rMax: R, points: [[ts, v]] });
      const put = (name, pid, entries) => fs.writeFileSync(path.join(dir, name), JSON.stringify({ v: 1, pid, entries }));
      put("limit-history-dead-old.json", deadPid, [entry(now - 3 * 24 * HOUR, now - 4 * 24 * HOUR, 5)]);
      put("limit-history-dead-valid.json", deadPid, [entry(now + 24 * HOUR, now - HOUR, 7)]);
      put("limit-history-alive-old.json", process.pid, [entry(now - 3 * 24 * HOUR, now - 4 * 24 * HOUR, 5)]);
      const reader = new LimitHistoryStore(dir, "reader", () => clock);
      const pts = reader.pointsFor(A, histWin(now + 24 * HOUR, 0, now), now - 7 * 24 * HOUR, now);
      assert.deepStrictEqual(pts.map((p) => p.v), [7], "끝난 주인의 유효한 기록은 계속 읽음");
      let names = fs.readdirSync(dir);
      assert.ok(!names.includes("limit-history-dead-old.json"), "끝난 주인 + 모두 지난 기록 → 정리");
      assert.ok(names.includes("limit-history-dead-valid.json"), "끝난 주인이어도 유효한 기록이 있으면 유지");
      assert.ok(names.includes("limit-history-alive-old.json"), "주인이 살아 있으면 지우지 않음(엇갈려 새로 저장한 파일 보호)");
      clock = now + 24 * HOUR + 25 * HOUR; // 파일은 그대로, 시간만 리셋 + 25시간
      const later = reader.pointsFor(A, histWin(now + 24 * HOUR, 0, clock), 0, clock);
      assert.deepStrictEqual(later, [], "만료된 기록은 더 읽지 않음");
      names = fs.readdirSync(dir);
      assert.ok(!names.includes("limit-history-dead-valid.json"), "읽어 둔 파일도 만료되면 정리");
    });
  });

  await atest("사용률 기록: 저장에 실패하면 미저장으로 남겨 두었다가 다음 저장(flush)에서 다시 저장", async () => {
    const fs = require("fs");
    await withHistDir(async (root) => {
      const dir = path.join(root, "store");
      fs.writeFileSync(dir, "폴더 자리에 파일"); // 저장 폴더를 만들 수 없게
      const now = Date.now();
      const A = historyAccountKey("claude", "acct-A");
      const store = new LimitHistoryStore(dir, "w");
      store.record(A, [histWin(now + 24 * HOUR, 33, now - HOUR)], () => now + 24 * HOUR);
      store.flush(); // 실패
      fs.unlinkSync(dir); // 원인 해소
      store.record(A, [histWin(now + 24 * HOUR, 33, now - HOUR)], () => now + 24 * HOUR); // 같은 관측(변경 없음)
      store.dispose(); // 종료 때 다시 저장
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("limit-history-w")) : [];
      assert.strictEqual(files.length, 1, "종료 때 미저장분을 저장");
      assert.ok(fs.readFileSync(path.join(dir, files[0]), "utf8").includes(",33]"));
    });
  });

  await atest("사용률 기록: 점 상한을 넘어도 창 시작(첫 점)과 마지막 점을 지키며 줄임", async () => {
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 24 * HOUR;
      const A = historyAccountKey("codex", "x");
      const store = new LimitHistoryStore(dir, "w");
      const first = now - 10_000 * MIN;
      for (let i = 0; i < 10_000; i++) {
        store.record(A, [histWin(R, i % 2 ? 51 : 50, first + i * MIN)], () => R); // 1분마다 50·51 번갈아
      }
      store.flush();
      const pts = new LimitHistoryStore(dir, "reader").pointsFor(A, histWin(R, 0, now), 0, now);
      assert.ok(pts.length <= 4000, `저장 점 ${pts.length}`);
      const ts = pts.map((p) => p.ts);
      assert.strictEqual(Math.min(...ts), first, "첫 점(창 시작 쪽) 유지");
      assert.strictEqual(Math.max(...ts), first + 9_999 * MIN, "마지막 점 유지");
      assert.deepStrictEqual(thinKeepEnds([1, 2, 3, 4, 5], 3), [1, 3, 5]);
    });
  });

  test("그래프 묶음: 여러 출처를 합쳐 창 구간만 · 같은 시각은 뒤 출처(지금 기억하는 값) 우선 · 너무 많으면 처음·끝 유지하며 고르게 줄임", () => {
    const merged = mergeChartSamples([[{ ts: 1, v: 5 }, { ts: 5, v: 9 }], [{ ts: 5, v: 7 }, { ts: 50, v: 1 }]], 0, 10);
    assert.deepStrictEqual(merged, [{ ts: 1, v: 5 }, { ts: 5, v: 7 }]);
    const many = Array.from({ length: 1000 }, (_, i) => ({ ts: i, v: i % 100 }));
    const thin = mergeChartSamples([many], 0, 999, 50);
    assert.strictEqual(thin.length, 50);
    assert.deepStrictEqual([thin[0].ts, thin[49].ts], [0, 999]);
  });

  // ---- Codex: 가짜 app-server 클라이언트 ----
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.running = false;
      FakeClient.instances.push(this);
    }
    get isRunning() {
      return this.running;
    }
    async start() {
      this.running = true;
    }
    request(method) {
      // 실제 클라이언트처럼 dispose 되면 진행 중 요청이 거절된다.
      return new Promise((resolve, reject) => {
        this.rejectors = (this.rejectors || []).concat(reject);
        Promise.resolve(FakeClient.handler(method, this)).then(resolve, reject);
      });
    }
    dispose() {
      this.running = false;
      for (const r of this.rejectors || []) r(new Error("Codex app-server client disposed"));
      this.rejectors = [];
    }
  }
  codexClient.CodexRpcClient = FakeClient;
  const codexLimits = (u) => ({ rateLimits: { limitId: "codex", primary: { usedPercent: u, windowDurationMins: WEEK, resetsAt: R0 / 1000 }, secondary: null } });
  const account = { account: { type: "chatgpt", email: "a@example.com", planType: "prolite" }, requiresOpenaiAuth: false };

  await atest("Codex 서비스: 어느 계정인지 모르던 값 뒤에 계정이 확인되면 이전 값을 버림 — 모르던 값과 비교한 하락 보류도, 모르던 값의 저장도 없음", async () => {
    const fs = require("fs");
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      let acct = { account: null, requiresOpenaiAuth: false };
      let used = 80;
      FakeClient.instances = [];
      FakeClient.handler = async (m) =>
        m === "account/read" ? acct : { rateLimits: { limitId: "codex", primary: { usedPercent: used, windowDurationMins: WEEK, resetsAt: R / 1000 }, secondary: null } };
      const store = new LimitHistoryStore(dir, "w");
      const svc = new UsageService(output, store);
      try {
        await svc.reconnect(); // 식별 없이 80%
        acct = account;
        used = 20;
        await svc.refreshServer(); // 서버 조회만(로컬 기록 집계는 이 시험과 무관)
        await sleep(20);
        const id = svc.currentState.limits[0].id;
        assert.strictEqual(svc.currentState.limits[0].usedPercent, 20);
        assert.ok(!svc.currentState.holds[id], "모르던 80% 와 비교한 하락 보류 아님");
        store.flush();
        const raw = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
        assert.ok(!raw.includes(",80]"), "모르던 값은 저장하지 않음");
      } finally {
        svc.dispose();
        store.dispose();
      }
    });
  });

  await atest("Codex 서비스: A 확인 → 식별 없이 받은 값 → 다시 A 확인이면, 식별 없이 받은 값을 A 것으로 잇지 않음(실선·하락 보류 모두)", async () => {
    const now = Date.now();
    const R = now + 2 * 24 * HOUR;
    let acct = account;
    let used = 10;
    FakeClient.instances = [];
    FakeClient.handler = async (m) =>
      m === "account/read" ? acct : { rateLimits: { limitId: "codex", primary: { usedPercent: used, windowDurationMins: WEEK, resetsAt: R / 1000 }, secondary: null } };
    const svc = new UsageService(output);
    try {
      await svc.reconnect();
      acct = { account: null, requiresOpenaiAuth: false };
      used = 80;
      await svc.refreshServer();
      acct = account;
      used = 20;
      await svc.refreshServer();
      await sleep(10);
      const id = svc.currentState.limits[0].id;
      assert.strictEqual(svc.currentState.limits[0].usedPercent, 20);
      assert.ok(!svc.currentState.holds[id], "식별 없이 받은 80 과 비교한 하락 보류 아님");
      assert.ok(!svc.currentState.samples[id].some((p) => p.v === 80), "80 이 실선에 없음");
    } finally {
      svc.dispose();
    }
  });

  await atest("Codex 서비스: 확인된 A 80% 를 보는 중 식별 없는 새 값 20% 가 오면 그 순간부터 A 와 잇지 않음(실선에 80 없음·하락 보류 없음)", async () => {
    const now = Date.now();
    const R = now + 2 * 24 * HOUR;
    let acct = account;
    let used = 80;
    FakeClient.instances = [];
    FakeClient.handler = async (m) =>
      m === "account/read" ? acct : { rateLimits: { limitId: "codex", primary: { usedPercent: used, windowDurationMins: WEEK, resetsAt: R / 1000 }, secondary: null } };
    const svc = new UsageService(output);
    try {
      await svc.reconnect();
      await sleep(5);
      acct = { account: null, requiresOpenaiAuth: false };
      used = 20;
      await svc.refreshServer();
      const id = svc.currentState.limits[0].id;
      assert.strictEqual(svc.currentState.limits[0].usedPercent, 20);
      assert.deepStrictEqual(svc.currentState.samples[id].map((p) => p.v), [20], "A 의 80 과 잇지 않음");
      assert.ok(!svc.currentState.holds[id], "A 의 80 과 비교한 하락 보류 아님");
    } finally {
      svc.dispose();
    }
  });

  await atest("Codex 서비스: 시계가 뒤로 가 식별 없는 응답이 모두 옛 관측이면 A 의 값·하락 보류·요금제·크레딧을 그대로 두고, A 가 다시 확인돼도 보류 유지", async () => {
    const now = Date.now();
    const R = now + 2 * 24 * HOUR;
    let acct = account;
    let used = 80;
    let planType = "prolite";
    let credits = { hasCredits: true, unlimited: false, balance: "10" };
    FakeClient.instances = [];
    FakeClient.handler = async (m) =>
      m === "account/read"
        ? acct
        : { rateLimits: { limitId: "codex", planType, credits, primary: { usedPercent: used, windowDurationMins: WEEK, resetsAt: R / 1000 }, secondary: null } };
    const svc = new UsageService(output);
    const realNow = Date.now;
    try {
      await svc.reconnect();
      await sleep(5);
      used = 20; // 같은 창에서 하락 → 보류
      await svc.refreshServer();
      const id = svc.currentState.limits[0].id;
      assert.strictEqual(svc.currentState.holds[id], true);
      const labelA = svc.currentState.planLabel;
      Date.now = () => realNow() - 10 * MIN; // 시계가 10분 뒤로
      acct = { account: null, requiresOpenaiAuth: false };
      used = 90;
      planType = "plus";
      credits = { hasCredits: false, unlimited: false, balance: "0" };
      try {
        await svc.refreshServer();
      } finally {
        Date.now = realNow;
      }
      let st = svc.currentState;
      assert.strictEqual(st.limits[0].usedPercent, 20, "A 값 유지");
      assert.strictEqual(st.holds[id], true, "하락 보류 유지");
      assert.strictEqual(st.planLabel, labelA, "다른 응답의 요금제 표시를 붙이지 않음");
      assert.deepStrictEqual(st.rateLimits.credits, { hasCredits: true, unlimited: false, balance: "10" }, "다른 응답의 크레딧을 붙이지 않음");
      assert.deepStrictEqual(st.account, account.account);
      await sleep(5);
      acct = account;
      used = 21;
      planType = "prolite";
      await svc.refreshServer();
      st = svc.currentState;
      assert.strictEqual(st.limits[0].usedPercent, 21);
      assert.strictEqual(st.holds[id], true, "같은 계정이라 보류 유지");
    } finally {
      Date.now = realNow;
      svc.dispose();
    }
  });

  await atest("Codex 서비스: 식별 없이 받은 80% → 다시 연결 뒤 식별 없는 빈 목록 → 확인된 A 20% 이면 A 값만(80 과 잇지 않고 보류 없음)", async () => {
    const now = Date.now();
    const R = now + 2 * 24 * HOUR;
    let acct = { account: null, requiresOpenaiAuth: false };
    let limits = { rateLimits: { limitId: "codex", primary: { usedPercent: 80, windowDurationMins: WEEK, resetsAt: R / 1000 }, secondary: null } };
    FakeClient.instances = [];
    FakeClient.handler = async (m) => (m === "account/read" ? acct : limits);
    const svc = new UsageService(output);
    try {
      await svc.reconnect();
      const id = svc.currentState.limits[0].id;
      const label80 = svc.currentState.planLabel;
      limits = { rateLimits: { limitId: "codex", planType: "plus", primary: null, secondary: null } }; // 식별 없는 빈 목록(다른 요금제)
      await svc.reconnect(); // 다른 로그인 구간 — 누구 것인지 모르는 응답
      assert.strictEqual(svc.currentState.limits[0]?.usedPercent, 80, "누구 것인지 모르는 빈 응답은 표시 중인 값을 바꾸지 않음");
      assert.strictEqual(svc.currentState.planLabel, label80, "그 응답의 요금제 표시를 붙이지 않음");
      assert.strictEqual(svc.currentState.accountChecking, true);
      await sleep(5);
      acct = account;
      limits = { rateLimits: { limitId: "codex", primary: { usedPercent: 20, windowDurationMins: WEEK, resetsAt: R / 1000 }, secondary: null } };
      await svc.refreshServer();
      const st = svc.currentState;
      assert.strictEqual(st.limits[0].usedPercent, 20);
      assert.deepStrictEqual(st.samples[id].map((p) => p.v), [20]);
      assert.ok(!st.holds[id]);
    } finally {
      svc.dispose();
    }
  });

  await atest("Codex 서비스: 식별 없는 값은 같은 연결·계정 구간이면 이어 그리고(하락 보류 포함), 계정 변경 알림 뒤 식별 없는 새 값은 잇지 않음", async () => {
    const now = Date.now();
    const R = now + 2 * 24 * HOUR;
    let used = 80;
    FakeClient.instances = [];
    FakeClient.handler = async (m) =>
      m === "account/read"
        ? { account: null, requiresOpenaiAuth: false }
        : { rateLimits: { limitId: "codex", primary: { usedPercent: used, windowDurationMins: WEEK, resetsAt: R / 1000 }, secondary: null } };
    const svc = new UsageService(output);
    try {
      await svc.reconnect();
      const id = svc.currentState.limits[0].id;
      await sleep(5);
      used = 70;
      await svc.refreshServer();
      assert.deepStrictEqual(svc.currentState.samples[id].map((p) => p.v), [80, 70], "같은 구간은 이음");
      assert.strictEqual(svc.currentState.holds[id], true);
      await sleep(5);
      used = 20;
      FakeClient.instances[0].emit("notification", "account/updated", {});
      await sleep(30);
      await svc.refreshServer();
      const st = svc.currentState;
      assert.strictEqual(st.limits[0].usedPercent, 20);
      const series = st.samples[id].map((p) => p.v);
      assert.ok(series.length >= 1 && series.every((v) => v === 20), `알림 전 값(80·70)과 잇지 않음: ${series}`);
      assert.ok(!st.holds[id], "알림 전 값과 비교한 하락 보류 아님");
      assert.strictEqual(st.accountChecking, false, "새 주인의 값을 받았으므로 확인 중 해제");
    } finally {
      svc.dispose();
    }
  });

  await atest("Codex 서비스: 식별 없는 값을 보던 중 다시 연결한 뒤 누구 것인지 모르는 빈 응답이 오면 값은 그대로 두되 '계정 확인 중' — 그 연결에서 또 와도 유지", async () => {
    const now = Date.now();
    const R = now + 2 * 24 * HOUR;
    let limits = { rateLimits: { limitId: "codex", primary: { usedPercent: 80, windowDurationMins: WEEK, resetsAt: R / 1000 }, secondary: null } };
    FakeClient.instances = [];
    FakeClient.handler = async (m) => (m === "account/read" ? { account: null, requiresOpenaiAuth: false } : limits);
    const svc = new UsageService(output);
    try {
      await svc.reconnect();
      assert.ok(!svc.currentState.accountChecking);
      limits = { rateLimits: { limitId: "codex", primary: null, secondary: null } }; // 빈 응답
      await svc.reconnect(); // 다시 연결(그사이 로그인이 바뀌었을 수 있음)
      let st = svc.currentState;
      assert.strictEqual(st.limits[0].usedPercent, 80, "값은 그대로");
      assert.strictEqual(st.accountChecking, true, "지금 로그인의 값이 아닐 수 있음을 알림");
      await svc.refreshServer(); // 새 연결에서 다시 빈 응답 — 여전히 표시 값의 주인 구간이 아님
      st = svc.currentState;
      assert.strictEqual(st.limits[0].usedPercent, 80);
      assert.strictEqual(st.accountChecking, true);
    } finally {
      svc.dispose();
    }
  });

  await atest("Codex 서비스: 식별 없는 주인과 같은 연결 구간의 응답은 새 한도 값이 없어도 그 주인의 응답 — 크레딧 갱신·빈 목록이면 서버 답대로·확인 중 아님", async () => {
    const now = Date.now();
    const R = now + 2 * 24 * HOUR;
    const credits = (balance) => ({ hasCredits: true, unlimited: false, balance });
    let limits = { rateLimits: { limitId: "codex", credits: credits("10"), primary: null, secondary: null } };
    FakeClient.instances = [];
    FakeClient.handler = async (m) => (m === "account/read" ? { account: null, requiresOpenaiAuth: false } : limits);
    const svc = new UsageService(output);
    try {
      await svc.reconnect();
      assert.strictEqual(svc.currentState.rateLimits.credits.balance, "10");
      limits = { rateLimits: { limitId: "codex", credits: credits("9"), primary: null, secondary: null } };
      await svc.refreshServer();
      let st = svc.currentState;
      assert.strictEqual(st.rateLimits.credits.balance, "9", "같은 구간이면 크레딧이 갱신됨(멈추지 않음)");
      assert.ok(!st.accountChecking);
      limits = { rateLimits: { limitId: "codex", credits: credits("9"), primary: { usedPercent: 80, windowDurationMins: WEEK, resetsAt: R / 1000 }, secondary: null } };
      await svc.refreshServer();
      assert.strictEqual(svc.currentState.limits[0].usedPercent, 80);
      limits = { rateLimits: { limitId: "codex", planType: "plus", credits: credits("8"), primary: null, secondary: null } };
      await svc.refreshServer();
      st = svc.currentState;
      assert.deepStrictEqual(st.limits, [], "같은 주인의 서버가 창이 없다고 하면 그대로(확인된 계정과 같은 처리)");
      assert.strictEqual(st.rateLimits.credits.balance, "8");
      assert.ok(!st.accountChecking);
    } finally {
      svc.dispose();
    }
  });

  await atest("Codex 서비스: 식별·한도 없이 크레딧만 보던 중 다시 연결 뒤 식별 없는 다른 크레딧 응답이 오면 이전 크레딧을 그대로 두고 '계정 확인 중'(툴팁에도)", async () => {
    let limits = { rateLimits: { limitId: "codex", credits: { hasCredits: true, unlimited: false, balance: "10" }, primary: null, secondary: null } };
    FakeClient.instances = [];
    FakeClient.handler = async (m) => (m === "account/read" ? { account: null, requiresOpenaiAuth: false } : limits);
    const svc = new UsageService(output);
    try {
      await svc.reconnect();
      limits = { rateLimits: { limitId: "codex", credits: { hasCredits: true, unlimited: false, balance: "99" }, primary: null, secondary: null } };
      await svc.reconnect();
      const st = svc.currentState;
      assert.strictEqual(st.rateLimits.credits.balance, "10", "누구 것인지 모르는 응답의 크레딧으로 바꾸지 않음");
      assert.strictEqual(st.accountChecking, true);
      assert.ok(formatTooltip(st).includes(T.fcAccountChecking), formatTooltip(st));
    } finally {
      svc.dispose();
    }
  });

  await atest("Codex 서비스: 확인된 A 의 계정·크레딧을 보던 중 다시 연결 뒤 조회가 실패하면 실패 안내와 함께 '계정 확인 중'(툴팁에도) — 같은 연결의 실패면 켜지 않음", async () => {
    let fail = false;
    const limits = { rateLimits: { limitId: "codex", credits: { hasCredits: true, unlimited: false, balance: "10" }, primary: null, secondary: null } };
    FakeClient.instances = [];
    FakeClient.handler = async (m) => {
      if (fail && m === "account/rateLimits/read") throw new Error("boom");
      return m === "account/read" ? account : limits;
    };
    const svc = new UsageService(output);
    try {
      await svc.reconnect();
      fail = true;
      await svc.refreshServer(); // 같은 연결에서 실패
      let st = svc.currentState;
      assert.strictEqual(st.serverFailing, true);
      assert.ok(!st.accountChecking, "같은 연결의 실패는 확인 중 아님");
      await svc.reconnect(); // 다시 연결 뒤 실패
      st = svc.currentState;
      assert.strictEqual(st.serverFailing, true);
      assert.deepStrictEqual(st.account, account.account, "A 정보는 그대로");
      assert.strictEqual(st.accountChecking, true, "다른 로그인 구간일 수 있음을 알림");
      assert.ok(formatTooltip(st).includes(T.fcAccountChecking), formatTooltip(st));
      fail = false;
      await svc.refreshServer(); // A 가 다시 확인되면 해제
      assert.strictEqual(svc.currentState.accountChecking, false);
    } finally {
      svc.dispose();
    }
  });

  await atest("Codex 서비스: 한도 목록 없이 계정·크레딧만 표시 중 다시 연결 후 식별 없는 빈 응답이 오면 A 정보는 그대로 두되 '계정 확인 중'(툴팁에도) — 같은 연결이면 켜지 않음", async () => {
    let acct = account;
    const creditsA = { hasCredits: true, unlimited: false, balance: "10" };
    let limits = { rateLimits: { limitId: "codex", credits: creditsA, primary: null, secondary: null } };
    FakeClient.instances = [];
    FakeClient.handler = async (m) => (m === "account/read" ? acct : limits);
    const svc = new UsageService(output);
    try {
      await svc.reconnect();
      let st = svc.currentState;
      assert.deepStrictEqual([st.limits.length, st.account, st.accountChecking], [0, account.account, false]);
      acct = { account: null, requiresOpenaiAuth: false };
      limits = { rateLimits: { limitId: "codex", credits: { hasCredits: false, unlimited: false, balance: "0" }, primary: null, secondary: null } };
      await svc.refreshServer();
      st = svc.currentState;
      assert.strictEqual(st.accountChecking, false, "같은 연결이면 켜지 않음");
      assert.deepStrictEqual(st.rateLimits.credits, creditsA);
      await svc.reconnect();
      st = svc.currentState;
      assert.deepStrictEqual(st.account, account.account, "A 계정 그대로");
      assert.deepStrictEqual(st.rateLimits.credits, creditsA, "A 크레딧 그대로");
      assert.strictEqual(st.accountChecking, true, "한도 목록이 없어도 계정 확인 중");
      assert.ok(formatTooltip(st).includes(T.fcAccountChecking), formatTooltip(st));
    } finally {
      svc.dispose();
    }
  });

  await atest("Codex 서비스: 그래프는 같은 계정의 저장된 값(다른 창·다시 켜기 전)과 지금 값을 창 시작부터 이어 그리고, 다른 계정 것은 섞지 않음", async () => {
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      const live = windowsFromCodex({ limitId: "codex", primary: { usedPercent: 60, windowDurationMins: WEEK, resetsAt: R / 1000 } }, undefined, now)[0];
      const identity = "chatgpt:a@example.com:prolite";
      const old = new LimitHistoryStore(path.join(dir, "store"), "old-window");
      old.record(historyAccountKey("codex", identity), [{ ...live, usedPercent: 40, observedAtMs: now - 3 * 24 * HOUR }], () => R);
      old.record(historyAccountKey("codex", "chatgpt:b@example.com:prolite"), [{ ...live, usedPercent: 99, observedAtMs: now - 2 * 24 * HOUR }], () => R);
      old.flush();
      FakeClient.instances = [];
      FakeClient.handler = async (m) =>
        m === "account/read" ? account : { rateLimits: { limitId: "codex", primary: { usedPercent: 60, windowDurationMins: WEEK, resetsAt: R / 1000 }, secondary: null } };
      const store = new LimitHistoryStore(path.join(dir, "store"), "this-window");
      const svc = new UsageService(output, store);
      try {
        await svc.reconnect();
        const series = svc.currentState.samples[live.id].map((p) => p.v);
        assert.deepStrictEqual(series, [40, 60], "저장된 40 → 지금 60");
        assert.ok(!series.includes(99), "다른 계정 값은 섞지 않음");
      } finally {
        svc.dispose();
        store.dispose();
      }
    });
  });

  await atest("Codex: 재연결 뒤 이전 연결의 늦은 끊김 신호는 새 연결 상태를 훼손하지 않음", async () => {
    FakeClient.instances = [];
    FakeClient.handler = async (m) => (m === "account/read" ? account : codexLimits(30));
    const svc = new UsageService(output);
    await svc.reconnect();
    await svc.reconnect();
    FakeClient.instances[0].emit("close");
    assert.strictEqual(svc.currentState.connected, true);
    FakeClient.instances[1].emit("close");
    assert.strictEqual(svc.currentState.connected, false, "현재 연결의 끊김은 반영");
    svc.dispose();
  });

  await atest("Codex: 조회 중 알림이 와도 값은 직접 쓰지 않고 다음 전체 조회로 — 순서 역전 없음", async () => {
    FakeClient.instances = [];
    let reads = 0;
    const gate = deferred();
    FakeClient.handler = async (m) => {
      if (m === "account/read") return account;
      reads += 1;
      if (reads === 2) await gate.promise;
      return codexLimits(reads === 2 ? 50 : 60);
    };
    const svc = new UsageService(output);
    svc.notifyMaxWaitMs = 10;
    await svc.reconnect(); // read 1 → 60
    const inflight = svc.refresh(); // read 2 (50, 대기 중)
    FakeClient.instances[0].emit("notification", "account/rateLimits/updated", { rateLimits: codexLimits(99).rateLimits });
    await sleep(30);
    assert.strictEqual(svc.currentState.limits[0].usedPercent, 60, "알림 값(99)을 직접 쓰지 않음");
    gate.resolve();
    await inflight;
    await sleep(30);
    assert.strictEqual(reads, 3, "진행 중 조회 뒤 1회 재조회");
    assert.strictEqual(svc.currentState.limits[0].usedPercent, 60, "마지막 확정 조회 값");
    svc.dispose();
  });

  await atest("Codex: 연속 알림이 와도 첫 알림 기준 최대 대기 안에 조회(계속 미뤄지지 않음)", async () => {
    FakeClient.instances = [];
    let reads = 0;
    FakeClient.handler = async (m) => (m === "account/read" ? account : (reads++, codexLimits(30)));
    const svc = new UsageService(output);
    svc.notifyMaxWaitMs = 40;
    await svc.reconnect();
    const before = reads;
    for (let i = 0; i < 12; i++) {
      FakeClient.instances[0].emit("notification", "account/rateLimits/updated", {});
      await sleep(10);
    }
    assert.ok(reads - before >= 2, `알림 120ms 동안 조회 ${reads - before}회`);
    svc.dispose();
  });

  await atest("Codex: 조회 중 계정이 바뀌면(account/updated) 그 결과는 버리고 다시 읽음", async () => {
    FakeClient.instances = [];
    let reads = 0;
    const gate = deferred();
    FakeClient.handler = async (m) => {
      if (m === "account/read") return account;
      reads += 1;
      if (reads === 2) await gate.promise;
      return codexLimits(reads === 2 ? 77 : 40);
    };
    const svc = new UsageService(output);
    await svc.reconnect();
    const inflight = svc.refresh();
    FakeClient.instances[0].emit("notification", "account/updated", {});
    gate.resolve();
    await inflight;
    await sleep(30);
    assert.notStrictEqual(svc.currentState.limits[0].usedPercent, 77, "계정 변경 전 시작한 조회 결과(77) 폐기");
    svc.dispose();
  });

  await atest("Codex: 조회 실패 중엔 노후 표시 유지(간격이 늘어도 다시 '신선'해지지 않음)", async () => {
    FakeClient.instances = [];
    let fail = false;
    FakeClient.handler = async (m) => {
      if (fail) throw new Error("boom");
      return m === "account/read" ? account : codexLimits(30);
    };
    const svc = new UsageService(output);
    await svc.reconnect();
    const staleAt = svc.currentState.limits[0].staleAtMs;
    assert.ok(staleAt > Date.now());
    fail = true;
    await svc.refresh();
    assert.strictEqual(svc.currentState.serverFailing, true);
    assert.strictEqual(svc.currentState.limits[0].staleAtMs, staleAt, "노후 시각은 관측 때 고정");
    const views = withViews(svc.currentState.limits, {}, { failing: svc.currentState.serverFailing }, Date.now());
    assert.ok(views[0].forecastText.includes("마지막 관측"), "실패 중엔 시간과 무관하게 이전 관측 표시");
    svc.dispose();
  });

  await atest("Codex: 조회 중 재연결로 이전 요청이 취소돼도 새 연결의 실패로 세지 않고 새 연결로 다시 읽음", async () => {
    FakeClient.instances = [];
    let reads = 0;
    const gate = deferred();
    FakeClient.handler = async (m) => {
      if (m === "account/read") return account;
      reads += 1;
      if (reads === 2) await gate.promise; // 이전 연결의 조회 — 끝나기 전에 재연결됨
      return codexLimits(42);
    };
    const svc = new UsageService(output);
    await svc.reconnect(); // read 1
    const inflight = svc.refresh(); // read 2 (대기)
    await sleep(5);
    await svc.reconnect(); // 이전 클라이언트 dispose → read 2 거절
    await inflight;
    await sleep(20);
    assert.strictEqual(svc.currentState.serverFailing, false, "취소를 실패로 보지 않음");
    assert.ok(reads >= 3, `새 연결에서 다시 읽음(reads=${reads})`);
    assert.strictEqual(svc.currentState.connected, true);
    svc.dispose();
  });

  await atest("Codex: 종료(dispose) 뒤 거절된 요청은 실패 반영·재예약하지 않음", async () => {
    FakeClient.instances = [];
    let reads = 0;
    const gate = deferred();
    FakeClient.handler = async (m) => {
      if (m === "account/read") return account;
      reads += 1;
      if (reads === 2) await gate.promise;
      return codexLimits(42);
    };
    const svc = new UsageService(output);
    await svc.reconnect();
    const inflight = svc.refresh();
    await sleep(5);
    const timers = await countLongTimers(async () => {
      svc.dispose();
      await inflight;
      await sleep(5);
    });
    assert.strictEqual(svc.currentState.serverFailing, false);
    assert.strictEqual(timers, 0);
  });

  await atest("Codex: 계정 변경 알림 뒤 이전 요청이 실패해도 현재 실패로 세지 않고 새 계정으로 다시 읽음('계정 확인 중' 표시)", async () => {
    FakeClient.instances = [];
    let reads = 0;
    const gate = deferred();
    let acct = account;
    FakeClient.handler = async (m) => {
      if (m === "account/read") return acct;
      reads += 1;
      if (reads === 2) {
        await gate.promise;
        throw new Error("unauthorized");
      }
      return codexLimits(reads === 1 ? 80 : 12);
    };
    const svc = new UsageService(output);
    await svc.reconnect(); // A 80%
    const inflight = svc.refresh(); // 진행 중(실패 예정)
    await sleep(5);
    acct = { account: { type: "chatgpt", email: "b@example.com", planType: "plus" }, requiresOpenaiAuth: false };
    FakeClient.instances[0].emit("notification", "account/updated", {});
    assert.strictEqual(svc.currentState.accountChecking, true);
    const v = withViews(svc.currentState.limits, {}, { failing: false, checking: true }, Date.now());
    assert.ok(v[0].forecastText.includes("계정 변경 확인 중"), v[0].forecastText);
    gate.resolve();
    await inflight;
    await sleep(30);
    assert.strictEqual(svc.currentState.serverFailing, false, "이전 계정 요청 실패는 세지 않음");
    assert.strictEqual(svc.currentState.limits[0].usedPercent, 12, "새 계정 값");
    assert.strictEqual(svc.currentState.accountChecking, false);
    svc.dispose();
  });

  await atest("Codex: 시작 도중 종료하면 로컬 집계·주기 타이머를 만들지 않음", async () => {
    FakeClient.instances = [];
    const gate = deferred();
    FakeClient.handler = async (m) => {
      if (m === "account/read") return account;
      await gate.promise;
      return codexLimits(30);
    };
    const svc = new UsageService(output);
    let localRuns = 0;
    const origLocal = svc.refreshLocal.bind(svc);
    svc.refreshLocal = async () => {
      localRuns += 1;
      return origLocal();
    };
    const n = await countIntervals(async () => {
      const started = svc.start();
      await sleep(5);
      svc.dispose();
      gate.resolve();
      await started;
    });
    assert.strictEqual(n, 0);
    assert.strictEqual(localRuns, 0);
  });

  // ---------- 0.10.1: 값을 받지 못한 구간(흐린 선) · 받은 마지막 값까지 · 리셋 뒤 새 시작 ----------
  const { extendCover, markGaps, chartUpTo, coverGapFor, DEFAULT_COVER_GAP_MS } = require("../out/limits.js");
  const MINUTE = 60_000;

  await atest("새 값을 계속 받던 구간: 새 관측의 관측 시각이 앞 관측과 30분 안이면 이어지고 더 벌어지면 새 구간 · 되풀이·옛 관측 시각은 아무것도 바꾸지 않음", async () => {
    const T = Date.UTC(2026, 10, 10, 0, 0, 0);
    const c = [];
    extendCover(c, T, DEFAULT_COVER_GAP_MS);
    extendCover(c, T, DEFAULT_COVER_GAP_MS); // 같은 관측 시각 되풀이 → 변화 없음
    extendCover(c, T + 29 * MINUTE, DEFAULT_COVER_GAP_MS); // 29분 → 이어짐
    assert.deepStrictEqual(c, [[T, T + 29 * MINUTE]]);
    extendCover(c, T + 10 * MINUTE, DEFAULT_COVER_GAP_MS); // 옛 관측 시각 → 변화 없음
    assert.deepStrictEqual(c, [[T, T + 29 * MINUTE]]);
    extendCover(c, T + 60 * MINUTE, DEFAULT_COVER_GAP_MS); // 31분 → 새 구간
    assert.deepStrictEqual(c, [[T, T + 29 * MINUTE], [T + 60 * MINUTE, T + 60 * MINUTE]]);
    assert.strictEqual(coverGapFor(120_000), DEFAULT_COVER_GAP_MS, "기본 조회 간격(2분)이면 30분");
    assert.strictEqual(coverGapFor(20 * MINUTE), 60 * MINUTE, "조회 간격이 길면 그 3배");
  });

  await atest("흐린 구간 표시: 여러 출처 구간을 합쳐(사이 30분 이내면 이어짐) 두 점이 한 구간 안이면 이어진 것, 아니면 gap — 첫 점엔 붙이지 않음", async () => {
    const T = Date.UTC(2026, 10, 10, 0, 0, 0);
    const pts = [0, 60, 125, 400, 410].map((m, i) => ({ ts: T + m * MINUTE, v: 10 + i }));
    const a = [[T, T + 60 * MINUTE, 0]]; // 창 A: 0~60분
    const b = [[T + 80 * MINUTE, T + 125 * MINUTE, 0]]; // 창 B: 80~125분(A 끝과 20분 차 → 이어짐)
    const live = [[T + 400 * MINUTE, T + 410 * MINUTE, 0]];
    const out = markGaps(pts, [a, b, live], DEFAULT_COVER_GAP_MS);
    assert.deepStrictEqual(out.map((p) => Boolean(p.gap)), [false, false, false, true, false]);
    assert.deepStrictEqual(out.map((p) => p.v), [10, 11, 12, 13, 14], "값·시각은 그대로");
    assert.ok(!("gap" in out[0]) && !("gap" in out[1]), "이어진 점에는 표시 없음");
    assert.deepStrictEqual(markGaps(pts.slice(0, 2), [], DEFAULT_COVER_GAP_MS).map((p) => Boolean(p.gap)), [false, true], "구간 정보가 없으면 모른다 → gap");
  });

  await atest("그래프 상한: 지금과 받아들인 관측 시각 중 늦은 쪽(서버 관측 시각이 PC 보다 앞서도), 단 리셋을 넘지 않음", async () => {
    const now = Date.now();
    assert.strictEqual(chartUpTo(histWin(now + 10 * HOUR, 5, now + 1000), now), now + 1000);
    assert.strictEqual(chartUpTo(histWin(now + 10 * HOUR, 5, now - 1000), now), now);
    assert.strictEqual(chartUpTo(histWin(now - HOUR, 5, now - 2 * HOUR), now), now - HOUR, "리셋이 지났으면 리셋까지");
  });

  await atest("이력 저장소: 계속 받던 구간을 함께 저장·다른 창이 읽음, 0.10.0 기록(구간 없음)은 처음~마지막을 한 구간으로, 깨진 구간은 버림", async () => {
    await withHistDir(async (dir) => {
      const fs = require("fs");
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      const acct = historyAccountKey("claude", "acct-A");
      const w1 = new LimitHistoryStore(dir, "w1");
      w1.record(acct, [histWin(R, 10, now - 5 * HOUR)], () => R);
      w1.record(acct, [histWin(R, 12, now - 4.9 * HOUR)], () => R);
      w1.record(acct, [histWin(R, 30, now - HOUR)], () => R); // 4시간 가까이 끊긴 뒤
      w1.flush();
      fs.writeFileSync(
        path.join(dir, "limit-history-legacy-1.json"),
        JSON.stringify({ v: 1, pid: process.pid, entries: [{ account: acct, id: "weekly_all", len: WEEK, R0: R, rMin: R, rMax: R, points: [[now - 10 * HOUR, 2], [now - 8 * HOUR, 4]] }] }),
      );
      fs.writeFileSync(
        path.join(dir, "limit-history-broken-1.json"),
        JSON.stringify({ v: 1, pid: process.pid, entries: [{ account: acct, id: "weekly_all", len: WEEK, R0: R, rMin: R, rMax: R, points: [[now - 7 * HOUR, 5]], cover: [null, ["x", 1], [now - 6 * HOUR, now - 7 * HOUR], [now - 7 * HOUR, now - 7 * HOUR, "bad"]] }] }),
      );
      const reader = new LimitHistoryStore(dir, "reader");
      const data = reader.chartDataFor(acct, histWin(R, 30, now), now - 24 * HOUR, now);
      const spans = data.cover.map((s) => [s[0], s[1]]).sort((a, b) => a[0] - b[0]);
      assert.deepStrictEqual(spans, [
        [now - 10 * HOUR, now - 8 * HOUR], // 0.10.0 기록: 처음~마지막
        [now - 7 * HOUR, now - 7 * HOUR], // 깨진 구간 중 쓸 수 있는 것만(받은 시각이 깨지면 0)
        [now - 5 * HOUR, now - 4.9 * HOUR],
        [now - HOUR, now - HOUR],
      ]);
      assert.deepStrictEqual(data.points.map((p) => p.v).sort((a, b) => a - b), [2, 4, 5, 10, 12, 30]);
      reader.dispose();
      w1.dispose();
    });
  });

  await atest("Claude 서비스: 다른 창이 사흘 전 받은 값들과 지금 값 사이(값을 받지 못한 구간)만 흐린 구간으로 표시 — 계속 받은 구간은 그대로", async () => {
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      const acct = historyAccountKey("claude", "acct-A");
      const old = new LimitHistoryStore(dir, "old");
      for (let i = 0; i <= 12; i++) {
        const t = now - 3 * 24 * HOUR + i * 10 * MINUTE;
        old.record(acct, [histWin(R, 10 + i, t)], () => R);
      }
      old.flush();
      claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
      claudeApi.fetchPlanUsage = async () => ({ usage: { windows: [histWin(R, 40, Date.now())], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" });
      const store = new LimitHistoryStore(dir, "this");
      const svc = new ClaudeService(output, store);
      try {
        await svc.refreshPlan(true);
        const s = svc.currentState.samples.weekly_all;
        assert.deepStrictEqual(s.map((p) => p.v), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 40]);
        assert.deepStrictEqual(s.map((p) => Boolean(p.gap)), [...Array(13).fill(false), true], "사흘 공백만 흐림");
      } finally {
        svc.dispose();
        store.dispose();
        old.dispose();
      }
    });
  });

  await atest("Claude 서비스: VS Code 를 켜 둔 채 3시간 같은 값(점은 처음·끝만 남음)이어도, 점이 그래프 상한(400)을 넘어 솎여도 계속 받은 구간은 흐리게 표시하지 않음", async () => {
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      const acct = historyAccountKey("claude", "acct-A");
      const old = new LimitHistoryStore(dir, "old");
      // 사흘 전부터 2분마다 오르는 값 1100개(그래프로 보낼 때 상한 400 으로 솎임)
      for (let i = 0; i < 1100; i++) {
        const t = now - 3 * 24 * HOUR + i * 2 * MINUTE;
        old.record(acct, [histWin(R, Math.min(39, i / 30), t)], () => R);
      }
      // 한참 끊긴 뒤 3시간 동안 2분마다 40% (같은 값 → 저장은 처음·끝 두 점)
      for (let t = now - 3 * HOUR; t <= now - 5 * MINUTE; t += 2 * MINUTE) old.record(acct, [histWin(R, 40, t)], () => R);
      old.flush();
      claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
      claudeApi.fetchPlanUsage = async () => ({ usage: { windows: [histWin(R, 40, Date.now())], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" });
      const store = new LimitHistoryStore(dir, "this");
      const svc = new ClaudeService(output, store);
      try {
        await svc.refreshPlan(true);
        const s = svc.currentState.samples.weekly_all;
        assert.ok(s.length <= 400, `그래프 점 상한: ${s.length}`);
        const gaps = s.map((p, i) => (p.gap ? i : -1)).filter((i) => i >= 0);
        assert.strictEqual(gaps.length, 1, `흐린 구간은 사흘 기록 끝 → 3시간 전 사이 하나뿐: ${gaps}`);
        const g = s[gaps[0]];
        assert.strictEqual(g.v, 40);
        assert.ok(Math.abs(g.ts - (now - 3 * HOUR)) < MINUTE, "3시간 같은 값 구간의 시작에서만 흐림");
        assert.ok(!s[s.length - 1].gap, "같은 값으로 계속 받은 3시간 → 지금은 이어짐");
      } finally {
        svc.dispose();
        store.dispose();
        old.dispose();
      }
    });
  });

  await atest("Claude 서비스: 서버가 붙인 관측 시각이 PC 시계보다 조금 앞서도 방금 받은 값이 실선 끝에 들어감(카드 값과 실선 끝 일치)", async () => {
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      let next = { usage: { windows: [histWin(R, 9, now - MINUTE)], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" };
      claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
      claudeApi.fetchPlanUsage = async () => next;
      const store = new LimitHistoryStore(dir, "this");
      const svc = new ClaudeService(output, store);
      try {
        await svc.refreshPlan(true);
        next = { usage: { windows: [histWin(R, 10, Date.now() + 2000)], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" };
        await svc.refreshPlan(true);
        const st = svc.currentState;
        assert.strictEqual(st.plan.windows[0].usedPercent, 10);
        assert.deepStrictEqual(st.samples.weekly_all.map((p) => p.v), [9, 10], "미래로 보이는 마지막 관측도 실선에 포함");
      } finally {
        svc.dispose();
        store.dispose();
      }
    });
  });

  await atest("리셋 뒤 실선 새 시작: 지난 창 40%·70% 뒤 새 창 값을 받으면 그 첫 관측부터(같은 서비스·저장 기록을 공유한 다른 창 모두) — 하락 보류 없음", async () => {
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R1 = now - HOUR;
      const R2 = R1 + WEEK * MINUTE;
      let next;
      claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
      claudeApi.fetchPlanUsage = async () => next;
      const s1 = new LimitHistoryStore(dir, "first");
      const svc = new ClaudeService(output, s1);
      try {
        next = { usage: { windows: [histWin(R1, 40, now - 3 * HOUR)], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" };
        await svc.refreshPlan(true);
        next = { usage: { windows: [histWin(R1, 70, now - 2 * HOUR)], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" };
        await svc.refreshPlan(true);
        assert.deepStrictEqual(svc.currentState.samples.weekly_all.map((p) => p.v), [40, 70]);
        next = { usage: { windows: [histWin(R2, 3, now - 10 * MINUTE)], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" };
        await svc.refreshPlan(true);
        assert.deepStrictEqual(svc.currentState.samples.weekly_all.map((p) => p.v), [3], "새 창 첫 관측부터");
        next = { usage: { windows: [histWin(R2, 9, now - 5 * MINUTE)], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" };
        await svc.refreshPlan(true);
        assert.deepStrictEqual(svc.currentState.samples.weekly_all.map((p) => p.v), [3, 9]);
        assert.ok(!svc.currentState.holds.weekly_all, "지난 창 70% 와 비교한 하락 보류 아님");
        s1.flush();
      } finally {
        svc.dispose();
        s1.dispose();
      }
      const s2 = new LimitHistoryStore(dir, "second");
      const other = new ClaudeService(output, s2);
      try {
        next = { usage: { windows: [histWin(R2, 10, Date.now())], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" };
        await other.refreshPlan(true);
        assert.deepStrictEqual(other.currentState.samples.weekly_all.map((p) => p.v), [3, 9, 10], "다른 창도 지난 창 점 없이 새 창부터");
      } finally {
        other.dispose();
        s2.dispose();
      }
    });
  });

  await atest("Codex 서비스: 같은 연결에서 몇 분 간격으로 이어 받은 값(관측 시각 = 받은 시각)은 흐린 구간 없음", async () => {
    const now = Date.now();
    const R = now + 2 * 24 * HOUR;
    let used = 10;
    FakeClient.instances = [];
    FakeClient.handler = async (m) =>
      m === "account/read" ? account : { rateLimits: { limitId: "codex", primary: { usedPercent: used, windowDurationMins: WEEK, resetsAt: R / 1000 }, secondary: null } };
    const svc = new UsageService(output);
    try {
      await svc.reconnect();
      const id = svc.currentState.limits[0].id;
      await sleep(5);
      used = 12;
      await svc.refreshServer();
      const s = svc.currentState.samples[id];
      assert.deepStrictEqual(s.map((p) => p.v), [10, 12]);
      assert.ok(!s.some((p) => p.gap), JSON.stringify(s));
    } finally {
      svc.dispose();
    }
  });

  await atest("이력 저장소: 끊긴 구간 양쪽이 같은 값이어도 저장할 때 하나로 줄이지 않음(경계 점 유지) — 구간 안의 같은 값만 줄임", async () => {
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      const acct = historyAccountKey("claude", "acct-A");
      const st = new LimitHistoryStore(dir, "w");
      const T = now - 10 * HOUR;
      const put = (t) => st.record(acct, [histWin(R, 40, t)], () => R);
      put(T);
      put(T + 2 * MINUTE);
      put(T + 4 * MINUTE); // 1구간: 같은 값 세 점 → 처음·끝
      put(T + 5 * HOUR); // 5시간 끊긴 뒤 2구간 시작(같은 값)
      put(T + 5 * HOUR + 2 * MINUTE);
      put(T + 5 * HOUR + 4 * MINUTE);
      const data = st.chartDataFor(acct, histWin(R, 40, now), 0, now);
      assert.deepStrictEqual(
        data.points.map((p) => (p.ts - T) / MINUTE),
        [0, 4, 300, 304],
        "1구간 끝(4분)과 2구간 시작(300분)이 남음",
      );
      const s = chartSeries([data.points], [data.cover], 0, now);
      assert.deepStrictEqual(s.map((p) => [(p.ts - T) / MINUTE, Boolean(p.gap)]), [[0, false], [4, false], [300, true], [304, false]]);
      st.dispose();
    });
  });

  await atest("지금 기억하는 점이 상한(300)을 넘어 앞쪽을 솎아도 값을 받던 구간의 시작·끝 점은 남아 흐린 구간이 정확히 그 사이만", async () => {
    const wt = new LimitWatch();
    const T = Date.now() - 2 * 24 * HOUR;
    const R = T + 5 * 24 * HOUR;
    const obsAt = (t, u) => wt.observe([histWin(R, u, t)]);
    let u = 0;
    for (let i = 0; i < 250; i++) obsAt(T + i * 2 * MINUTE, (u += 0.01)); // 1구간 약 8시간
    const end1 = T + 249 * 2 * MINUTE;
    const start2 = end1 + 6 * HOUR; // 6시간 끊김
    for (let i = 0; i < 250; i++) obsAt(start2 + i * 2 * MINUTE, (u += 0.01));
    const w = histWin(R, u, start2 + 249 * 2 * MINUTE);
    const samples = wt.samplesFor(w);
    assert.ok(samples.length <= 300 + 4, `솎임: ${samples.length}`);
    assert.ok(samples.some((p) => p.ts === end1), "1구간 끝 점 유지");
    assert.ok(samples.some((p) => p.ts === start2), "2구간 시작 점 유지");
    const marked = markGaps(samples, [wt.coverFor(w)], DEFAULT_COVER_GAP_MS);
    const gaps = marked.map((p, i) => (p.gap ? i : -1)).filter((i) => i >= 0);
    assert.strictEqual(gaps.length, 1);
    assert.strictEqual(marked[gaps[0]].ts, start2);
    assert.strictEqual(marked[gaps[0] - 1].ts, end1);
  });

  await atest("Claude·Codex 서비스: 계정 정보를 읽지 못해 저장 기록 없이 그릴 때도, 새 값의 관측 시각이 3시간 벌어지면 그 사이만 흐린 구간(2분 간격이면 이어짐)", async () => {
    const realNow = Date.now;
    const base = realNow() - 5 * HOUR;
    let fake = base;
    Date.now = () => fake;
    try {
      // Claude: 식별 없음(저장 안 함) — 같은 토큰이라 같은 주인으로 이어 그림
      const R = base + 2 * 24 * HOUR;
      let next;
      claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: null });
      claudeApi.fetchPlanUsage = async () => next;
      const svc = new ClaudeService(output);
      try {
        for (const [dt, u] of [[0, 10], [2 * MINUTE, 11], [3 * HOUR, 30], [3 * HOUR + 2 * MINUTE, 31]]) {
          fake = base + dt;
          next = { usage: { windows: [histWin(R, u, fake)], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" };
          await svc.refreshPlan(true);
        }
        const s = svc.currentState.samples.weekly_all;
        assert.deepStrictEqual(s.map((p) => [p.v, Boolean(p.gap)]), [[10, false], [11, false], [30, true], [31, false]]);
      } finally {
        svc.dispose();
      }
      // Codex: 식별 없음 — 받은 시각(응답 도착)으로 판단
      let used = 10;
      FakeClient.instances = [];
      FakeClient.handler = async (m) =>
        m === "account/read"
          ? { account: null, requiresOpenaiAuth: false }
          : { rateLimits: { limitId: "codex", primary: { usedPercent: used, windowDurationMins: WEEK, resetsAt: R / 1000 }, secondary: null } };
      const cx = new UsageService(output);
      try {
        fake = base;
        await cx.reconnect();
        const id = cx.currentState.limits[0].id;
        for (const [dt, u] of [[2 * MINUTE, 11], [3 * HOUR, 30], [3 * HOUR + 2 * MINUTE, 31]]) {
          fake = base + dt;
          used = u;
          await cx.refreshServer();
        }
        const s = cx.currentState.samples[id];
        assert.deepStrictEqual(s.map((p) => [p.v, Boolean(p.gap)]), [[10, false], [11, false], [30, true], [31, false]]);
      } finally {
        cx.dispose();
      }
    } finally {
      Date.now = realNow;
    }
  });

  await atest("Claude 서비스: 응답은 20분마다 받았어도 서버가 같은 옛 관측 시각만 되풀이해 새 값의 관측 시각이 40분 벌어지면 그 사이는 흐린 구간(새 값을 받지 못함)", async () => {
    const realNow = Date.now;
    const base = realNow() - 5 * HOUR;
    let fake = base;
    Date.now = () => fake;
    try {
      const R = base + 2 * 24 * HOUR;
      let next;
      claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: null });
      claudeApi.fetchPlanUsage = async () => next;
      const svc = new ClaudeService(output);
      try {
        // 받은 시각: 0·20·40분, 서버 관측 시각: 0·0(되풀이)·40분 → 새 값은 0분과 40분뿐
        for (const [dt, O, u] of [[0, 0, 10], [20 * MINUTE, 0, 10], [40 * MINUTE, 40 * MINUTE, 12]]) {
          fake = base + dt;
          next = { usage: { windows: [histWin(R, u, base + O)], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" };
          await svc.refreshPlan(true);
        }
        const s = svc.currentState.samples.weekly_all;
        assert.deepStrictEqual(s.map((p) => [p.v, Boolean(p.gap)]), [[10, false], [12, true]], JSON.stringify(s));
      } finally {
        svc.dispose();
      }
    } finally {
      Date.now = realNow;
    }
  });

  await atest("이력 저장소: 한 창 기록이 상한(4000점)을 넘어 솎여도 값을 받던 구간의 시작·끝 점은 남음", async () => {
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 3 * 24 * HOUR;
      const acct = historyAccountKey("codex", "acct-A");
      const st = new LimitHistoryStore(dir, "w");
      const T = now - 6 * 24 * HOUR;
      let i = 0;
      let t = T;
      for (; i < 2500; i++, t += MINUTE) st.record(acct, [histWin(R, i * 0.01, t)], () => R);
      const end1 = t - MINUTE;
      const start2 = end1 + 5 * HOUR;
      t = start2;
      for (let k = 0; k < 2000; k++, i++, t += MINUTE) st.record(acct, [histWin(R, i * 0.01, t)], () => R);
      const data = st.chartDataFor(acct, histWin(R, 1, now), 0, now);
      assert.ok(data.points.length < 4000, `솎임: ${data.points.length}`);
      const ts = new Set(data.points.map((p) => p.ts));
      assert.ok(ts.has(end1), "1구간 끝 점 유지");
      assert.ok(ts.has(start2), "2구간 시작 점 유지");
      const s = chartSeries([data.points], [data.cover], 0, now);
      const gaps = s.filter((p) => p.gap);
      assert.strictEqual(gaps.length, 1);
      assert.strictEqual(gaps[0].ts, start2);
      st.dispose();
    });
  });

  await atest("Claude 서비스: 서버 관측 시각이 받은 시각보다 2분 늦게 붙어 응답 간격이 31분이어도 관측 시각 사이가 29분이면 이어진 것(그래프·예상과 같은 관측 시각 기준)", async () => {
    const realNow = Date.now;
    const base = realNow() - 5 * HOUR;
    let fake = base;
    Date.now = () => fake;
    try {
      const R = base + 2 * 24 * HOUR;
      let next;
      claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: null });
      claudeApi.fetchPlanUsage = async () => next;
      const svc = new ClaudeService(output);
      try {
        for (const [dt, O, u] of [[MINUTE, MINUTE, 10], [32 * MINUTE, 30 * MINUTE, 20]]) {
          fake = base + dt;
          next = { usage: { windows: [histWin(R, u, base + O)], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" };
          await svc.refreshPlan(true);
        }
        assert.deepStrictEqual(svc.currentState.samples.weekly_all.map((p) => [p.v, Boolean(p.gap)]), [[10, false], [20, false]]);
      } finally {
        svc.dispose();
      }
    } finally {
      Date.now = realNow;
    }
  });

  await atest("Claude 서비스: 받아들이지 않은 옛 관측 응답이 사이에 와도 구간을 늘리지 않아, 실행 중 그래프와 다시 켠 뒤(저장 기록) 그래프가 같음", async () => {
    await withHistDir(async (dir) => {
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      const t0 = now - 3 * HOUR;
      let next;
      claudeApi.readAccountInfo = () => ({ planDisplayName: "Ultra", identity: "acct-A" });
      claudeApi.fetchPlanUsage = async () => next;
      const s1 = new LimitHistoryStore(dir, "first");
      const svc = new ClaudeService(output, s1);
      try {
        next = { usage: { windows: [histWin(R, 10, t0 + 2 * MINUTE)], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" };
        await svc.refreshPlan(true);
        for (let k = 0; k < 5; k++) {
          next = { usage: { windows: [histWin(R, 9, t0 + MINUTE)], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" }; // 옛 관측(거부)
          await svc.refreshPlan(true);
        }
        next = { usage: { windows: [histWin(R, 20, t0 + 62 * MINUTE)], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" };
        await svc.refreshPlan(true);
        assert.deepStrictEqual(svc.currentState.samples.weekly_all.map((p) => [p.v, Boolean(p.gap)]), [[10, false], [20, true]], "실행 중");
        s1.flush();
      } finally {
        svc.dispose();
        s1.dispose();
      }
      const s2 = new LimitHistoryStore(dir, "second");
      const again = new ClaudeService(output, s2);
      try {
        next = { usage: { windows: [histWin(R, 21, t0 + 64 * MINUTE)], extraUsage: null }, subscriptionType: "max", loginKey: "login-test" };
        await again.refreshPlan(true);
        assert.deepStrictEqual(again.currentState.samples.weekly_all.map((p) => [p.v, Boolean(p.gap)]), [[10, false], [20, true], [21, false]], "다시 켠 뒤");
      } finally {
        again.dispose();
        s2.dispose();
      }
    });
  });

  await atest("이력 저장소: 구간 칸이 있는데 형식이 깨졌으면(문자열·null) 0.10.0 기록으로 보지 않고 구간 없음 — 그 기록의 점 사이는 흐린 구간", async () => {
    await withHistDir(async (dir) => {
      const fs = require("fs");
      const now = Date.now();
      const R = now + 2 * 24 * HOUR;
      const acct = historyAccountKey("claude", "acct-A");
      for (const [name, cover] of [["str", "corrupted"], ["nul", null]]) {
        fs.writeFileSync(
          path.join(dir, `limit-history-${name}-1.json`),
          JSON.stringify({ v: 1, pid: process.pid, entries: [{ account: acct, id: `weekly_all`, len: WEEK, R0: R, rMin: R, rMax: R, points: [[now - 8 * HOUR, 5], [now - 2 * HOUR, 9]], cover }] }),
        );
        const reader = new LimitHistoryStore(dir, "reader");
        const data = reader.chartDataFor(acct, histWin(R, 9, now), 0, now);
        assert.deepStrictEqual(data.cover, [], name);
        const s = chartSeries([data.points], [data.cover], 0, now);
        assert.deepStrictEqual(s.map((p) => [p.v, Boolean(p.gap)]), [[5, false], [9, true]], name);
        reader.dispose();
        fs.unlinkSync(path.join(dir, `limit-history-${name}-1.json`));
      }
    });
  });

  await atest("구간 상한: 30일 창은 30분 기준으로 상한(2000)에 닿지 않고, 그보다 긴 창에서 닿으면 가장 오래된 구간과 그 점을 함께 버려 남은 점은 잘못 흐려지지 않음(메모리·저장 모두)", async () => {
    const { COVER_CAP } = require("../out/limits.js");
    assert.ok(Math.floor((30 * 24 * 60) / 30) + 1 < COVER_CAP, "30일 창의 최대 구간 수 < 상한");
    await withHistDir(async (dir) => {
      const now = Date.now();
      const LONG = 200 * 24 * 60; // 200일짜리(비정상적으로 긴) 창
      const R = now + 2 * 24 * HOUR;
      const win = (u, O) => ({ ...histWin(R, u, O), windowMins: LONG });
      const acct = historyAccountKey("codex", "acct-A");
      const wt = new LimitWatch();
      const st = new LimitHistoryStore(dir, "w");
      const T0 = now - (COVER_CAP + 5) * 40 * MINUTE;
      const firsts = [];
      for (let k = 0; k < COVER_CAP + 5; k++) {
        const a = T0 + k * 40 * MINUTE; // 구간마다 8분 간격 두 관측, 다음 구간까지 32분 공백
        firsts.push(a);
        for (const t of [a, a + 8 * MINUTE]) {
          const w = win(10, t);
          wt.observe([w]);
          st.record(acct, [w], () => R);
        }
      }
      const last = win(10, T0 + (COVER_CAP + 4) * 40 * MINUTE + 8 * MINUTE);
      const liveCover = wt.coverFor(last);
      assert.strictEqual(liveCover.length, COVER_CAP);
      assert.strictEqual(liveCover[0][0], firsts[5], "가장 오래된 5개 구간을 버림");
      const live = wt.samplesFor(last);
      assert.ok(live.every((p) => p.ts >= firsts[5]), "버린 구간의 점도 메모리에서 버림");
      const liveMarked = markGaps(live, [liveCover], DEFAULT_COVER_GAP_MS);
      assert.ok(!liveMarked[1].gap, "남은 첫 구간 안은 이어짐");
      st.flush();
      const reader = new LimitHistoryStore(dir, "reader");
      const data = reader.chartDataFor(acct, last, 0, now + HOUR);
      assert.strictEqual(data.cover.length, COVER_CAP);
      assert.ok(data.points.every((p) => p.ts >= firsts[5]), "버린 구간의 점도 저장에서 버림");
      const s = chartSeries([data.points], [data.cover], 0, now + HOUR, DEFAULT_COVER_GAP_MS, 100000);
      assert.strictEqual(s[0].ts, firsts[5]);
      assert.ok(!s[1].gap, "남은 첫 구간 안은 다시 읽어도 이어짐");
      reader.dispose();
      st.dispose();
    });
  });

  await atest("대시보드 그래프: 이어진 구간은 진한 실선, 흐린 구간(gap)은 흐린 선, 앞뒤가 끊긴 외딴 점은 작은 점으로 그림", async () => {
    const vm = require("vm");
    const S = require("../out/i18n.js").webviewStrings("ko");
    const els = {};
    const mk = (id) => ({
      id, innerHTML: "", textContent: id === "bootstrap" ? JSON.stringify(S) : "", title: "", value: "", style: {}, dataset: {}, children: [],
      addEventListener() {}, insertBefore() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, getAttribute: () => null, closest: () => null,
    });
    const el = (id) => (els[id] = els[id] || mk(id));
    const listeners = {};
    const win = { addEventListener: (t, f) => (listeners[t] = f) };
    win.window = win;
    const ctx = {
      document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => mk("tmp"), addEventListener() {}, body: mk("body"), documentElement: mk("html") },
      window: win, addEventListener: win.addEventListener,
      acquireVsCodeApi: () => ({ postMessage() {}, getState: () => null, setState() {} }),
      console, setTimeout, clearTimeout, setInterval, clearInterval,
    };
    vm.createContext(ctx);
    vm.runInContext(require("fs").readFileSync(path.join(__dirname, "..", "media", "main.js"), "utf8"), ctx);
    const now = Date.now();
    const start = now - 3 * 24 * HOUR;
    const R = start + WEEK * MINUTE;
    const win1 = { ...histWin(R, 50, now), label: "주간", forecast: { startMs: start, resetsAtMs: R, state: "safe" } };
    const series = [
      { ts: start + HOUR, v: 5 }, { ts: start + 2 * HOUR, v: 8 }, // 이어진 구간
      { ts: start + 30 * HOUR, v: 20, gap: true }, // 흐림 → 외딴 점
      { ts: start + 60 * HOUR, v: 40, gap: true }, { ts: start + 61 * HOUR, v: 45 }, { ts: now, v: 50 },
    ];
    listeners.message({ data: { type: "state", state: { connected: true, limits: [] }, claude: { available: true, plan: { windows: [win1] }, samples: { weekly_all: series } }, extraPaths: [], codexExtraPaths: [] } });
    const html = el("claudeRoot").innerHTML;
    const count = (re) => (html.match(re) || []).length;
    assert.strictEqual(count(/<polyline class="hist"/g), 2, html);
    assert.strictEqual(count(/<line class="histgap"/g), 2, html);
    assert.strictEqual(count(/<circle class="histpt"/g), 1, html);
    // 관측이 하나뿐(새 창 첫 값) — 평균 점선을 그릴 수 없는 상태여도 파란 점은 보인다.
    for (const state of ["idle", "held", "safe"]) {
      const one = { ...win1, forecast: { startMs: start, resetsAtMs: R, state } };
      listeners.message({ data: { type: "state", state: { connected: true, limits: [] }, claude: { available: true, plan: { windows: [one] }, samples: { weekly_all: [{ ts: start + HOUR, v: 0 }] } }, extraPaths: [], codexExtraPaths: [] } });
      const h = el("claudeRoot").innerHTML;
      assert.strictEqual((h.match(/<circle class="histpt"/g) || []).length, 1, `${state}: ${h}`);
    }
  });
}

async function codexLocalAfterDispose() {
  const codexHistory = require("../out/codexHistory.js");
  const orig = codexHistory.readCodexHistoryAsync;
  const gate = deferred();
  codexHistory.readCodexHistoryAsync = async () => {
    await gate.promise;
    return { error: "late" };
  };
  try {
    const svc = new UsageService(output);
    const pending = svc.refreshLocal();
    await sleep(5);
    svc.dispose();
    gate.resolve();
    await pending;
    assert.strictEqual(svc.currentState.lastHistoryScanAt, undefined, "종료 뒤 로컬 집계 결과 미반영");
    assert.strictEqual(svc.currentState.historyError, undefined);
    passed += 1;
    console.log("ok - Codex: 진행 중이던 로컬 집계는 종료(dispose) 뒤 상태를 바꾸지 않음");
  } finally {
    codexHistory.readCodexHistoryAsync = orig;
  }
}

serviceTests()
  .then(codexLocalAfterDispose)
  .then(() => console.log(`\n${passed} passed`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });


