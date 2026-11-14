import { UsageInsights } from "./insights";
import type { HoldReason, LimitSample, LimitWindow } from "./limits";

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
  /** 창별 '같은 창 안에서 사용률 하락(복원·보정)' 감지 여부 — 그 창이 끝날 때까지 소진 예상 보류. Claude와 동일. */
  holds?: Record<string, boolean>;
  /** 창별 보류 사유(같은 창 사용률 하락 / 기록 상한 초과로 추적 정보 부족). */
  holdReasons?: Record<string, HoldReason>;
  /** 창별 관측 샘플(현재 리셋 기준의 창 구간만) — 대시보드 그래프용. */
  samples?: Record<string, LimitSample[]>;
  /** 마지막 한도 조회가 실패함(이전 관측을 표시 중). */
  serverFailing?: boolean;
  /** 계정 변경 알림 뒤 새 계정 값을 확인하는 중(표시값이 이전 계정 것일 수 있음). */
  accountChecking?: boolean;
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
