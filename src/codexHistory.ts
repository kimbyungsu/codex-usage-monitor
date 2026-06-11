import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StringDecoder } from "string_decoder";
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

export function readCodexHistory(
  codexHome = defaultCodexHome(),
  extraSessionPaths: string[] = [],
): CodexHistoryUsage {
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
  if (!existingDirs.length) {
    return emptyHistory(`Codex sessions folder not found: ${sessionDirs.join(", ")}`);
  }

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
    const summary = parseRolloutFile(file);
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

function parseRolloutFile(file: string): FileSummary {
  const events: ParsedEvent[] = [];
  const turnModels = new Map<string, string>();
  let threadId = path.basename(file, ".jsonl");
  let title: string | undefined;
  let updatedAt = 0;
  let latestModel: string | undefined;
  let currentTurnId: string | undefined;
  let latestTotal = emptyBreakdown();
  let latestContextWindow: number | null | undefined;

  // 한 줄 처리(상태 누적). 순서 보존이 중요하므로 스트리밍에서도 줄 순서대로 호출한다.
  const handleLine = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed[0] !== "{") return;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }

    const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
    if (isFinite(ts) && ts > updatedAt) updatedAt = ts;

    if (obj.type === "session_meta") {
      threadId = String(obj.payload?.id || threadId);
      title = obj.payload?.thread_name || obj.payload?.title || title;
      const metaModel = obj.payload?.model || obj.payload?.settings?.model;
      if (metaModel) latestModel = String(metaModel);
      return;
    }

    if (obj.type === "turn_context") {
      const turnId = obj.payload?.turn_id;
      const model = obj.payload?.model || obj.payload?.collaboration_mode?.settings?.model;
      if (turnId && model) {
        turnModels.set(String(turnId), String(model));
        latestModel = String(model);
      }
      return;
    }

    if (obj.payload?.type === "task_started") {
      currentTurnId = obj.payload.turn_id ? String(obj.payload.turn_id) : currentTurnId;
      return;
    }

    if (obj.payload?.type !== "token_count") {
      return;
    }

    const info = obj.payload.info ?? {};
    const last = normalizeUsage(info.last_token_usage);
    latestTotal = normalizeUsage(info.total_token_usage);
    latestContextWindow = typeof info.model_context_window === "number" ? info.model_context_window : latestContextWindow;
    const model = currentTurnId ? turnModels.get(currentTurnId) : undefined;
    events.push({
      ts: isFinite(ts) ? ts : 0,
      model: model || latestModel || "unknown",
      usage: last,
      turnId: currentTurnId,
    });
  };

  // 청크 스트리밍 읽기: fs.readFileSync 는 ~512MB(Node 최대 문자열) 초과 시 ERR_STRING_TOO_LONG 으로
  // 던지므로 대용량 rollout 이 통째로 누락된다. StringDecoder 로 멀티바이트 경계도 안전 처리.
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const CHUNK = 4 * 1024 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    const decoder = new StringDecoder("utf8");
    let leftover = "";
    let pos = 0;
    for (;;) {
      const bytes = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (bytes <= 0) {
        break;
      }
      pos += bytes;
      leftover += decoder.write(buf.subarray(0, bytes));
      let nl: number;
      while ((nl = leftover.indexOf("\n")) >= 0) {
        handleLine(leftover.slice(0, nl));
        leftover = leftover.slice(nl + 1);
      }
    }
    leftover += decoder.end();
    if (leftover) {
      handleLine(leftover);
    }
  } catch {
    /* 읽기 실패 시 지금까지 파싱한 결과만 반환 */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    threadId,
    title,
    path: file,
    updatedAt,
    latestModel,
    latestTotal,
    latestContextWindow,
    events,
  };
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
