import { UsageInsights } from "./insights";
import type { LimitProjection, LimitSample, LimitWindow } from "./limits";

export interface CodexAccount {
  type: string;
  email?: string;
  /** 서버의 내부 요금제 식별자(예: plus, prolite). 표시는 codexPlanLabel 로. */
  planType?: string;
}

export interface RateLimitWindow {
  usedPercent: number;
  resetsAt?: number | null;
  windowDurationMins?: number | null;
}

export interface CreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string | null;
}

export interface SpendControlLimitSnapshot {
  limit: string;
  remainingPercent: number;
  resetsAt: number;
  used: string;
}

export interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: CreditsSnapshot | null;
  individualLimit?: SpendControlLimitSnapshot | null;
  spendControlReached?: boolean | null;
  rateLimitReachedType?: string | null;
}

export interface TokenUsageBreakdown {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ThreadTokenUsage {
  last: TokenUsageBreakdown;
  total: TokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface TokenUsageNotification {
  threadId: string;
  turnId: string;
  tokenUsage: ThreadTokenUsage;
}

export interface CodexTokenBucket extends TokenUsageBreakdown {
  events: number;
  costUsd: number;
  unpricedTokens: number;
}

export interface CodexModelUsage {
  model: string;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  events: number;
  costUsd: number;
  unpricedTokens: number;
}

export interface CodexThreadUsage {
  threadId: string;
  title?: string;
  path: string;
  updatedAt: number;
  model?: string;
  total: TokenUsageBreakdown;
  lastSevenDays: CodexTokenBucket;
  events: number;
}

export interface CodexHistoryUsage {
  total: CodexTokenBucket;
  today: CodexTokenBucket;
  lastFiveHours: CodexTokenBucket;
  lastSevenDays: CodexTokenBucket;
  session: CodexTokenBucket;
  contextTokens: number;
  modelContextWindow?: number | null;
  sessionModel?: string;
  byModel: CodexModelUsage[];
  recentThreads: CodexThreadUsage[];
  /** 일별/시간별/히트맵/턴 통계 (차트용 압축 시리즈). */
  insights?: UsageInsights;
  filesScanned: number;
  lastScannedAt: number;
  error?: string;
}

export interface UsageState {
  connected: boolean;
  connecting: boolean;
  account?: CodexAccount | null;
  requiresOpenaiAuth?: boolean;
  rateLimits?: RateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
  /** 요금제 표시명(공식 Codex TUI 표기, 미지의 값은 원문). */
  planLabel?: string | null;
  /**
   * 서버가 보고한 한도 창(창 길이로 분류, 짧은 창 → 긴 창 · 기본 버킷 → 모델 전용 버킷).
   * primary/secondary 위치는 플랜에 따라 의미가 바뀌므로(5시간 창이 없으면 주간 창이 primary) 표시는 이것만 쓴다.
   */
  limits?: LimitWindow[];
  /** 최근 사용률 추세로 추정한 한도 소진 예상(창 id별, 창 리셋 전 도달 시에만 reaches=true). Claude 방식과 동일. */
  projection?: Record<string, LimitProjection | null> | null;
  /** 한도 사용률 추세 샘플(창 id별 최근 2시간) — 대시보드 스파크라인용. */
  samples?: Record<string, LimitSample[]>;
  tokenUsage?: TokenUsageNotification | null;
  history?: CodexHistoryUsage | null;
  lastRefresh?: number;
  lastHistoryScanAt?: number;
  lastHistoryScanOkAt?: number;
  historyError?: string;
  serverRetrySeconds?: number;
  extraUsageOutput?: string;
  extraUsageError?: string;
  error?: string;
}

export interface RateLimitsReadResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
}

export interface AccountReadResponse {
  account?: CodexAccount | null;
  requiresOpenaiAuth: boolean;
}
