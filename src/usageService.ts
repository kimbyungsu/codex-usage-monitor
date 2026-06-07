import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { readCodexHistory } from "./codexHistory";
import { CodexRpcClient } from "./codexClient";
import {
  AccountReadResponse,
  RateLimitsReadResponse,
  RateLimitSnapshot,
  TokenUsageNotification,
  UsageState,
} from "./types";

const execAsync = promisify(exec);

export class UsageService implements vscode.Disposable {
  private client?: CodexRpcClient;
  private serverTimer?: NodeJS.Timeout;
  private localTimer?: NodeJS.Timeout;
  private serverBaseMs = 60_000;
  private serverIntervalMs = 60_000;
  private serverFailureCount = 0;
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
      this.setState({
        account: account.account,
        requiresOpenaiAuth: account.requiresOpenaiAuth,
        rateLimits: limits.rateLimits,
        rateLimitsByLimitId: limits.rateLimitsByLimitId,
        lastRefresh: Date.now(),
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
      Promise.resolve(readCodexHistory(undefined, extraSessionPaths)),
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
    this.client?.dispose();
    this.onDidChangeEmitter.dispose();
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "thread/tokenUsage/updated") {
      this.setState({ tokenUsage: params as TokenUsageNotification });
      return;
    }

    if (method === "account/rateLimits/updated") {
      const update = params as { rateLimits?: RateLimitSnapshot };
      if (update.rateLimits) {
        const merged = mergeRateLimit(this.state.rateLimits, update.rateLimits);
        this.setState({ rateLimits: merged, lastRefresh: Date.now() });
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

function mergeRateLimit(previous: RateLimitSnapshot | null | undefined, next: RateLimitSnapshot): RateLimitSnapshot {
  return {
    ...previous,
    ...next,
    primary: next.primary ? { ...previous?.primary, ...next.primary } : previous?.primary,
    secondary: next.secondary ? { ...previous?.secondary, ...next.secondary } : previous?.secondary,
    credits: next.credits ? { ...previous?.credits, ...next.credits } : previous?.credits,
    individualLimit: next.individualLimit ? { ...previous?.individualLimit, ...next.individualLimit } : previous?.individualLimit,
  };
}
