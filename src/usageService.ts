import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { readCodexHistoryAsync } from "./codexHistory";
import { CodexRpcClient } from "./codexClient";
import { historyAccountKey, LimitHistoryStore, mergeChartSamples } from "./limitHistory";
import { acceptObservations, LimitSample, LimitWatch, LimitWindow, windowsFromCodex, windowStartOf } from "./limits";
import {
  AccountReadResponse,
  CodexAccount,
  RateLimitsReadResponse,
  TokenUsageNotification,
  UsageState,
} from "./types";

const execAsync = promisify(exec);

// 서버는 내부 요금제 식별자만 준다. 표시명은 공식 Codex TUI(codex-rs/tui/src/subscription.rs,
// Status 표기)와 같게 하고, 목록에 없는 새 식별자는 원문 그대로 보여준다(개명·신설에도 깨지지 않음).
const CODEX_PLAN_LABELS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro 200",
  prolite: "Pro 100",
  promax: "Pro 500",
  team: "Business",
  self_serve_business_usage_based: "Business",
  business: "Enterprise",
  self_serve_business_prolite: "Business Premium",
  enterprise: "Enterprise",
  ent26: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  enterprise_cbp_automation: "Enterprise (Automation)",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
};

export function codexPlanLabel(planType: string | null | undefined): string | null {
  const raw = (planType ?? "").trim();
  if (!raw) return null;
  return CODEX_PLAN_LABELS[raw.toLowerCase()] ?? raw;
}

export class UsageService implements vscode.Disposable {
  private client?: CodexRpcClient;
  private serverTimer?: NodeJS.Timeout;
  private localTimer?: NodeJS.Timeout;
  private serverBaseMs = 60_000;
  private serverIntervalMs = 60_000;
  private serverFailureCount = 0;
  /** 같은 창 추적(복원 감지·그래프 샘플) — Claude와 같은 LimitWatch. 실제 계정이 바뀔 때만 초기화. */
  private readonly watch = new LimitWatch();
  /** 연결 세대: 재연결하면 이전 연결의 늦은 알림·끊김·응답을 버린다. */
  private clientGen = 0;
  /** 계정 세대: account/updated 가 오면 진행 중 조회 결과를 버린다. */
  private authGen = 0;
  /** 마지막으로 확인한 계정 식별(재연결이 아니라 이것이 바뀔 때만 창 기록을 지운다). */
  private accountIdentity: string | null = null;
  /**
   * 지금 상태(표시값·감지 기록·실선·계정 정보)를 만든 마지막 응답의 로그인 구간(연결 세대:계정 세대). 계정을 읽지 못할 때
   * 같은 로그인 구간인지 가르는 데만 쓴다 — 다시 연결했거나 계정 변경 알림(account/updated)이 왔으면 같은 계정이라고 보지 않는다.
   */
  private ownerLoginKey: string | null = null;
  /** 진행 중인 서버 조회(한 번에 하나). */
  private serverInFlight?: Promise<void>;
  /** 진행 중에 또 요청됨 → 끝난 뒤 한 번 더. */
  private serverRerun = false;
  /** 한도 변경 알림 → 전체 다시 읽기 예약(첫 알림 기준 — 뒤 알림이 미루지 않음). */
  private notifyTimer?: NodeJS.Timeout;
  /** 알림에서 전체 다시 읽기까지 최대 대기(ms). */
  notifyMaxWaitMs = 2000;
  /** dispose 이후 늦게 끝난 요청의 실패 반영·재예약을 막는다. */
  private disposed = false;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<UsageState>();
  private state: UsageState = {
    connected: false,
    connecting: false,
  };

  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    private readonly output: vscode.OutputChannel,
    /** 그래프용 사용률 기록 저장소(없으면 지금 기억하는 값만 그린다). */
    private readonly history?: LimitHistoryStore,
  ) {}

  get currentState(): UsageState {
    return this.state;
  }

  async start(): Promise<void> {
    await this.reconnect();
    if (this.disposed) return; // 시작 도중 종료됨 → 로컬 집계·주기 타이머를 만들지 않는다
    await this.refreshLocal();
    if (this.disposed) return;
    this.configureTimer();
  }

  async reconnect(): Promise<void> {
    if (await this.connectClient()) {
      await this.refreshServer();
    } else {
      this.scheduleNextServerRefresh();
    }
  }

  /** 새 연결을 맺는다. 이전 연결에서 늦게 오는 알림·끊김·오류는 세대 번호로 걸러 새 연결 상태를 훼손하지 않는다. */
  private async connectClient(): Promise<boolean> {
    const gen = ++this.clientGen;
    this.setState({ connecting: true, connected: false, error: undefined, serverRetrySeconds: undefined });
    this.client?.dispose();

    const command = this.resolveCodexCommand(this.config().get<string>("codexCommand", "codex"));
    const client = new CodexRpcClient(command, this.output);
    this.client = client;
    client.on("notification", (method: string, params: unknown) => {
      if (gen === this.clientGen) this.handleNotification(method, params);
    });
    client.on("close", () => {
      if (gen === this.clientGen) {
        this.setState({ connected: false, connecting: false, error: "Codex app-server disconnected" });
      }
    });
    client.on("error", (error: Error) => {
      if (gen === this.clientGen) this.setState({ connected: false, connecting: false, error: error.message });
    });

    try {
      await client.start();
      if (gen !== this.clientGen) return false;
      this.setState({ connected: true, connecting: false, error: undefined });
      return true;
    } catch (error) {
      if (gen === this.clientGen) {
        this.noteServerFailure(error as Error);
        this.setState({ connected: false, connecting: false });
      }
      return false;
    }
  }

  async refresh(): Promise<void> {
    await Promise.all([this.refreshServer(), this.refreshLocal()]);
  }

  /** 서버 조회는 한 번에 하나 — 진행 중 요청은 끝난 뒤 1회로 합친다(늦게 온 옛 응답이 새 값을 덮지 않게). */
  private refreshServer(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.serverInFlight) {
      this.serverRerun = true;
      return this.serverInFlight;
    }
    this.serverInFlight = this.runServerRead().finally(() => {
      this.serverInFlight = undefined;
      if (this.serverRerun && !this.disposed) {
        this.serverRerun = false;
        // 실패 중이면 백오프 예약(scheduleNextServerRefresh)을 따른다.
        if (this.serverFailureCount === 0) void this.refreshServer();
      }
    });
    return this.serverInFlight;
  }

  private async runServerRead(): Promise<void> {
    let gen = this.clientGen;
    let auth = this.authGen;
    try {
      if (!this.client?.isRunning && !(await this.connectClient())) {
        return;
      }
      const client = this.client as CodexRpcClient;
      gen = this.clientGen;
      auth = this.authGen;
      // 관측 시각 = 한도 응답을 받은 시각(계정 조회 완료를 기다린 시각이 아니라).
      const limitsRead = client
        .request<RateLimitsReadResponse>("account/rateLimits/read", {})
        .then((value) => ({ value, at: Date.now() }));
      const [account, limits] = await Promise.all([
        client.request<AccountReadResponse>("account/read", { refreshToken: false }),
        limitsRead,
      ]);
      if (this.disposed || gen !== this.clientGen) return; // 그 사이 다시 연결됨(또는 종료) → 이 결과는 이전 연결 것
      if (auth !== this.authGen) {
        this.serverRerun = true; // 그 사이 계정이 바뀜 → 이 결과는 버리고 다시 읽는다
        return;
      }

      const identity = codexAccountIdentity(account.account);
      const received = windowsFromCodex(limits.value.rateLimits, limits.value.rateLimitsByLimitId, limits.at);
      // 지금 상태의 주인 계정이 미확정인데(식별 없이 값을 받음) 이번에 식별이 확인돼도 같은 계정임을 보장할 수 없으니 바뀐 것으로 본다.
      // 식별 없는 응답(계정을 읽지 못함): 지금 주인이 미확정이고 같은 로그인 구간(다시 연결·계정 변경 알림 없음)이면, 새
      // 관측이 있든 없든 그 주인의 응답으로 이어 간다(요금제·크레딧 갱신 포함). 그 밖에 새 관측을 가져오면(확인된 계정을
      // 보던 중이거나 로그인 구간이 바뀜) 누구 것인지 모르는 새 주인(미확정)으로 보고 처음부터(이전 값·기록과 비교하거나
      // 잇지 않음). 새 관측도 없으면(빈 목록·모두 옛 관측) 지킬 주인 상태(확인된 계정, 또는 표시 중인 한도·계정·요금제·
      // 크레딧)가 있을 때 그 상태를 바꾸지 않는다(이 응답의 요금제·크레딧 정보도 쓰지 않음). 지킬 것이 없으면 이 응답이 새 주인.
      const loginKey = `${gen}:${auth}`;
      const sameLogin = this.ownerLoginKey === loginKey;
      const bringsFresh = received.some((w) => this.watch.accepts(w));
      const hasOwner = Boolean(this.accountIdentity) || this.showsOwnerInfo();
      const continuesUnconfirmed = !identity && !this.accountIdentity && sameLogin;
      const accountChanged =
        Boolean(identity && this.accountIdentity && identity !== this.accountIdentity) ||
        Boolean(identity && !this.accountIdentity) ||
        (!identity && !continuesUnconfirmed && (bringsFresh || !hasOwner));
      if (accountChanged) {
        this.watch.clear(); // 실제 계정이 바뀔 때만(재연결로는 지우지 않음)
        this.accountIdentity = identity;
      } else if (identity) {
        this.accountIdentity = identity;
      }

      this.serverFailureCount = 0;
      this.serverIntervalMs = this.serverBaseMs;
      if (!accountChanged && !identity && !bringsFresh && !continuesUnconfirmed) {
        // 누구 것인지 알 수 없는 응답 — 연결·실패 상태만 갱신하고 지금 주인의 값·정보는 그대로.
        // '계정 확인 중'은 이 응답으로 해제하지 않고, 같은 로그인 구간임도 확인되지 않으면(다시 연결·계정 변경 알림) 켠다.
        this.setState({
          serverFailing: false,
          connected: true,
          connecting: false,
          error: undefined,
          serverRetrySeconds: undefined,
          accountChecking: this.state.accountChecking || (!sameLogin && this.showsOwnerInfo()),
        });
        return;
      }
      // 이 응답이 지금 상태의 주인이 된다(새 주인·같은 주인 이어감) — 그 로그인 구간을 기억한다.
      this.ownerLoginKey = loginKey;
      // 같은 창 기준에서 더 새 관측을 이미 봤으면 이전 표시 유지, 새로 받은 관측에만 노후 시각(관측 때 고정)을 붙인다.
      const staleAfterMs = Math.max(2 * this.serverBaseMs, 5 * 60_000);
      const windows = acceptObservations(this.watch, accountChanged ? undefined : this.state.limits, received, staleAfterMs);
      this.watch.observe(windows);
      // 이번 응답에서 새로 받아들인 관측만 이 계정 기록으로 저장한다(이어 둔 이전 표시값은 저장하지 않음).
      const fresh = new Set(received.map((x) => `${x.id}\u0000${x.observedAtMs}`));
      const accepted = windows.filter((x) => fresh.has(`${x.id}\u0000${x.observedAtMs}`));
      this.history?.record(historyAccountKey("codex", identity), accepted, (w) => this.watch.anchorFor(w));
      const tracked = this.watch.snapshot(windows);
      this.setState({
        account: account.account,
        requiresOpenaiAuth: account.requiresOpenaiAuth,
        planLabel: codexPlanLabel(account.account?.planType ?? limits.value.rateLimits?.planType),
        rateLimits: limits.value.rateLimits,
        rateLimitsByLimitId: limits.value.rateLimitsByLimitId,
        limits: windows,
        holds: tracked.holds,
        holdReasons: tracked.holdReasons,
        samples: this.chartSamples(windows, tracked.samples, identity),
        serverFailing: false,
        accountChecking: false,
        lastRefresh: limits.at,
        connected: true,
        connecting: false,
        error: undefined,
        serverRetrySeconds: undefined,
      });
    } catch (error) {
      // 재연결로 정리된 이전 연결의 요청 실패는 새 연결의 실패가 아니다(실패 횟수·백오프에 넣지 않음).
      // 계정 변경(account/updated) 전에 시작한 요청의 실패도 현재 계정의 실패가 아니다 → 세지 않고 다시 읽는다.
      if (!this.disposed && gen === this.clientGen && auth === this.authGen) {
        this.noteServerFailure(error as Error);
      } else if (!this.disposed && auth !== this.authGen) {
        this.serverRerun = true;
      }
    } finally {
      if (!this.disposed) this.scheduleNextServerRefresh();
    }
  }

  private async refreshLocal(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const now = Date.now();
    const extraSessionPaths = this.config().get<string[]>("codexExtraSessionPaths", []) || [];
    const [extraUsage, history] = await Promise.all([
      this.readExtraUsageCommand(),
      // 비동기 집계: 바뀐 파일의 새 꼬리만 읽고, 읽는 동안에도 확장 호스트를 멈추지 않는다.
      readCodexHistoryAsync(undefined, extraSessionPaths),
    ]);
    if (this.disposed) {
      return; // 집계 중 종료됨 → 종료된 서비스 상태를 바꾸지 않는다
    }

    const hasPreviousHistory = Boolean(this.state.history && !this.state.history.error);
    const historyFailed = Boolean(history.error);
    this.setState({
      history: historyFailed && hasPreviousHistory ? this.state.history : history,
      historyError: history.error,
      lastHistoryScanAt: now,
      lastHistoryScanOkAt: historyFailed ? this.state.lastHistoryScanOkAt : now,
      extraUsageOutput: extraUsage.output,
      extraUsageError: extraUsage.error,
    });
  }

  /**
   * 그래프의 파란 실선: 지금 기억하는 값 + 저장된 값(다시 켜기 전 포함·모든 창) — 모두 서버가 알려 준 실제 값이고,
   * 이 창(LimitWatch 가 정한 같은 창)의 시작부터 지금까지만. identity 는 이번 서버 조회로 확인한 지금 계정 —
   * 없으면 지금 기억하는 값만.
   */
  private chartSamples(
    windows: LimitWindow[],
    tracked: Record<string, LimitSample[]>,
    identity: string | null,
  ): Record<string, LimitSample[]> {
    const out: Record<string, LimitSample[]> = {};
    const key = historyAccountKey("codex", identity);
    const now = Date.now();
    for (const w of windows) {
      const live = tracked[w.id] ?? [];
      const S = windowStartOf(w);
      out[w.id] =
        S === null || !key
          ? live
          : mergeChartSamples([this.history?.pointsFor(key, w, S, now) ?? [], live], S, now);
    }
    return out;
  }

  private noteServerFailure(error: Error): void {
    this.serverFailureCount += 1;
    this.serverIntervalMs = Math.min(
      Math.max(this.serverBaseMs * 2, this.serverIntervalMs * 2),
      5 * 60_000,
    );
    const retrySeconds = Math.round(this.serverIntervalMs / 1000);
    this.output.appendLine(
      `[codex] server refresh failed (${this.serverFailureCount}): ${error.message}; retry in ${retrySeconds}s`,
    );
    this.setState({
      connected: Boolean(this.client?.isRunning),
      connecting: false,
      error: `${error.message} · 마지막 서버 값 표시 중 · 약 ${retrySeconds}초 후 재시도`,
      serverRetrySeconds: retrySeconds,
      serverFailing: true,
      // 실패(연결·조회)도 누구 것인지 알 수 없는 결과 — 지금 연결이 표시 정보를 만든 로그인 구간과 다르면(다시 연결·
      // 계정 변경 알림 뒤) 그 정보가 지금 로그인의 것이 아닐 수 있음을 알린다(해제는 주인이 정해진 응답에서만).
      accountChecking:
        this.state.accountChecking ||
        (this.ownerLoginKey !== `${this.clientGen}:${this.authGen}` && this.showsOwnerInfo()),
    });
  }

  /** 지금 화면에 어떤 계정의 것으로 보이는 정보(한도 목록·계정·요금제·크레딧)가 있는지. */
  private showsOwnerInfo(): boolean {
    const s = this.state;
    return Boolean(s.limits?.length || s.account || s.rateLimits);
  }

  private scheduleNextServerRefresh(): void {
    if (this.serverTimer) {
      clearTimeout(this.serverTimer);
    }
    if (this.disposed) {
      return;
    }
    this.serverTimer = setTimeout(() => {
      void this.refreshServer();
    }, this.serverIntervalMs);
  }

  configureTimer(): void {
    if (this.disposed) {
      return;
    }
    if (this.serverTimer) {
      clearTimeout(this.serverTimer);
    }
    if (this.localTimer) {
      clearInterval(this.localTimer);
    }

    const seconds = Math.max(10, this.config().get<number>("refreshIntervalSeconds", 60));
    this.serverBaseMs = seconds * 1000;
    this.serverIntervalMs = this.serverBaseMs;
    this.serverFailureCount = 0;
    this.scheduleNextServerRefresh();
    this.localTimer = setInterval(() => {
      void this.refreshLocal();
    }, seconds * 1000);
  }

  dispose(): void {
    this.disposed = true;
    if (this.serverTimer) {
      clearTimeout(this.serverTimer);
    }
    if (this.localTimer) {
      clearInterval(this.localTimer);
    }
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
    }
    this.clientGen += 1; // 늦게 오는 이전 연결 이벤트 무시
    this.client?.dispose();
    this.onDidChangeEmitter.dispose();
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "thread/tokenUsage/updated") {
      this.setState({ tokenUsage: params as TokenUsageNotification });
      return;
    }

    if (method === "account/rateLimits/updated") {
      // 희소 갱신 값을 직접 쓰면 옛/새 값과 창 정체(리셋 기준 이동)가 섞인다 → 전체를 다시 읽어 확정한다.
      this.requestServerReadSoon();
      return;
    }

    if (method === "account/updated") {
      this.authGen += 1; // 진행 중 조회 결과는 이전 계정 것일 수 있어 버린다
      this.setState({ accountChecking: true }); // 새 계정 값 확인 전까지 표시값이 이전 계정 것일 수 있음
      void this.refresh();
    }
  }

  private async readExtraUsageCommand(): Promise<{ output?: string; error?: string }> {
    const command = this.config().get<string>("extraUsageCommand", "").trim();
    if (!command) {
      return {};
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 1024 * 1024,
      });
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n");
      return { output: combined.slice(0, 20000) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  /**
   * 한도 변경 알림 → 첫 알림 기준 최대 notifyMaxWaitMs 안에 전체 다시 읽기(연속 알림이 계속 미루지 않음).
   * 조회 실패 중이면 백오프 재시도 예약을 따른다.
   */
  private requestServerReadSoon(): void {
    if (this.notifyTimer || this.disposed) {
      return;
    }
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      if (this.serverFailureCount === 0) void this.refreshServer();
    }, this.notifyMaxWaitMs);
  }

  private setState(patch: Partial<UsageState>): void {
    this.state = { ...this.state, ...patch };
    this.onDidChangeEmitter.fire(this.state);
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("codexUsageMonitor");
  }

  private resolveCodexCommand(configured: string): string {
    if (configured && configured !== "codex") {
      return configured;
    }

    const chatgpt = vscode.extensions.getExtension("openai.chatgpt");
    if (!chatgpt) {
      return configured || "codex";
    }

    const platformDir = process.platform === "win32"
      ? "windows-x86_64"
      : process.platform === "darwin"
        ? process.arch === "arm64" ? "macos-aarch64" : "macos-x86_64"
        : process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64";
    const executable = process.platform === "win32" ? "codex.exe" : "codex";
    const candidate = path.join(chatgpt.extensionPath, "bin", platformDir, executable);

    if (fs.existsSync(candidate)) {
      this.output.appendLine(`Using Codex executable: ${candidate}`);
      return candidate;
    }

    return configured || "codex";
  }
}

/** 계정 식별: 종류·이메일·요금제(요금제가 바뀌면 한도 창도 바뀌므로 다른 계정처럼 취급). */
function codexAccountIdentity(account: CodexAccount | null | undefined): string | null {
  if (!account) return null;
  return `${account.type}:${account.email ?? ""}:${account.planType ?? ""}`;
}
