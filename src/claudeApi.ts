// Anthropic OAuth usage 엔드포인트 클라이언트.
// 공식 Claude Code CLI가 `/usage` 명령에서 호출하는 것과 동일한 엔드포인트를
// 사용자의 로컬 OAuth 토큰(~/.claude/.credentials.json)으로 호출한다.
// 별도 로그인 없이 이미 로그인된 CLI의 자격증명을 그대로 재사용한다.

import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import * as tls from "tls";
import { ClaudeCredentials, ClaudePlanUsage } from "./claudeTypes";
import { LimitWindow, spanFromMeter } from "./limits";

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

// Claude Code OAuth 공개 클라이언트 ID / 엔드포인트 (번들 CLI에서 확인된 상수).
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
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
let planNameCache: { file: string; mtimeMs: number; size: number; value: string | null } | undefined;

function globalConfigCandidates(configDir: string): string[] {
  const out = [path.join(configDir, ".claude.json")];
  // 기본 설정 폴더(~/.claude)면 CLI는 홈의 ~/.claude.json 을 쓴다.
  if (path.resolve(configDir) === path.resolve(os.homedir(), ".claude")) {
    out.push(path.join(os.homedir(), ".claude.json"));
  }
  return out;
}

export function readPlanDisplayName(configDir: string): string | null {
  for (const file of globalConfigCandidates(configDir)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (planNameCache && planNameCache.file === file && planNameCache.mtimeMs === stat.mtimeMs && planNameCache.size === stat.size) {
      return planNameCache.value;
    }
    let value: string | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { oauthAccount?: { planDisplayName?: unknown } };
      const name = raw?.oauthAccount?.planDisplayName;
      value = typeof name === "string" && name.trim() ? name.trim() : null;
    } catch {
      value = null;
    }
    planNameCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, value };
    return value;
  }
  return null;
}

interface HttpResult {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function httpRequest(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
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
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      },
    );
    req.on("error", reject);
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
  return {
    id: meterId(kind ?? group ?? "limit", scope),
    span: spanFromMeter(kind, group),
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
    const w: LimitWindow = {
      id,
      span: spanFromMeter(kind, null),
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

export function normalizeUsage(raw: any): ClaudePlanUsage {
  const extra = raw?.extra_usage ?? {};
  return {
    windows: normalizeWindows(raw),
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

/** 만료된 access token 을 refresh token 으로 갱신하고 자격증명 파일에 기록한다. */
async function refreshToken(
  configDir: string,
  creds: ClaudeCredentials,
  log?: (m: string) => void,
): Promise<ClaudeCredentials | undefined> {
  if (!creds.refreshToken) {
    return undefined;
  }
  const result = await httpRequest(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (result.status !== 200) {
    log?.(`Claude token refresh failed: HTTP ${result.status}`);
    return undefined;
  }
  const parsed = JSON.parse(result.body) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!parsed.access_token) {
    return undefined;
  }
  const updated: ClaudeCredentials = {
    ...creds,
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? creds.refreshToken,
    expiresAt: parsed.expires_in ? Date.now() + parsed.expires_in * 1000 : creds.expiresAt,
  };
  // 기존 파일의 다른 필드를 보존하면서 토큰만 갱신해 다시 쓴다.
  try {
    const file = credentialsPath(configDir);
    const existing = JSON.parse(fs.readFileSync(file, "utf8")) as any;
    existing.claudeAiOauth = {
      ...existing.claudeAiOauth,
      accessToken: updated.accessToken,
      refreshToken: updated.refreshToken,
      expiresAt: updated.expiresAt,
    };
    fs.writeFileSync(file, JSON.stringify(existing, null, 2), "utf8");
    log?.("Claude OAuth token refreshed.");
  } catch (error) {
    log?.(`Could not persist refreshed token: ${(error as Error).message}`);
  }
  return updated;
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
}

function parseRetryAfterMs(headers: Record<string, string | string[] | undefined>): number {
  const raw = headers["retry-after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const seconds = Number(value);
  if (isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 10 * 60 * 1000); // 최대 10분
  }
  return 60_000; // 헤더 없으면 기본 60초
}

/** 플랜 한도(서버가 보고하는 창 전부)를 가져온다. 필요 시 토큰을 갱신한다. */
export async function fetchPlanUsage(options: ClaudeApiOptions): Promise<PlanFetchResult> {
  const configDir = resolveConfigDir(options.configDirOverride);
  let creds = readCredentials(configDir);
  if (!creds) {
    return { error: `Claude 자격증명을 찾을 수 없습니다 (${credentialsPath(configDir)}).` };
  }

  // 만료가 임박(60초 이내)하면 미리 갱신 시도.
  if (creds.expiresAt && creds.expiresAt - Date.now() < 60_000 && creds.refreshToken) {
    const refreshed = await refreshToken(configDir, creds, options.log).catch(() => undefined);
    if (refreshed) {
      creds = refreshed;
    }
  }

  try {
    let result = await fetchUsageOnce(creds.accessToken);

    if (result.status === 401 && creds.refreshToken) {
      const refreshed = await refreshToken(configDir, creds, options.log);
      if (refreshed) {
        creds = refreshed;
        result = await fetchUsageOnce(creds.accessToken);
      }
    }

    if (result.status === 401) {
      return {
        subscriptionType: creds.subscriptionType,
        rateLimitTier: creds.rateLimitTier,
        error: "토큰이 만료되었습니다. Claude Code에 한 번 접속하면 자동 갱신됩니다.",
      };
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
      usage: normalizeUsage(JSON.parse(result.body)),
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
