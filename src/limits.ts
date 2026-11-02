// 한도 창(limit window) 공통 모델 — Claude·Codex 공용.
// 어떤 창이 적용되는지는 서버가 정한다. 5시간 창은 플랜·시기에 따라 사라졌다가 다시 생기고
// (예: 2026-07 Codex Plus/Pro 일시 폐지·일부 부활, 2026-10 Claude Ultra 폐지), 모델 전용 창도
// 늘거나 준다. 그래서 위치(primary/secondary)나 고정 필드(5h/7d)로 의미를 가정하지 않고,
// 서버가 보고한 창들을 그 길이·종류로 분류해 있는 만큼만 그린다.
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
  /** 표시 라벨(대시보드로 보낼 때 채움). */
  label?: string;
}

export interface LimitProjection {
  reaches: boolean;
  hoursToFull?: number;
  etaMs?: number;
}

export interface LimitSample {
  ts: number;
  v: number;
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

function windowsOfSnapshot(snap: RateLimitSnapshot, bucketId: string, scope: string | null): LimitWindow[] {
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
): LimitWindow[] {
  const mainId = main?.limitId || "codex";
  const out: LimitWindow[] = main ? windowsOfSnapshot(main, mainId, null) : [];
  for (const [key, snap] of Object.entries(byLimitId ?? {})) {
    if (!snap || key === mainId || snap.limitId === mainId) continue;
    out.push(...windowsOfSnapshot(snap, key, snap.limitName || snap.limitId || key));
  }
  return dedupeIds(out);
}

/**
 * 희소(sparse) rate-limit 갱신 알림을 직전 스냅샷에 병합한다.
 * 창은 위치가 아니라 정체(길이)끼리 병합한다 — 5시간 창이 빠지면 주간 창이 primary 자리로 오므로
 * 위치끼리 병합하면 주간 값이 5시간 자리에 섞이고 옛 주간 창이 secondary에 중복으로 남는다.
 * 직전에 없던 창이 오면 shapeChanged=true(창 구성 변경 가능성 → 호출 측이 전체 재조회).
 */
export function mergeRateLimitSnapshot(
  previous: RateLimitSnapshot | null | undefined,
  next: RateLimitSnapshot,
): { snapshot: RateLimitSnapshot; shapeChanged: boolean } {
  const merged: RateLimitSnapshot = { ...(previous ?? {}) };
  // 알림의 null 메타데이터는 '이번 갱신에 없음'이지 '지움'이 아니다(프로토콜 명시).
  for (const [k, v] of Object.entries(next) as Array<[keyof RateLimitSnapshot, unknown]>) {
    if (k === "primary" || k === "secondary" || v == null) continue;
    if (k === "credits" || k === "individualLimit") {
      (merged as any)[k] = { ...((previous as any)?.[k] ?? {}), ...nonNull(v as object) };
    } else {
      (merged as any)[k] = v;
    }
  }

  const prevWins = [previous?.primary, previous?.secondary]
    .map((w, i) => (w ? { key: codexWindowKey(w, i), pos: i, win: w } : null))
    .filter((x): x is { key: string; pos: number; win: RateLimitWindow } => Boolean(x));
  let shapeChanged = !previous;
  [next.primary, next.secondary].forEach((w, i) => {
    if (!w) return;
    const key = codexWindowKey(w, i);
    // 길이가 빠진 갱신은 정체를 알 수 없으니 같은 위치의 직전 창 값만 갱신(길이는 직전 값 유지).
    const durationKnown = Number(w.windowDurationMins) > 0;
    const hit = prevWins.find((p) => (durationKnown ? p.key === key : p.pos === i));
    if (hit) {
      hit.win = { ...hit.win, ...nonNull(w) };
    } else {
      prevWins.push({ key, pos: i, win: { ...w } });
      shapeChanged = true;
    }
  });
  const ordered = prevWins
    .map((p) => p.win)
    .sort((a, b) => (Number(a.windowDurationMins) || Infinity) - (Number(b.windowDurationMins) || Infinity));
  merged.primary = ordered[0] ?? null;
  merged.secondary = ordered[1] ?? null;
  return { snapshot: merged, shapeChanged };
}

function nonNull<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null) (out as any)[k] = v;
  }
  return out;
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

// ---------- 추세 샘플 · 소진 예상 (창별) ----------

const SAMPLE_WINDOW_MS = 2 * 60 * 60 * 1000;
const SAMPLE_MAX = 60;

/**
 * 창별 사용률 추세. 창마다 따로 쌓아서, 한 창의 리셋(급락)이 다른 창의 추세를 지우지 않고,
 * 창 구성이 바뀌면(예: 5시간 창 폐지) 사라진 창의 추세만 버린다.
 */
export class LimitTrend {
  private series = new Map<string, LimitSample[]>();

  record(now: number, windows: LimitWindow[]): void {
    const live = new Set<string>();
    for (const w of windows) {
      live.add(w.id);
      let s = this.series.get(w.id) ?? [];
      const last = s[s.length - 1];
      if (last && w.usedPercent < last.v - 5) {
        s = []; // 사용률 급락 = 이 창 리셋 → 이 창의 이전 추세만 폐기
      }
      s.push({ ts: now, v: w.usedPercent });
      this.series.set(
        w.id,
        s.filter((x) => x.ts >= now - SAMPLE_WINDOW_MS).slice(-SAMPLE_MAX),
      );
    }
    for (const id of [...this.series.keys()]) {
      if (!live.has(id)) this.series.delete(id);
    }
  }

  samples(): Record<string, LimitSample[]> {
    const out: Record<string, LimitSample[]> = {};
    for (const [id, s] of this.series) out[id] = [...s];
    return out;
  }

  /** 창 리셋 전에 한도에 닿을 때만 reaches=true (5시간 창에 '2일 후 소진' 같은 모순 방지). */
  projections(now: number, windows: LimitWindow[]): Record<string, LimitProjection | null> {
    const out: Record<string, LimitProjection | null> = {};
    for (const w of windows) {
      out[w.id] = projectSeries(now, this.series.get(w.id) ?? [], w.resetsAtMs);
    }
    return out;
  }
}

function projectSeries(now: number, s: LimitSample[], resetsAtMs?: number | null): LimitProjection | null {
  if (s.length < 2) return null;
  const oldest = s[0];
  const newest = s[s.length - 1];
  const dtHours = (newest.ts - oldest.ts) / 3_600_000;
  if (dtHours < 0.05) return null; // 표본 구간이 너무 짧으면 추정 보류
  const ratePerHour = (newest.v - oldest.v) / dtHours;
  if (ratePerHour <= 0.05) return { reaches: false }; // 증가세 거의 없음 → 이번 창 미도달
  const hoursToFull = (100 - newest.v) / ratePerHour;
  if (!isFinite(hoursToFull) || hoursToFull < 0) return { reaches: false };
  const etaMs = now + hoursToFull * 3_600_000;
  if (typeof resetsAtMs === "number" && isFinite(resetsAtMs) && etaMs >= resetsAtMs) {
    return { reaches: false }; // 리셋이 먼저 → 이번 창에선 미도달
  }
  return { reaches: true, hoursToFull, etaMs };
}
