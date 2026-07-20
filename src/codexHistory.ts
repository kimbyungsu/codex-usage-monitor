import { createHash } from "crypto";
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

const CACHE_VERSION = 4;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_LINE_BYTES = 256 * 1024;
const FINGERPRINT_BYTES = 4096;
// 대시보드의 가장 긴 원시 이벤트 창은 28일 heatmap이다. 경계 여유를 두고 35일만 보존한다.
const EVENT_RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

/**
 * 영속 캐시 크기를 줄이기 위한 compact event tuple.
 * [ts, model, input, cachedInput, output, reasoningOutput, total, turnId?]
 */
type ParsedEvent = [number, string, number, number, number, number, number, string?];

interface FileSummary {
  threadId: string;
  title?: string;
  path: string;
  updatedAt: number;
  latestModel?: string;
  latestTotal: TokenUsageBreakdown;
  latestContextWindow?: number | null;
  /** 전체 파일에서 처리한 token_count 수. 오래된 이벤트를 버려도 세션 events 수를 보존한다. */
  totalEvents: number;
  events: ParsedEvent[];
}

interface ParserState {
  currentTurnId?: string;
  currentTurnModel?: string;
  lastTurnContextId?: string;
  lastTurnContextModel?: string;
}

interface FileIdentity {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

interface CachedFile {
  path: string;
  identity: FileIdentity;
  /** 마지막으로 처리한 개행 바로 다음 바이트. 항상 UTF-8 문자/JSONL 경계다. */
  parsedBytes: number;
  /** parsedBytes 직전의 작은 바이트 창 해시. append 여부 검증에 사용한다. */
  prefixTailHash: string;
  parser: ParserState;
  summary: FileSummary;
}

interface PersistedCacheFile {
  version: number;
  file: CachedFile;
}

export interface CodexHistoryScanDiagnostics {
  elapsedMs: number;
  bytesRead: number;
  cacheHits: number;
  filesParsedFull: number;
  filesParsedIncremental: number;
  filesRemoved: number;
  cacheLoaded: boolean;
  cacheWritten: boolean;
  cacheFilesWritten: number;
}

export interface CodexHistoryScanResult {
  history: CodexHistoryUsage;
  diagnostics: CodexHistoryScanDiagnostics;
}

/**
 * Codex JSONL 파일별 파싱 인덱스.
 *
 * 인스턴스는 Worker Thread 안에서 재사용하며, 선택적으로 작은 요약 인덱스를 디스크에
 * 영속화한다. 원본 메시지 본문은 저장하지 않고 토큰 이벤트/스레드 메타만 저장한다.
 */
export class CodexHistoryIndex {
  private readonly files = new Map<string, CachedFile>();
  private loaded = false;
  private loadedFromDisk = false;

  constructor(private readonly cacheDir?: string) {}

  scan(codexHome = defaultCodexHome(), extraSessionPaths: string[] = []): CodexHistoryScanResult {
    const started = Date.now();
    this.loadCache();
    const diagnostics: CodexHistoryScanDiagnostics = {
      elapsedMs: 0,
      bytesRead: 0,
      cacheHits: 0,
      filesParsedFull: 0,
      filesParsedIncremental: 0,
      filesRemoved: 0,
      cacheLoaded: this.loadedFromDisk,
      cacheWritten: false,
      cacheFilesWritten: 0,
    };

    const sessionDirs = resolveSessionDirs(codexHome, extraSessionPaths);
    const existingDirs = sessionDirs.filter((dir) => fs.existsSync(dir));
    if (!existingDirs.length) {
      diagnostics.elapsedMs = Date.now() - started;
      return {
        history: emptyHistory(`Codex sessions folder not found: ${sessionDirs.join(", ")}`),
        diagnostics,
      };
    }

    const seenFiles = new Set<string>();
    const rolloutFiles: string[] = [];
    for (const dir of existingDirs) {
      for (const file of listRolloutFiles(dir)) {
        const key = path.resolve(file);
        if (!seenFiles.has(key)) {
          seenFiles.add(key);
          rolloutFiles.push(key);
        }
      }
    }
    if (!rolloutFiles.length) {
      diagnostics.elapsedMs = Date.now() - started;
      return {
        history: emptyHistory(`No Codex rollout files found: ${existingDirs.join(", ")}`),
        diagnostics,
      };
    }

    const retentionCutoff = Date.now() - EVENT_RETENTION_MS;
    const summaries: FileSummary[] = [];
    for (const file of rolloutFiles) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const identity = fileIdentity(stat);
      const cached = this.files.get(file);
      if (cached && sameIdentity(cached.identity, identity)) {
        if (pruneOldEvents(cached.summary, retentionCutoff)) {
          if (this.persistCachedFile(cached)) {
            diagnostics.cacheWritten = true;
            diagnostics.cacheFilesWritten += 1;
          }
        }
        diagnostics.cacheHits += 1;
        summaries.push(cached.summary);
        continue;
      }

      let next: CachedFile;
      if (cached && isSafeAppend(file, cached, identity)) {
        next = parseRolloutFile(file, cached, diagnostics);
        diagnostics.filesParsedIncremental += 1;
      } else {
        next = parseRolloutFile(file, undefined, diagnostics);
        diagnostics.filesParsedFull += 1;
      }
      this.files.set(file, next);
      if (this.persistCachedFile(next)) {
        diagnostics.cacheWritten = true;
        diagnostics.cacheFilesWritten += 1;
      }
      summaries.push(next.summary);
    }

    for (const cachedPath of [...this.files.keys()]) {
      if (!seenFiles.has(cachedPath)) {
        this.files.delete(cachedPath);
        this.removeCachedFile(cachedPath);
        diagnostics.filesRemoved += 1;
      }
    }
    diagnostics.elapsedMs = Date.now() - started;
    return {
      history: aggregateHistory(summaries, rolloutFiles.length),
      diagnostics,
    };
  }

  private loadCache(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    if (!this.cacheDir) {
      return;
    }
    try {
      const entries = fs.readdirSync(this.cacheDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        let parsed: PersistedCacheFile;
        try {
          parsed = JSON.parse(fs.readFileSync(path.join(this.cacheDir, entry.name), "utf8")) as PersistedCacheFile;
        } catch {
          continue;
        }
        const item = parsed.file;
        if (parsed.version !== CACHE_VERSION) {
          continue;
        }
        if (!validCachedFile(item)) {
          continue;
        }
        const resolved = path.resolve(item.path);
        item.path = resolved;
        item.summary.path = resolved;
        this.files.set(resolved, item);
      }
      this.loadedFromDisk = this.files.size > 0;
    } catch {
      // 캐시가 없거나 손상됐으면 원본 JSONL로 안전하게 재구축한다.
    }
  }

  private persistCachedFile(file: CachedFile): boolean {
    if (!this.cacheDir) {
      return false;
    }
    const target = this.cacheFilePath(file.path);
    const tmp = `${target}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const payload: PersistedCacheFile = {
        version: CACHE_VERSION,
        file,
      };
      fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, target);
      return true;
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  private removeCachedFile(filePath: string): void {
    if (!this.cacheDir) {
      return;
    }
    try {
      fs.unlinkSync(this.cacheFilePath(filePath));
    } catch {
      /* ignore */
    }
  }

  private cacheFilePath(filePath: string): string {
    const name = createHash("sha256").update(path.resolve(filePath)).digest("hex");
    return path.join(this.cacheDir || ".", `${name}.json`);
  }
}

/** 기존 호출자/간단한 테스트용 동기 API. 확장 본체는 Worker client를 사용한다. */
export function readCodexHistory(
  codexHome = defaultCodexHome(),
  extraSessionPaths: string[] = [],
): CodexHistoryUsage {
  return new CodexHistoryIndex().scan(codexHome, extraSessionPaths).history;
}

function resolveSessionDirs(codexHome: string, extraSessionPaths: string[]): string[] {
  const sessionDirs: string[] = [];
  const addDir = (dir: string): void => {
    if (dir && !sessionDirs.includes(dir)) {
      sessionDirs.push(dir);
    }
  };
  addDir(path.join(codexHome, "sessions"));
  for (const raw of extraSessionPaths) {
    const candidate = (raw ?? "").trim();
    if (!candidate) {
      continue;
    }
    const withSessions = path.join(candidate, "sessions");
    addDir(fs.existsSync(withSessions) ? withSessions : candidate);
  }
  return sessionDirs;
}

function aggregateHistory(summaries: FileSummary[], filesScanned: number): CodexHistoryUsage {
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
  for (const summary of summaries) {
    addBucket(total, summary.latestTotal, summary.latestModel);
    for (const event of summary.events) {
      if (event[0] >= todayMs) addEventBucket(today, event);
      if (event[0] >= fiveHoursAgo) addEventBucket(lastFiveHours, event);
      if (event[0] >= sevenDaysAgo) addEventBucket(lastSevenDays, event);
      if (event[0] >= sevenDaysAgo) addModelEvent(byModel, event);
    }
  }

  const newest = summaries
    .filter((summary) => summary.events.length > 0 || summary.updatedAt > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const session = newest
    ? { ...emptyBucket(), ...newest.latestTotal, events: newest.totalEvents }
    : emptyBucket();

  const recentThreads: CodexThreadUsage[] = summaries
    .map((summary) => {
      const lastSeven = emptyBucket();
      for (const event of summary.events) {
        if (event[0] >= sevenDaysAgo) {
          addEventBucket(lastSeven, event);
        }
      }
      return { summary, lastSeven };
    })
    .filter((item) => item.lastSeven.totalTokens > 0)
    .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)
    .slice(0, 8)
    .map(({ summary, lastSeven }) => ({
      threadId: summary.threadId,
      title: summary.title,
      path: summary.path,
      updatedAt: summary.updatedAt,
      model: summary.latestModel,
      total: summary.latestTotal,
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
    insights: computeInsights(iterateInsightEntries(summaries), now),
    filesScanned,
    lastScannedAt: Date.now(),
  };
}

function parseRolloutFile(
  file: string,
  previous: CachedFile | undefined,
  diagnostics: CodexHistoryScanDiagnostics,
): CachedFile {
  const summary: FileSummary = previous
    ? {
        ...previous.summary,
        latestTotal: { ...previous.summary.latestTotal },
        events: [...previous.summary.events],
      }
    : {
        threadId: path.basename(file, ".jsonl"),
        path: file,
        updatedAt: 0,
        latestTotal: emptyBreakdown(),
        totalEvents: 0,
        events: [],
      };
  const parser: ParserState = previous
    ? { ...previous.parser }
    : {};
  const retentionCutoff = Date.now() - EVENT_RETENTION_MS;
  const startOffset = previous?.parsedBytes ?? 0;
  let committedOffset = startOffset;
  let fd: number | undefined;
  let lineParts: Buffer[] = [];
  let lineBytes = 0;
  let lineTruncated = false;

  const addLinePart = (part: Buffer): void => {
    if (!part.length || lineBytes >= MAX_BUFFERED_LINE_BYTES) {
      if (part.length) lineTruncated = true;
      return;
    }
    const available = MAX_BUFFERED_LINE_BYTES - lineBytes;
    const kept = part.length > available ? part.subarray(0, available) : part;
    lineParts.push(Buffer.from(kept));
    lineBytes += kept.length;
    if (kept.length < part.length) {
      lineTruncated = true;
    }
  };
  const finishLine = (): void => {
    const raw = lineParts.length ? Buffer.concat(lineParts, lineBytes).toString("utf8") : "";
    handleLine(raw, lineTruncated, summary, parser, retentionCutoff);
    lineParts = [];
    lineBytes = 0;
    lineTruncated = false;
  };

  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let pos = startOffset;
    for (;;) {
      const bytes = fs.readSync(fd, buf, 0, buf.length, pos);
      if (bytes <= 0) {
        break;
      }
      diagnostics.bytesRead += bytes;
      let segmentStart = 0;
      for (let i = 0; i < bytes; i += 1) {
        if (buf[i] !== 0x0a) {
          continue;
        }
        addLinePart(buf.subarray(segmentStart, i));
        finishLine();
        committedOffset = pos + i + 1;
        segmentStart = i + 1;
      }
      addLinePart(buf.subarray(segmentStart, bytes));
      pos += bytes;
    }
    // 개행 없는 마지막 줄은 다음 append에서 완성될 수 있으므로 커밋하지 않는다.
  } catch {
    // 읽기 실패 시 마지막 완전한 JSONL 경계까지의 결과만 사용한다.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }

  let identity: FileIdentity;
  try {
    identity = fileIdentity(fs.statSync(file));
  } catch {
    identity = previous?.identity ?? { size: committedOffset, mtimeMs: 0, ctimeMs: 0, ino: 0 };
  }
  return {
    path: file,
    identity,
    parsedBytes: committedOffset,
    prefixTailHash: hashPrefixTail(file, committedOffset),
    parser,
    summary,
  };
}

function handleLine(
  raw: string,
  truncated: boolean,
  summary: FileSummary,
  parser: ParserState,
  retentionCutoff: number,
): void {
  const trimmed = raw.trim();
  if (!trimmed || trimmed[0] !== "{") {
    return;
  }
  const timestamp = extractJsonString(trimmed, "timestamp");
  const ts = timestamp ? Date.parse(timestamp) : 0;
  if (isFinite(ts) && ts > summary.updatedAt) {
    summary.updatedAt = ts;
  }

  const topType = extractJsonString(trimmed, "type");
  if (topType === "session_meta") {
    if (!truncated) {
      const obj = tryParseJson(trimmed);
      if (obj) {
        summary.threadId = String(obj.payload?.id || obj.payload?.session_id || summary.threadId);
        summary.title = obj.payload?.thread_name || obj.payload?.title || summary.title;
        const model = obj.payload?.model || obj.payload?.settings?.model;
        if (model) summary.latestModel = String(model);
        return;
      }
    }
    summary.threadId = extractJsonString(trimmed, "session_id")
      || extractJsonString(afterPayload(trimmed), "id")
      || summary.threadId;
    summary.title = extractJsonString(trimmed, "thread_name")
      || extractJsonString(trimmed, "title")
      || summary.title;
    summary.latestModel = extractJsonString(trimmed, "model") || summary.latestModel;
    return;
  }

  if (topType === "turn_context") {
    if (!truncated) {
      const obj = tryParseJson(trimmed);
      if (obj) {
        const turnId = obj.payload?.turn_id;
        const model = obj.payload?.model || obj.payload?.collaboration_mode?.settings?.model;
        if (turnId && model) {
          parser.lastTurnContextId = String(turnId);
          parser.lastTurnContextModel = String(model);
          if (parser.currentTurnId === parser.lastTurnContextId) {
            parser.currentTurnModel = parser.lastTurnContextModel;
          }
          summary.latestModel = parser.lastTurnContextModel;
        }
        return;
      }
    }
    const payload = afterPayload(trimmed);
    const turnId = extractJsonString(payload, "turn_id");
    const model = extractJsonString(payload, "model");
    if (turnId && model) {
      parser.lastTurnContextId = turnId;
      parser.lastTurnContextModel = model;
      if (parser.currentTurnId === turnId) {
        parser.currentTurnModel = model;
      }
      summary.latestModel = model;
    }
    return;
  }

  if (topType !== "event_msg" || truncated) {
    return;
  }
  const payloadText = afterPayload(trimmed);
  const payloadType = extractJsonString(payloadText, "type");
  if (payloadType !== "task_started" && payloadType !== "token_count") {
    return;
  }
  const obj = tryParseJson(trimmed);
  if (!obj) {
    return;
  }
  if (obj.payload?.type === "task_started") {
    parser.currentTurnId = obj.payload.turn_id
      ? String(obj.payload.turn_id)
      : parser.currentTurnId;
    parser.currentTurnModel = parser.currentTurnId === parser.lastTurnContextId
      ? parser.lastTurnContextModel
      : undefined;
    return;
  }
  if (obj.payload?.type !== "token_count") {
    return;
  }
  const info = obj.payload.info ?? {};
  const last = normalizeUsage(info.last_token_usage);
  summary.latestTotal = normalizeUsage(info.total_token_usage);
  summary.latestContextWindow = typeof info.model_context_window === "number"
    ? info.model_context_window
    : summary.latestContextWindow;
  const eventTs = isFinite(ts) ? ts : 0;
  summary.totalEvents += 1;
  if (eventTs >= retentionCutoff) {
    summary.events.push([
      eventTs,
      parser.currentTurnModel || summary.latestModel || "unknown",
      last.inputTokens,
      last.cachedInputTokens,
      last.outputTokens,
      last.reasoningOutputTokens,
      last.totalTokens,
      parser.currentTurnId,
    ]);
  }
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

function addEventBucket(bucket: CodexTokenBucket, event: ParsedEvent): void {
  bucket.inputTokens += event[2];
  bucket.cachedInputTokens += event[3];
  bucket.outputTokens += event[4];
  bucket.reasoningOutputTokens += event[5];
  bucket.totalTokens += event[6];
  bucket.events += 1;
}

function addModelEvent(models: Map<string, CodexModelUsage>, event: ParsedEvent): void {
  const key = event[1] || "unknown";
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
  item.inputTokens += event[2];
  item.cachedInputTokens += event[3];
  item.outputTokens += event[4];
  item.reasoningOutputTokens += event[5];
  item.totalTokens += event[6];
  item.events += 1;
  models.set(key, item);
}

function* iterateInsightEntries(summaries: FileSummary[]): Iterable<InsightEntry> {
  for (const summary of summaries) {
    for (const event of summary.events) {
      yield {
        ts: event[0],
        model: event[1],
        totalTokens: event[6],
        // Codex 의미론: reasoning은 output의 부분집합이라 합산하지 않는다.
        outputTokens: event[4],
        turnKey: event[7] ? `${summary.path}#${event[7]}` : undefined,
      };
    }
  }
}

function listRolloutFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
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

function fileIdentity(stat: fs.Stats): FileIdentity {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    ino: Number(stat.ino),
  };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.size === b.size
    && a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs
    && a.ino === b.ino;
}

function isSafeAppend(file: string, cached: CachedFile, current: FileIdentity): boolean {
  if (current.ino !== cached.identity.ino || current.size <= cached.identity.size) {
    return false;
  }
  if (current.size < cached.parsedBytes) {
    return false;
  }
  return hashPrefixTail(file, cached.parsedBytes) === cached.prefixTailHash;
}

function hashPrefixTail(file: string, endOffset: number): string {
  if (endOffset <= 0) {
    return "";
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const start = Math.max(0, endOffset - FINGERPRINT_BYTES);
    const length = endOffset - start;
    const buf = Buffer.allocUnsafe(length);
    const bytes = fs.readSync(fd, buf, 0, length, start);
    return createHash("sha256").update(buf.subarray(0, bytes)).digest("hex");
  } catch {
    return "!unreadable";
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

function validCachedFile(value: unknown): value is CachedFile {
  const item = value as CachedFile;
  return Boolean(
    item
      && typeof item.path === "string"
      && item.identity
      && typeof item.identity.size === "number"
      && typeof item.parsedBytes === "number"
      && typeof item.prefixTailHash === "string"
      && item.parser
      && item.summary
      && typeof item.summary.totalEvents === "number"
      && Array.isArray(item.summary.events),
  );
}

function pruneOldEvents(summary: FileSummary, cutoff: number): boolean {
  const retained = summary.events.filter((event) => event[0] >= cutoff);
  if (retained.length === summary.events.length) {
    return false;
  }
  summary.events = retained;
  return true;
}

function afterPayload(raw: string): string {
  const index = raw.indexOf('"payload"');
  return index >= 0 ? raw.slice(index) : raw;
}

function extractJsonString(raw: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(raw);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

function tryParseJson(raw: string): any | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
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
