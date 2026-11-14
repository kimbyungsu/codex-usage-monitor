import * as vscode from "vscode";
import {
  Dashboard,
  formatClaudeStatusBar,
  formatClaudeTooltip,
  formatStatusBarText,
  formatTooltip,
  statusBarLevel,
} from "./dashboard";
import * as path from "path";
import { LimitHistoryStore } from "./limitHistory";
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
  // 그래프용 사용률 기록: 확장 전용 저장 폴더에, 이 VS Code 창 구분자로 된 자기 파일에만 쓴다(여러 창이 서로 덮지 않음).
  const history = new LimitHistoryStore(
    path.join(context.globalStorageUri.fsPath, "limit-history"),
    vscode.env.sessionId,
    Date.now,
    (m) => output.appendLine(m),
  );
  context.subscriptions.push({ dispose: () => history.dispose() });
  const service = new UsageService(output, history);
  const claude = new ClaudeService(output, history);
  const dashboard = new Dashboard(context.extensionUri, service, claude);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  statusBar.name = "Codex 사용량";
  statusBar.command = "codexUsageMonitor.openDashboard";

  const claudeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
  claudeStatusBar.name = "Claude 사용량";
  claudeStatusBar.command = "codexUsageMonitor.openDashboard";

  output.appendLine("AI 에이전트 사용량 모니터 activated (Codex + Claude).");

  // 상태바에 올린 한도 창의 단계로 배경을 강조한다(서버 심각도 우선, 없으면 >=95% 빨강 · >=80% 노랑).
  const warnColor = (level: 0 | 1 | 2): vscode.ThemeColor | undefined => {
    if (level >= 2) {
      return new vscode.ThemeColor("statusBarItem.errorBackground");
    }
    if (level >= 1) {
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
    statusBar.backgroundColor = warnColor(statusBarLevel(s.limits));
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
    claudeStatusBar.backgroundColor = warnColor(statusBarLevel(s.plan?.windows));
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
      if (event.affectsConfiguration("codexUsageMonitor.codexExtraSessionPaths")) {
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
  // 새 응답이 없어도 시간이 흐르면 남은 시간·리셋 경과·관측 노후·예상 시각 경과가 바뀐다 → 1분마다 다시 그림(API 호출 없음).
  const tick = setInterval(() => {
    renderStatusBar();
    renderClaudeStatusBar();
    dashboard.rerender();
  }, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(tick) });
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
