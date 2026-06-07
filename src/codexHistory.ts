import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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

export function readCodexHistory(codexHome = defaultCodexHome()): CodexHistoryUsage {
  const sessionsDir = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessionsDir)) {
    return emptyHistory(`Codex sessions folder not found: ${sessionsDir}`);
  }

  const files = listRolloutFiles(sessionsDir);
  if (!files.length) {
    return emptyHistory(`No Codex rollout files found: ${sessionsDir}`);
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

  for (const file of files) {
    const summary = parseRolloutFile(file);
    summaries.push(summary);
    addBucket(total, summary.latestTotal, summary.latestModel);
    for (const event of summary.events) {
      if (event.ts >= todayMs) addBucket(today, event.usage, event.model);
      if (event.ts >= fiveHoursAgo) addBucket(lastFiveHours, event.usage, event.model);
      if (event.ts >= sevenDaysAgo) addBucket(lastSevenDays, event.usage, event.model);
      if (event.ts >= sevenDaysAgo) addModel(byModel, event.model, event.usage);
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

  let content = "";
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
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

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
    if (isFinite(ts) && ts > updatedAt) updatedAt = ts;

    if (obj.type === "session_meta") {
      threadId = String(obj.payload?.id || threadId);
      title = obj.payload?.thread_name || obj.payload?.title || title;
      const metaModel = obj.payload?.model || obj.payload?.settings?.model;
      if (metaModel) latestModel = String(metaModel);
      continue;
    }

    if (obj.type === "turn_context") {
      const turnId = obj.payload?.turn_id;
      const model = obj.payload?.model || obj.payload?.collaboration_mode?.settings?.model;
      if (turnId && model) {
        turnModels.set(String(turnId), String(model));
        latestModel = String(model);
      }
      continue;
    }

    if (obj.payload?.type === "task_started") {
      currentTurnId = obj.payload.turn_id ? String(obj.payload.turn_id) : currentTurnId;
      continue;
    }

    if (obj.payload?.type !== "token_count") {
      continue;
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
    });
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
