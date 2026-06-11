// 빌드 산출물 실데이터 검증 스크립트 (vsce 패키징에는 포함되지 않음).
//  1) computeInsights 단위 검증(합성 데이터로 일별/턴/히트맵 수치 확인)
//  2) readCodexHistory 를 실제 ~/.codex 에 돌려 insights 가 채워지는지 확인
//  3) 실제 Claude 트랜스크립트 1개에 턴 경계 규칙을 적용해 통계가 그럴듯한지 확인
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { computeInsights } = require("../out/insights.js");
const { readCodexHistory } = require("../out/codexHistory.js");

// ---- 1) 합성 데이터 단위 검증 ----
const now = Date.now();
const H = 3600_000;
const entries = [
  // 턴 A: opus 2회 호출 (오늘)
  { ts: now - 1 * H, model: "opus", totalTokens: 1000, outputTokens: 100, costUsd: 0.5, turnKey: "f#1" },
  { ts: now - 1 * H + 60_000, model: "opus", totalTokens: 3000, outputTokens: 300, costUsd: 1.5, turnKey: "f#1" },
  // 턴 B: opus 1회 (오늘)
  { ts: now - 2 * H, model: "opus", totalTokens: 2000, outputTokens: 200, costUsd: 1.0, turnKey: "f#2" },
  // 턴 C: haiku 가 지배 모델 (어제)
  { ts: now - 26 * H, model: "haiku", totalTokens: 500, outputTokens: 50, turnKey: "f#3" },
  // turnKey 없음 → 턴 통계 제외, 시리즈 포함
  { ts: now - 3 * H, model: "sonnet", totalTokens: 700, outputTokens: 70 },
  // 8일 전 → 턴 통계(7일) 제외
  { ts: now - 8 * 24 * H, model: "opus", totalTokens: 9999, outputTokens: 1, turnKey: "f#4" },
];
const ins = computeInsights(entries, now);
assert.strictEqual(ins.daily.length, 14, "daily 14일");
const todaySum = ins.daily[13].totalTokens;
assert.ok(todaySum >= 6700, "오늘 합계에 오늘 항목 포함: " + todaySum);
const opus = ins.modelTurns.find((m) => m.model === "opus");
const haiku = ins.modelTurns.find((m) => m.model === "haiku");
assert.strictEqual(opus.turns, 2, "opus 턴 2개");
assert.strictEqual(opus.calls, 3, "opus 호출 3회");
assert.strictEqual(opus.avgTokensPerTurn, 3000, "opus 평균 (4000+2000)/2");
assert.strictEqual(opus.medianTokensPerTurn, 2000, "opus 중앙값(nearest-rank)");
assert.ok(Math.abs(opus.avgCostPerTurn - 1.5) < 1e-9, "opus $/턴 = (2.0+1.0)/2");
assert.strictEqual(haiku.turns, 1, "haiku 턴 1개");
assert.strictEqual(haiku.avgCostPerTurn, undefined, "비용 없는 턴은 $/턴 미표시");
assert.strictEqual(ins.hourly.length, 24, "hourly 24개");
const hmSum = ins.heatmap.flat().reduce((a, b) => a + b, 0);
assert.ok(hmSum >= 7200, "히트맵 합계에 최근 항목 반영: " + hmSum);
console.log("[1] computeInsights 합성 데이터 검증 OK");

// ---- 2) 실제 Codex 로그 ----
const codex = readCodexHistory();
if (codex.error) {
  console.log("[2] Codex 로그 없음(스킵): " + codex.error);
} else {
  const i = codex.insights;
  assert.ok(i && i.daily.length === 14 && i.hourly.length === 24, "codex insights 구조");
  const d7 = i.daily.slice(-7).reduce((a, d) => a + d.totalTokens, 0);
  console.log(
    `[2] Codex 실데이터 OK · 파일 ${codex.filesScanned}개 · 일별합(최근7일) ${d7.toLocaleString()} vs 버킷 ${codex.lastSevenDays.totalTokens.toLocaleString()} · 턴통계 ${i.modelTurns
      .map((m) => `${m.model}: ${m.turns}턴 avg ${m.avgTokensPerTurn.toLocaleString()}`)
      .join(" / ") || "(턴 마커 없음)"}`,
  );
}

// ---- 3) 실제 Claude 트랜스크립트 1개로 턴 경계 규칙 확인 ----
const projects = path.join(os.homedir(), ".claude", "projects");
function newestJsonl(dir) {
  let best = null;
  const walk = (d, depth) => {
    if (depth > 4) return;
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.name.endsWith(".jsonl")) {
        const st = fs.statSync(full);
        if (st.size < 200 * 1024 * 1024 && (!best || st.mtimeMs > best.mtimeMs)) best = { full, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(dir, 0);
  return best && best.full;
}
const file = newestJsonl(projects);
if (!file) {
  console.log("[3] Claude 트랜스크립트 없음(스킵)");
} else {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let turnSeq = 0;
  const claudeEntries = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t[0] !== "{") continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (o.type === "user" && !o.isSidechain && !o.isMeta && o.toolUseResult == null) {
      const c = o.message && o.message.content;
      const real = typeof c === "string" ? c.trim().length > 0 : Array.isArray(c) && c.some((p) => p && p.type === "text");
      if (real) turnSeq += 1;
    }
    const u = o.message && o.message.usage;
    if (!u) continue;
    const total = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    claudeEntries.push({
      ts: Date.parse(o.timestamp) || 0,
      model: String(o.message.model || "unknown"),
      totalTokens: total,
      outputTokens: u.output_tokens || 0,
      costUsd: 0,
      turnKey: `f#${turnSeq}`,
    });
  }
  const ci = computeInsights(claudeEntries, now);
  const totalCalls = claudeEntries.length;
  console.log(
    `[3] Claude 실데이터 OK · ${path.basename(file)} · 사용자 턴 ${turnSeq}개 · API 호출 ${totalCalls}회 · ` +
      ci.modelTurns.map((m) => `${m.model}: ${m.turns}턴 avg ${m.avgTokensPerTurn.toLocaleString()} med ${m.medianTokensPerTurn.toLocaleString()} p90 ${m.p90TokensPerTurn.toLocaleString()}`).join(" / "),
  );
  assert.ok(turnSeq > 0 || totalCalls === 0, "사용자 턴 감지");
}
console.log("sanity OK");
