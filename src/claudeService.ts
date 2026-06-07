// Claude Code 사용량 서비스.
//  1) 플랜 한도(5시간/주간): Anthropic OAuth usage 엔드포인트 (claudeApi.ts)
//  2) 토큰/비용/컨텍스트: ~/.claude/projects/**/*.jsonl 트랜스크립트 집계
// 두 소스를 합쳐 상태를 만들고, 주기적 갱신 + 파일 감시로 실시간에 가깝게 유지한다.

import * as fs from "fs";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import * as vscode from "vscode";
import { fetchPlanUsage, projectsDir, readCredentials, resolveConfigDir } from "./claudeApi";
import { ClaudeState, ClaudeThreadUsage, ClaudeTokenUsage, TokenBucket } from "./claudeTypes";
import { t } from "./i18n";

// 모델별 100만 토큰당 단가(USD). 구독 사용자는 실제 청구가 아니라 'API 환산 비용'.
interface Rate {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}
const RATES: Record<string, Rate> = {
  opus: { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
};

function rateFor(model: string): Rate {
  const m = model.toLowerCase();
  if (m.includes("opus")) return RATES.opus;
  if (m.includes("haiku")) return RATES.haiku;
  return RATES.sonnet; // sonnet 및 미상 모델 기본값
}

interface UsageEntry {
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  cost: number;
  key: string; // msgId:requestId (중복 제거용)
}

interface FileCache {
  mtimeMs: number;
  size: number;
  entries: UsageEntry[];
  cwd?: string;
  sessionId?: string;
  /** 증분 파싱용: 지금까지 읽은 바이트 오프셋. */
  parsedBytes: number;
  /** 증분 파싱용: 개행이 아직 안 온 마지막 미완성 라인. */
  tailLeftover: string;
}

function emptyBucket(): TokenBucket {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    messages: 0,
  };
}

function addEntry(bucket: TokenBucket, e: UsageEntry): void {
  bucket.inputTokens += e.input;
  bucket.outputTokens += e.output;
  bucket.cacheReadTokens += e.cacheRead;
  bucket.cacheCreationTokens += e.cacheCreate;
  bucket.totalTokens += e.input + e.output + e.cacheRead + e.cacheCreate;
  bucket.costUsd += e.cost;
  bucket.messages += 1;
}

function entryCost(model: string, u: any): number {
  const r = rateFor(model);
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const c5 = num(u.cache_creation?.ephemeral_5m_input_tokens);
  const c1 = num(u.cache_creation?.ephemeral_1h_input_tokens);
  const cacheCreate = num(u.cache_creation_input_tokens) || c5 + c1;
  // 세분화된 캐시 정보가 있으면 5m/1h 단가를 따로 적용, 없으면 5m 단가로 일괄.
  const cacheWriteCost =
    c5 + c1 > 0
      ? (c5 * r.cacheWrite5m + c1 * r.cacheWrite1h) / 1e6
      : (cacheCreate * r.cacheWrite5m) / 1e6;
  return (
    (input * r.input + output * r.output + cacheRead * r.cacheRead) / 1e6 + cacheWriteCost
  );
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

export class ClaudeService implements vscode.Disposable {
  private state: ClaudeState = { available: false, connecting: false };
  private readonly fileCaches = new Map<string, FileCache>();
  private planTimer?: NodeJS.Timeout;
  private tokenTimer?: NodeJS.Timeout;
  private watchers: fs.FSWatcher[] = [];
  private watchDebounce?: NodeJS.Timeout;
  // 수렴형(적응형) 폴링 간격: 429면 ×2(빠른 증가), 성공이 쌓이면 한 단계씩만 완화(느린 감소).
  // → '그 환경에서 지속 가능한 최소 간격'에 수렴하고, 실패한 간격으로 곧장 되돌아가지 않는다.
  private planBaseMs = 120_000;
  private planIntervalMs = 120_000;
  /** 연속 429 횟수(표시·증가용). 정상 응답 시 0. */
  private plan429Count = 0;
  /** 연속 성공 횟수. 일정 횟수마다 간격을 한 단계 완화. */
  private planSuccessStreak = 0;
  /** 사용률 추세 추정용 샘플 버퍼. */
  private planSamples: Array<{ ts: number; five?: number; seven?: number }> = [];
  /** 이미 알림을 보낸 (윈도우:임계치:리셋앵커) 키. */
  private alertedKeys = new Set<string>();
  private readonly emitter = new vscode.EventEmitter<ClaudeState>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly output: vscode.OutputChannel) {}

  get currentState(): ClaudeState {
    return this.state;
  }

  async start(): Promise<void> {
    const configDir = this.configDir();
    const creds = readCredentials(configDir);
    this.setState({
      available: Boolean(creds),
      subscriptionType: creds?.subscriptionType,
      rateLimitTier: creds?.rateLimitTier,
    });
    await Promise.all([this.refreshPlan(), this.refreshTokens()]);
    this.configureTimers();
    this.setupWatcher();
  }

  async refreshPlan(_force = false): Promise<void> {
    this.setState({ connecting: true });
    const result = await fetchPlanUsage({
      configDirOverride: this.cfg().get<string>("claudeConfigDir", "") || undefined,
      log: (m) => this.output.appendLine(`[claude] ${m}`),
    });

    const CAP_MS = 15 * 60_000; // 최대 간격 15분
    const STEP_MS = 30_000; // 완화 단위 30초
    const DECREASE_AFTER = 3; // 연속 성공 N회마다 한 단계 완화

    let rateLimitNotice: string | undefined;
    if (result.rateLimited) {
      // 빠른 증가: 간격을 2배(서버 retry-after가 더 길면 그걸 하한으로). 곧장 base로 안 돌아감.
      this.plan429Count += 1;
      this.planSuccessStreak = 0;
      const next = Math.max(this.planIntervalMs * 2, result.retryAfterMs ?? 0);
      this.planIntervalMs = Math.min(Math.max(next, this.planBaseMs), CAP_MS);
      rateLimitNotice = t().rateLimited(Math.round(this.planIntervalMs / 1000));
      this.output.appendLine(
        `[claude] HTTP 429 — 간격 ${Math.round(this.planIntervalMs / 1000)}초로 증가 (연속 ${this.plan429Count})`,
      );
    } else if (result.usage) {
      this.plan429Count = 0;
      // 느린 감소: 성공이 충분히 쌓였을 때만 한 단계씩 완화 → 지속 가능 간격에 수렴.
      this.planSuccessStreak += 1;
      if (this.planSuccessStreak >= DECREASE_AFTER && this.planIntervalMs > this.planBaseMs) {
        this.planIntervalMs = Math.max(this.planBaseMs, this.planIntervalMs - STEP_MS);
        this.planSuccessStreak = 0;
      }
    }

    let projection = this.state.projection;
    if (result.usage) {
      const now = Date.now();
      this.recordSample(now, result.usage);
      projection = this.computeProjection(now);
      this.checkAlerts(result.usage);
    }

    this.setState({
      connecting: false,
      available: Boolean(result.usage) || this.state.available,
      plan: result.usage ?? this.state.plan,
      projection,
      subscriptionType: result.subscriptionType ?? this.state.subscriptionType,
      rateLimitTier: result.rateLimitTier ?? this.state.rateLimitTier,
      lastPlanRefresh: result.usage ? Date.now() : this.state.lastPlanRefresh,
      // 429는 차분한 상태 문구(planRateLimited)로만, 진짜 오류(토큰만료·인증서)는 알림 카드(planError)로.
      planError: result.rateLimited ? undefined : result.error,
      planRateLimited: result.rateLimited ? rateLimitNotice : undefined,
    });

    // 다음 폴링을 현재 적응 간격으로 예약(자기 스케줄링).
    this.scheduleNextPlan();
  }

  private scheduleNextPlan(): void {
    if (this.planTimer) {
      clearTimeout(this.planTimer);
    }
    this.planTimer = setTimeout(() => void this.refreshPlan(), this.planIntervalMs);
  }

  /** 사용률 추세 추정을 위한 샘플 기록(리셋으로 급락 시 버퍼 초기화). */
  private recordSample(
    now: number,
    usage: {
      fiveHour?: { utilization: number } | null;
      sevenDay?: { utilization: number } | null;
    },
  ): void {
    // 5시간·주간 모두 '이번 응답'에서 직접 읽는다(state 반영 전 값이 섞이지 않도록).
    const five = usage.fiveHour?.utilization;
    const seven = usage.sevenDay?.utilization;
    const last = this.planSamples[this.planSamples.length - 1];
    // 5시간 사용률이 크게 떨어졌으면(=윈도우 리셋) 이전 추세를 버린다.
    if (last && typeof five === "number" && typeof last.five === "number" && five < last.five - 5) {
      this.planSamples = [];
    }
    this.planSamples.push({ ts: now, five, seven });
    // 최근 2시간, 최대 60개만 유지.
    const cutoff = now - 2 * 60 * 60 * 1000;
    this.planSamples = this.planSamples.filter((s) => s.ts >= cutoff).slice(-60);
  }

  private computeProjection(now: number): ClaudeState["projection"] {
    const s = this.planSamples;
    if (s.length < 2) {
      return null;
    }
    const newest = s[s.length - 1];
    const oldest = s[0];
    const dtHours = (newest.ts - oldest.ts) / 3_600_000;
    if (dtHours < 0.05) {
      return null; // 표본 구간이 너무 짧으면 추정 보류
    }
    const proj = (cur?: number, old?: number) => {
      if (typeof cur !== "number" || typeof old !== "number") {
        return null;
      }
      const ratePerHour = (cur - old) / dtHours; // %/시간
      if (ratePerHour <= 0.05) {
        return null; // 증가세가 거의 없으면 소진 예상 무의미
      }
      const hoursToFull = (100 - cur) / ratePerHour;
      if (!isFinite(hoursToFull) || hoursToFull < 0) {
        return null;
      }
      return { hoursToFull, etaMs: now + hoursToFull * 3_600_000 };
    };
    return {
      fiveHour: proj(newest.five, oldest.five),
      sevenDay: proj(newest.seven, oldest.seven),
    };
  }

  private checkAlerts(usage: {
    fiveHour?: { utilization: number; resetsAt: string | null } | null;
    sevenDay?: { utilization: number; resetsAt: string | null } | null;
  }): void {
    const thresholds = (this.cfg().get<number[]>("claudeUsageAlertThresholds", [80, 95]) || [])
      .filter((n) => typeof n === "number" && n > 0)
      .sort((a, b) => a - b);
    if (!thresholds.length) {
      return;
    }
    const T = t();
    const activeAnchors = new Set<string>();
    const check = (label: string, w?: { utilization: number; resetsAt: string | null } | null) => {
      if (!w || typeof w.utilization !== "number") {
        return;
      }
      const anchor = w.resetsAt ?? "";
      // 임계치를 넘긴 것 중 가장 높은 단계만 알림(중복 최소화).
      const crossed = thresholds.filter((th) => w.utilization >= th);
      for (const th of crossed) {
        activeAnchors.add(`${label}:${th}:${anchor}`);
      }
      const top = crossed[crossed.length - 1];
      if (top === undefined) {
        return;
      }
      const key = `${label}:${top}:${anchor}`;
      if (!this.alertedKeys.has(key)) {
        this.alertedKeys.add(key);
        const reset = w.resetsAt ? new Date(w.resetsAt).toLocaleString() : "";
        void vscode.window.showWarningMessage(T.alert(label, Math.round(w.utilization), top, reset));
      }
    };
    check(T.alertFiveHour, usage.fiveHour);
    check(T.alertWeekly, usage.sevenDay);
    // 현재 윈도우와 무관한(리셋되어 anchor가 바뀐) 옛 키 정리.
    for (const k of [...this.alertedKeys]) {
      if (!activeAnchors.has(k)) {
        this.alertedKeys.delete(k);
      }
    }
  }

  async refreshTokens(): Promise<void> {
    try {
      const tokens = this.aggregateTokens();
      this.setState({ tokens, lastTokenRefresh: Date.now(), tokenError: undefined });
    } catch (error) {
      this.setState({ tokenError: (error as Error).message });
    }
  }

  configureTimers(): void {
    // 플랜: 적응형 자기 스케줄링(설정값을 base로, 현재 간격을 base로 리셋 후 재예약).
    this.planBaseMs = Math.max(30, this.cfg().get<number>("claudePlanRefreshSeconds", 120)) * 1000;
    this.planIntervalMs = this.planBaseMs;
    this.plan429Count = 0;
    this.planSuccessStreak = 0;
    this.scheduleNextPlan();
    // 토큰: 고정 주기 폴링(+ 파일 감시).
    if (this.tokenTimer) clearInterval(this.tokenTimer);
    const tokenSec = Math.max(5, this.cfg().get<number>("claudeTokenRefreshSeconds", 15));
    this.tokenTimer = setInterval(() => void this.refreshTokens(), tokenSec * 1000);
  }

  dispose(): void {
    if (this.planTimer) clearTimeout(this.planTimer);
    if (this.tokenTimer) clearInterval(this.tokenTimer);
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.closeWatchers();
    this.emitter.dispose();
  }

  /** 설정(설정 폴더/추가 경로 등) 변경 시 감시·집계를 다시 구성한다. */
  async reconfigure(): Promise<void> {
    this.closeWatchers();
    this.setupWatcher();
    await Promise.all([this.refreshPlan(), this.refreshTokens()]);
  }

  // ---- 내부 구현 ----

  private closeWatchers(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers = [];
  }

  private setupWatcher(): void {
    for (const dir of this.projectRoots()) {
      if (!fs.existsSync(dir)) {
        continue;
      }
      try {
        const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
          if (filename && !String(filename).endsWith(".jsonl")) {
            return;
          }
          // 활발한 세션은 쓰기가 잦으므로 디바운스로 묶어 갱신.
          if (this.watchDebounce) clearTimeout(this.watchDebounce);
          this.watchDebounce = setTimeout(() => void this.refreshTokens(), 1500);
        });
        this.watchers.push(watcher);
      } catch (error) {
        this.output.appendLine(`[claude] watch 실패(${dir}): ${(error as Error).message}`);
      }
    }
  }

  /** 집계 대상 projects 폴더 목록. 기본 폴더 + 사용자가 추가한 다른 환경 경로들. */
  private projectRoots(): string[] {
    const roots = [projectsDir(this.configDir())];
    const extra = this.cfg().get<string[]>("claudeExtraProjectPaths", []) || [];
    for (const p of extra) {
      const trimmed = (p ?? "").trim();
      if (trimmed) {
        roots.push(trimmed);
      }
    }
    return roots;
  }

  private aggregateTokens(): ClaudeTokenUsage {
    const roots = this.projectRoots();
    const existingRoots = roots.filter((r) => fs.existsSync(r));
    if (!existingRoots.length) {
      throw new Error(`트랜스크립트 폴더 없음: ${roots.join(", ")}`);
    }

    let files: string[] = [];
    for (const r of existingRoots) {
      files = files.concat(this.listTranscripts(r));
    }
    let newestFile: { path: string; mtimeMs: number } | undefined;

    // 변경된 파일만 재파싱(파일별 캐시).
    for (const file of files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!newestFile || stat.mtimeMs > newestFile.mtimeMs) {
        newestFile = { path: file, mtimeMs: stat.mtimeMs };
      }
      const cached = this.fileCaches.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        continue;
      }
      if (cached && stat.size > cached.size && cached.parsedBytes <= stat.size) {
        // 파일이 늘어난 append 케이스: 새로 추가된 꼬리만 파싱해 이어붙인다(대용량 세션 성능).
        const delta = this.parseFileRange(file, cached.parsedBytes, cached.tailLeftover);
        this.fileCaches.set(file, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          entries: cached.entries.concat(delta.entries),
          cwd: delta.cwd || cached.cwd,
          sessionId: cached.sessionId || delta.sessionId,
          parsedBytes: delta.parsedBytes,
          tailLeftover: delta.tailLeftover,
        });
      } else {
        // 신규/재작성(크기 축소 등): 전체를 스트리밍으로 파싱(>512MB도 안전).
        const parsed = this.parseFileRange(file, 0, "");
        this.fileCaches.set(file, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          entries: parsed.entries,
          cwd: parsed.cwd,
          sessionId: parsed.sessionId,
          parsedBytes: parsed.parsedBytes,
          tailLeftover: parsed.tailLeftover,
        });
      }
    }
    // 사라진 파일 캐시 정리.
    for (const key of [...this.fileCaches.keys()]) {
      if (!files.includes(key)) {
        this.fileCaches.delete(key);
      }
    }

    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    const total = emptyBucket();
    const today = emptyBucket();
    const lastFiveHours = emptyBucket();
    const lastSevenDays = emptyBucket();
    const byModel = new Map<
      string,
      {
        totalTokens: number;
        costUsd: number;
        weekTokens: number;
        weekCostUsd: number;
        weekInputTokens: number;
        weekCacheTokens: number;
        weekOutputTokens: number;
      }
    >();
    const seen = new Set<string>();

    for (const cache of this.fileCaches.values()) {
      for (const e of cache.entries) {
        if (e.key && seen.has(e.key)) {
          continue;
        }
        if (e.key) seen.add(e.key);
        addEntry(total, e);
        if (e.ts >= todayMs) addEntry(today, e);
        if (e.ts >= fiveHoursAgo) addEntry(lastFiveHours, e);
        if (e.ts >= sevenDaysAgo) addEntry(lastSevenDays, e);
        // 모델별: 전체 기간 로스터(4.6/4.7/4.8/sonnet/haiku 등)는 유지하고,
        // 주간 한도와 같은 '최근 7일' 값도 같은 행에 함께 담는다.
        const tokensOfEntry = e.input + e.output + e.cacheRead + e.cacheCreate;
        const m = byModel.get(e.model) ?? {
          totalTokens: 0,
          costUsd: 0,
          weekTokens: 0,
          weekCostUsd: 0,
          weekInputTokens: 0,
          weekCacheTokens: 0,
          weekOutputTokens: 0,
        };
        m.totalTokens += tokensOfEntry;
        m.costUsd += e.cost;
        if (e.ts >= sevenDaysAgo) {
          m.weekTokens += tokensOfEntry;
          m.weekCostUsd += e.cost;
          m.weekInputTokens += e.input;
          m.weekCacheTokens += e.cacheRead + e.cacheCreate;
          m.weekOutputTokens += e.output;
        }
        byModel.set(e.model, m);
      }
    }

    // 현재 세션 = 가장 최근에 수정된 트랜스크립트 파일.
    const session = emptyBucket();
    let contextTokens = 0;
    let sessionModel: string | undefined;
    if (newestFile) {
      const cache = this.fileCaches.get(newestFile.path);
      if (cache) {
        // 전역 집계와 동일하게 중복(같은 msgId:requestId)을 제거해야 세션 값이
        // 부풀지 않는다. (스트리밍/재개 등으로 한 파일에 중복 줄이 생길 수 있음)
        const sessionSeen = new Set<string>();
        for (const e of cache.entries) {
          if (e.key && sessionSeen.has(e.key)) {
            continue;
          }
          if (e.key) {
            sessionSeen.add(e.key);
          }
          addEntry(session, e);
          sessionModel = e.model || sessionModel;
        }
        const last = cache.entries[cache.entries.length - 1];
        if (last) {
          contextTokens = last.input + last.cacheRead + last.cacheCreate;
        }
      }
    }

    // 스레드(=트랜스크립트 파일)별 최근 7일 요약 — Codex recentThreads와 대칭.
    const threads: ClaudeThreadUsage[] = [];
    for (const [filePath, cache] of this.fileCaches.entries()) {
      const tTotal = emptyBucket();
      const tWeek = emptyBucket();
      let tModel: string | undefined;
      let updatedAt = cache.mtimeMs;
      const tSeen = new Set<string>();
      for (const e of cache.entries) {
        if (e.key && tSeen.has(e.key)) {
          continue;
        }
        if (e.key) {
          tSeen.add(e.key);
        }
        addEntry(tTotal, e);
        if (e.ts > updatedAt) {
          updatedAt = e.ts;
        }
        if (e.model) {
          tModel = e.model;
        }
        if (e.ts >= sevenDaysAgo) {
          addEntry(tWeek, e);
        }
      }
      if (tWeek.totalTokens <= 0) {
        continue; // 최근 7일 사용분이 있는 스레드만 노출
      }
      threads.push({
        threadId: cache.sessionId || path.basename(filePath, ".jsonl"),
        title: cache.cwd ? path.basename(cache.cwd) : path.basename(path.dirname(filePath)),
        path: filePath,
        updatedAt,
        model: tModel,
        total: tTotal,
        lastSevenDays: tWeek,
        events: tWeek.messages,
      });
    }
    threads.sort((a, b) => b.updatedAt - a.updatedAt);
    const recentThreads = threads.slice(0, 8);

    return {
      total,
      today,
      lastFiveHours,
      lastSevenDays,
      session,
      contextTokens,
      sessionModel,
      recentThreads,
      byModel: [...byModel.entries()]
        .map(([model, v]) => ({ model, ...v }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
    };
  }

  /**
   * 트랜스크립트를 startOffset 바이트부터 청크 스트리밍으로 파싱한다.
   * - fs.readFileSync 는 ~512MB(Node 최대 문자열) 초과 파일에서 ERR_STRING_TOO_LONG 으로 던진다.
   *   Claude 세션 jsonl 은 수백 MB~GB 까지 커지므로(예: 597MB) 반드시 스트리밍으로 읽어야 한다.
   * - StringDecoder 로 청크 경계의 멀티바이트(한글 등) 분할을 안전 처리.
   * - startOffset>0 이면 증분(append) 파싱: 직전 미완성 라인(initialLeftover)을 이어붙인다.
   * - 마지막 개행 없는 꼬리는 파싱하지 않고 tailLeftover 로 넘겨 다음 append 때 완성시킨다.
   */
  private parseFileRange(
    file: string,
    startOffset: number,
    initialLeftover: string,
  ): { entries: UsageEntry[]; cwd?: string; sessionId?: string; parsedBytes: number; tailLeftover: string } {
    const entries: UsageEntry[] = [];
    let cwd: string | undefined;
    let sessionId: string | undefined;
    let parsedBytes = startOffset;
    let leftover = initialLeftover;

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") {
        return;
      }
      let obj: any;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return;
      }
      // 파일 레벨 메타(스레드 식별·제목용)는 usage 유무와 무관하게 가능한 한 채운다.
      if (typeof obj.cwd === "string" && obj.cwd) cwd = obj.cwd;
      if (typeof obj.sessionId === "string" && obj.sessionId) sessionId = obj.sessionId;
      const usage = obj?.message?.usage;
      if (!usage) {
        return;
      }
      const model = String(obj.message.model ?? "unknown");
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
      const msgId = obj.message.id ?? "";
      const reqId = obj.requestId ?? "";
      const c5 = num(usage.cache_creation?.ephemeral_5m_input_tokens);
      const c1 = num(usage.cache_creation?.ephemeral_1h_input_tokens);
      entries.push({
        ts: isFinite(ts) ? ts : 0,
        model,
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheCreate: num(usage.cache_creation_input_tokens) || c5 + c1,
        cost: entryCost(model, usage),
        key: msgId || reqId ? `${msgId}:${reqId}` : "",
      });
    };

    let fd: number | undefined;
    try {
      fd = fs.openSync(file, "r");
      const CHUNK = 4 * 1024 * 1024;
      const buf = Buffer.allocUnsafe(CHUNK);
      const decoder = new StringDecoder("utf8");
      let pos = startOffset;
      for (;;) {
        const bytes = fs.readSync(fd, buf, 0, CHUNK, pos);
        if (bytes <= 0) {
          break;
        }
        pos += bytes;
        parsedBytes = pos;
        leftover += decoder.write(buf.subarray(0, bytes));
        let nl: number;
        while ((nl = leftover.indexOf("\n")) >= 0) {
          handleLine(leftover.slice(0, nl));
          leftover = leftover.slice(nl + 1);
        }
      }
      leftover += decoder.end();
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

    return { entries, cwd, sessionId, parsedBytes, tailLeftover: leftover };
  }

  private listTranscripts(dir: string): string[] {
    const out: string[] = [];
    const walk = (current: string, depth: number) => {
      if (depth > 4) return;
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        const full = path.join(current, item.name);
        if (item.isDirectory()) {
          walk(full, depth + 1);
        } else if (item.isFile() && item.name.endsWith(".jsonl")) {
          out.push(full);
        }
      }
    };
    walk(dir, 0);
    return out;
  }

  private configDir(): string {
    return resolveConfigDir(this.cfg().get<string>("claudeConfigDir", "") || undefined);
  }

  private cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("codexUsageMonitor");
  }

  private setState(patch: Partial<ClaudeState>): void {
    this.state = { ...this.state, ...patch };
    this.emitter.fire(this.state);
  }
}
