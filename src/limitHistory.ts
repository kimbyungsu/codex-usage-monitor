// 한도 사용률 기록 — 대시보드 그래프의 파란 실선(지금까지 실제로 쓴 굴곡)을 VS Code 를 다시 켜도 이어 그리기 위한 저장소.
//
// - 그래프 전용이다: 소진 예상·보류 판단(LimitWatch·forecastWindow)에는 쓰지 않는다.
// - 실제 값만 담는다: 확장이 서버에서 받아들인 사용률뿐이고 추정치는 없다.
//   (Codex 로컬 세션 기록은 쓰지 않는다 — 기록마다 어느 계정으로 실행했는지 알 수 없어 다른 계정 값이 섞일 수 있다.)
// - 계정별로 나눠 저장한다. 계정 식별은 해시로만 남기고, 지금 계정 식별을 확인할 수 없으면 저장도 합치기도 하지 않는다.
// - 창 구분: 저장은 LimitWatch 가 그 관측을 배정한 창('처음 본 리셋 시각' anchor)별로 나누고, 기록마다 실제로 본
//   리셋 시각의 범위를 함께 남긴다. 읽을 때는 (1) 그 범위 전체가 지금 리셋 시각과 30초 안이고 (2) 지금 창이 아닌
//   다른 기록(모든 파일)과 리셋 시각이 2분(LimitWatch 의 같은 창 허용폭) 안으로 가깝지 않은 기록만 잇는다 — 같은 창의
//   흔들림(실측 수 초)은 잇고, 리셋이 밀리거나 경계에서 오가 어느 창인지 모호한 기록은 잇지 않는다(VS Code 창마다
//   '처음 본 시각'이 달라 생기는 경계 차이도 포함).
// - VS Code 창(확장 호스트)마다 자기 파일에만 쓰고, 그릴 때 모든 파일을 합친다 — 여러 창이 동시에 써도 서로 덮지 않는다.
//   다른 창의 파일은 그 주인 프로세스가 끝났고 담긴 기록이 모두 지난 창의 것일 때만 지운다(살아 있는 주인과 엇갈려
//   새로 저장한 파일을 지우는 일이 없게).
// - 같은 값이 이어지면 그 구간의 처음·마지막 점만 남긴다. 점이 상한을 넘으면 처음·끝을 유지하며 고르게 줄인다.

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { LimitSample, LimitWindow } from "./limits";

const FILE_PREFIX = "limit-history-";
/** 이 기록이 지금 창의 것이라고 볼 수 있는 리셋 시각 차이(기록 안 모든 리셋 시각 기준) — 실측 흔들림 수 초보다 넉넉히. */
const SAME_RESET_MS = 30_000;
/** LimitWatch 가 같은 창으로 묶는 리셋 시각 허용폭 — 다른 창 기록이 이만큼 가까우면 그 근처 기록은 어느 창인지 모호하다. */
const AMBIGUOUS_RESET_MS = 2 * 60_000;
/** 리셋이 지난 뒤에도 하루는 남긴다(시계 차이·늦게 도착한 관측 대비) — 그 뒤 버린다. */
const KEEP_AFTER_RESET_MS = 24 * 3600_000;
/** 한 창 기록의 점 개수 상한(같은 값 구간은 두 점으로 줄어 보통 훨씬 적다). 넘으면 처음·끝을 유지하며 줄인다. */
const POINT_CAP = 4000;
const SAVE_DELAY_MS = 3000;
const SAVE_RETRY_MS = 30_000;
/** 그래프로 보내는 점 개수 상한. */
const CHART_CAP = 400;

export type HistoryPoint = [ts: number, v: number];

interface HistoryEntry {
  account: string;
  id: string;
  len: number | null;
  /** LimitWatch 가 이 창에 정한 '처음 본 리셋 시각'(이 작성자 안에서 창을 나누는 키). */
  R0: number;
  /** 이 기록에 담긴 관측들이 실제로 본 리셋 시각의 범위. */
  rMin: number;
  rMax: number;
  points: HistoryPoint[];
}

interface HistoryFile {
  v: 1;
  /** 이 파일의 주인(확장 호스트) 프로세스 번호 — 주인이 끝났는지 확인해 정리할 때만 쓴다. */
  pid: number;
  entries: HistoryEntry[];
}

/** 계정 식별 → 저장용 키(해시). 식별이 없으면 null(저장·표시하지 않음). */
export function historyAccountKey(agent: "claude" | "codex", identity: string | null | undefined): string | null {
  if (!identity) return null;
  return createHash("sha256").update(`${agent}\u0000${identity}`).digest("hex").slice(0, 32);
}

/**
 * 점을 덧붙인다 — 같은 값이 세 번 이상 이어지면 가운데를 지우고 구간의 처음·마지막만 남긴다.
 * 시각이 앞서는 점은 버리고(기록은 시각순), 같은 시각은 값만 바꾼다(값 정정). 바뀌었으면 true.
 */
export function appendPoint(points: HistoryPoint[], ts: number, v: number): boolean {
  const last = points[points.length - 1];
  if (last && ts < last[0]) return false;
  if (last && ts === last[0]) {
    if (last[1] === v) return false;
    last[1] = v;
    return true;
  }
  const prev = points[points.length - 2];
  if (last && prev && last[1] === v && prev[1] === v) {
    last[0] = ts;
    return true;
  }
  points.push([ts, v]);
  return true;
}

/** 점이 cap 을 넘으면 처음·끝을 유지하며 고르게 줄인다. */
export function thinKeepEnds<T>(points: T[], cap: number): T[] {
  if (points.length <= cap || cap < 2) return points;
  const step = (points.length - 1) / (cap - 1);
  const out: T[] = [];
  for (let i = 0; i < cap; i++) out.push(points[Math.round(i * step)]);
  return out;
}

function finiteNumber(x: unknown): x is number {
  return typeof x === "number" && isFinite(x);
}

/**
 * 파일에서 읽은 기록 하나를 검사해 쓸 수 있는 형태로 만든다(손상·다른 형식이면 null). 점은 [시각, 사용률] 두 수가
 * 모두 유한한 것만 남기고 시각순으로 정렬한다 — 깨진 점 하나 때문에 기록 전체나 그래프·조회가 멈추지 않게.
 */
function toEntry(x: any): HistoryEntry | null {
  if (!x || typeof x !== "object") return null;
  if (typeof x.account !== "string" || typeof x.id !== "string") return null;
  if (!(x.len === null || finiteNumber(x.len))) return null;
  if (!finiteNumber(x.R0) || !finiteNumber(x.rMin) || !finiteNumber(x.rMax) || !Array.isArray(x.points)) return null;
  const points: HistoryPoint[] = [];
  for (const p of x.points as unknown[]) {
    if (Array.isArray(p) && finiteNumber(p[0]) && finiteNumber(p[1])) points.push([p[0], p[1]]);
  }
  points.sort((a, b) => a[0] - b[0]);
  return { account: x.account, id: x.id, len: x.len, R0: x.R0, rMin: x.rMin, rMax: x.rMax, points };
}

/** 리셋이 지난 지 하루가 넘은(더 쓸 일 없는) 기록인지. */
function expired(e: HistoryEntry, now: number): boolean {
  return Math.max(e.R0, e.rMax) + KEEP_AFTER_RESET_MS < now;
}

/** 주인 프로세스가 끝났는지(확실할 때만 true — 알 수 없으면 살아 있다고 본다). */
function processEnded(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export class LimitHistoryStore {
  private readonly file: string;
  private own: HistoryEntry[] = [];
  private ownLoaded = false;
  private dirty = false;
  private saveTimer?: NodeJS.Timeout;
  private disposed = false;
  private readonly others = new Map<string, { mtimeMs: number; size: number; pid: unknown; entries: HistoryEntry[] }>();

  /**
   * @param dir 기록 파일을 둘 폴더(확장 전용 저장 폴더 — Claude·Codex 설정 폴더가 아님)
   * @param writerId 이 VS Code 창의 구분자 — 파일 이름에 쓴다(프로세스 번호와 함께)
   */
  constructor(
    private readonly dir: string,
    writerId: string,
    private readonly now: () => number = Date.now,
    private readonly log?: (m: string) => void,
  ) {
    const safe = (writerId || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
    this.file = path.join(dir, `${FILE_PREFIX}${safe}-${process.pid}.json`);
  }

  /**
   * 받아들인 관측을 기록한다. anchorOf 는 LimitWatch 가 그 관측을 배정한 창의 '처음 본 리셋 시각'(없으면 기록 안 함).
   * 계정 키가 없으면 아무것도 하지 않는다.
   */
  record(account: string | null, windows: LimitWindow[], anchorOf: (w: LimitWindow) => number | null): void {
    // 그래프 기록은 부가 기능 — 어떤 오류도 서버 값 반영·다음 조회 예약을 막지 않게 여기서 멈춘다(기록만 건너뜀).
    try {
      this.recordUnsafe(account, windows, anchorOf);
    } catch (error) {
      this.log?.(`사용률 기록 건너뜀: ${(error as Error).message}`);
    }
  }

  private recordUnsafe(account: string | null, windows: LimitWindow[], anchorOf: (w: LimitWindow) => number | null): void {
    if (!account || this.disposed) return;
    this.loadOwn();
    let changed = false;
    for (const w of windows) {
      const R0 = anchorOf(w);
      const R = Number(w.resetsAtMs);
      const O = Number(w.observedAtMs);
      const v = Number(w.usedPercent);
      if (R0 === null || !(R0 > 0) || !(R > 0) || !(O > 0) || !isFinite(v)) continue;
      const len = w.windowMins ?? null;
      let e = this.own.find((x) => x.account === account && x.id === w.id && x.len === len && x.R0 === R0);
      if (!e) {
        e = { account, id: w.id, len, R0, rMin: R, rMax: R, points: [] };
        this.own.push(e);
      }
      if (R < e.rMin || R > e.rMax) {
        e.rMin = Math.min(e.rMin, R);
        e.rMax = Math.max(e.rMax, R);
        changed = true;
      }
      if (appendPoint(e.points, O, v)) changed = true;
      if (e.points.length > POINT_CAP) e.points = thinKeepEnds(e.points, Math.floor(POINT_CAP * 0.75));
    }
    if (changed) {
      this.dirty = true;
      this.scheduleSave(SAVE_DELAY_MS);
    }
  }

  /**
   * 이 계정·창의 저장된 점 — 모든 파일을 합쳐 [fromMs, toMs] 안만. 같은 미터·길이 기록 중
   * (1) 기록 안의 모든 리셋 시각이 지금 리셋 시각(w.resetsAtMs)과 30초 안이고,
   * (2) 그 조건을 못 갖춘 다른 기록(= 다른 창)과 리셋 시각 범위가 2분 안으로 가깝지 않은 기록만 잇는다.
   * (2)는 리셋 시각이 경계 근처에서 오가 같은 리셋 값이 서로 다른 창에 배정됐을 수 있는 경우를 보수적으로 뺀다.
   */
  pointsFor(account: string | null, w: LimitWindow, fromMs: number, toMs: number): LimitSample[] {
    // 저장 기록을 못 읽으면 지금 기억하는 값만 그린다 — 어떤 오류도 서버 값 반영·다음 조회 예약을 막지 않게.
    try {
      return this.pointsForUnsafe(account, w, fromMs, toMs);
    } catch (error) {
      this.log?.(`사용률 기록 읽기 건너뜀: ${(error as Error).message}`);
      return [];
    }
  }

  private pointsForUnsafe(account: string | null, w: LimitWindow, fromMs: number, toMs: number): LimitSample[] {
    const R = Number(w.resetsAtMs);
    if (!account || !(R > 0)) return [];
    this.loadOwn();
    const len = w.windowMins ?? null;
    const all: HistoryEntry[] = [];
    for (const entries of [this.own, ...this.readOthers()]) {
      for (const e of entries) if (e.account === account && e.id === w.id && e.len === len) all.push(e);
    }
    const near = (e: HistoryEntry) => Math.abs(e.rMin - R) <= SAME_RESET_MS && Math.abs(e.rMax - R) <= SAME_RESET_MS;
    const gap = (a: HistoryEntry, b: HistoryEntry) => Math.max(0, a.rMin - b.rMax, b.rMin - a.rMax);
    const others = all.filter((e) => !near(e));
    const out: LimitSample[] = [];
    for (const e of all) {
      if (!near(e)) continue;
      if (others.some((f) => gap(e, f) <= AMBIGUOUS_RESET_MS)) continue; // 어느 창인지 모호
      for (const [ts, v] of e.points) {
        if (ts >= fromMs && ts <= toMs && isFinite(v)) out.push({ ts, v });
      }
    }
    return out;
  }

  /** 남은 기록을 바로 저장한다(실패하면 미저장으로 남겨 다음에 다시 시도). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.dirty) this.save();
  }

  dispose(): void {
    this.flush();
    this.disposed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
  }

  private scheduleSave(delay: number): void {
    if (this.saveTimer || this.disposed) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, delay);
    this.saveTimer.unref?.();
  }

  private loadOwn(): void {
    if (this.ownLoaded) return;
    this.ownLoaded = true;
    const loaded = this.readFile(this.file);
    if (loaded) this.own = loaded.entries.concat(this.own);
  }

  /** 저장 — 성공했을 때만 미저장 표시를 지운다. 실패하면 잠시 뒤 다시 시도한다. */
  private save(): void {
    const now = this.now();
    this.own = this.own.filter((e) => !expired(e, now));
    const body: HistoryFile = { v: 1, pid: process.pid, entries: this.own };
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(body), "utf8");
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (error) {
      this.log?.(`사용률 기록 저장 실패(다시 시도): ${(error as Error).message}`);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      this.scheduleSave(SAVE_RETRY_MS);
    }
  }

  private readFile(file: string): { pid: unknown; entries: HistoryEntry[] } | null {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HistoryFile>;
      if (!raw || raw.v !== 1 || !Array.isArray(raw.entries)) return null;
      const entries: HistoryEntry[] = [];
      for (const x of raw.entries as unknown[]) {
        const e = toEntry(x);
        if (e) entries.push(e);
      }
      return { pid: raw.pid, entries };
    } catch {
      return null;
    }
  }

  /**
   * 다른 창들의 기록 파일(바뀐 것만 다시 읽음 — 만료는 읽을 때마다 지금 시각으로 다시 따진다). 주인 프로세스가 끝났고
   * 담긴 기록이 모두 지난 창의 것인 파일만 지운다 — 주인이 끝났으면 그 파일을 새로 쓰는 쪽이 없으므로 확인과 삭제
   * 사이에 엇갈릴 일이 없다.
   */
  private readOthers(): HistoryEntry[][] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const now = this.now();
    const seen = new Set<string>();
    const out: HistoryEntry[][] = [];
    for (const name of names) {
      if (!name.startsWith(FILE_PREFIX) || !name.endsWith(".json")) continue;
      const full = path.join(this.dir, name);
      if (full === this.file) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      seen.add(full);
      let cached = this.others.get(full);
      if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        const read = this.readFile(full);
        cached = { mtimeMs: st.mtimeMs, size: st.size, pid: read?.pid, entries: read?.entries ?? [] };
        this.others.set(full, cached);
      }
      const live = cached.entries.filter((e) => !expired(e, now));
      if (live.length === 0 && processEnded(cached.pid)) {
        try {
          fs.unlinkSync(full);
        } catch {
          /* 다른 창이 먼저 지웠거나 잠김 — 다음에 */
        }
        this.others.delete(full);
        continue;
      }
      out.push(live);
    }
    for (const key of [...this.others.keys()]) if (!seen.has(key)) this.others.delete(key);
    return out;
  }
}

/**
 * 그래프용 실제 값 묶음: 여러 출처의 점을 합쳐 [fromMs, toMs] 안만 시각순으로 — 같은 시각은 뒤 출처가 우선
 * (확장이 지금 기억하는 값을 마지막에 넘겨 정정이 반영되게), 같은 값 구간은 처음·마지막만, 너무 많으면 처음·끝을 유지하며 줄인다.
 */
export function mergeChartSamples(sources: LimitSample[][], fromMs: number, toMs: number, cap = CHART_CAP): LimitSample[] {
  const byTs = new Map<number, number>();
  for (const src of sources) {
    for (const p of src) {
      if (isFinite(p.ts) && isFinite(p.v) && p.ts >= fromMs && p.ts <= toMs) byTs.set(p.ts, p.v);
    }
  }
  const points: HistoryPoint[] = [];
  for (const ts of [...byTs.keys()].sort((a, b) => a - b)) appendPoint(points, ts, byTs.get(ts) as number);
  return thinKeepEnds(points, cap).map(([ts, v]) => ({ ts, v }));
}
