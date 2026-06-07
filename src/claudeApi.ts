// Anthropic OAuth usage 엔드포인트 클라이언트.
// 공식 Claude Code CLI가 `/usage` 명령에서 호출하는 것과 동일한 엔드포인트를
// 사용자의 로컬 OAuth 토큰(~/.claude/.credentials.json)으로 호출한다.
// 별도 로그인 없이 이미 로그인된 CLI의 자격증명을 그대로 재사용한다.

import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import * as tls from "tls";
import { ClaudeCredentials, ClaudePlanUsage, UsageWindow } from "./claudeTypes";

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

function normalizeWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as { utilization?: number; resets_at?: string | null };
  if (typeof obj.utilization !== "number") {
    return null;
  }
  return { utilization: obj.utilization, resetsAt: obj.resets_at ?? null };
}

function normalizeUsage(raw: any): ClaudePlanUsage {
  const extra = raw?.extra_usage ?? {};
  return {
    fiveHour: normalizeWindow(raw?.five_hour),
    sevenDay: normalizeWindow(raw?.seven_day),
    sevenDayOpus: normalizeWindow(raw?.seven_day_opus),
    sevenDaySonnet: normalizeWindow(raw?.seven_day_sonnet),
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

/** 플랜 한도(5시간/주간)를 가져온다. 필요 시 토큰을 갱신한다. */
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
