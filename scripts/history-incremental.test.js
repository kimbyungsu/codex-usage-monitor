// Codex 사용 기록 집계의 '이어 읽기' 시험 (vsce 패키징에는 포함되지 않음 · npm run test:history).
//  - 바뀐 파일은 새로 붙은 꼬리만 읽고, 결과는 처음부터 다시 읽은 것과 같아야 한다.
//  - 쓰는 중인 미완결 줄·줄바꿈 없이 끝난 줄·줄어듦·같은 크기 재작성·앞부분 교체·삭제·여러 바이트 글자의 청크 경계.
//  - 비동기 집계는 동기와 같은 결과이고, 읽는 동안 이벤트 루프를 오래 막지 않는다.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const H = require("../out/codexHistory.js");

const NOW = Date.now();
const realNow = Date.now;
Date.now = () => NOW; // 버킷 경계가 시험 중에 움직이지 않게
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cum-hist-"));
const dir = path.join(home, "sessions", "2026", "10", "10");
fs.mkdirSync(dir, { recursive: true });
const fileA = path.join(dir, "rollout-2026-10-10T00-00-00-aaaa.jsonl");
const fileB = path.join(dir, "rollout-2026-10-10T00-00-00-bbbb.jsonl");

let seq = 0;
function turnLines(turnId, model, tokens, eol = "\n") {
  const t = NOW - 90 * MIN + ++seq * 1000;
  return [
    { timestamp: iso(t), type: "turn_context", payload: { turn_id: turnId, model } },
    { timestamp: iso(t + 1), type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { timestamp: iso(t + 2), type: "response_item", payload: { type: "message", content: "한글 설명 — 여러 바이트 글자 ✓ " + "가".repeat(seq % 7) } },
    { timestamp: iso(t + 3), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: tokens, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: tokens + 2 }, total_token_usage: { input_tokens: tokens * seq, output_tokens: 2 * seq, total_tokens: (tokens + 2) * seq }, model_context_window: 272000 } } },
  ].map((o) => JSON.stringify(o) + eol).join("");
}
const meta = (id, title) => JSON.stringify({ timestamp: iso(NOW - 100 * MIN), type: "session_meta", payload: { id, thread_name: title, model: "gpt-x" } }) + "\n";

const strip = (r) => { const o = JSON.parse(JSON.stringify(r)); delete o.lastScannedAt; return o; };
function fresh() { H.__resetHistoryCacheForTest(); const r = H.readCodexHistory(home); return strip(r); }
// 캐시를 유지한 채 다시 집계 → 처음부터 다시 읽은 결과와 같아야 한다
function checkIncremental(label) {
  const inc = strip(H.readCodexHistory(home));
  const full = fresh();
  assert.deepStrictEqual(inc, full, label + ": 이어 읽기 결과 = 처음부터 읽은 결과");
  return inc;
}
// 이 파일에서 실제로 읽은 바이트 위치 기록(앞부분 지문 읽기=0번 위치 4096바이트 이하 제외)
function readPositions(fn, file) {
  const realOpen = fs.openSync, realRead = fs.readSync, realClose = fs.closeSync;
  const fds = new Map(), reads = [];
  fs.openSync = function (p, ...rest) { const fd = realOpen.call(fs, p, ...rest); fds.set(fd, path.resolve(String(p))); return fd; };
  fs.readSync = function (fd, buf, off, len, pos) { const n = realRead.call(fs, fd, buf, off, len, pos); if (fds.get(fd) === path.resolve(file)) reads.push({ pos, len, n }); return n; };
  fs.closeSync = function (fd) { fds.delete(fd); return realClose.call(fs, fd); };
  try { fn(); } finally { fs.openSync = realOpen; fs.readSync = realRead; fs.closeSync = realClose; }
  return reads.filter((r) => !(r.pos === 0 && r.len <= 4096));
}
const bump = (f) => { const t = new Date(realNow() + ++seq * 2000); fs.utimesSync(f, t, t); };

let n = 0;
const ok = (name) => console.log(`  ✅ [${++n}] ${name}`);

(async () => {
  // 1) 첫 집계
  fs.writeFileSync(fileA, meta("thread-a", "첫 대화") + turnLines("t1", "gpt-x", 100) + turnLines("t2", "gpt-y", 200));
  fs.writeFileSync(fileB, meta("thread-b", "둘째 대화") + turnLines("u1", "gpt-x", 50));
  H.__resetHistoryCacheForTest();
  const r0 = strip(H.readCodexHistory(home));
  assert.strictEqual(r0.filesScanned, 2);
  assert.strictEqual(r0.lastSevenDays.events, 3, "토큰 기록 3건");
  ok("첫 집계 — 파일 2개·토큰 기록 3건");

  // 2) 바뀌지 않은 파일은 다시 읽지 않음
  const noRead = readPositions(() => H.readCodexHistory(home), fileA);
  assert.strictEqual(noRead.length, 0, "그대로인 파일은 읽지 않음 " + JSON.stringify(noRead));
  ok("바뀌지 않은 파일은 다시 읽지 않음");

  // 3) 덧붙음 — 새 꼬리만 읽고 결과는 처음부터 읽은 것과 같음
  const sizeBefore = fs.statSync(fileA).size;
  fs.appendFileSync(fileA, turnLines("t3", "gpt-x", 300));
  bump(fileA);
  const reads = readPositions(() => H.readCodexHistory(home), fileA);
  assert.ok(reads.length > 0 && reads.every((r) => r.pos >= sizeBefore), "새 꼬리만 읽음 " + JSON.stringify(reads.slice(0, 3)) + " 앞 크기 " + sizeBefore);
  const r3 = checkIncremental("덧붙음");
  assert.strictEqual(r3.lastSevenDays.events, 4);
  ok("덧붙음 — 새로 붙은 부분만 읽고, 결과는 처음부터 읽은 것과 같음");

  // 4) 쓰는 중인 미완결 줄 → 다음 번에 완성되면 정확히 한 번 반영
  const line = turnLines("t4", "gpt-y", 400);
  const cut = Buffer.from(line).length - 40;
  fs.appendFileSync(fileA, Buffer.from(line).subarray(0, cut));
  bump(fileA);
  const r4a = checkIncremental("미완결 줄");
  assert.strictEqual(r4a.lastSevenDays.events, 4, "미완결 토큰 줄은 아직 안 셈");
  fs.appendFileSync(fileA, Buffer.from(line).subarray(cut));
  bump(fileA);
  const r4b = checkIncremental("미완결 줄 완성");
  assert.strictEqual(r4b.lastSevenDays.events, 5, "완성되면 정확히 한 번");
  ok("쓰는 중인 미완결 줄 — 완성된 뒤 정확히 한 번 반영(빠짐·중복 없음)");

  // 5) 줄바꿈 없이 끝난 완결 줄은 반영(종전 동작) · 그 뒤 줄이 이어 붙어도 중복 없음
  const noEol = turnLines("t5", "gpt-x", 500).replace(/\n$/, "");
  fs.appendFileSync(fileA, noEol);
  bump(fileA);
  const r5a = checkIncremental("줄바꿈 없는 끝 줄");
  assert.strictEqual(r5a.lastSevenDays.events, 6);
  fs.appendFileSync(fileA, "\n" + turnLines("t6", "gpt-y", 600));
  bump(fileA);
  const r5b = checkIncremental("끝 줄 뒤 이어 붙음");
  assert.strictEqual(r5b.lastSevenDays.events, 7);
  ok("줄바꿈 없이 끝난 완결 줄 반영 — 뒤에 줄이 이어 붙어도 중복 없음");

  // 6) 줄어듦(잘라 냄) → 처음부터 다시
  fs.writeFileSync(fileA, meta("thread-a", "첫 대화") + turnLines("t1", "gpt-x", 100));
  bump(fileA);
  const r6 = checkIncremental("줄어듦");
  assert.strictEqual(r6.lastSevenDays.events, 2);
  ok("파일이 줄어들면 처음부터 다시 읽음");

  // 7) 같은 크기 재작성(수정 시각만 바뀜) → 처음부터 다시 — 바뀐 곳은 앞부분 지문(4096바이트) 밖
  let padTurns = "";
  for (let i = 0; i < 12; i++) padTurns += turnLines("p" + i, "gpt-x", 1);
  fs.writeFileSync(fileA, meta("thread-a", "첫 대화") + padTurns + turnLines("t9", "gpt-x", 100));
  bump(fileA);
  checkIncremental("재작성 전");
  const before7 = fs.readFileSync(fileA, "utf8");
  const at = before7.lastIndexOf('"input_tokens":100');
  assert.ok(Buffer.byteLength(before7.slice(0, at)) > 4096, "(전제) 바뀌는 곳이 앞부분 지문 밖");
  const same = before7.slice(0, at) + '"input_tokens":900' + before7.slice(at + '"input_tokens":100'.length);
  assert.strictEqual(Buffer.byteLength(same), fs.statSync(fileA).size, "(전제) 같은 크기");
  fs.writeFileSync(fileA, same);
  bump(fileA);
  const r7 = checkIncremental("같은 크기 재작성");
  assert.strictEqual(r7.lastSevenDays.inputTokens, 12 + 900 + 50, "다시 쓰인 값 반영(A 12+900 + B 50 · 옛 값이면 162)");
  ok("같은 크기로 다시 쓰인 파일은 처음부터 다시 읽음");

  // 8) 앞부분이 다른 더 큰 파일로 통째로 바뀜 → 덧붙음으로 오인하지 않음
  const size8 = fs.statSync(fileA).size;
  let body8 = meta("thread-a2", "바뀐 대화");
  for (let i = 0; Buffer.byteLength(body8) <= size8 + 100; i++) body8 += turnLines("v" + i, "gpt-z", 70 + i);
  fs.writeFileSync(fileA, body8);
  bump(fileA);
  assert.ok(fs.statSync(fileA).size > size8, "(전제) 바뀐 파일이 더 큼");
  const r8 = checkIncremental("앞부분 교체");
  assert.ok(r8.recentThreads.some((t) => t.threadId === "thread-a2") && !r8.recentThreads.some((t) => t.threadId === "thread-a"), "바뀐 대화로 다시 읽음");
  ok("앞부분이 다른 파일로 통째로 바뀌면(더 커져도) 처음부터 다시 읽음");

  // 9) 여러 바이트 글자가 청크 경계에 걸려도 같은 결과
  H.__setChunkSizeForTest(37);
  const small = fresh();
  H.__setChunkSizeForTest(4 * 1024 * 1024);
  const big = fresh();
  assert.deepStrictEqual(small, big, "청크 37바이트 = 4MB 결과");
  H.__setChunkSizeForTest(41);
  H.__resetHistoryCacheForTest(); H.readCodexHistory(home);
  fs.appendFileSync(fileB, turnLines("u2", "gpt-x", 55) + turnLines("u3", "gpt-y", 66));
  bump(fileB);
  const incSmall = strip(H.readCodexHistory(home));
  H.__setChunkSizeForTest(4 * 1024 * 1024);
  assert.deepStrictEqual(incSmall, fresh(), "작은 청크로 이어 읽어도 같은 결과");
  ok("여러 바이트 글자가 읽기 단위 경계에 걸려도 결과 동일(처음부터·이어 읽기 모두)");

  // 10) 삭제된 파일은 결과·캐시에서 빠짐
  H.readCodexHistory(home);
  assert.ok(H.__historyCacheKeysForTest().includes(path.resolve(fileB)), "(전제) 삭제 전 캐시에 있음");
  fs.unlinkSync(fileB);
  H.readCodexHistory(home);
  assert.ok(!H.__historyCacheKeysForTest().includes(path.resolve(fileB)), "삭제된 파일의 캐시도 버림");
  const r10 = checkIncremental("삭제");
  assert.strictEqual(r10.filesScanned, 1);
  ok("삭제된 파일은 결과에서 빠짐");

  // 11) 비동기 = 동기 · 같은 인자로 겹쳐 부르면 한 번만 읽음
  fs.writeFileSync(fileB, meta("thread-b", "둘째 대화") + turnLines("u1", "gpt-x", 50));
  H.__resetHistoryCacheForTest();
  const p1 = H.readCodexHistoryAsync(home), p2 = H.readCodexHistoryAsync(home);
  assert.strictEqual(p1, p2, "진행 중이면 같은 결과를 함께 기다림");
  const ra = strip(await p1);
  assert.deepStrictEqual(ra, fresh(), "비동기 = 동기");
  ok("비동기 집계 = 동기 집계 · 겹쳐 부르면 한 번만 읽음");

  // 12) 큰 파일을 처음 읽는 동안에도 이벤트 루프를 오래 막지 않음
  const bigFile = path.join(dir, "rollout-2026-10-10T00-00-00-cccc.jsonl");
  const chunk = turnLines("w", "gpt-x", 10);
  const fd = fs.openSync(bigFile, "w");
  fs.writeSync(fd, meta("thread-c", "큰 대화"));
  for (let i = 0; i < 80000; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  H.__resetHistoryCacheForTest();
  Date.now = realNow;
  let maxGap = 0, last = realNow();
  const iv = setInterval(() => { const t = realNow(); maxGap = Math.max(maxGap, t - last); last = t; }, 2);
  const t0 = realNow();
  const rb = await H.readCodexHistoryAsync(home);
  const took = realNow() - t0;
  maxGap = Math.max(maxGap, realNow() - last);
  clearInterval(iv);
  Date.now = () => NOW;
  assert.ok(rb.filesScanned === 3, "큰 파일 포함");
  // 양보 없이 한 번에 다 읽으면 최대 멈춤 ≈ 전체 시간이다. 다른 일로 바쁜 PC에서도 흔들리지 않게 '전체의 절반 미만 · 1초 미만'으로 본다.
  assert.ok(maxGap < took / 2 && maxGap < 1000, `읽는 동안 최대 멈춤 ${maxGap}ms (전체 ${took}ms)`);
  ok(`큰 파일(${(fs.statSync(bigFile).size / 1048576).toFixed(0)}MB) 첫 읽기 ${took}ms 동안 최대 멈춤 ${maxGap}ms`);

  // 13) 집계 폴더가 통째로 사라져도 그 아래 캐시를 버림(여러 폴더 중 하나만 사라진 경우 포함) · 다른 집계의 캐시는 그대로
  H.readCodexHistory(home);
  const mainKeys = H.__historyCacheKeysForTest().filter((k) => k.startsWith(path.resolve(home) + path.sep));
  assert.ok(mainKeys.length > 0, "(전제) 다른 집계의 캐시");
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "cum-hist2-")), extra = fs.mkdtempSync(path.join(os.tmpdir(), "cum-extra-"));
  const d2 = path.join(home2, "sessions", "2026", "10", "11"), d3 = path.join(extra, "sessions", "2026", "10", "11");
  fs.mkdirSync(d2, { recursive: true }); fs.mkdirSync(d3, { recursive: true });
  const fX = path.join(d2, "rollout-2026-10-11T00-00-00-xxxx.jsonl"), fY = path.join(d3, "rollout-2026-10-11T00-00-00-yyyy.jsonl");
  fs.writeFileSync(fX, meta("thread-x", "X") + turnLines("x1", "gpt-x", 11));
  fs.writeFileSync(fY, meta("thread-y", "Y") + turnLines("y1", "gpt-x", 12));
  const has = (f) => H.__historyCacheKeysForTest().includes(path.resolve(f));
  assert.strictEqual(H.readCodexHistory(home2, [extra]).filesScanned, 2);
  assert.ok(has(fX) && has(fY), "(전제) 두 폴더 캐시");
  fs.rmSync(extra, { recursive: true, force: true }); // 추가 폴더 하나만 통째로 사라짐
  assert.strictEqual(H.readCodexHistory(home2, [extra]).filesScanned, 1);
  assert.ok(has(fX) && !has(fY), "★사라진 추가 폴더 아래 캐시 버림");
  fs.rmSync(path.join(home2, "sessions"), { recursive: true, force: true }); // 기본 sessions 폴더도 통째로 사라짐(일찍 끝나는 경로)
  const r13 = H.readCodexHistory(home2, [extra]);
  assert.ok(r13.filesScanned === 0 && /not found/.test(String(r13.error || "")), JSON.stringify({ f: r13.filesScanned, e: r13.error }));
  assert.ok(!has(fX), "★폴더째 사라져 일찍 끝나는 경우에도 캐시 버림");
  assert.deepStrictEqual(H.__historyCacheKeysForTest().filter((k) => k.startsWith(path.resolve(home) + path.sep)).sort(), mainKeys.sort(), "다른 집계의 캐시는 그대로");
  fs.rmSync(home2, { recursive: true, force: true });
  ok("집계 폴더가 통째로 사라지면(추가 폴더 하나만·기본 폴더까지) 그 아래 캐시를 버림 — 다른 집계의 캐시는 그대로");

  Date.now = realNow;
  fs.rmSync(home, { recursive: true, force: true });
  console.log(`\n결과: ${n}/13 통과`);
})().catch((e) => { Date.now = realNow; console.error(e); process.exit(1); });
