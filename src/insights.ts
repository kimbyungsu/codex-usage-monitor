// 사용량 인사이트 공용 집계 (Claude/Codex 양쪽에서 사용).
// 입력은 "이벤트 1건 = API 호출 1건" 수준의 평탄화된 항목이고,
// 출력은 웹뷰가 바로 그릴 수 있는 압축 시리즈(일별/시간별/히트맵/턴 통계)다.
// 원시 이벤트를 웹뷰로 그대로 보내지 않고 여기서 버킷으로 줄여 postMessage 부하를 막는다.

/** 집계 입력 1건. turnKey 가 없으면 턴 통계에서 제외된다(시리즈에는 포함). */
export interface InsightEntry {
  ts: number;
  model: string;
  totalTokens: number;
  /** 출력 토큰(Codex 는 출력+추론 합산). */
  outputTokens: number;
  /** 비용 추정(USD). Codex 는 비용 미표시 정책이라 undefined. */
  costUsd?: number;
  /** 같은 턴(사용자 입력→최종 응답)에 속한 이벤트를 묶는 키 (예: "파일경로#3"). */
  turnKey?: string;
}

/** 일별 시리즈 한 점(로컬 자정 기준). */
export interface DailyUsagePoint {
  dayStartMs: number;
  totalTokens: number;
  costUsd: number;
  /** 모델별 토큰(스택 차트용). */
  byModel: Record<string, number>;
}

/** 시간별(최근 24시간, 정시 정렬) 시리즈 한 점. */
export interface HourlyUsagePoint {
  hourStartMs: number;
  totalTokens: number;
}

/** 모델별 턴당 통계(최근 7일). 턴 귀속 모델 = 그 턴에서 토큰을 가장 많이 쓴 모델. */
export interface ModelTurnStats {
  model: string;
  /** 턴 수. */
  turns: number;
  /** API 호출 수(메시지 수). */
  calls: number;
  avgTokensPerTurn: number;
  medianTokensPerTurn: number;
  p90TokensPerTurn: number;
  avgOutputPerTurn: number;
  /** Claude 만(비용 추정치 보유 시). */
  avgCostPerTurn?: number;
}

export interface UsageInsights {
  /** 최근 DAILY_DAYS 일(오늘 포함, 빈 날도 0으로 채움). */
  daily: DailyUsagePoint[];
  /** 최근 24시간(빈 시간도 0으로 채움). */
  hourly: HourlyUsagePoint[];
  /** [요일(월=0)..일=6][시각 0..23] 토큰 합. 최근 HEATMAP_DAYS 일. */
  heatmap: number[][];
  heatmapDays: number;
  /** 최근 7일 턴 통계. turnKey 없는 이벤트는 제외. */
  modelTurns: ModelTurnStats[];
}

export const DAILY_DAYS = 14;
export const HEATMAP_DAYS = 28;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** 정렬된 배열의 p(0~1) 분위값(nearest-rank). */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

interface TurnAgg {
  byModel: Map<string, number>;
  total: number;
  output: number;
  cost: number;
  hasCost: boolean;
  calls: number;
}

export function computeInsights(entries: Iterable<InsightEntry>, now = Date.now()): UsageInsights {
  // 로컬 자정 기준 일 경계. (한국 등 비-DST 시간대 기준 정확, DST 지역도 표시용으론 충분)
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const dailyStartMs = todayStart.getTime() - (DAILY_DAYS - 1) * DAY_MS;
  const heatmapStartMs = now - HEATMAP_DAYS * DAY_MS;
  // 현재 '로컬' 정시. UTC 정수 오프셋이 아닌 시간대(+5:30 등)에서도 시계 정시에 맞춘다.
  const hourAnchor = new Date(now);
  hourAnchor.setMinutes(0, 0, 0);
  const hourEndStartMs = hourAnchor.getTime();
  const hourlyStartMs = hourEndStartMs - 23 * HOUR_MS;
  const sevenDaysAgo = now - 7 * DAY_MS;

  const daily: DailyUsagePoint[] = Array.from({ length: DAILY_DAYS }, (_, i) => ({
    dayStartMs: dailyStartMs + i * DAY_MS,
    totalTokens: 0,
    costUsd: 0,
    byModel: {},
  }));
  const hourly: HourlyUsagePoint[] = Array.from({ length: 24 }, (_, i) => ({
    hourStartMs: hourlyStartMs + i * HOUR_MS,
    totalTokens: 0,
  }));
  const heatmap: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const turns = new Map<string, TurnAgg>();

  for (const e of entries) {
    if (!isFinite(e.ts) || e.ts <= 0 || e.ts > now + HOUR_MS) {
      continue; // 타임스탬프 불명/미래 값은 시리즈에서 제외
    }
    if (e.ts >= dailyStartMs) {
      const idx = Math.floor((e.ts - dailyStartMs) / DAY_MS);
      if (idx >= 0 && idx < DAILY_DAYS) {
        const d = daily[idx];
        d.totalTokens += e.totalTokens;
        d.costUsd += e.costUsd ?? 0;
        d.byModel[e.model] = (d.byModel[e.model] ?? 0) + e.totalTokens;
      }
    }
    if (e.ts >= hourlyStartMs) {
      const idx = Math.floor((e.ts - hourlyStartMs) / HOUR_MS);
      if (idx >= 0 && idx < 24) {
        hourly[idx].totalTokens += e.totalTokens;
      }
    }
    if (e.ts >= heatmapStartMs) {
      const d = new Date(e.ts);
      heatmap[(d.getDay() + 6) % 7][d.getHours()] += e.totalTokens;
    }
    if (e.turnKey && e.ts >= sevenDaysAgo) {
      const turn = turns.get(e.turnKey) ?? {
        byModel: new Map<string, number>(),
        total: 0,
        output: 0,
        cost: 0,
        hasCost: false,
        calls: 0,
      };
      turn.byModel.set(e.model, (turn.byModel.get(e.model) ?? 0) + e.totalTokens);
      turn.total += e.totalTokens;
      turn.output += e.outputTokens;
      if (typeof e.costUsd === "number") {
        turn.cost += e.costUsd;
        turn.hasCost = true;
      }
      turn.calls += 1;
      turns.set(e.turnKey, turn);
    }
  }

  // 턴 → 지배 모델 귀속 후 모델별 분포 집계.
  const perModel = new Map<
    string,
    { totals: number[]; output: number; cost: number; hasCost: boolean; calls: number }
  >();
  for (const turn of turns.values()) {
    if (turn.total <= 0) {
      continue;
    }
    let dominant = "unknown";
    let best = -1;
    for (const [model, tokens] of turn.byModel) {
      if (tokens > best) {
        best = tokens;
        dominant = model;
      }
    }
    const m = perModel.get(dominant) ?? { totals: [], output: 0, cost: 0, hasCost: false, calls: 0 };
    m.totals.push(turn.total);
    m.output += turn.output;
    m.cost += turn.cost;
    m.hasCost = m.hasCost || turn.hasCost;
    m.calls += turn.calls;
    perModel.set(dominant, m);
  }

  const modelTurns: ModelTurnStats[] = [...perModel.entries()]
    .map(([model, m]) => {
      const sorted = [...m.totals].sort((a, b) => a - b);
      const sum = sorted.reduce((acc, v) => acc + v, 0);
      const n = sorted.length;
      return {
        model,
        turns: n,
        calls: m.calls,
        avgTokensPerTurn: Math.round(sum / n),
        medianTokensPerTurn: Math.round(percentile(sorted, 0.5)),
        p90TokensPerTurn: Math.round(percentile(sorted, 0.9)),
        avgOutputPerTurn: Math.round(m.output / n),
        avgCostPerTurn: m.hasCost ? m.cost / n : undefined,
      };
    })
    .sort((a, b) => b.turns - a.turns);

  return { daily, hourly, heatmap, heatmapDays: HEATMAP_DAYS, modelTurns };
}
