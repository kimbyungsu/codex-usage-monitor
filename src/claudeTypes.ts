// Claude Code 사용량 모니터링에 쓰는 타입 정의.
// - 플랜 한도(5시간/주간)는 Anthropic OAuth usage 엔드포인트에서 받는다.
// - 토큰/비용/컨텍스트는 ~/.claude/projects/**/*.jsonl 트랜스크립트에서 집계한다.

import { UsageInsights } from "./insights";

/** 캐시 효율 요약(이 PC · 최근 7일 · 추정). */
export interface ClaudeCacheStats {
  /** 캐시에서 읽은 입력 토큰. */
  cacheReadTokens: number;
  /** 캐시에 새로 쓴 입력 토큰. */
  cacheWriteTokens: number;
  /** 캐시를 안 거친 일반 입력 토큰. */
  freshInputTokens: number;
  /** 캐시 적중률(%) = read / (read + write + fresh). */
  hitRatePercent: number;
  /** 캐시가 없었다면 더 냈을 추정 비용(쓰기 할증 차감한 순절감, 음수 가능). */
  savedUsd: number;
}

/** /api/oauth/usage 의 단일 윈도우 (5시간/주간/모델별). */
export interface UsageWindow {
  /** 0~100 사용률(%). */
  utilization: number;
  /** ISO8601 리셋 시각. */
  resetsAt: string | null;
}

/** 초과 사용(extra usage) 크레딧 정보. */
export interface ExtraUsage {
  isEnabled: boolean;
  utilization?: number | null;
  usedCredits?: number | null;
  monthlyLimit?: number | null;
  currency?: string | null;
  disabledReason?: string | null;
}

/** /api/oauth/usage 응답을 정규화한 형태. */
export interface ClaudePlanUsage {
  fiveHour?: UsageWindow | null;
  sevenDay?: UsageWindow | null;
  sevenDayOpus?: UsageWindow | null;
  sevenDaySonnet?: UsageWindow | null;
  extraUsage?: ExtraUsage | null;
}

/** 토큰 사용량 한 묶음(오늘/최근 5시간/세션/전체). */
export interface TokenBucket {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 모든 종류 합. */
  totalTokens: number;
  /** 모델 단가로 환산한 추정 비용(USD). */
  costUsd: number;
  /** 집계에 포함된 어시스턴트 메시지 수. */
  messages: number;
}

/** 트랜스크립트 파일(=세션/스레드) 단위 사용량 요약. Codex recentThreads와 대칭. */
export interface ClaudeThreadUsage {
  /** 세션 ID(트랜스크립트의 sessionId 또는 파일명). */
  threadId: string;
  /** 표시용 제목(프로젝트 cwd 등). */
  title?: string;
  /** 트랜스크립트 파일 경로. */
  path: string;
  /** 마지막 활동 시각(ms). */
  updatedAt: number;
  /** 이 스레드의 주 모델. */
  model?: string;
  /** 파일 전체 누적. */
  total: TokenBucket;
  /** 최근 7일 분만. */
  lastSevenDays: TokenBucket;
  /** 최근 7일 어시스턴트 메시지 수. */
  events: number;
}

/** JSONL에서 집계한 토큰/비용 묶음들. */
export interface ClaudeTokenUsage {
  total: TokenBucket;
  today: TokenBucket;
  /** 지금 기준 최근 5시간 롤링 윈도우. */
  lastFiveHours: TokenBucket;
  /** 지금 기준 최근 7일 롤링 윈도우. */
  lastSevenDays: TokenBucket;
  /** 가장 최근 세션(최근 수정된 트랜스크립트 파일). */
  session: TokenBucket;
  /** 현재 컨텍스트 점유량 = 마지막 메시지의 input+cacheRead+cacheCreation. */
  contextTokens: number;
  /** 현재 세션의 주 모델. */
  sessionModel?: string;
  /** 최근 스레드 목록(이 PC · 최근 7일). 최근 활동순 상위 8개. */
  recentThreads: ClaudeThreadUsage[];
  /** 모델별 합계. 전체 기간 로스터를 유지하되 최근 7일 값도 함께 제공. */
  byModel: Array<{
    model: string;
    totalTokens: number;
    costUsd: number;
    weekTokens: number;
    weekCostUsd: number;
    weekInputTokens: number;
    weekCacheTokens: number;
    weekOutputTokens: number;
  }>;
  /** 일별/시간별/히트맵/턴 통계 (차트용 압축 시리즈). */
  insights: UsageInsights;
  /** 캐시 효율(최근 7일 · 추정). */
  cache: ClaudeCacheStats;
}

/** 확장이 화면에 그릴 Claude 전체 상태. */
export interface ClaudeState {
  /** ~/.claude 자격증명이 확인되어 동작 가능한 상태인지. */
  available: boolean;
  connecting: boolean;
  /** 구독 종류(max/pro 등). */
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  plan?: ClaudePlanUsage | null;
  tokens?: ClaudeTokenUsage | null;
  lastPlanRefresh?: number;
  lastTokenRefresh?: number;
  /** 최근 사용률 추세로 추정한 한도 소진 예상. */
  projection?: {
    fiveHour?: { reaches: boolean; hoursToFull?: number; etaMs?: number } | null;
    sevenDay?: { reaches: boolean; hoursToFull?: number; etaMs?: number } | null;
  } | null;
  /** 한도 사용률 추세 샘플(최근 2시간) — 대시보드 스파크라인용. */
  samples?: Array<{ ts: number; five?: number; seven?: number }>;
  /** 플랜 한도 API 관련 *실제* 오류(토큰 만료·인증서 등) — 알림 카드로 표시. */
  planError?: string;
  /** 일시적 요청 제한(429) 안내 — 알림이 아니라 차분한 상태 문구로 표시. */
  planRateLimited?: string;
  /** 토큰 집계 관련 오류(트랜스크립트 폴더 없음 등). */
  tokenError?: string;
}

/** .credentials.json 에서 읽은 OAuth 자격증명. */
export interface ClaudeCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
}
