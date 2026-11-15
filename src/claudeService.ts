// Claude Code 사용량 서비스.
//  1) 플랜 한도(서버가 보고하는 창들 — 5시간·주간·모델 전용 등): Anthropic OAuth usage 엔드포인트 (claudeApi.ts)
//  2) 토큰/비용/컨텍스트: ~/.claude/projects/**/*.jsonl 트랜스크립트 집계
// 두 소스를 합쳐 상태를 만들고, 주기적 갱신 + 파일 감시로 실시간에 가깝게 유지한다.

import * as fs from "fs";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import * as vscode from "vscode";
import {
  credentialsPath,
  fetchPlanUsage,
  loginKeyOf,
  projectsDir,
  readAccountInfo,
  readCredentials,
  readLoginKey,
  resolveConfigDir,
  samePath,
} from "./claudeApi";
import { ClaudeCacheStats, ClaudeState, ClaudeThreadUsage, ClaudeTokenUsage, TokenBucket } from "./claudeTypes";
import { computeInsights, InsightEntry } from "./insights";
import { chartSeries, historyAccountKey, LimitHistoryStore } from "./limitHistory";
import {
  acceptObservations,
  chartUpTo,
  CoverSpan,
  coverGapFor,
  LimitSample,
  LimitWatch,
  LimitWindow,
  markGaps,
  windowStartOf,
} from "./limits";
import { formatWhen, limitLabel, t } from "./i18n";

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
  /** 이 항목이 속한 턴 번호(파일 내 실제 사용자 입력 기준 누적). */
  turn: number;
  /** 서브에이전트(sidechain) 호출 여부. */
  sidechain: boolean;
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
  /** 증분 파싱용: 지금까지 본 턴 수(다음 증분에서 이어서 센다). */
  turnSeq: number;
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

/** 타이머 한 번에 거는 최대 길이(하루) — Node 타이머 한계(약 24.8일)를 넘는 대기를 나눠 건다. */
const TIMER_CHUNK_MS = 24 * 60 * 60_000;

/** 로그인 파일의 현재 상태(수정 시각·크기). 없으면 undefined. */
function credentialsStamp(configDir: string): string | undefined {
  try {
    const st = fs.statSync(credentialsPath(configDir));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return undefined;
  }
}

export class ClaudeService implements vscode.Disposable {
  private state: ClaudeState = { available: false, connecting: false };
  private readonly fileCaches = new Map<string, FileCache>();
  private planTimer?: NodeJS.Timeout;
  private tokenTimer?: NodeJS.Timeout;
  private watchers: fs.FSWatcher[] = [];
  private watchDebounce?: NodeJS.Timeout;
  private credentialsDebounce?: NodeJS.Timeout;
  private credentialsWatcher?: fs.FSWatcher;
  /** 설정 폴더가 아직 없을 때 그 폴더가 생기는 것을 지켜보는 상위 폴더 감시. */
  private credentialsParentWatcher?: fs.FSWatcher;
  private credentialsWatchDir?: string;
  /** 마지막 조회를 시작할 때 본 로그인 파일 상태(수정 시각·크기) — 감시를 건 직후 그사이 바뀌었는지 확인용. */
  private lastCredentialsStamp?: string;
  /** start() 가 끝나 주기 조회·감시가 구성됨(그 전·종료 뒤에는 감시를 새로 걸지 않는다). */
  private started = false;
  // 수렴형(적응형) 폴링 간격: 429면 ×2(빠른 증가), 성공이 쌓이면 한 단계씩만 완화(느린 감소).
  // → '그 환경에서 지속 가능한 최소 간격'에 수렴하고, 실패한 간격으로 곧장 되돌아가지 않는다.
  private planBaseMs = 120_000;
  private planIntervalMs = 120_000;
  /** 연속 429 횟수(표시·증가용). 정상 응답 시 0. */
  private plan429Count = 0;
  /** 연속 성공 횟수. 일정 횟수마다 간격을 한 단계 완화. */
  private planSuccessStreak = 0;
  /** 같은 창 추적(복원 감지·그래프 샘플). 실제 계정이 바뀔 때만 초기화. */
  private readonly watch = new LimitWatch();
  /** 진행 중인 플랜 조회(한 번에 하나 — 늦게 온 옛 응답이 새 값을 덮지 않게). */
  private planInFlight?: Promise<void>;
  /** 진행 중에 또 요청됨 → 끝난 뒤 한 번 더(재시도 대기 시각은 지킴). */
  private planRerun = false;
  /** 429 등으로 이 시각 전에는 다시 부르지 않음(수동 새로고침·합쳐진 요청 포함). */
  private planNextAllowedAt = 0;
  /** 마지막으로 확인한 계정 식별. 재연결·토큰 갱신·설정 변경이 아니라 이것이 바뀔 때만 감지 기록을 지운다. */
  private accountIdentity: string | null = null;
  /**
   * 지금 상태(표시값·감지 기록·계정별 정보)를 만든 마지막 응답의 로그인 지문(토큰 해시). 계정 정보를 읽지 못할 때
   * 같은 로그인 구간인지 가르는 데만 쓴다 — 지문이 다르면(토큰 갱신이든 다른 로그인이든) 같은 계정이라고 보지 않는다.
   */
  private ownerLoginKey: string | null = null;
  /** dispose 이후 늦게 도착한 응답·재예약을 막는다. */
  private disposed = false;
  /**
   * 지금 화면 상태(사용량·요금제 표시명·구독 정보·추적 기록)가 어느 설정 폴더의 계정 것인지. 사용량을 받았는지와
   * 무관하게, 그 폴더의 계정 정보를 상태에 올릴 때마다(시작·매 조회 반영) 함께 기록한다 — 폴더가 바뀌면 새 계정
   * 값 확인 전까지 '계정 확인 중', 같은 계정임을 확인할 수 없으면 이전 상태를 버리는 기준이 된다.
   */
  private acceptedConfigDir: string | null = null;
  /** 이미 알림을 보낸 (윈도우:임계치:리셋앵커) 키. */
  private alertedKeys = new Set<string>();
  private readonly emitter = new vscode.EventEmitter<ClaudeState>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly output: vscode.OutputChannel,
    /** 그래프용 사용률 기록 저장소(없으면 지금 기억하는 값만 그린다). */
    private readonly history?: LimitHistoryStore,
  ) {}

  get currentState(): ClaudeState {
    return this.state;
  }

  async start(): Promise<void> {
    const configDir = this.configDir();
    const creds = readCredentials(configDir);
    const account = readAccountInfo(configDir);
    this.setState({
      available: Boolean(creds),
      subscriptionType: creds?.subscriptionType,
      rateLimitTier: creds?.rateLimitTier,
      planDisplayName: account.planDisplayName,
    });
    // 이 시점의 화면 상태는 이 폴더·계정의 것이다(첫 조회 전에 폴더가 바뀌어도 이전 계정 정보가 섞이지 않게).
    this.acceptedConfigDir = configDir;
    this.accountIdentity = account.identity;
    this.ownerLoginKey = loginKeyOf(creds);
    await Promise.all([this.refreshPlan(), this.refreshTokens()]);
    if (this.disposed) {
      return; // 시작 도중 종료됨 → 주기 타이머·파일 감시를 만들지 않는다
    }
    this.configureTimers();
    this.started = true;
    this.setupWatcher();
  }

  /**
   * 플랜 한도 조회. 한 번에 하나만 돌고, 진행 중 요청은 끝난 뒤 1회로 합친다.
   * 재시도 대기 중(429)에는 수동 새로고침이라도 서버를 부르지 않고 허용 시각에 예약만 한다.
   */
  refreshPlan(_force = false): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.planInFlight) {
      this.planRerun = true;
      return this.planInFlight;
    }
    const wait = this.planNextAllowedAt - Date.now();
    if (wait > 0) {
      // 서버 대기 중이라도 계정·설정이 바뀌었으면 표시값이 이전 계정 것임을 알린다(서버는 부르지 않음).
      this.markIfAccountSwitched(this.configDir(), readAccountInfo(this.configDir()).identity);
      this.scheduleNextPlan(wait);
      return Promise.resolve();
    }
    this.planInFlight = this.runPlanFetch().finally(() => {
      this.planInFlight = undefined;
      if (this.planRerun && !this.disposed) {
        this.planRerun = false;
        const left = this.planNextAllowedAt - Date.now();
        if (left > 0) this.scheduleNextPlan(left);
        else void this.refreshPlan();
      }
    });
    return this.planInFlight;
  }

  private async runPlanFetch(): Promise<void> {
    this.setState({ connecting: true });
    // 요청을 시작한 문맥(설정 폴더·계정)을 고정해 두고, 끝났을 때 바뀌었으면 결과를 버린다.
    const startDir = this.configDir();
    const startIdentity = readAccountInfo(startDir).identity;
    this.lastCredentialsStamp = credentialsStamp(startDir);
    // 조회를 시작하기 전에 이미 계정·설정 폴더가 바뀌었으면, 응답을 기다리는 동안 표시값이 이전 계정 것임을 알린다.
    this.markIfAccountSwitched(startDir, startIdentity);
    const result = await fetchPlanUsage({
      configDirOverride: this.cfg().get<string>("claudeConfigDir", "") || undefined,
      log: (m) => this.output.appendLine(`[claude] ${m}`),
    });
    if (this.disposed) {
      return;
    }
    // 시작 뒤(감시가 구성된 뒤)에는 매 조회 때 자격증명 감시가 빠졌으면 다시 건다(설치 실패·폴더 삭제·첫 로그인 전 시작).
    if (this.started) this.ensureCredentialsWatcher();
    if (result.credentialsChanged) {
      // 조회 도중 자격증명 파일이 바뀜(다른 계정 로그인 등) — 어느 계정 값인지 보장할 수 없으니 버리고 새로 조회한다.
      this.discardAndRecheck(result);
      return;
    }
    // 문맥 확인을 가장 먼저: 조회 중 계정·설정 폴더가 바뀌었으면 이 응답(값·오류·429 대기 모두)은 이전 계정 것이므로
    // 어디에도 반영하지 않고, '계정 확인 중'으로 표시한 뒤 곧바로 다시 조회한다.
    const dir = this.configDir();
    const account = readAccountInfo(dir);
    if (dir !== startDir || account.identity !== startIdentity) {
      this.discardAndRecheck(result);
      return;
    }

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
      // 서버가 정한 대기는 조회 간격 상한(15분)과 별개로 줄이지 않고 지킨다.
      const waitMs = Math.max(this.planIntervalMs, result.retryAfterMs ?? 0);
      rateLimitNotice = t().rateLimited(Math.round(waitMs / 1000));
      this.planNextAllowedAt = Date.now() + waitMs;
      this.output.appendLine(
        `[claude] HTTP 429 — 간격 ${Math.round(this.planIntervalMs / 1000)}초로 증가 (연속 ${this.plan429Count})`,
      );
    } else if (result.usage) {
      this.plan429Count = 0;
      this.planNextAllowedAt = 0;
      // 느린 감소: 성공이 충분히 쌓였을 때만 한 단계씩 완화 → 지속 가능 간격에 수렴.
      this.planSuccessStreak += 1;
      if (this.planSuccessStreak >= DECREASE_AFTER && this.planIntervalMs > this.planBaseMs) {
        this.planIntervalMs = Math.max(this.planBaseMs, this.planIntervalMs - STEP_MS);
        this.planSuccessStreak = 0;
      }
    }

    // 계정이 바뀌었으면 이전 계정의 창 기록(복원 감지·샘플)과 표시값을 버린다(비교 대상에서도 제외).
    // - 같은 설정 폴더: 계정 식별이 둘 다 있고 서로 다를 때만 변경(식별을 잠시 못 읽은 것만으로는 버리지 않음).
    // - 설정 폴더가 바뀜: 같은 계정임을 확인할 수 있을 때(식별이 둘 다 있고 같음)만 유지 — 확인할 수 없으면 다른
    //   계정으로 보고 버린다(새 폴더에 계정 정보 파일이 없어도 이전 계정 값·기록과 섞이지 않게).
    //   '바뀜'은 경로 표기가 아니라 실제 대상으로 판단한다(같은 폴더를 다르게 적은 것은 바뀐 게 아니다).
    // - 지금 상태의 주인 계정이 미확정인데(식별 없이 값·정보를 받음 — 아래 참고) 이번에 식별이 확인되면, 같은 계정임을
    //   보장할 수 없으니 다른 계정으로 보고 사용량·계정별 정보를 모두 버린다(모르던 값이 확인된 계정의 것으로 둔갑하지 않게).
    // - 식별 없는 응답(계정 정보를 읽지 못함 — 같은 계정의 일시적 누락인지 다른 로그인인지 알 수 없음):
    //   · 지금 주인이 미확정이고 이 응답이 같은 로그인 구간(같은 토큰 지문 — 둘 다 자격 증명 없음 포함)이면, 새 관측이
    //     있든 없든 그 주인의 응답으로 이어 간다(계정 정보를 계속 못 읽는 환경에서도 하락 보류·실선·요금제 정보 갱신 동작,
    //     저장은 안 함).
    //   · 그 밖에 새 관측을 가져오면(지금 기록 기준으로 받아들일 관측이 하나라도 있으면): 확인된 계정을 보던 중이거나
    //     로그인 지문이 다르므로(토큰 갱신·다른 로그인 — 구분 불가) 누구 것인지 모르는 새 주인(미확정)으로 보고 처음부터 —
    //     이전 값·기록·정보와 비교하거나 잇지 않는다(섞인 실선·하락 보류 방지).
    //   · 새 관측도 없으면(조회 실패·만료·빈 목록·모두 옛 관측) 지킬 주인 상태(확인된 계정, 또는 표시 중인 사용량·요금제
    //     표시명·구독 유형·등급)가 있을 때 그 상태를 바꾸지 않는다(이 응답의 사용량 부가 정보·구독 정보도 쓰지 않음).
    //     지킬 것이 없으면 이 응답이 새 주인.
    const loginKey = result.loginKey ?? null;
    const sameLogin = loginKey === this.ownerLoginKey;
    const bringsFresh = Boolean(result.usage?.windows.some((w) => this.watch.accepts(w)));
    const hasOwner = Boolean(this.accountIdentity) || this.showsOwnerInfo();
    const continuesUnconfirmed = !account.identity && !this.accountIdentity && sameLogin;
    const knownSame = Boolean(account.identity && this.accountIdentity && account.identity === this.accountIdentity);
    const knownDifferent =
      Boolean(account.identity && this.accountIdentity && account.identity !== this.accountIdentity) ||
      Boolean(account.identity && !this.accountIdentity);
    const unidentifiedNewOwner = !account.identity && !continuesUnconfirmed && (bringsFresh || !hasOwner);
    const dirChanged = this.acceptedConfigDir !== null && !samePath(dir, this.acceptedConfigDir);
    const accountChanged = knownDifferent || (dirChanged && !knownSame) || unidentifiedNewOwner;
    /** 누구 것인지 알 수 없는 응답(식별·새 관측·같은 미확정 로그인 구간 모두 아님) — 지금 주인의 상태(사용량·계정별 정보·마지막 확인 시각)를 바꾸지 않는다. */
    const unattributed = !accountChanged && !account.identity && !bringsFresh && !continuesUnconfirmed;
    if (accountChanged) {
      this.watch.clear();
      this.accountIdentity = account.identity;
    } else if (account.identity) {
      this.accountIdentity = account.identity;
    }
    // 이 응답이 지금 상태의 주인이 되면(새 주인·같은 주인 이어감) 그 로그인 지문을 기억한다.
    if (!unattributed) this.ownerLoginKey = loginKey;
    // 아래에서 이 폴더 계정의 정보(사용량이 없어도 구독·표시명·기다림 상태)를 상태에 올리므로 소유 문맥도 함께 기록한다.
    this.acceptedConfigDir = dir;

    let plan = accountChanged ? undefined : this.state.plan;
    if (result.usage && !unattributed) {
      // 같은 창 기준에서 더 새 관측을 이미 봤으면 이전 표시 유지, 새로 받은 관측에만 노후 시각(관측 때 고정)을 붙인다.
      const staleAfterMs = Math.max(2 * this.planBaseMs, 5 * 60_000);
      const windows = acceptObservations(this.watch, plan?.windows, result.usage.windows, staleAfterMs);
      plan = { ...result.usage, windows };
      this.watch.observe(windows, this.coverGapMs());
      // 계정 식별을 확인할 수 있을 때만, 이번 응답에서 새로 받아들인 관측만 그 계정 기록으로 저장한다
      // (없으면 저장하지 않음 · 받아들이지 않고 이어 둔 이전 표시값은 저장하지 않음 — 다른 계정과 섞이지 않게).
      const fresh = new Set(result.usage.windows.map((x) => `${x.id}\u0000${x.observedAtMs}`));
      const accepted = windows.filter((x) => fresh.has(`${x.id}\u0000${x.observedAtMs}`));
      this.history?.record(
        historyAccountKey("claude", account.identity),
        accepted,
        (w) => this.watch.anchorFor(w),
        this.coverGapMs(),
      );
      this.checkAlerts(windows);
    }
    // 계정별 정보(구독 유형·등급·표시명)는 이 응답이 지금 상태의 주인 것일 때만 응답 값으로 바꾼다
    // (식별 확인 또는 새 주인으로 처리). 누구 것인지 알 수 없는 응답은 지금 주인의 정보를 덮지 않는다.
    const ownerSpeaks = !unattributed;
    const tracked = plan ? this.watch.snapshot(plan.windows) : { holds: {}, holdReasons: {}, samples: {}, covers: {} };
    // 계정이 바뀌었으면 요금제 표시명·구독 유형·등급·마지막 확인 시각도 이전 계정 것을 이어 쓰지 않는다.
    const previous: Partial<ClaudeState> = accountChanged ? {} : this.state;
    const lastPlanRefresh = result.usage && !unattributed ? Date.now() : previous.lastPlanRefresh;

    this.setState({
      connecting: false,
      available: Boolean(result.usage) || this.state.available,
      plan,
      holds: tracked.holds,
      holdReasons: tracked.holdReasons,
      // 저장 기록은 이번 조회로 확인한 지금 계정 식별로만 합친다(식별이 없으면 지금 기억하는 값만).
      // 누구 것인지 알 수 없는 응답이면 지금 주인의 실선을 그대로 둔다(다시 그리지 않음).
      samples: unattributed
        ? this.state.samples
        : plan
          ? this.chartSamples(plan.windows, tracked, account.identity)
          : tracked.samples,
      planFailing: !result.usage,
      // 누구 것인지 모르는 응답이 같은 로그인 구간임도 확인되지 않으면(토큰이 바뀜·자격 증명이 생기거나 사라짐) 표시 중인 정보
      // (사용량이 없어도 요금제 정보)가 지금 로그인의 것이 아닐 수 있음을 알린다. 주인이 정해진 응답(식별 확인·새 주인·같은 미확정 로그인 구간)이면
      // 표시 정보가 그 응답의 계정 것이므로 해제한다.
      planAccountChecking: unattributed
        ? this.state.planAccountChecking || (!sameLogin && this.showsOwnerInfo())
        : false,
      subscriptionType: ownerSpeaks ? result.subscriptionType ?? previous.subscriptionType ?? null : this.state.subscriptionType,
      rateLimitTier: ownerSpeaks ? result.rateLimitTier ?? previous.rateLimitTier ?? null : this.state.rateLimitTier,
      planDisplayName: ownerSpeaks ? account.planDisplayName ?? previous.planDisplayName ?? null : this.state.planDisplayName,
      lastPlanRefresh,
      // 429·토큰 만료 대기는 차분한 상태 문구로만, 진짜 오류(인증서 등)는 알림 카드(planError)로.
      planError: result.rateLimited || result.tokenExpired ? undefined : result.error,
      planRateLimited: result.rateLimited ? rateLimitNotice : undefined,
      planWaiting: result.tokenExpired
        ? t().planWaitingForClaude(lastPlanRefresh ? formatWhen(lastPlanRefresh) : null)
        : undefined,
    });

    // 다음 폴링을 현재 적응 간격으로 예약(자기 스케줄링).
    this.scheduleNextPlan();
  }

  private scheduleNextPlan(delayMs: number = this.planIntervalMs): void {
    if (this.planTimer) {
      clearTimeout(this.planTimer);
    }
    if (this.disposed) {
      return;
    }
    // 아주 긴 서버 대기(타이머 한계 약 24.8일 초과)도 1ms 반복 없이: 타이머는 최대 하루씩 나눠 걸고,
    // 깨어나면 refreshPlan 이 대기 시각을 다시 확인해 남은 만큼 다시 예약한다(대기 시각 자체는 줄이지 않음).
    const delay = Math.max(0, Math.min(isFinite(delayMs) ? delayMs : TIMER_CHUNK_MS, TIMER_CHUNK_MS));
    this.planTimer = setTimeout(() => void this.refreshPlan(), delay);
  }

  /**
   * 어느 계정 것인지 보장할 수 없는 응답을 버리고 다시 조회한다(결과를 버리는 모든 경로 공용).
   * 값·오류는 반영하지 않지만, 서버가 요구한 재시도 대기는 지킨다 — 재조회도 그 시각 이후이고,
   * 그동안은 '계정 확인 중'으로 표시값이 이전 계정 것일 수 있음을 알린다.
   */
  private discardAndRecheck(result: { rateLimited?: boolean; retryAfterMs?: number }): void {
    if (result.rateLimited) {
      this.planNextAllowedAt = Math.max(
        this.planNextAllowedAt,
        Date.now() + Math.max(this.planIntervalMs, result.retryAfterMs ?? 0),
      );
    }
    this.planRerun = true;
    this.setState({ connecting: false, planAccountChecking: true });
  }

  /**
   * 조회 전·서버 대기 중: 지금 표시값의 주인과 같은 계정임을 확인할 수 없으면 '계정 확인 중'(이전 값이 있을 때만).
   * 결과 반영(runPlanFetch)의 계정 변경 판단과 같은 기준 — 식별이 다름, 주인 미확정인데 식별이 확인됨, 설정 폴더가 바뀜,
   * 식별을 읽지 못하는데 로그인 지문도 같지 않음(토큰이 바뀜·자격 증명이 생기거나 사라짐).
   */
  private markIfAccountSwitched(dir: string, identity: string | null): void {
    const loginKey = readLoginKey(dir);
    const sameLogin = loginKey === this.ownerLoginKey;
    const switched =
      (identity && this.accountIdentity && identity !== this.accountIdentity) ||
      (identity && !this.accountIdentity) ||
      (!identity && !sameLogin) ||
      (this.acceptedConfigDir !== null && !samePath(dir, this.acceptedConfigDir));
    if (switched && this.showsOwnerInfo() && !this.state.planAccountChecking) {
      this.setState({ planAccountChecking: true });
    }
  }

  /** 지금 화면에 어떤 계정의 것으로 보이는 정보(사용량 또는 요금제 표시명·구독 유형·등급)가 있는지. */
  private showsOwnerInfo(): boolean {
    const s = this.state;
    return Boolean(s.plan || s.planDisplayName || s.subscriptionType || s.rateLimitTier);
  }

  /**
   * 그래프의 파란 실선: 지금 기억하는 값 + 저장된 값(다시 켜기 전 포함·모든 창) — 모두 서버가 알려 준 실제 값이고,
   * 이 창(LimitWatch 가 정한 같은 창)의 시작부터 받은 마지막 값까지만(chartUpTo — 서버가 붙인 관측 시각이 PC 시계보다 조금
   * 앞서도 빠지지 않게). identity 는 이번 조회로 확인한 지금 계정 — 없으면 지금 기억하는 값만.
   * 점마다 '앞 점에서 여기까지 값을 계속 받았는지'를 붙인다(markGaps) — 받지 못한 긴 구간만 그래프가 흐리게 잇는다.
   */
  private chartSamples(
    windows: LimitWindow[],
    tracked: { samples: Record<string, LimitSample[]>; covers: Record<string, CoverSpan[]> },
    identity: string | null,
  ): Record<string, LimitSample[]> {
    const out: Record<string, LimitSample[]> = {};
    const key = historyAccountKey("claude", identity);
    const now = Date.now();
    const gapMs = this.coverGapMs();
    for (const w of windows) {
      const live = tracked.samples[w.id] ?? [];
      const liveCover = tracked.covers[w.id] ?? [];
      const S = windowStartOf(w);
      if (S === null || !key) {
        out[w.id] = markGaps(live, [liveCover], gapMs);
        continue;
      }
      const upTo = chartUpTo(w, now);
      const stored = this.history?.chartDataFor(key, w, S, upTo) ?? { points: [], cover: [] };
      out[w.id] = chartSeries([stored.points, live], [stored.cover, liveCover], S, upTo, gapMs);
    }
    return out;
  }

  /** 이보다 오래 응답이 없었으면 그래프에서 '값을 받지 못한 구간'(30분과 평소 조회 간격의 3배 중 긴 쪽). */
  private coverGapMs(): number {
    return coverGapFor(this.planBaseMs);
  }

  /** 서버가 보고한 창마다 임계치 알림(적용되지 않는 창은 목록에 없으므로 자연히 제외). */
  private checkAlerts(windows: LimitWindow[]): void {
    const thresholds = (this.cfg().get<number[]>("claudeUsageAlertThresholds", [80, 95]) || [])
      .filter((n) => typeof n === "number" && n > 0)
      .sort((a, b) => a - b);
    if (!thresholds.length) {
      return;
    }
    const T = t();
    const activeAnchors = new Set<string>();
    for (const w of windows) {
      const anchor = w.resetsAtMs ?? "";
      // 임계치를 넘긴 것 중 가장 높은 단계만 알림(중복 최소화).
      const crossed = thresholds.filter((th) => w.usedPercent >= th);
      for (const th of crossed) {
        activeAnchors.add(`${w.id}:${th}:${anchor}`);
      }
      const top = crossed[crossed.length - 1];
      if (top === undefined) {
        continue;
      }
      const key = `${w.id}:${top}:${anchor}`;
      if (!this.alertedKeys.has(key)) {
        this.alertedKeys.add(key);
        const reset = w.resetsAtMs ? new Date(w.resetsAtMs).toLocaleString() : "";
        void vscode.window.showWarningMessage(T.alert(limitLabel(w, T), Math.round(w.usedPercent), top, reset));
      }
    }
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
    if (this.disposed) {
      return;
    }
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
    this.disposed = true;
    if (this.planTimer) clearTimeout(this.planTimer);
    if (this.tokenTimer) clearInterval(this.tokenTimer);
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    if (this.credentialsDebounce) clearTimeout(this.credentialsDebounce);
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
    this.closeCredentialsWatchers();
  }

  /**
   * 자격증명 파일이 바뀌면(Claude Code 의 토큰 갱신·다른 계정 로그인) 곧바로 다시 조회하도록 감시를 건다 — 토큰 만료로
   * 기다리던 값도, 바뀐 계정의 값도 다음 주기를 기다리지 않고 이어진다(확장은 이 파일을 읽기만 한다).
   * 여러 번 불러도 안전하며, 매 조회 때 불러 빠진 감시(설치 실패·폴더 삭제 등)를 다시 건다. 설정 폴더가 아직 없으면
   * (Claude Code 첫 로그인 전) 상위 폴더에서 그 폴더가 생기는 순간을 감지해 감시를 걸고 바로 조회한다.
   */
  private ensureCredentialsWatcher(): void {
    if (this.disposed) {
      return;
    }
    const dir = this.configDir();
    const dirExists = fs.existsSync(dir);
    if (this.credentialsWatchDir === dir) {
      if (this.credentialsWatcher) return;
      if (this.credentialsParentWatcher && !dirExists) return;
    }
    this.closeCredentialsWatchers();
    const onError = (error: Error) => {
      // 감시 대상이 사라지는 등 — 닫아 두면 다음 조회 때 다시 건다.
      this.output.appendLine(`[claude] 자격증명 감시 중단(${dir}): ${error.message}`);
      this.closeCredentialsWatchers();
    };
    // 감시 신호의 이름 글자는 비교하지 않는다(대소문자 규칙은 볼륨·폴더마다 다르다) — 신호가 오면 실제 상태를 확인한다:
    // 폴더 감시는 로그인 파일 상태가 마지막 조회 때와 달라졌는지, 상위 감시는 설정 폴더가 이제 있는지.
    try {
      if (dirExists) {
        const watcher = fs.watch(dir, () => {
          if (credentialsStamp(dir) !== this.lastCredentialsStamp) this.onCredentialsChanged();
        });
        watcher.on("error", onError);
        this.credentialsWatcher = watcher;
        this.credentialsWatchDir = dir;
        // 확인과 감시 등록 사이(또는 감시가 빠져 있던 동안)에 로그인 파일이 바뀌었으면 그 신호는 이미 지나갔다 —
        // 마지막 조회 때 본 상태와 지금을 비교해 다르면 바로 다시 조회한다.
        if (credentialsStamp(dir) !== this.lastCredentialsStamp) this.onCredentialsChanged();
      } else {
        const parent = path.dirname(dir);
        if (!fs.existsSync(parent)) return; // 상위 폴더도 없으면 다음 조회 때 다시 시도
        const watcher = fs.watch(parent, () => {
          if (fs.existsSync(dir)) {
            this.ensureCredentialsWatcher();
            this.onCredentialsChanged();
          }
        });
        watcher.on("error", onError);
        this.credentialsParentWatcher = watcher;
        this.credentialsWatchDir = dir;
        // 확인과 감시 등록 사이에 폴더가 생겼으면 그 생성 신호는 이미 지나갔다 — 지금 다시 확인해 바로 전환·조회한다.
        if (fs.existsSync(dir)) {
          this.ensureCredentialsWatcher();
          this.onCredentialsChanged();
        }
      }
    } catch (error) {
      this.output.appendLine(`[claude] 자격증명 감시 실패(${dir}): ${(error as Error).message}`);
    }
  }

  /**
   * 로그인 파일 변경에 따른 재조회를 약 1초 뒤로 예약한다(연달아 오는 신호는 하나로 묶음). 이미 예약돼 있으면 마감을
   * 미루지 않는다 — 무관한 신호가 계속 와도 처음 예약대로 조회하고, 조회는 그때의 최신 파일을 읽는다.
   */
  private onCredentialsChanged(): void {
    if (this.credentialsDebounce) return;
    this.credentialsDebounce = setTimeout(() => {
      this.credentialsDebounce = undefined;
      void this.refreshPlan();
    }, 1000);
  }

  private closeCredentialsWatchers(): void {
    for (const w of [this.credentialsWatcher, this.credentialsParentWatcher]) {
      try {
        w?.close();
      } catch {
        /* ignore */
      }
    }
    this.credentialsWatcher = undefined;
    this.credentialsParentWatcher = undefined;
    this.credentialsWatchDir = undefined;
  }

  private setupWatcher(): void {
    if (this.disposed) {
      return;
    }
    this.ensureCredentialsWatcher();
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
        const delta = this.parseFileRange(file, cached.parsedBytes, cached.tailLeftover, cached.turnSeq);
        this.fileCaches.set(file, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          entries: cached.entries.concat(delta.entries),
          cwd: delta.cwd || cached.cwd,
          sessionId: cached.sessionId || delta.sessionId,
          parsedBytes: delta.parsedBytes,
          tailLeftover: delta.tailLeftover,
          turnSeq: delta.turnSeq,
        });
      } else {
        // 신규/재작성(크기 축소 등): 전체를 스트리밍으로 파싱(>512MB도 안전).
        const parsed = this.parseFileRange(file, 0, "", 0);
        this.fileCaches.set(file, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          entries: parsed.entries,
          cwd: parsed.cwd,
          sessionId: parsed.sessionId,
          parsedBytes: parsed.parsedBytes,
          tailLeftover: parsed.tailLeftover,
          turnSeq: parsed.turnSeq,
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
    const insightEntries: InsightEntry[] = [];
    // 캐시 효율(최근 7일): 적중률과 '캐시가 없었다면 더 냈을' 순절감 추정.
    let cacheRead7 = 0;
    let cacheWrite7 = 0;
    let freshInput7 = 0;
    let savedUsd7 = 0;

    for (const [filePath, cache] of this.fileCaches.entries()) {
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
          const r = rateFor(e.model);
          cacheRead7 += e.cacheRead;
          cacheWrite7 += e.cacheCreate;
          freshInput7 += e.input;
          // 절감 = 캐시읽기를 일반입력 단가로 냈을 차액 − 캐시쓰기 할증(5m 단가 기준 근사).
          savedUsd7 +=
            (e.cacheRead * (r.input - r.cacheRead) - e.cacheCreate * (r.cacheWrite5m - r.input)) / 1e6;
        }
        byModel.set(e.model, m);
        insightEntries.push({
          ts: e.ts,
          model: e.model,
          totalTokens: tokensOfEntry,
          outputTokens: e.output,
          costUsd: e.cost,
          turnKey: `${filePath}#${e.turn}`,
        });
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

    const denom = cacheRead7 + cacheWrite7 + freshInput7;
    const cacheStats: ClaudeCacheStats = {
      cacheReadTokens: cacheRead7,
      cacheWriteTokens: cacheWrite7,
      freshInputTokens: freshInput7,
      hitRatePercent: denom > 0 ? (cacheRead7 / denom) * 100 : 0,
      savedUsd: savedUsd7,
    };

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
      insights: computeInsights(insightEntries, now),
      cache: cacheStats,
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
    startTurnSeq: number,
  ): {
    entries: UsageEntry[];
    cwd?: string;
    sessionId?: string;
    parsedBytes: number;
    tailLeftover: string;
    turnSeq: number;
  } {
    const entries: UsageEntry[] = [];
    let cwd: string | undefined;
    let sessionId: string | undefined;
    let parsedBytes = startOffset;
    let leftover = initialLeftover;
    let turnSeq = startTurnSeq;

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
      // 턴 경계 = 실제 사용자 입력(도구 결과·메타·서브에이전트 프롬프트 제외).
      // 이후 등장하는 모든 usage(서브에이전트 포함)는 이 턴에 귀속된다.
      if (obj.type === "user" && !obj.isSidechain && !obj.isMeta && obj.toolUseResult == null) {
        const c = obj.message?.content;
        const isRealInput =
          typeof c === "string"
            ? c.trim().length > 0
            : Array.isArray(c) && c.some((p: any) => p && p.type === "text");
        if (isRealInput) {
          turnSeq += 1;
        }
      }
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
        turn: turnSeq,
        sidechain: Boolean(obj.isSidechain),
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

    return { entries, cwd, sessionId, parsedBytes, tailLeftover: leftover, turnSeq };
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
