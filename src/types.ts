export interface CodexAccount {
  type: string;
  email?: string;
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
  /** 최근 사용률 추세로 추정한 한도 소진 예상(창 리셋 전 도달 시에만 reaches=true). Claude 방식과 동일. */
  projection?: {
    primary?: { reaches: boolean; hoursToFull?: number; etaMs?: number } | null;
    secondary?: { reaches: boolean; hoursToFull?: number; etaMs?: number } | null;
  } | null;
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
