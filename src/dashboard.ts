import * as vscode from "vscode";
import * as fs from "fs";
import * as nodePath from "path";
import { UsageService } from "./usageService";
import { RateLimitSnapshot, UsageState } from "./types";
import { ClaudeService } from "./claudeService";
import { ClaudeState } from "./claudeTypes";
import { resolveLang, t, webviewStrings } from "./i18n";

export class Dashboard implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: UsageService,
    private readonly claude: ClaudeService,
  ) {
    this.disposables.push(
      this.service.onDidChange(() => this.postState()),
      this.claude.onDidChange(() => this.postState()),
    );
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.postState();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "codexUsageMonitor",
      webviewStrings(resolveLang()).pageTitle,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === "refresh") {
        void this.service.refresh();
        void this.claude.refreshPlan(true);
        void this.claude.refreshTokens();
      }
      if (message?.type === "reconnect") {
        void this.service.reconnect();
      }
      if (message?.type === "refreshClaude") {
        void this.claude.refreshPlan(true);
        void this.claude.refreshTokens();
      }
      if (message?.type === "addClaudePath" && message.path) {
        void this.addExtraPath(String(message.path));
      }
      if (message?.type === "removeClaudePath" && message.path) {
        void this.removeExtraPath(String(message.path));
      }
      if (message?.type === "browseClaudePath") {
        void this.browseExtraPath();
      }
      if (message?.type === "addCodexPath" && message.path) {
        void this.addCodexExtraPath(String(message.path));
      }
      if (message?.type === "removeCodexPath" && message.path) {
        void this.removeCodexExtraPath(String(message.path));
      }
      if (message?.type === "browseCodexPath") {
        void this.browseCodexExtraPath();
      }
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.postState();
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private postState(): void {
    this.panel?.webview.postMessage({
      type: "state",
      state: this.service.currentState,
      claude: this.claude.currentState,
      extraPaths: this.getExtraPaths(),
      codexExtraPaths: this.getCodexExtraPaths(),
    });
  }

  private getExtraPaths(): string[] {
    return (
      vscode.workspace
        .getConfiguration("codexUsageMonitor")
        .get<string[]>("claudeExtraProjectPaths", []) || []
    );
  }

  private async setExtraPaths(paths: string[]): Promise<void> {
    await vscode.workspace
      .getConfiguration("codexUsageMonitor")
      .update("claudeExtraProjectPaths", paths, vscode.ConfigurationTarget.Global);
    this.postState();
  }

  private async addExtraPath(input: string): Promise<void> {
    const T = t();
    let target = input.trim();
    if (!target) {
      return;
    }
    // 사용자가 .claude 폴더를 고르면 그 안의 projects 하위로 자동 보정.
    try {
      if (fs.existsSync(target)) {
        const projectsChild = nodePath.join(target, "projects");
        if (nodePath.basename(target).toLowerCase() === ".claude" && fs.existsSync(projectsChild)) {
          target = projectsChild;
        }
      } else {
        vscode.window.showWarningMessage(T.pathNotExist(target));
      }
    } catch {
      /* ignore */
    }
    const list = this.getExtraPaths();
    if (list.includes(target)) {
      vscode.window.showInformationMessage(T.pathAlready);
      return;
    }
    await this.setExtraPaths([...list, target]);
    vscode.window.showInformationMessage(T.pathAdded(target));
  }

  private async removeExtraPath(target: string): Promise<void> {
    await this.setExtraPaths(this.getExtraPaths().filter((p) => p !== target));
  }

  private async browseExtraPath(): Promise<void> {
    const T = t();
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: T.pickFolderLabel,
      title: T.pickFolderTitle,
    });
    if (picked && picked[0]) {
      await this.addExtraPath(picked[0].fsPath);
    }
  }

  // ---- Codex 합산 경로 (Claude 쪽과 대칭) ----

  private getCodexExtraPaths(): string[] {
    return (
      vscode.workspace
        .getConfiguration("codexUsageMonitor")
        .get<string[]>("codexExtraSessionPaths", []) || []
    );
  }

  private async setCodexExtraPaths(paths: string[]): Promise<void> {
    await vscode.workspace
      .getConfiguration("codexUsageMonitor")
      .update("codexExtraSessionPaths", paths, vscode.ConfigurationTarget.Global);
    void this.service.refresh();
    this.postState();
  }

  private async addCodexExtraPath(input: string): Promise<void> {
    const T = t();
    let target = input.trim();
    if (!target) {
      return;
    }
    // 사용자가 .codex 폴더를 고르면 그 안의 sessions 하위로 자동 보정.
    try {
      if (fs.existsSync(target)) {
        const sessionsChild = nodePath.join(target, "sessions");
        if (nodePath.basename(target).toLowerCase() === ".codex" && fs.existsSync(sessionsChild)) {
          target = sessionsChild;
        }
      } else {
        vscode.window.showWarningMessage(T.pathNotExist(target));
      }
    } catch {
      /* ignore */
    }
    const list = this.getCodexExtraPaths();
    if (list.includes(target)) {
      vscode.window.showInformationMessage(T.pathAlready);
      return;
    }
    await this.setCodexExtraPaths([...list, target]);
    vscode.window.showInformationMessage(T.pathAdded(target));
  }

  private async removeCodexExtraPath(target: string): Promise<void> {
    await this.setCodexExtraPaths(this.getCodexExtraPaths().filter((p) => p !== target));
  }

  private async browseCodexExtraPath(): Promise<void> {
    const T = t();
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: T.pickFolderLabel,
      title: T.codexPickFolderTitle,
    });
    if (picked && picked[0]) {
      await this.addCodexExtraPath(picked[0].fsPath);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const lang = resolveLang();
    const S = webviewStrings(lang);
    // </script> 조기 종료 방지 + 따옴표/역슬래시는 JSON.stringify 가 처리.
    const injected = JSON.stringify(S).replace(/</g, "\\u003c");
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "dashboard.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.js"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${S.pageTitle}</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <main class="shell">
    <section class="top">
      <h1>${S.pageTitle}</h1>
      <div class="actions">
        <button id="refresh">${S.refresh}</button>
        <button id="reconnect" class="secondary">${S.codexReconnect}</button>
      </div>
    </section>

    <section id="emptyAgents" class="card wide" style="display:none">
      <div class="value">${S.noAgentsDetected}</div>
      <div class="sub">${S.noAgentsHint}</div>
    </section>

    <div id="agentSections">
      <section id="claudeSection">
        <h2>Claude Code <span class="pill" id="claudePlan">—</span></h2>
        <div class="muted" style="margin:-4px 0 10px;font-size:12px">${S.claudeScopeNote}</div>
        <section id="claudeRoot" class="grid"></section>

        <section class="card wide" style="margin-top:12px">
          <div class="label">${S.mergeTitle}</div>
          <div style="font-size:13px">${S.mergeAuto}</div>
          <div class="muted" style="font-size:12px;margin:4px 0 10px">${S.mergeWhen}</div>
          <div class="mergebox">
            <button id="browsePath">${S.browse}</button>
            <input id="pathInput" type="text" placeholder="${S.pathPlaceholder}">
            <button id="addPath">${S.add}</button>
          </div>
          <ul id="pathList" style="list-style:none;padding:0;margin:10px 0 0"></ul>
        </section>
      </section>

      <section id="codexSection">
        <h2>Codex</h2>
        <div class="muted" style="margin:-4px 0 10px;font-size:12px">${S.codexScopeNote}</div>
        <section id="root" class="grid"></section>

        <section class="card wide" style="margin-top:12px">
          <div class="label">${S.codexMergeTitle}</div>
          <div style="font-size:13px">${S.codexMergeAuto}</div>
          <div class="muted" style="font-size:12px;margin:4px 0 10px">${S.codexMergeWhen}</div>
          <div class="mergebox">
            <button id="browseCodexPath">${S.codexBrowse}</button>
            <input id="codexPathInput" type="text" placeholder="${S.codexPathPlaceholder}">
            <button id="addCodexPath">${S.add}</button>
          </div>
          <ul id="codexPathList" style="list-style:none;padding:0;margin:10px 0 0"></ul>
        </section>
      </section>
    </div>
  </main>
  <script type="application/json" id="bootstrap">${injected}</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// ===== Codex 상태바 =====
export function formatStatusBarText(state: UsageState): string {
  if (state.connecting) {
    return "$(sync~spin) Codex";
  }
  if (!state.connected) {
    return "$(warning) Codex";
  }
  const primary = state.rateLimits?.primary;
  const secondary = state.rateLimits?.secondary;
  // 남은 % (한도) · 카운트다운은 괄호로 분리해 핵심 숫자가 또렷하게. 토큰은 대시보드/툴팁에.
  const fiveText = typeof primary?.usedPercent === "number"
    ? `5h ${remainPct(primary.usedPercent)}% (${countdownShortUnix(primary.resetsAt)})`
    : "5h ?";
  const sevenText = typeof secondary?.usedPercent === "number"
    ? `7d ${remainPct(secondary.usedPercent)}% (${countdownShortUnix(secondary.resetsAt)})`
    : "7d ?";
  return `$(pulse) Codex  ${fiveText} · ${sevenText}`;
}

export function formatTooltip(state: UsageState): string {
  const T = t();
  const parts = [state.connected ? T.codexConnected : T.codexDisconnected];
  if (state.account) {
    parts.push(`${T.codexAccount}: ${state.account.email ?? state.account.type} (${state.account.planType ?? "unknown"})`);
  }
  const primaryName = formatCodexWindowName(state.rateLimits?.primary, T.fiveHourLimit);
  const secondaryName = formatCodexWindowName(state.rateLimits?.secondary, T.sevenDayLimit);
  if (state.rateLimits?.primary) {
    const w = state.rateLimits.primary;
    parts.push(`${primaryName}: ${gaugeBar(w.usedPercent)} ${T.remainResetsIn(remainPct(w.usedPercent), countdownLongUnix(w.resetsAt), formatReset(w.resetsAt))}`);
  }
  if (state.rateLimits?.secondary) {
    const w = state.rateLimits.secondary;
    parts.push(`${secondaryName}: ${gaugeBar(w.usedPercent)} ${T.remainResetsIn(remainPct(w.usedPercent), countdownLongUnix(w.resetsAt), formatReset(w.resetsAt))}`);
  }
  if (state.tokenUsage) {
    parts.push(`${T.threadTokens}: ${state.tokenUsage.tokenUsage.total.totalTokens.toLocaleString()}`);
  }
  if (state.history) {
    parts.push(`${T.last5hLocal}: ${state.history.lastFiveHours.totalTokens.toLocaleString()}`);
    parts.push(`${T.last7dLocal}: ${state.history.lastSevenDays.totalTokens.toLocaleString()}`);
    parts.push(T.scopeShort);
  }
  if (state.historyError) {
    parts.push(`${T.error}: ${state.historyError}`);
  }
  if (state.error) {
    parts.push(`${T.error}: ${state.error}`);
  }
  return parts.join("\n");
}

// ===== Claude 상태바 =====
export function formatClaudeStatusBar(state: ClaudeState): string {
  const T = t();
  const plan = state.plan;
  const hasWindows = Boolean(plan?.fiveHour || plan?.sevenDay);
  if (!hasWindows) {
    const t7 = state.tokens?.lastSevenDays.totalTokens;
    if (typeof t7 === "number") {
      return `$(hubot) Claude 7d ${compactNumber(t7)} (${T.local})`;
    }
    if (state.connecting) {
      return "$(sync~spin) Claude";
    }
    return "$(warning) Claude";
  }
  const five = plan?.fiveHour;
  const seven = plan?.sevenDay;
  // 남은 % (한도) · 카운트다운은 괄호로 분리. 토큰은 대시보드/툴팁에.
  const fiveText = five ? `5h ${remainPct(five.utilization)}% (${countdownShort(five.resetsAt)})` : "5h ?";
  const sevenText = seven ? `7d ${remainPct(seven.utilization)}% (${countdownShort(seven.resetsAt)})` : "7d ?";
  return `$(hubot) Claude  ${fiveText} · ${sevenText}`;
}

export function formatClaudeTooltip(state: ClaudeState): string {
  const T = t();
  const parts: string[] = [];
  parts.push(
    state.subscriptionType
      ? `Claude ${state.subscriptionType}${state.rateLimitTier ? ` (${state.rateLimitTier})` : ""}`
      : T.claudeCredsMissing,
  );
  const plan = state.plan;
  if (plan?.fiveHour) {
    const u = plan.fiveHour.utilization;
    parts.push(`${T.fiveHourLimit}: ${gaugeBar(u)} ${T.remainResetsIn(remainPct(u), countdownLong(plan.fiveHour.resetsAt), formatResetIso(plan.fiveHour.resetsAt))}`);
  }
  if (plan?.sevenDay) {
    const u = plan.sevenDay.utilization;
    parts.push(`${T.sevenDayLimit}: ${gaugeBar(u)} ${T.remainResetsIn(remainPct(u), countdownLong(plan.sevenDay.resetsAt), formatResetIso(plan.sevenDay.resetsAt))}`);
  }
  if (plan?.sevenDayOpus) {
    const u = plan.sevenDayOpus.utilization;
    parts.push(`${T.weeklyOpus}: ${gaugeBar(u)} ${remainPct(u)}% ${T.remaining}`);
  }
  if (plan?.sevenDaySonnet) {
    const u = plan.sevenDaySonnet.utilization;
    parts.push(`${T.weeklySonnet}: ${gaugeBar(u)} ${remainPct(u)}% ${T.remaining}`);
  }
  const proj = state.projection;
  if (proj?.fiveHour?.reaches) {
    parts.push(`${T.fiveHourEta}: ${formatHours(proj.fiveHour.hoursToFull ?? 0)} ${T.after}`);
  }
  if (proj?.sevenDay?.reaches) {
    parts.push(`${T.sevenDayEta}: ${formatHours(proj.sevenDay.hoursToFull ?? 0)} ${T.after}`);
  }
  const tok = state.tokens;
  if (tok) {
    parts.push(`${T.recent5hTokens}: ${tok.lastFiveHours.totalTokens.toLocaleString()} ($${tok.lastFiveHours.costUsd.toFixed(2)})`);
    parts.push(`${T.recent7dTokens}: ${tok.lastSevenDays.totalTokens.toLocaleString()} ($${tok.lastSevenDays.costUsd.toFixed(2)})`);
    parts.push(`${T.currentSession}: ${tok.session.totalTokens.toLocaleString()} ${T.tokensUnit} · ${T.context} ${tok.contextTokens.toLocaleString()}`);
  }
  if (state.planRateLimited) {
    parts.push(`⏳ ${state.planRateLimited}`);
  }
  if (state.planError) {
    parts.push(`${T.plan}: ${state.planError}`);
  }
  if (state.tokenError) {
    parts.push(`${T.token}: ${state.tokenError}`);
  }
  return parts.join("\n");
}

/** 사용률(used%) → 남은 % (0~100). 상태바·툴팁은 "남은 한도"를 보여준다. */
function remainPct(used: number | null | undefined): number {
  const u = Number(used);
  return isFinite(u) ? Math.max(0, 100 - Math.round(u)) : 0;
}

/**
 * 사용률(used%)을 게이지 막대로 표현. 채워질수록 소진 → 100%면 10칸 가득(=다 씀).
 * 빈 칸 = 남은 양(옆의 "X% 남음"과 시각적으로 일치). 기본 10칸=10% 해상도, 반칸(▌) 지원. 툴팁 전용.
 */
function gaugeBar(used: number | null | undefined, cells = 10): string {
  const u = Math.max(0, Math.min(100, Number(used) || 0));
  const exact = (u / 100) * cells;
  let full = Math.floor(exact);
  const frac = exact - full;
  let half = false;
  if (frac >= 0.75) {
    full += 1; // 거의 한 칸 → 한 칸으로 올림
  } else if (frac >= 0.25) {
    half = true; // 애매한 값 → 반칸
  }
  full = Math.min(full, cells);
  const empty = Math.max(0, cells - full - (half ? 1 : 0));
  return "█".repeat(full) + (half ? "▌" : "") + "░".repeat(empty);
}

/** ISO reset 시각 → 표시 문자열 (Claude용; Codex는 formatReset(unix초) 사용). */
function formatResetIso(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : t().unknown;
}

function formatCodexWindowName(window: RateLimitSnapshot["primary"], fallback: string): string {
  const T = t();
  const mins = Number(window?.windowDurationMins || 0);
  if (mins > 0 && mins <= 360) return T.fiveHourLimit;
  if (mins >= 6 * 24 * 60) return T.sevenDayLimit;
  return fallback;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(value);
}

function countdownShort(iso: string | null | undefined): string {
  if (!iso) return "?";
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return t().soon;
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${mm}m`;
  return `${mm}m`;
}

function countdownLong(iso: string | null | undefined): string {
  const T = t();
  if (!iso) return T.unknown;
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return T.soon;
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return T.dh(d, h);
  if (h > 0) return T.hm(h, mm);
  return T.m(mm);
}

function countdownShortUnix(seconds: number | null | undefined): string {
  if (!seconds) return "?";
  return countdownShort(new Date(seconds * 1000).toISOString());
}

function countdownLongUnix(seconds: number | null | undefined): string {
  if (!seconds) return t().unknown;
  return countdownLong(new Date(seconds * 1000).toISOString());
}

function formatReset(resetsAt: number | null | undefined): string {
  return resetsAt ? new Date(resetsAt * 1000).toLocaleString() : t().unknown;
}

function formatHours(hours: number): string {
  const T = t();
  if (!isFinite(hours) || hours < 0) {
    return T.unknown;
  }
  if (hours >= 24) {
    return T.dh(Math.floor(hours / 24), Math.round(hours % 24));
  }
  if (hours >= 1) {
    return T.hm(Math.floor(hours), Math.round((hours % 1) * 60));
  }
  return T.m(Math.max(1, Math.round(hours * 60)));
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
