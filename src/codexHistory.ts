import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { computeInsights, InsightEntry } from "./insights";
import {
  CodexHistoryUsage,
  CodexModelUsage,
  CodexThreadUsage,
  CodexTokenBucket,
  TokenUsageBreakdown,
} from "./types";

interface ParsedEvent {
  ts: number;
  model: string;
  usage: TokenUsageBreakdown;
  /** 이 이벤트가 속한 턴 ID(턴 마커 없는 옛 로그는 undefined → 턴 통계 제외). */
  turnId?: string;
}

interface FileSummary {
  threadId: string;
  title?: string;
  path: string;
  updatedAt: number;
  latestModel?: string;
  latestTotal: TokenUsageBreakdown;
  latestContextWindow?: number | null;
  events: ParsedEvent[];
}

/** 한 rollout 파일을 줄 순서대로 읽으며 쌓는 상태(이어 읽기 위해 캐시에 보관). */
interface ParseState {
  threadId: string;
  title?: string;
  updatedAt: number;
  latestModel?: string;
  currentTurnId?: string;
  latestTotal: TokenUsageBreakdown;
  latestContextWindow?: number | null;
  turnModels: Map<string, string>;
  events: ParsedEvent[];
}

interface FileCacheEntry {
  size: number;
  mtimeMs: number;
  /** 끝까지 처리한 완결 줄의 바이트 위치(마지막 줄바꿈 다음). 그 뒤 미완결 꼬리는 다음 번에 다시 읽는다. */
  parsedBytes: number;
  /** 파일 앞부분 지문 — 같은 파일이 통째로 바뀌었는데 크기만 커진 경우를 덧붙음으로 오인하지 않게. */
  headLen: number;
  headFp: string;
  state: ParseState;
  summary: FileSummary;
}

// 파일별 캐시(확장 호스트 하나 = 창 하나 안에서 유지). 1분 주기 재집계가 매번 sessions 전체(수 GB 가능)를
// 처음부터 다시 읽어 창을 수십 초 멈추게 하던 것을, 바뀐 파일의 새로 붙은 꼬리만 읽도록 줄인다.
const fileCache = new Map<string, FileCacheEntry>();
const HEAD_FP_BYTES = 4096;
const LINES_PER_YIELD = 500;
/** 비동기 집계가 쉬지 않고 이어서 일하는 최대 시간(ms) — 넘으면 한 번 양보해 확장 호스트가 다른 일을 처리하게 한다. */
const YIELD_EVERY_MS = 15;
let chunkSize = 4 * 1024 * 1024;
const inflight = new Map<string, Promise<CodexHistoryUsage>>();

/** 시험 전용: 캐시·진행 중 집계를 비운다. */
export function __resetHistoryCacheForTest(): void {
  fileCache.clear();
  inflight.clear();
}

/** 시험 전용: 캐시에 남은 파일 목록. */
export function __historyCacheKeysForTest(): string[] {
  return [...fileCache.keys()];
}

/** 시험 전용: 읽기 단위(바이트)를 줄여 청크 경계 처리를 시험한다. */
export function __setChunkSizeForTest(bytes: number): void {
  chunkSize = Math.max(16, Math.floor(bytes));
}

/** 동기 집계(스크립트용). 확장은 창이 멈추지 않도록 readCodexHistoryAsync 를 쓴다. */
export function readCodexHistory(
  codexHome = defaultCodexHome(),
  extraSessionPaths: string[] = [],
): CodexHistoryUsage {
  const gen = historyGen(codexHome, extraSessionPaths);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

/**
 * 비동기 집계 — 같은 일을 하되 일정 시간마다 이벤트 루프에 양보한다(첫 전체 읽기도 창을 멈추지 않음).
 * 같은 인자로 이미 진행 중이면 그 결과를 함께 기다린다(주기 타이머가 겹쳐도 두 번 읽지 않음).
 */
export function readCodexHistoryAsync(
  codexHome = defaultCodexHome(),
  extraSessionPaths: string[] = [],
): Promise<CodexHistoryUsage> {
  const key = JSON.stringify([codexHome, extraSessionPaths]);
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const gen = historyGen(codexHome, extraSessionPaths);
    let last = Date.now();
    for (;;) {
      const r = gen.next();
      if (r.done) return r.value;
      if (Date.now() - last >= YIELD_EVERY_MS) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        last = Date.now();
      }
    }
  })().finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

function* historyGen(codexHome: string, extraSessionPaths: string[]): Generator<void, CodexHistoryUsage, void> {
  // 집계 대상 sessions 폴더 목록 = 기본 ~/.codex/sessions + 사용자가 추가한 다른 환경 경로들.
  const sessionDirs: string[] = [];
  const addDir = (d: string): void => {
    if (d && !sessionDirs.includes(d)) {
      sessionDirs.push(d);
    }
  };
  addDir(path.join(codexHome, "sessions"));
  for (const raw of extraSessionPaths) {
    const p = (raw ?? "").trim();
    if (!p) {
      continue;
    }
    // .codex 홈을 고르면 그 안 sessions 로 자동 보정, 이미 sessions 폴더면 그대로 사용.
    const withSessions = path.join(p, "sessions");
    addDir(fs.existsSync(withSessions) ? withSessions : p);
  }

  const existingDirs = sessionDirs.filter((d) => fs.existsSync(d));

  // 겹치는 루트 간 동일 rollout 파일은 절대경로 기준으로 중복 제거(이중집계 방지).
  const seenFiles = new Set<string>();
  const files: string[] = [];
  for (const dir of existingDirs) {
    for (const f of listRolloutFiles(dir)) {
      const key = path.resolve(f);
      if (seenFiles.has(key)) {
        continue;
      }
      seenFiles.add(key);
      files.push(f);
    }
  }
  // 사라진 파일의 캐시는 버린다 — 이번에 집계하라고 받은 폴더 전부(폴더째 사라진 것 포함) 아래만, 일찍 끝나는 경우보다 먼저.
  // 다른 인자로 부른 집계의 캐시는 건드리지 않는다.
  const roots = sessionDirs.map((d) => path.resolve(d) + path.sep);
  for (const key of [...fileCache.keys()]) {
    if (!seenFiles.has(key) && roots.some((r) => key.startsWith(r))) fileCache.delete(key);
  }
  if (!existingDirs.length) {
    return emptyHistory(`Codex sessions folder not found: ${sessionDirs.join(", ")}`);
  }
  if (!files.length) {
    return emptyHistory(`No Codex rollout files found: ${existingDirs.join(", ")}`);
  }

  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const total = emptyBucket();
  const today = emptyBucket();
  const lastFiveHours = emptyBucket();
  const lastSevenDays = emptyBucket();
  const byModel = new Map<string, CodexModelUsage>();
  const summaries: FileSummary[] = [];

  const insightEntries: InsightEntry[] = [];
  for (const file of files) {
    const summary = yield* summaryFor(file);
    summaries.push(summary);
    addBucket(total, summary.latestTotal, summary.latestModel);
    for (const event of summary.events) {
      if (event.ts >= todayMs) addBucket(today, event.usage, event.model);
      if (event.ts >= fiveHoursAgo) addBucket(lastFiveHours, event.usage, event.model);
      if (event.ts >= sevenDaysAgo) addBucket(lastSevenDays, event.usage, event.model);
      if (event.ts >= sevenDaysAgo) addModel(byModel, event.model, event.usage);
      insightEntries.push({
        ts: event.ts,
        model: event.model,
        totalTokens: event.usage.totalTokens,
        // Codex 의미론: reasoning ⊆ output (total = input + output 으로 실측 확인).
        // 합산하면 추론이 이중 계산되므로 output 만 쓴다.
        outputTokens: event.usage.outputTokens,
        turnKey: event.turnId ? `${file}#${event.turnId}` : undefined,
      });
    }
  }

  const newest = summaries
    .filter((s) => s.events.length > 0 || s.updatedAt > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const session = emptyBucket();
  if (newest) {
    for (const event of newest.events) {
      addBucket(session, event.usage, event.model);
    }
  }

  const recentThreads: CodexThreadUsage[] = summaries
    .map((s) => {
      const lastSeven = emptyBucket();
      for (const event of s.events) {
        if (event.ts >= sevenDaysAgo) {
          addBucket(lastSeven, event.usage, event.model);
        }
      }
      return { summary: s, lastSeven };
    })
    .filter((item) => item.lastSeven.totalTokens > 0)
    .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)
    .slice(0, 8)
    .map(({ summary: s, lastSeven }) => ({
      threadId: s.threadId,
      title: s.title,
      path: s.path,
      updatedAt: s.updatedAt,
      model: s.latestModel,
      total: s.latestTotal,
      lastSevenDays: lastSeven,
      events: lastSeven.events,
    }));

  return {
    total,
    today,
    lastFiveHours,
    lastSevenDays,
    session,
    contextTokens: newest?.latestTotal.totalTokens ?? 0,
    modelContextWindow: newest?.latestContextWindow ?? null,
    sessionModel: newest?.latestModel,
    byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    recentThreads,
    insights: computeInsights(insightEntries, now),
    filesScanned: files.length,
    lastScannedAt: Date.now(),
  };
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function emptyHistory(error?: string): CodexHistoryUsage {
  return {
    total: emptyBucket(),
    today: emptyBucket(),
    lastFiveHours: emptyBucket(),
    lastSevenDays: emptyBucket(),
    session: emptyBucket(),
    contextTokens: 0,
    byModel: [],
    recentThreads: [],
    filesScanned: 0,
    lastScannedAt: Date.now(),
    error,
  };
}

function emptyBreakdown(): TokenUsageBreakdown {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function emptyBucket(): CodexTokenBucket {
  return {
    ...emptyBreakdown(),
    events: 0,
    costUsd: 0,
    unpricedTokens: 0,
  };
}

function addBucket(bucket: CodexTokenBucket, usage: TokenUsageBreakdown, _model?: string): void {
  bucket.inputTokens += usage.inputTokens;
  bucket.cachedInputTokens += usage.cachedInputTokens;
  bucket.outputTokens += usage.outputTokens;
  bucket.reasoningOutputTokens += usage.reasoningOutputTokens;
  bucket.totalTokens += usage.totalTokens;
  bucket.events += 1;
}

function addModel(models: Map<string, CodexModelUsage>, model: string, usage: TokenUsageBreakdown): void {
  const key = model || "unknown";
  const item = models.get(key) ?? {
    model: key,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    events: 0,
    costUsd: 0,
    unpricedTokens: 0,
  };
  item.inputTokens += usage.inputTokens;
  item.cachedInputTokens += usage.cachedInputTokens;
  item.outputTokens += usage.outputTokens;
  item.reasoningOutputTokens += usage.reasoningOutputTokens;
  item.totalTokens += usage.totalTokens;
  item.events += 1;
  models.set(key, item);
}

function listRolloutFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  };
  walk(root, 0);
  return files;
}

/**
 * 파일 하나의 요약 — 크기·수정 시각이 그대로면 캐시를 그대로 쓰고, 뒤에 덧붙기만 했으면(앞부분 지문 동일)
 * 지난번에 처리한 위치부터 새 꼬리만 읽는다. 그 밖(줄어듦·같은 크기 재작성·앞부분 변경·첫 읽기)은 처음부터 읽는다.
 */
function* summaryFor(file: string): Generator<void, FileSummary, void> {
  const key = path.resolve(file);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    fileCache.delete(key);
    return summaryOf(newState(file), file);
  }
  const cached = fileCache.get(key);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    return cached.summary;
  }
  let state: ParseState;
  let start: number;
  if (
    cached &&
    st.size > cached.size &&
    st.size >= cached.parsedBytes &&
    headFp(file, cached.headLen) === cached.headFp
  ) {
    // 덧붙음 — 캐시 상태의 복사본에 새 꼬리만 이어 읽는다(완료 전에는 캐시를 건드리지 않음).
    state = cloneState(cached.state);
    start = cached.parsedBytes;
  } else {
    state = newState(file);
    start = 0;
  }
  const r = yield* parseRange(file, state, start);
  // 마지막 줄바꿈 뒤 꼬리가 완결된 JSON 이면(줄바꿈 없이 끝난 파일) 요약에만 반영하고, 캐시 상태는 완결 줄까지만 둔다.
  const withTail = r.leftover ? tailState(state, r.leftover) : null;
  const summary = summaryOf(withTail ?? state, file);
  if (r.ok) {
    const headLen = Math.min(HEAD_FP_BYTES, st.size);
    const fp = headFp(file, headLen);
    if (fp !== null) {
      fileCache.set(key, { size: st.size, mtimeMs: st.mtimeMs, parsedBytes: r.parsedBytes, headLen, headFp: fp, state, summary });
    } else {
      fileCache.delete(key);
    }
  } else {
    // 읽기 실패 — 이번 결과만 쓰고 캐시에 남기지 않는다(다음 집계에서 다시 읽음 · 종전 동작과 같음).
    fileCache.delete(key);
  }
  return summary;
}

function newState(file: string): ParseState {
  return {
    threadId: path.basename(file, ".jsonl"),
    updatedAt: 0,
    latestTotal: emptyBreakdown(),
    turnModels: new Map<string, string>(),
    events: [],
  };
}

function cloneState(s: ParseState): ParseState {
  return { ...s, latestTotal: { ...s.latestTotal }, turnModels: new Map(s.turnModels), events: s.events.slice() };
}

function summaryOf(s: ParseState, file: string): FileSummary {
  return {
    threadId: s.threadId,
    title: s.title,
    path: file,
    updatedAt: s.updatedAt,
    latestModel: s.latestModel,
    latestTotal: s.latestTotal,
    latestContextWindow: s.latestContextWindow,
    events: s.events,
  };
}

function tailState(s: ParseState, leftover: string): ParseState | null {
  const trimmed = leftover.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  try {
    JSON.parse(trimmed);
  } catch {
    return null; // 아직 쓰는 중인 미완결 줄 — 다음 번에 줄바꿈까지 와서 처리된다
  }
  const t = cloneState(s);
  applyLine(t, leftover);
  return t;
}

/** 파일 앞 len 바이트의 지문(판독 실패=null). */
function headFp(file: string, len: number): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(len);
    const n = len > 0 ? fs.readSync(fd, buf, 0, len, 0) : 0;
    if (n !== len) return null;
    return crypto.createHash("sha1").update(buf).digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// 한 줄 처리(상태 누적). 순서 보존이 중요하므로 스트리밍에서도 줄 순서대로 호출한다.
function applyLine(s: ParseState, raw: string): void {
  const trimmed = raw.trim();
  if (!trimmed || trimmed[0] !== "{") return;
  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return;
  }

  const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
  if (isFinite(ts) && ts > s.updatedAt) s.updatedAt = ts;

  if (obj.type === "session_meta") {
    s.threadId = String(obj.payload?.id || s.threadId);
    s.title = obj.payload?.thread_name || obj.payload?.title || s.title;
    const metaModel = obj.payload?.model || obj.payload?.settings?.model;
    if (metaModel) s.latestModel = String(metaModel);
    return;
  }

  if (obj.type === "turn_context") {
    const turnId = obj.payload?.turn_id;
    const model = obj.payload?.model || obj.payload?.collaboration_mode?.settings?.model;
    if (turnId && model) {
      s.turnModels.set(String(turnId), String(model));
      s.latestModel = String(model);
    }
    return;
  }

  if (obj.payload?.type === "task_started") {
    s.currentTurnId = obj.payload.turn_id ? String(obj.payload.turn_id) : s.currentTurnId;
    return;
  }

  if (obj.payload?.type !== "token_count") {
    return;
  }

  const info = obj.payload.info ?? {};
  const last = normalizeUsage(info.last_token_usage);
  s.latestTotal = normalizeUsage(info.total_token_usage);
  s.latestContextWindow = typeof info.model_context_window === "number" ? info.model_context_window : s.latestContextWindow;
  const model = s.currentTurnId ? s.turnModels.get(s.currentTurnId) : undefined;
  s.events.push({
    ts: isFinite(ts) ? ts : 0,
    model: model || s.latestModel || "unknown",
    usage: last,
    turnId: s.currentTurnId,
  });
}

/**
 * start 바이트부터 끝까지 완결 줄(줄바꿈으로 끝난 줄)을 순서대로 처리한다.
 * 청크 스트리밍 읽기: fs.readFileSync 는 ~512MB(Node 최대 문자열) 초과 시 ERR_STRING_TOO_LONG 으로 던지므로 쓰지 않는다.
 * 줄은 바이트 0x0A 에서 자른다 — UTF-8 의 여러 바이트 글자 안에는 0x0A 가 나올 수 없어 글자가 쪼개지지 않는다.
 * 반환 parsedBytes=마지막 줄바꿈 다음 위치 · leftover=그 뒤 미완결 꼬리 · ok=끝까지 읽었는지.
 */
function* parseRange(
  file: string,
  state: ParseState,
  start: number,
): Generator<void, { parsedBytes: number; leftover: string; ok: boolean }, void> {
  let fd: number | undefined;
  let carry: Buffer = Buffer.alloc(0);
  let carryStart = start; // carry[0] 의 파일 내 위치
  let pos = start;
  let lines = 0;
  let ok = true;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(chunkSize);
    for (;;) {
      const bytes = fs.readSync(fd, buf, 0, chunkSize, pos);
      if (bytes <= 0) {
        break;
      }
      pos += bytes;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytes)]) : buf.subarray(0, bytes);
      let from = 0;
      let nl: number;
      while ((nl = data.indexOf(0x0a, from)) >= 0) {
        applyLine(state, data.toString("utf8", from, nl));
        from = nl + 1;
        if (++lines % LINES_PER_YIELD === 0) yield;
      }
      carryStart += from;
      carry = Buffer.from(data.subarray(from)); // buf 는 다음 읽기에 재사용되므로 복사
      yield;
    }
  } catch {
    ok = false; // 읽기 실패 시 지금까지 처리한 결과만 반환
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  return { parsedBytes: carryStart, leftover: carry.length ? carry.toString("utf8") : "", ok };
}

function normalizeUsage(raw: any): TokenUsageBreakdown {
  return {
    inputTokens: num(raw?.input_tokens ?? raw?.inputTokens),
    cachedInputTokens: num(raw?.cached_input_tokens ?? raw?.cachedInputTokens),
    outputTokens: num(raw?.output_tokens ?? raw?.outputTokens),
    reasoningOutputTokens: num(raw?.reasoning_output_tokens ?? raw?.reasoningOutputTokens),
    totalTokens: num(raw?.total_tokens ?? raw?.totalTokens),
  };
}

function num(value: unknown): number {
  return typeof value === "number" && isFinite(value) ? value : 0;
}
