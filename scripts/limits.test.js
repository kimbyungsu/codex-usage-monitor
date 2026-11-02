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

const { windowsFromCodex, mergeRateLimitSnapshot, statusBarWindows, hasAccountFiveHour, LimitTrend, windowLevel } = require("../out/limits.js");
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

test("희소 갱신 병합: 5시간 창 폐지 형태의 갱신이 와도 주간 값이 5시간 자리에 섞이지 않음", () => {
  const update = { limitId: "codex", primary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: both.secondary.resetsAt }, secondary: null, planType: null };
  const { snapshot, shapeChanged } = mergeRateLimitSnapshot(both, update);
  assert.strictEqual(shapeChanged, false);
  assert.strictEqual(snapshot.primary.windowDurationMins, 300);
  assert.strictEqual(snapshot.primary.usedPercent, 20, "5시간 창 값 유지(희소 갱신은 삭제 의미 아님)");
  assert.strictEqual(snapshot.secondary.windowDurationMins, 10080);
  assert.strictEqual(snapshot.secondary.usedPercent, 50, "주간 창만 갱신");
  assert.strictEqual(snapshot.planType, "prolite", "null 메타데이터는 기존 값을 지우지 않음");
  const ids = windowsFromCodex(snapshot, null).map((w) => w.id);
  assert.deepStrictEqual(ids, ["codex:5h", "codex:weekly"], "중복 주간 창 없음");
});

test("희소 갱신 병합: 직전에 없던 창(5시간 부활)이 오면 shapeChanged=true", () => {
  const { snapshot, shapeChanged } = mergeRateLimitSnapshot(weeklyOnly, both);
  assert.strictEqual(shapeChanged, true);
  assert.deepStrictEqual([snapshot.primary.windowDurationMins, snapshot.secondary.windowDurationMins], [300, 10080]);
});

test("희소 갱신 병합: 길이 없는 창은 같은 위치 값만 갱신(중복 생성 안 함)", () => {
  const { snapshot, shapeChanged } = mergeRateLimitSnapshot(weeklyOnly, { primary: { usedPercent: 47 } });
  assert.strictEqual(shapeChanged, false);
  assert.strictEqual(snapshot.primary.usedPercent, 47);
  assert.strictEqual(snapshot.primary.windowDurationMins, 10080);
  assert.strictEqual(snapshot.secondary, null);
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

// ---------------- 추세 ----------------

test("창별 추세: 한 창 리셋이 다른 창 추세를 지우지 않고, 사라진 창 추세는 버림", () => {
  const trend = new LimitTrend();
  const w = (id, v, resetsAtMs = now + 10 * H) => ({ id, span: id === "s" ? "5h" : "weekly", usedPercent: v, resetsAtMs });
  trend.record(now - 60 * 60_000, [w("s", 40), w("k", 10)]);
  trend.record(now - 30 * 60_000, [w("s", 50), w("k", 12)]);
  trend.record(now, [w("s", 2), w("k", 14)]); // 5시간 창 리셋
  let s = trend.samples();
  assert.strictEqual(s.s.length, 1, "리셋된 창만 초기화");
  assert.strictEqual(s.k.length, 3, "주간 추세 유지");
  const p = trend.projections(now, [w("k", 14, now + 1000 * H)]);
  assert.strictEqual(p.k.reaches, true);
  assert.ok(Math.abs(p.k.hoursToFull - 86 / 4) < 1e-6, "4%/h 로 86% 남음");
  trend.record(now + 60_000, [w("k", 14)]); // 5시간 창 폐지
  s = trend.samples();
  assert.ok(!("s" in s), "사라진 창 추세 제거");
});

console.log(`\n${passed} passed`);
