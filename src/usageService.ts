import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { readCodexHistoryAsync } from "./codexHistory";
import { CodexRpcClient } from "./codexClient";
import { LimitTrend, mergeRateLimitSnapshot, windowsFromCodex } from "./limits";
import {
  AccountReadResponse,
  RateLimitsReadResponse,
  RateLimitSnapshot,
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
  /** 창별 사용률 추세(Claude와 같은 LimitTrend). */
  private readonly trend = new LimitTrend();
  /** 희소 갱신 알림으로 창 구성이 바뀐 듯할 때 전체 재조회를 묶는 타이머. */
  private reshapeTimer?: NodeJS.Timeout;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<UsageState>();
  private state: UsageState = {
    connected: false,
    connecting: false,
  };

  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly output: vscode.OutputChannel) {}

  get currentState(): UsageState {
    return this.state;
  }

  async start(): Promise<void> {
    await this.reconnect();
    await this.refreshLocal();
    this.configureTimer();
  }

  async reconnect(): Promise<void> {
    this.setState({ connecting: true, connected: false, error: undefined, serverRetrySeconds: undefined });
    this.client?.dispose();

    const command = this.resolveCodexCommand(this.config().get<string>("codexCommand", "codex"));
    this.client = new CodexRpcClient(command, this.output);
    this.client.on("notification", (method: string, params: unknown) => this.handleNotification(method, params));
    this.client.on("close", () => {
      this.setState({ connected: false, connecting: false, error: "Codex app-server disconnected" });
    });
    this.client.on("error", (error: Error) => {
      this.setState({ connected: false, connecting: false, error: error.message });
    });

    try {
      await this.client.start();
      this.setState({ connected: true, connecting: false, error: undefined });
      await this.refreshServer();
    } catch (error) {
      this.noteServerFailure(error as Error);
      this.setState({
        connected: false,
        connecting: false,
      });
    }
  }

  async refresh(): Promise<void> {
    await Promise.all([this.refreshServer(), this.refreshLocal()]);
  }

  private async refreshServer(): Promise<void> {
    try {
      if (!this.client?.isRunning) {
        await this.reconnect();
        return;
      }

      const [account, limits] = await Promise.all([
        this.client.request<AccountReadResponse>("account/read", { refreshToken: false }),
        this.client.request<RateLimitsReadResponse>("account/rateLimits/read", {}),
      ]);

      this.serverFailureCount = 0;
      this.serverIntervalMs = this.serverBaseMs;
      const sampledAt = Date.now();
      const windows = windowsFromCodex(limits.rateLimits, limits.rateLimitsByLimitId);
      this.trend.record(sampledAt, windows);
      this.setState({
        account: account.account,
        requiresOpenaiAuth: account.requiresOpenaiAuth,
        planLabel: codexPlanLabel(account.account?.planType ?? limits.rateLimits?.planType),
        rateLimits: limits.rateLimits,
        rateLimitsByLimitId: limits.rateLimitsByLimitId,
        limits: windows,
        projection: this.trend.projections(sampledAt, windows),
        samples: this.trend.samples(),
        lastRefresh: sampledAt,
        connected: true,
        connecting: false,
        error: undefined,
        serverRetrySeconds: undefined,
      });
    } catch (error) {
      this.noteServerFailure(error as Error);
    } finally {
      this.scheduleNextServerRefresh();
    }
  }

  private async refreshLocal(): Promise<void> {
    const now = Date.now();
    const extraSessionPaths = this.config().get<string[]>("codexExtraSessionPaths", []) || [];
    const [extraUsage, history] = await Promise.all([
      this.readExtraUsageCommand(),
      // 비동기 집계: 바뀐 파일의 새 꼬리만 읽고, 읽는 동안에도 확장 호스트를 멈추지 않는다.
      readCodexHistoryAsync(undefined, extraSessionPaths),
    ]);

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
    });
  }

  private scheduleNextServerRefresh(): void {
    if (this.serverTimer) {
      clearTimeout(this.serverTimer);
    }
    this.serverTimer = setTimeout(() => {
      void this.refreshServer();
    }, this.serverIntervalMs);
  }

  configureTimer(): void {
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
    if (this.serverTimer) {
      clearTimeout(this.serverTimer);
    }
    if (this.localTimer) {
      clearInterval(this.localTimer);
    }
    if (this.reshapeTimer) {
      clearTimeout(this.reshapeTimer);
    }
    this.client?.dispose();
    this.onDidChangeEmitter.dispose();
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "thread/tokenUsage/updated") {
      this.setState({ tokenUsage: params as TokenUsageNotification });
      return;
    }

    if (method === "account/rateLimits/updated") {
      const update = (params as { rateLimits?: RateLimitSnapshot })?.rateLimits;
      if (!update) {
        return;
      }
      // 버킷(limitId)별로 라우팅: 모델 전용 버킷의 갱신이 기본 버킷 창을 덮어쓰지 않게.
      const mainId = this.state.rateLimits?.limitId || "codex";
      const bucket = update.limitId || mainId;
      if (bucket === mainId) {
        const { snapshot, shapeChanged } = mergeRateLimitSnapshot(this.state.rateLimits, update);
        this.setState({
          rateLimits: snapshot,
          limits: windowsFromCodex(snapshot, this.state.rateLimitsByLimitId),
          lastRefresh: Date.now(),
        });
        if (shapeChanged) {
          this.scheduleReshapeRefresh();
        }
      } else {
        const byId = { ...(this.state.rateLimitsByLimitId ?? {}) };
        byId[bucket] = mergeRateLimitSnapshot(byId[bucket], update).snapshot;
        this.setState({
          rateLimitsByLimitId: byId,
          limits: windowsFromCodex(this.state.rateLimits, byId),
        });
      }
      return;
    }

    if (method === "account/updated") {
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
   * 희소 갱신에 직전에 없던 창이 왔다 = 창 구성이 바뀌었을 수 있음(예: 5시간 창 폐지/부활).
   * 희소 갱신만으로는 '사라진 창'을 알 수 없으므로 곧바로 전체 스냅샷을 다시 읽어 확정한다.
   */
  private scheduleReshapeRefresh(): void {
    if (this.reshapeTimer) {
      clearTimeout(this.reshapeTimer);
    }
    this.reshapeTimer = setTimeout(() => {
      this.reshapeTimer = undefined;
      void this.refreshServer();
    }, 2000);
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

