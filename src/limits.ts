// 한도 창(limit window) 공통 모델 — Claude·Codex 공용.
// 어떤 창이 적용되는지는 서버가 정한다. 5시간 창은 플랜·시기에 따라 사라졌다가 다시 생기고
// (예: 2026-07 Codex Plus/Pro 일시 폐지·일부 부활, 2026-10 Claude Ultra 폐지), 모델 전용 창도
// 늘거나 준다. 그래서 위치(primary/secondary)나 고정 필드(5h/7d)로 의미를 가정하지 않고,
// 서버가 보고한 창들을 그 길이·종류로 분류해 있는 만큼만 그린다.
// 리셋 기준(리셋 시각·창 시작)도 고정값이 아니다 — Codex는 몇 초씩 흔들리고, 예정보다 일찍 창이 통째로
// 새로 시작되며, 두 기준이 번갈아 오기도 한다(Claude도 같을 수 있음). 그래서 소진 예상은 기억해 둔 기준 없이
// 매 관측의 최신 리셋 시각에서 창 시작을 다시 구해 계산하고, 기억은 '같은 창 안 복원 감지'와 그래프에만 쓴다.
// (vscode 의존 없음 — 플레인 Node 스크립트에서도 로드 가능)

import type { RateLimitSnapshot, RateLimitWindow } from "./types";

/** 창의 길이 분류. 라벨·로컬 토큰 구간 매칭·상태바 약어의 기준. */
export type LimitSpan = "5h" | "daily" | "weekly" | "monthly" | "annual" | "other";

export interface LimitWindow {
  /** 추세 샘플·소진 예상·알림의 안정 키. 위치가 아니라 창의 정체(종류/길이/범위)로 만든다. */
  id: string;
  span: LimitSpan;
  /** 창 길이(분). Codex는 서버가 주고, Claude 미터는 주지 않는다. */
  windowMins?: number | null;
  /** 모델/표면 전용 창의 서버 표시명(예: 특정 모델 전용 주간 한도). 계정 전체 창이면 없음. */
  scope?: string | null;
  /** 서버 미터 종류(Claude limits[].kind). 미지의 종류 라벨 대체용. */
  kind?: string | null;
  /** 사용률 0~100(%). */
  usedPercent: number;
  /** 리셋 시각(ms). */
  resetsAtMs?: number | null;
  /** 서버가 매긴 심각도(normal/warning/critical). 있으면 클라이언트가 임계치로 재판정하지 않는다. */
  severity?: string | null;
  /** 서버가 고른 대표 창(단일 값 표시기가 보여줄 창). */
  headline?: boolean;
  /** 이 값을 관측한 시각(ms). 예상은 화면 시각이 아니라 이 시각 기준으로 계산한다. */
  observedAtMs?: number | null;
  /** 관측 시각 출처: 서버가 준 산출 시각 / 응답을 받은 시각. */
  observedSource?: "server" | "received" | null;
  /** 서버가 직접 준 창 시작(ms). 없으면 리셋 시각 − 창 길이로 구한다. */
  windowStartMs?: number | null;
  /** 서버가 준 창 정보(시작·관측 시각)가 서로 맞지 않음 → 예상 확인 대기. */
  metaConflict?: boolean;
  /** 이 관측이 '오래된 값'이 되는 시각 — 관측을 받아들일 때 창마다 고정(같은 관측을 다시 받아도 늘리지 않음). */
  staleAtMs?: number | null;
  /** 표시 라벨(대시보드로 보낼 때 채움). */
  label?: string;
}

const SPAN_MINUTES: Array<[Exclude<LimitSpan, "other">, number]> = [
  ["5h", 5 * 60],
  ["daily", 24 * 60],
  ["weekly", 7 * 24 * 60],
  ["monthly", 30 * 24 * 60],
  ["annual", 365 * 24 * 60],
];

/** 창 길이(분) → 분류. 공식 Codex TUI와 같은 ±5% 근사 규칙. */
export function spanFromMinutes(mins: number | null | undefined): LimitSpan {
  const m = Number(mins);
  if (!isFinite(m) || m <= 0) {
    return "other";
  }
  for (const [span, expected] of SPAN_MINUTES) {
    if (m >= expected * 0.95 && m <= expected * 1.05) {
      return span;
    }
  }
  return "other";
}

/**
 * Claude 미터(kind/group) → 분류. 서버 계약상 group 은 'session'·'weekly' 등이며,
 * Claude의 session 미터가 곧 롤링 5시간 창(구 필드 five_hour)이다. 미지의 값은 'other'.
 */
export function spanFromMeter(kind: string | null | undefined, group: string | null | undefined): LimitSpan {
  for (const raw of [group, kind]) {
    const v = (raw ?? "").toLowerCase();
    if (v.startsWith("session")) return "5h";
    if (v.startsWith("daily")) return "daily";
    if (v.startsWith("weekly")) return "weekly";
    if (v.startsWith("monthly")) return "monthly";
  }
  return "other";
}

// ---------- Codex: rate limit 스냅샷 → 창 목록 ----------

/** 같은 버킷 안에서 창의 정체 키: 길이 분류가 되면 그것, 아니면 분 단위 길이, 그것도 없으면 위치. */
function codexWindowKey(win: RateLimitWindow, position: number): string {
  const span = spanFromMinutes(win.windowDurationMins);
  if (span !== "other") return span;
  const mins = Number(win.windowDurationMins);
  if (isFinite(mins) && mins > 0) return `${mins}m`;
  return position === 0 ? "primary" : "secondary";
}

function windowsOfSnapshot(
  snap: RateLimitSnapshot,
  bucketId: string,
  scope: string | null,
  observedAtMs: number | null,
): LimitWindow[] {
  const out: LimitWindow[] = [];
  [snap.primary, snap.secondary].forEach((win, position) => {
    if (!win || typeof win.usedPercent !== "number") return;
    out.push({
      id: `${bucketId}:${codexWindowKey(win, position)}`,
      span: spanFromMinutes(win.windowDurationMins),
      windowMins: win.windowDurationMins ?? null,
      scope,
      usedPercent: win.usedPercent,
      resetsAtMs: typeof win.resetsAt === "number" && win.resetsAt > 0 ? win.resetsAt * 1000 : null,
      observedAtMs,
      observedSource: observedAtMs ? "received" : null,
    });
  });
  // 짧은 창 → 긴 창 순(서버 위치와 무관). 길이 미상은 뒤로.
  return out.sort((a, b) => (Number(a.windowMins) || Infinity) - (Number(b.windowMins) || Infinity));
}

/**
 * Codex 한도 창 목록. 기본 버킷(계정 전체)을 먼저, 그 외 버킷(모델 전용 한도)은 범위 표시명과 함께 뒤에.
 * 5시간 창이 빠진 플랜에서는 서버가 주간 창을 primary 자리로 올려 보내므로, 위치가 아니라 창 길이로 분류한다.
 */
export function windowsFromCodex(
  main: RateLimitSnapshot | null | undefined,
  byLimitId?: Record<string, RateLimitSnapshot> | null,
  observedAtMs: number | null = null,
): LimitWindow[] {
  const mainId = main?.limitId || "codex";
  const out: LimitWindow[] = main ? windowsOfSnapshot(main, mainId, null, observedAtMs) : [];
  for (const [key, snap] of Object.entries(byLimitId ?? {})) {
    if (!snap || key === mainId || snap.limitId === mainId) continue;
    out.push(...windowsOfSnapshot(snap, key, snap.limitName || snap.limitId || key, observedAtMs));
  }
  return dedupeIds(out);
}

export function dedupeIds(windows: LimitWindow[]): LimitWindow[] {
  const seen = new Map<string, number>();
  return windows.map((w) => {
    const n = seen.get(w.id) ?? 0;
    seen.set(w.id, n + 1);
    return n === 0 ? w : { ...w, id: `${w.id}#${n + 1}` };
  });
}

// ---------- 표시 보조 ----------

/** 상태바에 올릴 창: 계정 전체 창 + (모델 전용이라도) 서버가 대표로 고른 창. */
export function statusBarWindows(windows: LimitWindow[]): LimitWindow[] {
  const picked = windows.filter((w) => !w.scope || w.headline);
  return picked.length ? picked : windows.slice(0, 2);
}

/** 계정 전체 5시간 창이 보고되는지(없으면 '이 계정엔 현재 5시간 한도 미적용' 안내). */
export function hasAccountFiveHour(windows: LimitWindow[]): boolean {
  return windows.some((w) => w.span === "5h" && !w.scope);
}

/** 상태바 약어(언어 무관): 5h / 1d / 7d / 1mo / 1y, 그 외는 길이로. */
export function shortSpanLabel(w: LimitWindow): string {
  switch (w.span) {
    case "5h":
      return "5h";
    case "daily":
      return "1d";
    case "weekly":
      return "7d";
    case "monthly":
      return "1mo";
    case "annual":
      return "1y";
  }
  const mins = Number(w.windowMins);
  if (isFinite(mins) && mins > 0) {
    if (mins >= 1440) return `${Math.round(mins / 1440)}d`;
    if (mins >= 60) return `${Math.round(mins / 60)}h`;
    return `${mins}m`;
  }
  return "lim";
}

/** 0 정상 / 1 경고 / 2 위험. 서버 심각도가 있으면 그대로, 없으면 사용률 임계치(80/95). */
export function windowLevel(w: LimitWindow): 0 | 1 | 2 {
  const sev = (w.severity ?? "").toLowerCase();
  if (sev === "critical") return 2;
  if (sev === "warning") return 1;
  if (sev === "normal") return 0;
  if (w.usedPercent >= 95) return 2;
  if (w.usedPercent >= 80) return 1;
  return 0;
}

// ---------- 소진 예상 (창 시작 이후 평균) ----------

/**
 * 예상 상태(우선순위 순). 숫자 예상은 before/boundary/safe 에서만 나온다.
 * - expired: 리셋 시각이 지남(기준이 바뀌었을 수 있어 새 관측 전까지 예상 없음)
 * - reached: 사용률 100% 보고(실제 차단 확정은 아님)
 * - unknown: 리셋 시각·창 길이를 몰라 계산 불가
 * - metaPending: 서버 창 정보가 서로 맞지 않음
 * - held: 같은 창에서 사용률이 내려감(복원·보정) → 그 창이 끝날 때까지 예상 보류
 * - idle: 보고 사용률 0%
 * - tooEarly: 창 시작~관측 사이 시간이 없음
 */
export type ForecastState =
  | "expired"
  | "reached"
  | "unknown"
  | "metaPending"
  | "held"
  | "idle"
  | "tooEarly"
  | "before"
  | "boundary"
  | "safe";

export interface Forecast {
  state: ForecastState;
  usedPercent: number;
  startMs?: number;
  observedAtMs?: number;
  resetsAtMs?: number;
  /** 창 평균이 유지될 때 리셋 시점 사용률(점·보고 반올림 범위). */
  atReset?: number;
  atResetLo?: number;
  atResetHi?: number;
  /** 소진 예상 시각(점·이른·늦은). */
  etaMs?: number;
  etaEarlyMs?: number;
  etaLateMs?: number;
  /** before 인데 예상 시각이 지났고 100% 관측은 아직 없음(도달로 확정하지 않음). */
  etaPassed?: boolean;
  /** held 의 사유: 같은 창 사용률 하락(drop) / 기록 상한 초과로 추적 정보 부족(tracking). */
  heldReason?: HoldReason;
}

export type HoldReason = "drop" | "tracking";

/**
 * 보고 사용률의 반올림 단위 가정(±%p). Codex는 공식 프로토콜이 정수로 반올림해 보내고
 * (`used_percent.round() as i32`), Claude는 정밀도가 문서화되지 않아 같은 값을 보수적으로 쓴다.
 * 범위는 '보고값 반올림에 대한 민감도'이지 앞으로의 사용 패턴에 대한 신뢰구간이 아니다.
 */
export const REPORT_PRECISION = 0.5;

/** 창 시작(ms): 서버가 준 값이 있으면 그것, 없으면 최신 리셋 시각 − 창 길이(기억해 둔 기준을 쓰지 않음). */
export function windowStartOf(w: LimitWindow): number | null {
  if (typeof w.windowStartMs === "number" && isFinite(w.windowStartMs)) return w.windowStartMs;
  const R = Number(w.resetsAtMs);
  const len = Number(w.windowMins);
  if (!isFinite(R) || R <= 0 || !isFinite(len) || len <= 0) return null;
  return R - len * 60_000;
}

/**
 * 창 시작 이후 평균 속도로 리셋 전 소진 여부를 판단한다(순수 함수 — 같은 관측이면 같은 답).
 * 평균 = 사용률 ÷ (관측 시각 − 창 시작). 리셋 기준이 바뀌면 입력의 리셋 시각·창 시작이 바뀌므로
 * 다음 계산에 그대로 반영된다. now 는 리셋 경과·예상 시각 경과 판정에만 쓴다.
 */
export function forecastWindow(
  w: LimitWindow,
  now: number,
  opts: { held?: boolean; heldReason?: HoldReason; precision?: number } = {},
): Forecast {
  const U = Number(w.usedPercent);
  const R = Number(w.resetsAtMs);
  const O = Number(w.observedAtMs);
  const base: Forecast = { state: "unknown", usedPercent: U };
  const hasR = isFinite(R) && R > 0;
  if (hasR) base.resetsAtMs = R;
  if (isFinite(O) && O > 0) base.observedAtMs = O;
  // 창 좌표(그래프 축)는 상태와 무관하게 보존한다.
  const S = windowStartOf(w);
  if (S != null && hasR && S < R) base.startMs = S;
  if (!isFinite(U)) return base;
  if (hasR && (now >= R || (isFinite(O) && O >= R))) return { ...base, state: "expired" };
  if (U >= 100) return { ...base, state: "reached" };
  if (!hasR || S == null || !isFinite(O) || O <= 0) return base;
  if (w.metaConflict) return { ...base, state: "metaPending" };
  if (opts.held || opts.heldReason) return { ...base, state: "held", heldReason: opts.heldReason ?? "drop" };
  if (U <= 0) return { ...base, state: "idle" };
  const span = O - S;
  if (!(span > 0)) return { ...base, state: "tooEarly" };

  const q = opts.precision ?? REPORT_PRECISION;
  const k = (R - S) / span;
  const atReset = k * U;
  const atResetLo = k * Math.max(0, U - q);
  const atResetHi = k * (U + q);
  // 관측 시점 수준 u 에서 같은 평균(u/span)으로 계속 쓸 때 100%가 되는 시각.
  const etaFor = (u: number) => (u <= 0 ? Infinity : u >= 100 ? O : O + ((100 - u) / u) * span);
  const out: Forecast = {
    ...base,
    atReset,
    atResetLo,
    atResetHi,
    etaMs: etaFor(U),
    etaEarlyMs: etaFor(Math.min(100, U + q)),
    etaLateMs: etaFor(U - q),
    state: atResetLo > 100 ? "before" : atResetHi < 100 ? "safe" : "boundary",
  };
  // 리셋 전 예상 시각이 지났는데 아직 100% 관측이 없음 → 도달로 확정하지 않고 새 관측을 기다린다(경계 상태 포함).
  const eta = out.etaMs as number;
  if ((out.state === "before" || out.state === "boundary") && isFinite(eta) && eta <= R && now >= eta) {
    out.etaPassed = true;
  }
  return out;
}

// ---------- 같은 창 추적(복원 감지 · 그래프 샘플) ----------

export interface LimitSample {
  ts: number;
  v: number;
}

interface WindowIdentity {
  /** 이 창을 처음 본 리셋 시각 — 흔들림 허용 오차의 기준(연쇄 비교 금지). */
  R0: number;
  len: number | null;
  maxU: number;
  held: boolean;
  lastSeen: number;
  samples: LimitSample[];
}

const IDENTITY_TOLERANCE_MS = 2 * 60_000; // 관측된 리셋 시각 흔들림(대부분 ≤5초)을 같은 창으로
const DROP_TOLERANCE = 1; // %p — 이 창에서 본 최대보다 이만큼 넘게 내려가면 복원·보정으로 본다(정책 가정)
const ZERO_KEEP = 5; // 사용률 0%뿐인 창 기록은 최근 몇 개만(0%에서 리셋 시각이 계속 밀리는 경우 — 하락을 감지할 값이 없음)
const RECORD_HARD_CAP = 40; // 비정상 폭증 방지용 상한 — 넘쳐서 보류·사용 기록을 잃으면 그 창들의 리셋까지 보류로 본다
const STALE_MEMO_CAP = 50; // 미터별로 기억하는 '관측 시각 → 노후 시각' 개수
const SAMPLE_CAP = 300;

/**
 * 창 id 별로 '같은 창'(처음 본 리셋 시각 ±2분 · 같은 길이)을 추적한다.
 * - 리셋 시각이 크게 바뀌면 새 창으로 본다(조기 재시작·기준 이동). 이전 창 기록은 그 창 것으로만 남는다.
 * - 같은 창에서 사용률이 내려가면 보류(정기 리셋 시각을 유지한 채 한도를 복원하는 경우).
 * - 허용 범위가 겹쳐 한 관측이 여러 기록에 들면, 겹치는 모든 기록 기준으로 하락을 검사하고 하나라도 보류면 보류.
 * - 리셋 전 기록은 사용률이 0%보다 컸던 적이 있으면 지우지 않는다(하락 감지에 필요한 최소 정보).
 *   0%뿐인 기록만 최근 몇 개로 줄인다. 상한을 넘겨 그런 기록을 잃으면 그 창들의 리셋까지 '추적 정보 부족 → 보류'.
 * - 최신성은 창 기록과 별개로 미터별 '마지막으로 받은 관측 시각'으로 판단한다: 표시는 관측 시각상 뒤로 가지 않는다
 *   (기준이 번갈아 오거나 기록을 지워도 옛 값이 다시 들어오지 않음). 겹침 구간의 관측도 이 한 규칙을 따른다.
 * - 노후 시각은 미터·관측 시각별로 처음 받을 때 고정해 기억한다(다른 기준을 거쳐 같은 관측을 다시 받아도 늘리지 않음).
 * - 메모리에만 둔다: 계정이 실제로 바뀔 때만 clear(), 재연결·토큰 갱신·설정 변경으로는 지우지 않는다.
 */
export class LimitWatch {
  private byId = new Map<string, WindowIdentity[]>();
  /** 미터별 마지막으로 받아들인 관측 시각. */
  private lastAccepted = new Map<string, number>();
  /** 미터별 관측 시각 → 노후 시각(처음 받아들일 때 고정). */
  private staleMemo = new Map<string, Map<number, number>>();
  /** 기록 상한 초과로 보류·사용 기록을 잃었을 수 있음 → 이 관측 시각까지는 보류로 본다. */
  private overflowUntil = new Map<string, number>();

  private matches(w: LimitWindow): WindowIdentity[] {
    const R = Number(w.resetsAtMs);
    const len = w.windowMins ?? null;
    return (this.byId.get(w.id) ?? [])
      .filter((i) => Math.abs(i.R0 - R) <= IDENTITY_TOLERANCE_MS && i.len === len)
      .sort((a, b) => Math.abs(a.R0 - R) - Math.abs(b.R0 - R));
  }

  /** 이 관측을 받아들여도 되는지: 이 미터에서 이미 더 늦은 관측을 받았으면 false(표시가 관측 시각상 뒤로 가지 않게). */
  accepts(w: LimitWindow): boolean {
    const O = Number(w.observedAtMs);
    if (!isFinite(O)) return false;
    return O >= (this.lastAccepted.get(w.id) ?? -Infinity);
  }

  /** 이 미터·관측 시각에 처음 붙인 노후 시각(없으면 undefined). */
  staleAtFor(id: string, observedAtMs: number): number | undefined {
    return this.staleMemo.get(id)?.get(observedAtMs);
  }

  rememberStaleAt(id: string, observedAtMs: number, staleAtMs: number): void {
    const memo = this.staleMemo.get(id) ?? new Map<number, number>();
    if (!memo.has(observedAtMs)) memo.set(observedAtMs, staleAtMs);
    while (memo.size > STALE_MEMO_CAP) memo.delete(memo.keys().next().value as number);
    this.staleMemo.set(id, memo);
  }

  /** 전체 스냅샷의 관측을 반영한다(부분 입력을 넣어도 다른 창 기록을 지우지 않는다). */
  observe(windows: LimitWindow[]): void {
    for (const w of windows) {
      const O = Number(w.observedAtMs);
      if (!isFinite(O) || O <= 0) continue;
      if (!this.accepts(w)) continue; // 이 미터에서 이미 더 늦은 관측을 받음 — 옛 관측은 반영하지 않음
      // 표시에 받아들인 관측의 최신성은 리셋 시각 유무와 무관하게 남긴다(리셋 없는 100% 보고 뒤 옛 값이 덮지 않게).
      this.lastAccepted.set(w.id, O);
      const R = Number(w.resetsAtMs);
      if (!isFinite(R) || R <= 0 || !isFinite(w.usedPercent)) continue; // 창 추적·샘플은 리셋 시각이 있을 때만
      const hits = this.matches(w);
      const idn: WindowIdentity = hits[0] ?? {
        R0: R,
        len: w.windowMins ?? null,
        maxU: w.usedPercent,
        held: false,
        lastSeen: O,
        samples: [],
      };
      // 어느 기준에서 보든 같은 창 안 하락이면 보류.
      const dropped = hits.some((i) => w.usedPercent < i.maxU - DROP_TOLERANCE);
      for (const i of hits) {
        if (dropped) i.held = true;
        i.maxU = Math.max(i.maxU, w.usedPercent); // 겹침 관측은 어느 창 것인지 모호 → 보수적으로 모두의 최대값에 반영
      }
      idn.lastSeen = O; // 정리 순서용(최신성 판단에는 쓰지 않음)
      const last = idn.samples[idn.samples.length - 1];
      if (last && O === last.ts) {
        last.v = w.usedPercent; // 같은 관측 시각의 정정은 그 샘플을 바꾼다(카드와 그래프 일치)
      } else if (!last || O > last.ts) {
        idn.samples.push({ ts: O, v: w.usedPercent });
        if (idn.samples.length > SAMPLE_CAP) {
          const keepTail = SAMPLE_CAP / 2;
          const head = idn.samples.slice(0, -keepTail).filter((_, i) => i % 2 === 0);
          idn.samples = head.concat(idn.samples.slice(-keepTail));
        }
      }
      // 리셋이 지난 기록은 버린다. 리셋 전 기록 중 보류이거나 0%보다 컸던 적이 있는 기록은 유지, 0%뿐인 기록만 최근 몇 개.
      const others = (this.byId.get(w.id) ?? []).filter((i) => i !== idn && i.R0 + IDENTITY_TOLERANCE_MS >= O);
      // 보류·사용 기록과 0%뿐인 기록을 먼저 나눈 뒤 각각 상한을 적용한다(현재 기록이 어느 쪽인지에 따라 자리를 잡음).
      const important = (i: WindowIdentity) => i.held || i.maxU > 0;
      const idnImportant = important(idn);
      let keep = others.filter(important);
      const zeros = others
        .filter((i) => !important(i))
        .sort((a, b) => b.lastSeen - a.lastSeen)
        .slice(0, idnImportant ? ZERO_KEEP : ZERO_KEEP - 1); // 0%뿐인 기록은 따로 최근 몇 개
      const keepCap = idnImportant ? RECORD_HARD_CAP - 1 : RECORD_HARD_CAP;
      if (keep.length > keepCap) {
        keep = keep.sort((a, b) => Number(b.held) - Number(a.held) || b.lastSeen - a.lastSeen);
        const lost = keep.slice(keepCap);
        // 보류·사용 기록을 잃음 → 잃은 창들의 리셋까지는 '추적 정보 부족'으로 보류(확인한 보류를 정상으로 되돌리지 않음).
        const until = Math.max(...lost.map((i) => i.R0 + IDENTITY_TOLERANCE_MS));
        this.overflowUntil.set(w.id, Math.max(this.overflowUntil.get(w.id) ?? 0, until));
        keep = keep.slice(0, keepCap);
      }
      this.byId.set(w.id, [idn, ...keep, ...zeros]);
    }
  }

  /** 이 관측이 속한 창에서 복원·보정이 감지됐는지(겹치는 기록 중 하나라도 보류면 보류). */
  isHeld(w: LimitWindow): boolean {
    return this.holdReason(w) !== null;
  }

  /** 보류 사유: 같은 창 사용률 하락(drop)이 우선, 아니면 기록 상한 초과로 추적 정보 부족(tracking). */
  holdReason(w: LimitWindow): HoldReason | null {
    if (this.matches(w).some((i) => i.held)) return "drop";
    const until = this.overflowUntil.get(w.id);
    if (until !== undefined && Number(w.observedAtMs) <= until) return "tracking";
    return null;
  }

  /**
   * 이 관측이 속한 창(현재 기준)의 '처음 본 리셋 시각' — 그래프 기록이 같은 창 구분을 쓰도록 넘겨준다(observe 뒤에 부른다).
   * 해당 창 기록이 없으면 null.
   */
  anchorFor(w: LimitWindow): number | null {
    return this.matches(w)[0]?.R0 ?? null;
  }

  /** 이 관측이 속한 창(현재 기준)의 샘플만 — 이전 기준·창의 샘플과 잇지 않는다. */
  samplesFor(w: LimitWindow): LimitSample[] {
    const idn = this.matches(w)[0];
    return idn ? [...idn.samples] : [];
  }

  /** 창 목록 전체에 대한 보류 여부·샘플(상태로 내보낼 때). */
  snapshot(windows: LimitWindow[]): {
    holds: Record<string, boolean>;
    holdReasons: Record<string, HoldReason>;
    samples: Record<string, LimitSample[]>;
  } {
    const holds: Record<string, boolean> = {};
    const holdReasons: Record<string, HoldReason> = {};
    const samples: Record<string, LimitSample[]> = {};
    for (const w of windows) {
      const reason = this.holdReason(w);
      holds[w.id] = reason !== null;
      if (reason) holdReasons[w.id] = reason;
      samples[w.id] = this.samplesFor(w);
    }
    return { holds, holdReasons, samples };
  }

  /** 실제 계정이 바뀌었을 때만. */
  clear(): void {
    this.byId.clear();
    this.lastAccepted.clear();
    this.staleMemo.clear();
    this.overflowUntil.clear();
  }
}

/**
 * 새 응답의 창들을 받아들일지 정한다(두 서비스 공용). 반드시 watch.observe 전에 부른다.
 * 한계(보수적 처리): 같은 미터의 관측 시각 출처가 바뀌면(서버 산출 시각 ↔ 응답 받은 시각) 두 시각을 정확히 비교할 수 없다.
 * 받은 시각은 보통 서버 산출 시각보다 늦으므로, 받은 시각으로 들어온 값 뒤에 그보다 이른 서버 산출 시각의 값이 오면
 * 실제로는 더 새 값이어도 다음 관측(더 늦은 시각)이 올 때까지 받지 않는다(옛 값 역행보다 잠깐의 지연을 택함).
 * - 같은 창 기준에서 이미 더 늦은 관측을 봤으면(서버 산출 시각 역행·기준 교대 중 옛 값) 받지 않는다:
 *   이전 표시가 있으면 그것을 유지하고, 없으면(잠시 빠졌던 미터) 이번 목록에서 뺀다.
 * - 받아들인 관측은 최신 리셋·창 시작·길이·충돌 정보를 그대로 쓴다(이전 객체를 재사용하지 않음).
 * - 노후 시각은 관측 시각에 고정: 같은 미터·관측 시각을 다시 받으면(값 정정·기준 교대 뒤 재수신 포함) 처음 노후 시각을 쓴다.
 */
export function acceptObservations(
  watch: LimitWatch,
  prev: LimitWindow[] | undefined,
  next: LimitWindow[],
  staleAfterMs: number,
): LimitWindow[] {
  const out: LimitWindow[] = [];
  for (const w of next) {
    const old = prev?.find((p) => p.id === w.id);
    if (!watch.accepts(w)) {
      if (old) out.push(old);
      continue;
    }
    const O = Number(w.observedAtMs);
    let staleAt: number | null = null;
    if (isFinite(O)) {
      staleAt = watch.staleAtFor(w.id, O) ?? O + staleAfterMs;
      watch.rememberStaleAt(w.id, O, staleAt);
    }
    out.push({ ...w, staleAtMs: staleAt });
  }
  return out;
}
