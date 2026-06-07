import * as vscode from "vscode";
import {
  Dashboard,
  formatClaudeStatusBar,
  formatClaudeTooltip,
  formatStatusBarText,
  formatTooltip,
} from "./dashboard";
import { UsageService } from "./usageService";
import { ClaudeService } from "./claudeService";
import { t } from "./i18n";
import { UsageState } from "./types";
import { ClaudeState } from "./claudeTypes";

function hasUsableCodex(state: UsageState): boolean {
  const history = state.history;
  return Boolean(
    state.connected ||
    state.connecting ||
    state.account ||
    state.rateLimits ||
    state.tokenUsage ||
    state.lastRefresh ||
    (history && !history.error && Number(history.filesScanned || 0) > 0),
  );
}

function hasUsableClaude(state: ClaudeState): boolean {
  return Boolean(
    state.available ||
    state.connecting ||
    state.plan ||
    state.tokens ||
    state.lastPlanRefresh ||
    state.lastTokenRefresh,
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("AI 에이전트 사용량 모니터");
  const service = new UsageService(output);
  const claude = new ClaudeService(output);
  const dashboard = new Dashboard(context.extensionUri, service, claude);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  statusBar.name = "Codex 사용량";
  statusBar.command = "codexUsageMonitor.openDashboard";

  const claudeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
  claudeStatusBar.name = "Claude 사용량";
  claudeStatusBar.command = "codexUsageMonitor.openDashboard";

  output.appendLine("AI 에이전트 사용량 모니터 activated (Codex + Claude).");

  // 사용률에 따라 상태바 배경을 경고색으로 강조한다(>=95% 빨강, >=80% 노랑).
  const warnColor = (percent: number | undefined): vscode.ThemeColor | undefined => {
    if (typeof percent !== "number") {
      return undefined;
    }
    if (percent >= 95) {
      return new vscode.ThemeColor("statusBarItem.errorBackground");
    }
    if (percent >= 80) {
      return new vscode.ThemeColor("statusBarItem.warningBackground");
    }
    return undefined;
  };

  const renderStatusBar = () => {
    const cfg = vscode.workspace.getConfiguration("codexUsageMonitor");
    const showCodex = cfg.get<boolean>("showStatusBar", true);
    const s = service.currentState;
    statusBar.text = formatStatusBarText(s);
    statusBar.tooltip = formatTooltip(s);
    const peak = Math.max(s.rateLimits?.primary?.usedPercent ?? 0, s.rateLimits?.secondary?.usedPercent ?? 0);
    statusBar.backgroundColor = warnColor(peak);
    if (showCodex && hasUsableCodex(s)) {
      statusBar.show();
    } else {
      statusBar.hide();
    }
  };

  const renderClaudeStatusBar = () => {
    const cfg = vscode.workspace.getConfiguration("codexUsageMonitor");
    const showClaude = cfg.get<boolean>("showClaudeStatusBar", true);
    const s = claude.currentState;
    claudeStatusBar.text = formatClaudeStatusBar(s);
    claudeStatusBar.tooltip = formatClaudeTooltip(s);
    const peak = Math.max(s.plan?.fiveHour?.utilization ?? 0, s.plan?.sevenDay?.utilization ?? 0);
    claudeStatusBar.backgroundColor = warnColor(peak);
    if (showClaude && hasUsableClaude(s)) {
      claudeStatusBar.show();
    } else {
      claudeStatusBar.hide();
    }
  };

  context.subscriptions.push(
    output,
    service,
    claude,
    dashboard,
    statusBar,
    claudeStatusBar,
    service.onDidChange(renderStatusBar),
    claude.onDidChange(renderClaudeStatusBar),
    vscode.commands.registerCommand("codexUsageMonitor.openDashboard", () => dashboard.show()),
    vscode.commands.registerCommand("codexUsageMonitor.refresh", () => {
      void service.refresh();
      void claude.refreshPlan(true);
      void claude.refreshTokens();
    }),
    vscode.commands.registerCommand("codexUsageMonitor.reconnect", () => service.reconnect()),
    vscode.commands.registerCommand("codexUsageMonitor.refreshClaude", () => {
      void claude.refreshPlan(true);
      void claude.refreshTokens();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexUsageMonitor.refreshIntervalSeconds")) {
        service.configureTimer();
      }
      if (event.affectsConfiguration("codexUsageMonitor.codexCommand")) {
        void service.reconnect();
      }
      if (event.affectsConfiguration("codexUsageMonitor.showStatusBar")) {
        renderStatusBar();
      }
      if (event.affectsConfiguration("codexUsageMonitor.extraUsageCommand")) {
        void service.refresh();
      }
      if (event.affectsConfiguration("codexUsageMonitor.showClaudeStatusBar")) {
        renderClaudeStatusBar();
      }
      if (
        event.affectsConfiguration("codexUsageMonitor.claudePlanRefreshSeconds") ||
        event.affectsConfiguration("codexUsageMonitor.claudeTokenRefreshSeconds")
      ) {
        claude.configureTimers();
      }
      if (
        event.affectsConfiguration("codexUsageMonitor.claudeConfigDir") ||
        event.affectsConfiguration("codexUsageMonitor.claudeExtraProjectPaths")
      ) {
        void claude.reconfigure();
      }
    }),
  );

  renderStatusBar();
  renderClaudeStatusBar();
  await Promise.all([service.start(), claude.start()]);

  const config = vscode.workspace.getConfiguration("codexUsageMonitor");
  const notified = context.globalState.get<boolean>("startupNoticeShown.v2", false);
  if (config.get<boolean>("notifyOnStartup", true) && !notified) {
    void context.globalState.update("startupNoticeShown.v2", true);
    const T = t();
    const action = T.openDashboard;
    vscode.window.showInformationMessage(T.startupNotice, action).then((selected) => {
      if (selected === action) {
        dashboard.show();
      }
    });
  }
}

export function deactivate(): void {}
