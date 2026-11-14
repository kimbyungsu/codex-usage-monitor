// Anthropic OAuth usage 엔드포인트 클라이언트.
// 공식 Claude Code CLI가 `/usage` 명령에서 호출하는 것과 동일한 엔드포인트를
// 사용자의 로컬 OAuth 토큰(~/.claude/.credentials.json)으로 호출한다.
// 별도 로그인 없이 이미 로그인된 CLI의 자격증명을 그대로 재사용하되, **읽기만 한다**:
// 토큰을 갱신하거나 자격증명 파일을 쓰지 않는다(갱신·저장은 Claude Code 몫). 만료된 동안은 서버를 부르지 않고
// 마지막 값을 유지하며, Claude Code 가 토큰을 바꾸면 그 다음 조회부터 이어서 받는다.

import { createHash } from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import * as tls from "tls";
import { ClaudeCredentials, ClaudePlanUsage } from "./claudeTypes";
import { LimitSpan, LimitWindow, spanFromMeter } from "./limits";

// OS 신뢰 인증서 저장소(사내 백신/프록시 루트 포함)를 Node 기본 번들과 합쳐
// 둔다. 이렇게 하면 TLS 가로채기 환경에서도 인증서 검증을 *끄지 않고* 정상
// 통과시킬 수 있어 사용자가 아무것도 누를 필요가 없다(공개배포 안전성).
// null = 아직 계산 안 함, undefined = 사용할 수 없음(기본 동작에 위임).
let caBundleCache: string[] | undefined | null = null;
function systemCaBundle(): string[] | undefined {
  if (caBundleCache !== null) {
    return caBundleCache;
  }
  try {
    const anyTls = tls as unknown as {
      getCACertificates?: (type: string) => string[];
    };
    if (typeof anyTls.getCACertificates === "function") {
      const def = anyTls.getCACertificates("default") ?? [];
      const sys = anyTls.getCACertificates("system") ?? [];
      const merged = Array.from(new Set([...def, ...sys]));
      caBundleCache = merged.length ? merged : undefined;
    } else {
      // 구버전 Node: VS Code 전역 에이전트의 시스템 인증서 처리에 위임.
      caBundleCache = undefined;
    }
  } catch {
    caBundleCache = undefined;
  }
  return caBundleCache;
}

// Claude Code OAuth 사용량 엔드포인트 (번들 CLI에서 확인된 상수).
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const USER_AGENT = "claude-code-usage-monitor";

export interface ClaudeApiOptions {
  /** 사용자가 지정한 .claude 설정 폴더(미지정 시 CLAUDE_CONFIG_DIR 또는 ~/.claude). */
  configDirOverride?: string;
  log?: (message: string) => void;
}

export function resolveConfigDir(override?: string): string {
  const trimmed = override?.trim();
  if (trimmed) {
    return trimmed;
  }
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (env) {
    return env;
  }
  return path.join(os.homedir(), ".claude");
}

export function credentialsPath(configDir: string): string {
  return path.join(configDir, ".credentials.json");
}

export function projectsDir(configDir: string): string {
  return path.join(configDir, "projects");
}

export function readCredentials(configDir: string): ClaudeCredentials | undefined {
  const file = credentialsPath(configDir);
  if (!fs.existsSync(file)) {
    return undefined;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
        subscriptionType?: string | null;
        rateLimitTier?: string | null;
      };
    };
    const oauth = raw.claudeAiOauth;
    if (!oauth?.accessToken) {
      return undefined;
    }
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      subscriptionType: oauth.subscriptionType ?? null,
      rateLimitTier: oauth.rateLimitTier ?? null,
    };
  } catch {
    return undefined;
  }
}

// 요금제 표시명: Claude Code CLI가 OAuth 프로필(organization.plan_display_name)을 받아
// 전역 설정(.claude.json)의 oauthAccount.planDisplayName 에 캐시한다. 내부 식별자
// (subscriptionType/rateLimitTier)는 요금제가 개명돼도 그대로일 수 있어 표시명은 이것을 쓴다.
export interface ClaudeAccountInfo {
  planDisplayName: string | null;
  /** 실제 계정 식별(계정·조직 uuid). 계정이 바뀐 것을 재연결·토큰 갱신과 구분하는 데 쓴다. */
  identity: string | null;
}
let accountCache: { file: string; mtimeMs: number; size: number; value: ClaudeAccountInfo } | undefined;

/**
 * 두 경로가 디스크의 같은 대상인지 — 이름 글자가 아니라 실제 대상(장치·파일 번호)으로 확인한다. 그래서 대소문자를
 * 구분하지 않는 폴더에서는 대소문자만 다른 경로를 같게, 구분하는 볼륨·폴더(macOS 대소문자 구분 APFS, Windows 폴더별
 * 구분 설정)에서는 다른 폴더를 다르게 본다. 둘 중 하나라도 없거나 번호를 알 수 없으면 같은 대상이라고 확정하지 않는다.
 */
export function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (ra === rb) return true;
  try {
    const sa = fs.statSync(ra, { bigint: true });
    const sb = fs.statSync(rb, { bigint: true });
    return sa.ino !== 0n && sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

function globalConfigCandidates(configDir: string): string[] {
  const out = [path.join(configDir, ".claude.json")];
  // 기본 설정 폴더(~/.claude)면 CLI는 홈의 ~/.claude.json 을 쓴다(대소문자만 다르게 적어도 같은 폴더).
  if (samePath(configDir, path.join(os.homedir(), ".claude"))) {
    out.push(path.join(os.homedir(), ".claude.json"));
  }
  return out;
}

export function readAccountInfo(configDir: string): ClaudeAccountInfo {
  for (const file of globalConfigCandidates(configDir)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (accountCache && accountCache.file === file && accountCache.mtimeMs === stat.mtimeMs && accountCache.size === stat.size) {
      return accountCache.value;
    }
    const value: ClaudeAccountInfo = { planDisplayName: null, identity: null };
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
        oauthAccount?: { planDisplayName?: unknown; accountUuid?: unknown; organizationUuid?: unknown };
      };
      const acct = raw?.oauthAccount;
      const name = acct?.planDisplayName;
      value.planDisplayName = typeof name === "string" && name.trim() ? name.trim() : null;
      const ids = [acct?.accountUuid, acct?.organizationUuid].filter((v) => typeof v === "string" && v);
      value.identity = ids.length ? ids.join("/") : null;
    } catch {
      /* 읽기 실패 = 정보 없음 */
    }
    accountCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, value };
    return value;
  }
  return { planDisplayName: null, identity: null };
}

export function readPlanDisplayName(configDir: string): string | null {
  return readAccountInfo(configDir).planDisplayName;
}

interface HttpResult {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  /** 응답을 다 받은 시각(ms) — 서버 산출 시각이 없을 때의 관측 시각 대용. */
  receivedAt: number;
}

/** 요청 하나가 응답 없이 멈춰도 다음 조회가 막히지 않도록 전체 제한 시간을 둔다. */
const REQUEST_TIMEOUT_MS = 20_000;

function httpRequest(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let settled = false;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
      }
    };
    const timer = setTimeout(() => {
      req.destroy(new Error(`요청 시간 초과(${REQUEST_TIMEOUT_MS / 1000}초)`));
    }, REQUEST_TIMEOUT_MS);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: init.method,
        headers: init.headers,
        // OS 신뢰 인증서를 합쳐 검증을 정상 통과시킨다(가능한 경우).
        // 인증서 검증은 항상 유지한다(OAuth 토큰 보호).
        ca: systemCaBundle(),
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          finish(() => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers, receivedAt: Date.now() })),
        );
        res.on("aborted", () => finish(() => reject(new Error("응답이 중간에 끊겼습니다"))));
        res.on("error", (e) => finish(() => reject(e)));
      },
    );
    req.on("error", (e) => finish(() => reject(e)));
    if (init.body) {
      req.write(init.body);
    }
    req.end();
  });
}

function isCertError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  return (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "CERT_HAS_EXPIRED"
  );
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const ms = Date.parse(value);
  return isFinite(ms) ? ms : null;
}

function meterId(kind: string, scope: string | null): string {
  return scope ? `${kind}:${scope.toLowerCase()}` : kind;
}

/** Claude 미터는 길이를 주지 않으므로 서버 계약의 창 종류로 정한다(session = 롤링 5시간, weekly = 7일). */
function meterWindowMins(span: LimitSpan): number | null {
  if (span === "5h") return 5 * 60;
  if (span === "daily") return 24 * 60;
  if (span === "weekly") return 7 * 24 * 60;
  return null; // 월간 등은 달력 기준일 수 있어 길이를 가정하지 않음
}

/** limits[] 한 행(서버 미터) → 창. 분류는 라벨이 아니라 kind/group 으로(서버 계약). */
function windowFromMeter(row: any): LimitWindow | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const percent = row.percent;
  if (typeof percent !== "number" || !isFinite(percent)) {
    return null;
  }
  const kind = typeof row.kind === "string" && row.kind ? row.kind : null;
  const group = typeof row.group === "string" && row.group ? row.group : null;
  const scopeName = row.scope?.model?.display_name ?? row.scope?.surface?.display_name;
  const scope = typeof scopeName === "string" && scopeName.trim() ? scopeName.trim() : null;
  const span = spanFromMeter(kind, group);
  return {
    id: meterId(kind ?? group ?? "limit", scope),
    span,
    windowMins: meterWindowMins(span),
    kind,
    scope,
    usedPercent: percent,
    resetsAtMs: parseIsoMs(row.resets_at),
    severity: typeof row.severity === "string" && row.severity ? row.severity : null,
    headline: row.is_active === true,
  };
}

// 구버전 고정 필드 → 같은 창의 미터 정체(kind/범위). limits[]를 모르는 서버이거나
// limits[]에 빠진 창만 보충하고, 같은 창이면 limits[] 행을 우선한다.
const LEGACY_FIELDS: Array<{ field: string; kind: string; scope: string | null }> = [
  { field: "five_hour", kind: "session", scope: null },
  { field: "seven_day", kind: "weekly_all", scope: null },
  { field: "seven_day_opus", kind: "weekly_scoped", scope: "Opus" },
  { field: "seven_day_sonnet", kind: "weekly_scoped", scope: "Sonnet" },
];

function normalizeWindows(raw: any): LimitWindow[] {
  const windows: LimitWindow[] = [];
  const seen = new Set<string>();
  // 1) 서버의 구조화된 미터 목록 — 어떤 창이 적용되는지·순서·범위·심각도는 서버가 정한다.
  if (Array.isArray(raw?.limits)) {
    for (const row of raw.limits) {
      const w = windowFromMeter(row);
      if (w && !seen.has(w.id)) {
        seen.add(w.id);
        windows.push(w);
      }
    }
  }
  // 2) 구버전 고정 필드(값이 null 이면 그 창은 이 계정에 현재 미적용).
  for (const { field, kind, scope } of LEGACY_FIELDS) {
    const obj = raw?.[field];
    const id = meterId(kind, scope);
    if (seen.has(id) || !obj || typeof obj.utilization !== "number") {
      continue;
    }
    seen.add(id);
    const span = spanFromMeter(kind, null);
    const w: LimitWindow = {
      id,
      span,
      windowMins: meterWindowMins(span),
      kind,
      scope,
      usedPercent: obj.utilization,
      resetsAtMs: parseIsoMs(obj.resets_at),
    };
    // 계정 전체 5시간 창은 맨 앞(서버 목록에 없을 때도 기존 표시 순서 유지).
    if (kind === "session" && !scope) {
      windows.unshift(w);
    } else {
      windows.push(w);
    }
  }
  return windows;
}

const META_TOLERANCE_MS = 2 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * 주간 전체 창(weekly_all)에만 서버의 창 시작·산출 시각(seven_day_breakdown)을 붙인다 — 모델 전용 창에는 복사하지 않는다.
 * 필드가 없으면 그대로(리셋 − 7일로 계산), 있는데 서로 맞지 않으면 metaConflict(예상 확인 대기)로 둔다.
 */
function attachWeeklyBreakdown(windows: LimitWindow[], raw: any, receivedAt: number): void {
  const bd = raw?.seven_day_breakdown;
  const w = windows.find((x) => x.id === "weekly_all");
  if (!w || !bd || typeof bd !== "object") return;
  const hasS = bd.window_started_at != null;
  const hasO = bd.as_of != null;
  if (!hasS && !hasO) return; // 필드 없음 → 리셋 − 7일로 계산
  // 필드는 있는데 해석이 안 되거나 서로 맞지 않으면 '정보 없음'이 아니라 충돌로 본다.
  const S = parseIsoMs(bd.window_started_at);
  const O = parseIsoMs(bd.as_of);
  const R = Number(w.resetsAtMs);
  const len = Number(w.windowMins);
  const consistent =
    S != null &&
    O != null &&
    isFinite(R) &&
    isFinite(len) &&
    Math.abs(S - (R - len * 60_000)) <= META_TOLERANCE_MS &&
    S < O &&
    O < R &&
    O <= receivedAt + CLOCK_SKEW_MS;
  if (!consistent) {
    w.metaConflict = true;
    return;
  }
  w.windowStartMs = S;
  w.observedAtMs = O;
  w.observedSource = "server";
}

export function normalizeUsage(raw: any, receivedAt: number = Date.now()): ClaudePlanUsage {
  const extra = raw?.extra_usage ?? {};
  const windows = normalizeWindows(raw).map((w) => ({ ...w, observedAtMs: receivedAt, observedSource: "received" as const }));
  attachWeeklyBreakdown(windows, raw, receivedAt);
  return {
    windows,
    extraUsage: {
      isEnabled: Boolean(extra.is_enabled),
      utilization: extra.utilization ?? null,
      usedCredits: extra.used_credits ?? null,
      monthlyLimit: extra.monthly_limit ?? null,
      currency: extra.currency ?? null,
      disabledReason: extra.disabled_reason ?? null,
    },
  };
}

/** 지금 파일의 토큰이 이 조회에 쓴 것과 같은지(같은 자격증명으로 끝까지 조회했는지). */
function sameCredentials(configDir: string, used: ClaudeCredentials): boolean {
  const now = readCredentials(configDir);
  return Boolean(now && now.accessToken === used.accessToken && now.refreshToken === used.refreshToken);
}

async function fetchUsageOnce(token: string): Promise<HttpResult> {
  return httpRequest(USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
}

export interface PlanFetchResult {
  usage?: ClaudePlanUsage;
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  error?: string;
  /** 429 등으로 잠시 호출을 멈춰야 하는 경우의 대기 시간(ms). */
  retryAfterMs?: number;
  rateLimited?: boolean;
  /** 조회 도중 자격증명 파일이 바뀜 → 값·오류·대기 모두 버리고 새 문맥으로 다시 조회해야 함. */
  credentialsChanged?: boolean;
  /**
   * 토큰이 만료됐거나 서버가 받아 주지 않음(401) — 확장은 갱신하지 않으므로 오류가 아니라 '기다림' 상태다.
   * Claude Code 가 토큰을 바꾸면 다음 조회부터 이어서 받는다.
   */
  tokenExpired?: boolean;
  /**
   * 이 조회에 쓴 로그인(토큰)의 알아볼 수 없는 지문(`loginKeyOf`) — 계정 정보를 읽지 못할 때 '같은 로그인 구간'인지
   * 가르는 데만 쓴다. 토큰이 바뀌면(갱신·다른 로그인) 달라진다. 자격증명이 없으면 null/없음.
   */
  loginKey?: string | null;
}

/**
 * 로그인(액세스 토큰)의 알아볼 수 없는 지문. 토큰 원문은 어디에도 남기지 않고(해시 앞 32자만) 메모리에서 비교에만 쓴다.
 * 같은 지문 = 같은 토큰 = 같은 로그인. 다른 지문은 토큰 갱신이거나 다른 로그인(어느 쪽인지는 모름).
 */
export function loginKeyOf(creds: ClaudeCredentials | undefined): string | null {
  const token = creds?.accessToken;
  if (!token) return null;
  return createHash("sha256").update("claude-login\u0000").update(token).digest("hex").slice(0, 32);
}

/** 지금 설정 폴더 자격증명의 로그인 지문(읽기만 함 — 없으면 null). */
export function readLoginKey(configDir: string): string | null {
  return loginKeyOf(readCredentials(configDir));
}

/** 비정상적으로 큰 값(무한대 등)만 막는 안전 상한 — 정상적인 서버 대기를 줄이지 않을 만큼 크게(1년). */
const MAX_RETRY_AFTER_MS = 365 * 24 * 60 * 60_000;

/**
 * 서버가 정한 재시도 대기(Retry-After: 초 또는 HTTP 날짜)를 줄이지 않고 그대로 돌려준다.
 * 클라이언트의 조회 간격 상한(적응형 폴링)과는 별개 — 서버 대기는 그보다 길어도 지킨다.
 */
export function parseRetryAfterMs(
  headers: Record<string, string | string[] | undefined>,
  now: number = Date.now(),
): number {
  const raw = headers["retry-after"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (value) {
    const seconds = Number(value);
    if (isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
    const at = Date.parse(value);
    if (isFinite(at)) {
      return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS);
    }
  }
  return 60_000; // 헤더 없거나 해석 불가면 기본 60초
}

/**
 * 플랜 한도(서버가 보고하는 창 전부)를 가져온다. 자격증명은 읽기만 한다 — 만료된 토큰이면 서버를 부르지 않고
 * tokenExpired 로 돌려준다(갱신은 Claude Code 가 한다).
 */
export async function fetchPlanUsage(options: ClaudeApiOptions): Promise<PlanFetchResult> {
  const configDir = resolveConfigDir(options.configDirOverride);
  const creds = readCredentials(configDir);
  if (!creds) {
    return { error: `Claude 자격증명을 찾을 수 없습니다 (${credentialsPath(configDir)}).` };
  }
  const loginKey = loginKeyOf(creds);
  if (creds.expiresAt && creds.expiresAt <= Date.now()) {
    return { tokenExpired: true, subscriptionType: creds.subscriptionType, rateLimitTier: creds.rateLimitTier, loginKey };
  }
  const out = await fetchUsageWith(creds);
  // 조회에 쓴 자격증명이 끝까지 그대로인지 확인 — 그사이 계정이 바뀌었다 돌아와도(A→B→A) 다른 계정 값이 섞이지 않게.
  if (!sameCredentials(configDir, creds)) {
    options.log?.("Claude credentials changed during the request — discarding the result.");
    // 값은 버리되, 서버가 요구한 재시도 대기는 보존한다(같은 계정 토큰 회전과 429 가 겹쳐도 대기를 지키도록).
    return out.rateLimited
      ? { credentialsChanged: true, rateLimited: true, retryAfterMs: out.retryAfterMs }
      : { credentialsChanged: true };
  }
  return { ...out, loginKey };
}

async function fetchUsageWith(creds: ClaudeCredentials): Promise<PlanFetchResult> {
  try {
    const result = await fetchUsageOnce(creds.accessToken);
    if (result.status === 401) {
      // 만료 시각 전이라도 서버가 받지 않는 토큰 — 갱신하지 않고 Claude Code 가 바꿀 때까지 기다린다.
      return { tokenExpired: true, subscriptionType: creds.subscriptionType, rateLimitTier: creds.rateLimitTier };
    }
    if (result.status === 429) {
      // 사용자 표시 문구는 claudeService 가 적응 간격에 맞춰 만든다. 여기선 플래그만.
      return {
        subscriptionType: creds.subscriptionType,
        rateLimitTier: creds.rateLimitTier,
        retryAfterMs: parseRetryAfterMs(result.headers),
        rateLimited: true,
      };
    }
    if (result.status !== 200) {
      return {
        subscriptionType: creds.subscriptionType,
        rateLimitTier: creds.rateLimitTier,
        error: `usage 엔드포인트 오류: HTTP ${result.status}`,
      };
    }

    return {
      usage: normalizeUsage(JSON.parse(result.body), result.receivedAt),
      subscriptionType: creds.subscriptionType,
      rateLimitTier: creds.rateLimitTier,
    };
  } catch (error) {
    if (isCertError(error)) {
      return {
        subscriptionType: creds.subscriptionType,
        rateLimitTier: creds.rateLimitTier,
        error:
          "인증서 검증에 실패했습니다(사내 백신/프록시 가능성). VS Code의 시스템 인증서/프록시 설정(http.systemCertificates, http.proxy)을 확인하세요.",
      };
    }
    return {
      subscriptionType: creds.subscriptionType,
      rateLimitTier: creds.rateLimitTier,
      error: (error as Error).message,
    };
  }
}
