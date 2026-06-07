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
  <style>
    :root {
      color-scheme: light dark;
      --border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
      --bg-soft: var(--vscode-sideBar-background);
      --accent: var(--vscode-charts-blue);
      --warn: var(--vscode-charts-yellow);
      --danger: var(--vscode-charts-red);
    }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .shell { max-width: 1040px; margin: 0 auto; padding: 20px; }
    .top {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; margin-bottom: 16px;
    }
    h1 { margin: 0; font-size: 20px; font-weight: 600; }
    h2 {
      margin: 26px 0 10px; font-size: 15px; font-weight: 600;
      display: flex; align-items: center; gap: 8px;
    }
    h2 .pill {
      font-size: 11px; font-weight: 500; color: var(--muted);
      border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px;
    }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    button {
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      border: 0; border-radius: 4px; padding: 6px 10px; cursor: pointer; font: inherit;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .card {
      border: 1px solid var(--border); border-radius: 6px; padding: 14px;
      background: var(--bg-soft); min-width: 0;
    }
    .card.wide { grid-column: 1 / -1; }
    .label { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .value { font-size: 18px; font-weight: 600; word-break: break-word; }
    .sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; margin: 10px 0;
    }
    .bar {
      height: 8px; border-radius: 4px; overflow: hidden;
      background: var(--vscode-input-background); border: 1px solid var(--border);
    }
    .fill { height: 100%; width: 0; background: var(--accent); }
    .fill.warn { background: var(--warn); }
    .fill.danger { background: var(--danger); }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td {
      text-align: right; border-bottom: 1px solid var(--border);
      padding: 7px 6px; white-space: nowrap;
    }
    th:first-child, td:first-child { text-align: left; width: 28%; }
    pre {
      white-space: pre-wrap; overflow-wrap: anywhere; margin: 0;
      max-height: 280px; overflow: auto; color: var(--vscode-editor-foreground);
    }
    .muted { color: var(--muted); }
    .error { color: var(--danger); }
    @media (max-width: 720px) {
      .shell { padding: 14px; }
      .top { align-items: flex-start; flex-direction: column; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
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
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <button id="browsePath">${S.browse}</button>
            <input id="pathInput" type="text" placeholder="${S.pathPlaceholder}" style="flex:1;min-width:240px;padding:6px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--border);border-radius:4px;font:inherit">
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
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <button id="browseCodexPath">${S.codexBrowse}</button>
            <input id="codexPathInput" type="text" placeholder="${S.codexPathPlaceholder}" style="flex:1;min-width:240px;padding:6px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--border);border-radius:4px;font:inherit">
            <button id="addCodexPath">${S.add}</button>
          </div>
          <ul id="codexPathList" style="list-style:none;padding:0;margin:10px 0 0"></ul>
        </section>
      </section>
    </div>
  </main>
  <script nonce="${nonce}">
    const S = ${injected};
    const vscode = acquireVsCodeApi();
    const root = document.getElementById("root");
    const claudeRoot = document.getElementById("claudeRoot");
    const claudePlan = document.getElementById("claudePlan");
    const codexSection = document.getElementById("codexSection");
    const claudeSection = document.getElementById("claudeSection");
    const agentSections = document.getElementById("agentSections");
    const emptyAgents = document.getElementById("emptyAgents");
    document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    document.getElementById("reconnect").addEventListener("click", () => vscode.postMessage({ type: "reconnect" }));

    // --- 다른 환경 합치기 (입력 영역은 재렌더되지 않는 정적 요소) ---
    const pathInput = document.getElementById("pathInput");
    const pathList = document.getElementById("pathList");
    document.getElementById("browsePath").addEventListener("click", () => vscode.postMessage({ type: "browseClaudePath" }));
    function submitPath() {
      const v = (pathInput.value || "").trim();
      if (v) { vscode.postMessage({ type: "addClaudePath", path: v }); pathInput.value = ""; }
    }
    document.getElementById("addPath").addEventListener("click", submitPath);
    pathInput.addEventListener("keydown", e => { if (e.key === "Enter") submitPath(); });
    pathList.addEventListener("click", e => {
      const btn = e.target.closest("[data-remove]");
      if (btn) vscode.postMessage({ type: "removeClaudePath", path: btn.getAttribute("data-remove") });
    });
    function renderPaths(list) {
      if (!list || !list.length) {
        pathList.innerHTML = '<li class="muted" style="font-size:12px">' + S.noPaths + '</li>';
        return;
      }
      pathList.innerHTML = list.map(p =>
        '<li style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;margin-bottom:6px">' +
        '<span style="word-break:break-all;font-size:12px">' + escapeHtml(p) + '</span>' +
        '<button class="secondary" data-remove="' + escapeHtml(p) + '">' + S.remove + '</button></li>'
      ).join("");
    }

    // --- Codex 다른 환경 합치기 (Claude 쪽과 대칭) ---
    const codexPathInput = document.getElementById("codexPathInput");
    const codexPathList = document.getElementById("codexPathList");
    document.getElementById("browseCodexPath").addEventListener("click", () => vscode.postMessage({ type: "browseCodexPath" }));
    function submitCodexPath() {
      const v = (codexPathInput.value || "").trim();
      if (v) { vscode.postMessage({ type: "addCodexPath", path: v }); codexPathInput.value = ""; }
    }
    document.getElementById("addCodexPath").addEventListener("click", submitCodexPath);
    codexPathInput.addEventListener("keydown", e => { if (e.key === "Enter") submitCodexPath(); });
    codexPathList.addEventListener("click", e => {
      const btn = e.target.closest("[data-remove]");
      if (btn) vscode.postMessage({ type: "removeCodexPath", path: btn.getAttribute("data-remove") });
    });
    function renderCodexPaths(list) {
      if (!list || !list.length) {
        codexPathList.innerHTML = '<li class="muted" style="font-size:12px">' + S.codexNoPaths + '</li>';
        return;
      }
      codexPathList.innerHTML = list.map(p =>
        '<li style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;margin-bottom:6px">' +
        '<span style="word-break:break-all;font-size:12px">' + escapeHtml(p) + '</span>' +
        '<button class="secondary" data-remove="' + escapeHtml(p) + '">' + S.remove + '</button></li>'
      ).join("");
    }

    window.addEventListener("message", event => {
      if (event.data?.type === "state") {
        const codexState = event.data.state || {};
        const claudeState = event.data.claude || {};
        layoutAgents(codexState, claudeState);
        renderCodex(codexState);
        renderClaude(claudeState);
        renderPaths(event.data.extraPaths || []);
        renderCodexPaths(event.data.codexExtraPaths || []);
      }
    });

    function hasUsableCodex(state) {
      const history = state.history || {};
      return Boolean(
        state.connected ||
        state.connecting ||
        state.account ||
        state.rateLimits ||
        state.tokenUsage ||
        state.lastRefresh ||
        (history && !history.error && Number(history.filesScanned || 0) > 0)
      );
    }

    function hasUsableClaude(state) {
      return Boolean(
        state.available ||
        state.connecting ||
        state.plan ||
        state.tokens ||
        state.lastPlanRefresh ||
        state.lastTokenRefresh
      );
    }

    function layoutAgents(codexState, claudeState) {
      const showCodex = hasUsableCodex(codexState);
      const showClaude = hasUsableClaude(claudeState);
      codexSection.style.display = showCodex ? "" : "none";
      claudeSection.style.display = showClaude ? "" : "none";
      emptyAgents.style.display = showCodex || showClaude ? "none" : "";
      if (showCodex && !showClaude) {
        agentSections.insertBefore(codexSection, claudeSection);
      } else {
        agentSections.insertBefore(claudeSection, codexSection);
      }
    }

    // ---------- Claude ----------
    function renderClaude(s) {
      claudePlan.textContent = s.subscriptionType ? (s.subscriptionType + (s.rateLimitTier ? " · " + s.rateLimitTier : "")) : S.notConnected;
      const plan = s.plan || {};
      const tok = s.tokens || {};
      const cards = [];
      const proj = s.projection || {};
      // 429는 알림 카드가 아니라 상단의 작고 차분한 상태 문구로만 표시.
      if (s.planRateLimited) {
        cards.push('<div class="sub" style="grid-column:1/-1;margin:0">⏳ ' + escapeHtml(s.planRateLimited) + '</div>');
      }
      cards.push(windowCard(S.fiveHourLimit, plan.fiveHour, tok.lastFiveHours, proj.fiveHour));
      cards.push(windowCard(S.weeklyLimit, plan.sevenDay, tok.lastSevenDays, proj.sevenDay));
      if (plan.sevenDayOpus) cards.push(windowCard(S.weeklyOpusLimit, plan.sevenDayOpus, null));
      if (plan.sevenDaySonnet) cards.push(windowCard(S.weeklySonnetLimit, plan.sevenDaySonnet, null));
      cards.push(card(S.sessionCard, sessionHtml(tok, s)));
      cards.push(card(S.local7dCard, claudeLocalTokensHtml(tok, s), "wide"));
      cards.push(card(S.costCard, costHtml(tok)));
      cards.push(card(S.byModelCard, byModelHtml(tok), "wide"));
      cards.push(card(S.codexThreadsTitle, claudeThreadsHtml(tok), "wide"));
      if (s.planError) cards.push(card(S.planAlert, '<div class="error">' + escapeHtml(s.planError) + '</div>', "wide"));
      if (s.tokenError) cards.push(card(S.tokenAlert, '<div class="error">' + escapeHtml(s.tokenError) + '</div>', "wide"));
      if (!s.available && !s.planError && !s.tokenError) {
        cards.push(card(S.status, '<div class="value">' + S.lookingCreds + '</div>', "wide"));
      }
      claudeRoot.innerHTML = cards.join("");
    }

    function windowCard(title, win, tokenBucket, proj) {
      if (!win) {
        return card(title, '<div class="value muted">' + S.notApplicable + '</div>');
      }
      const used = Number(win.utilization || 0);
      const cls = used >= 90 ? "danger" : used >= 70 ? "warn" : "";
      const reset = win.resetsAt ? S.resetsUntil + ' ' + countdown(win.resetsAt) + ' (' + new Date(win.resetsAt).toLocaleString() + ')' : S.noResetTime;
      const tokenLine = tokenBucket
        ? '<div class="sub">' + S.thisPcTokens + ' ' + compact(tokenBucket.totalTokens) + ' · $' + money(tokenBucket.costUsd) + '</div>'
        : '';
      const projLine = proj
        ? (proj.reaches
            ? '<div class="sub">' + S.byTrend + ' ' + projText(proj) + '</div>'
            : '<div class="sub">' + S.noReachWindow + '</div>')
        : '';
      return card(title,
        '<div class="row"><div class="value">' + used + S.usedSuffix + '</div></div>' +
        '<div class="bar"><div class="fill ' + cls + '" style="width:' + clamp(used,0,100) + '%"></div></div>' +
        '<div class="sub">' + escapeHtml(reset) + '</div>' + tokenLine + projLine);
    }

    function projText(proj) {
      const h = Number(proj.hoursToFull || 0);
      const eta = proj.etaMs ? " (" + new Date(proj.etaMs).toLocaleTimeString() + ")" : "";
      let dur;
      if (h >= 24) dur = Math.floor(h / 24) + S.dayN + " " + Math.round(h % 24) + S.hourN;
      else if (h >= 1) dur = Math.floor(h) + S.hourN + " " + Math.round((h % 1) * 60) + S.minN;
      else dur = Math.max(1, Math.round(h * 60)) + S.minN;
      return S.about + " " + dur + " " + S.afterExhaust + eta;
    }

    function sessionHtml(tok, state) {
      const s = tok.session;
      if (!s) return '<div class="value muted">' + S.noSession + '</div>';
      const model = tok.sessionModel ? '<div class="sub">' + S.model + ' ' + escapeHtml(tok.sessionModel) + '</div>' : '';
      const updated = state.lastTokenRefresh ? '<div class="sub">' + S.lastUpdate + ' ' + new Date(state.lastTokenRefresh).toLocaleString() + '</div>' : '';
      return '<div class="value">' + compact(s.totalTokens) + ' ' + S.tokensUnit + '</div>' +
        '<div class="sub">' + S.contextOccupied + ' ' + compact(tok.contextTokens) + '</div>' + model + updated;
    }

    function costHtml(tok) {
      const wk = tok.lastSevenDays, today = tok.today, h5 = tok.lastFiveHours;
      if (!wk) return '<div class="value muted">' + S.noData + '</div>';
      return '<div class="value">$' + money(wk.costUsd) + ' <span class="muted" style="font-size:12px">' + S.per7d + '</span></div>' +
        '<div class="sub">' + S.today + ' $' + money(today ? today.costUsd : 0) + ' · ' + S.last5h + ' $' + money(h5 ? h5.costUsd : 0) + ' · ' + S.days7tokens + ' ' + compact(wk.totalTokens) + '</div>';
    }

    function claudeLocalTokensHtml(tok, state) {
      if (!tok.lastSevenDays) return '<div class="value muted">' + S.noData + '</div>';
      return '<div class="value">' + compact(tok.lastSevenDays.totalTokens) + ' ' + S.tokensUnit + '</div>' +
        '<div class="sub">' + S.secToday + ' ' + compact(tok.today?.totalTokens) + ' · ' + S.secLast5h + ' ' + compact(tok.lastFiveHours?.totalTokens) + ' · ' + S.secCurrentThread + ' ' + compact(tok.session?.totalTokens) + '</div>' +
        '<table style="margin-top:8px"><thead><tr><th>' + S.colSection + '</th><th>' + S.colTokens + '</th><th>' + S.colInput + '</th><th>' + S.colCache + '</th><th>' + S.colOutput + '</th></tr></thead><tbody>' +
        claudeBucketRow(S.secLast7, tok.lastSevenDays) +
        claudeBucketRow(S.secToday, tok.today) +
        claudeBucketRow(S.secLast5h, tok.lastFiveHours) +
        claudeBucketRow(S.secCurrentThread, tok.session) +
        '</tbody></table>' +
        (state.lastTokenRefresh ? '<div class="sub">' + S.lastUpdate + ' ' + new Date(state.lastTokenRefresh).toLocaleString() + '</div>' : '');
    }

    function claudeBucketRow(label, bucket) {
      const b = bucket || {};
      return '<tr><td>' + escapeHtml(label) + '</td><td>' + compact(b.totalTokens) + '</td><td>' + compact(b.inputTokens) + '</td><td>' + compact((b.cacheReadTokens || 0) + (b.cacheCreationTokens || 0)) + '</td><td>' + compact(b.outputTokens) + '</td></tr>';
    }

    function byModelHtml(tok) {
      const list = (tok.byModel || []).filter(m => (m.weekTokens || 0) > 0).sort((a, b) => b.weekTokens - a.weekTokens);
      if (!list.length) return '<div class="value muted">' + S.no7dUse + '</div>';
      return '<div class="sub">' + S.byModelNote + '</div>' +
        '<table><thead><tr><th>' + S.model + '</th><th>' + S.col7dTokens + '</th><th>' + S.col7dCost + '</th><th>' + S.colInput + '</th><th>' + S.colCache + '</th><th>' + S.colOutput + '</th></tr></thead><tbody>' +
        list.map(m => '<tr><td>' + escapeHtml(m.model) + '</td><td>' + compact(m.weekTokens) + '</td><td>$' + money(m.weekCostUsd) + '</td><td>' + compact(m.weekInputTokens) + '</td><td>' + compact(m.weekCacheTokens) + '</td><td>' + compact(m.weekOutputTokens) + '</td></tr>').join('') +
        '</tbody></table>';
    }

    // Claude 최근 스레드(이 PC · 최근 7일) — Codex codexThreadsHtml 와 대칭.
    function claudeThreadsHtml(tok) {
      const list = (tok.recentThreads || []).slice(0, 8);
      if (!list.length) return '<div class="value muted">' + S.no7dThreads + '</div>';
      return '<div class="sub">' + S.threadsNote + '</div>' +
        '<table><thead><tr><th>' + S.colThread + '</th><th>' + S.col7dTokens + '</th><th>' + S.colModel + '</th><th>' + S.colEvents + '</th><th>' + S.colUpdated + '</th></tr></thead><tbody>' +
        list.map(t => '<tr><td title="' + escapeHtml(t.threadId) + '">' + escapeHtml(shortThreadTitle(t)) + '</td><td>' + compact(t.lastSevenDays?.totalTokens) + '</td><td>' + escapeHtml(t.model || S.unknownModel) + '</td><td>' + compact(t.events) + '</td><td>' + (t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '-') + '</td></tr>').join('') +
        '</tbody></table>';
    }

    // ---------- Codex ----------
    function renderCodex(state) {
      const limit = state.rateLimits || {};
      const token = state.tokenUsage?.tokenUsage;
      const account = state.account;
      const history = state.history || {};
      const proj = state.projection || {};
      root.innerHTML = [
        card(S.account, accountHtml(account, state)),
        limitCard(codexLimitTitle(limit.primary, S.fiveHourLimit), limit.primary, history.lastFiveHours, proj.primary),
        limitCard(codexLimitTitle(limit.secondary, S.sevenDayLimitCodex), limit.secondary, history.lastSevenDays, proj.secondary),
        card(S.sessionCard, codexSessionHtml(token, history, state)),
        card(S.codexHistTitle, codexHistorySummaryHtml(history, state), "wide"),
        card(S.codexModelTitle, codexModelHtml(history), "wide"),
        card(S.codexThreadsTitle, codexThreadsHtml(history), "wide"),
        card(S.connection, connectionHtml(state)),
        card(S.credits, creditsHtml(limit)),
        card(S.spendLimit, spendHtml(limit.individualLimit)),
        card(S.recentTokens, tokenHtml(token), "wide"),
        card(S.customCmd, extraHtml(state), "wide"),
      ].join("");
    }

    function connectionHtml(state) {
      const status = state.connecting ? S.connecting : state.connected ? S.connected : S.disconnected;
      const last = state.lastRefresh ? new Date(state.lastRefresh).toLocaleString() : S.notRefreshed;
      const error = state.error ? '<div class="error">' + escapeHtml(state.error) + '</div>' : "";
      return '<div class="value">' + status + '</div><div class="muted">' + escapeHtml(last) + '</div>' + error;
    }
    function accountHtml(account, state) {
      if (!account) return '<div class="value">' + S.noAccount + '</div><div class="muted">requiresOpenaiAuth: ' + Boolean(state.requiresOpenaiAuth) + '</div>';
      const email = account.email ? '<div class="muted">' + escapeHtml(account.email) + '</div>' : "";
      return '<div class="value">' + escapeHtml(account.planType || account.type || "Unknown") + '</div>' + email;
    }
    function codexLimitTitle(win, fallback) {
      const mins = Number(win?.windowDurationMins || 0);
      if (mins > 0 && mins <= 360) return S.fiveHourLimit;
      if (mins >= 6 * 24 * 60) return S.sevenDayLimitCodex;
      return fallback;
    }
    function limitCard(title, win, tokenBucket, proj) {
      if (!win) return card(title, '<div class="value muted">' + S.noLimitInfo + '</div><div class="sub">' + S.noLimitSub + '</div>');
      const used = Number(win.usedPercent || 0);
      const cls = used >= 90 ? "danger" : used >= 70 ? "warn" : "";
      const reset = win.resetsAt
        ? S.resetsUntil + ' ' + countdownUnix(win.resetsAt) + ' (' + new Date(win.resetsAt * 1000).toLocaleString() + ')'
        : S.noResetTime;
      const duration = win.windowDurationMins ? " · " + formatDuration(win.windowDurationMins) : "";
      const tokenLine = tokenBucket
        ? '<div class="sub">' + S.sameWindowLocal + ' ' + compact(tokenBucket.totalTokens) + ' ' + S.tokensUnit + '</div>'
        : '';
      const projLine = proj
        ? (proj.reaches
            ? '<div class="sub">' + S.byTrend + ' ' + projText(proj) + '</div>'
            : '<div class="sub">' + S.noReachWindow + '</div>')
        : '';
      return card(title,
        '<div class="row"><div class="value">' + used + S.usedSuffix + '</div></div>' +
        '<div class="bar"><div class="fill ' + cls + '" style="width:' + clamp(used, 0, 100) + '%"></div></div>' +
        '<div class="sub">' + escapeHtml(reset + duration) + '</div>' + tokenLine + projLine);
    }
    function creditsHtml(limit) {
      const credits = limit.credits;
      if (!credits) return '<div class="value">' + S.noData + '</div>';
      const balance = credits.balance == null ? S.unknownBalance : S.balance + ' ' + credits.balance;
      const state = credits.unlimited ? S.unlimited : credits.hasCredits ? S.available : S.noCredits;
      return '<div class="value">' + escapeHtml(state) + '</div><div class="muted">' + escapeHtml(balance) + '</div>';
    }
    function spendHtml(limit) {
      if (!limit) return '<div class="value">' + S.noData + '</div>';
      const reset = limit.resetsAt ? new Date(limit.resetsAt * 1000).toLocaleString() : S.noResetTime;
      return '<div class="value">' + escapeHtml(limit.used) + ' / ' + escapeHtml(limit.limit) + '</div><div class="muted">' + limit.remainingPercent + S.remainingMid + ' ' + escapeHtml(reset) + '</div>';
    }
    function tokenHtml(token) {
      if (!token) return '<div class="value">' + S.waitingTokens + '</div><div class="muted">' + S.waitingTokensSub + '</div>';
      return '<table><thead><tr><th>' + S.colScope + '</th><th>' + S.colTotal + '</th><th>' + S.colInput + '</th><th>' + S.colCache + '</th><th>' + S.colOutput + '</th><th>' + S.colReasoning + '</th></tr></thead><tbody>' +
        tokenRow(S.lastTurn, token.last) + tokenRow(S.threadTotal, token.total) +
        '</tbody></table>' + (token.modelContextWindow ? '<div class="muted">' + S.contextWindow + ' ' + compact(token.modelContextWindow) + '</div>' : '');
    }
    function tokenRow(label, usage) {
      return '<tr><td>' + escapeHtml(label) + '</td><td>' + compact(usage.totalTokens) + '</td><td>' + compact(usage.inputTokens) + '</td><td>' + compact(usage.cachedInputTokens) + '</td><td>' + compact(usage.outputTokens) + '</td><td>' + compact(usage.reasoningOutputTokens) + '</td></tr>';
    }
    function codexSessionHtml(token, history, state) {
      const liveTotal = token?.total?.totalTokens;
      const localSession = history?.session || {};
      const total = typeof liveTotal === "number" ? liveTotal : Number(localSession.totalTokens || history?.contextTokens || 0);
      if (!total) return '<div class="value muted">' + S.noSession + '</div>';
      const windowSize = Number(token?.modelContextWindow || history?.modelContextWindow || 0);
      const liveLast = token?.last || {};
      const liveContext = Number(liveLast.inputTokens || 0) + Number(liveLast.cachedInputTokens || 0);
      const historyContext = Number(history?.contextTokens || 0);
      const context = liveContext > 0
        ? liveContext
        : historyContext > 0 && (!windowSize || historyContext <= windowSize * 1.2)
          ? historyContext
          : 0;
      const contextLine = context > 0
        ? S.contextOccupied + ' ' + compact(context) + (windowSize ? ' / ' + compact(windowSize) : '')
        : windowSize
          ? S.contextWindow + ' ' + compact(windowSize)
          : '';
      const model = history?.sessionModel ? '<div class="sub">' + S.model + ' ' + escapeHtml(history.sessionModel) + '</div>' : '';
      const updatedAt = state.lastHistoryScanOkAt || history?.lastScannedAt;
      const updated = updatedAt ? '<div class="sub">' + S.lastUpdate + ' ' + new Date(updatedAt).toLocaleString() + '</div>' : '';
      return '<div class="value">' + compact(total) + ' ' + S.tokensUnit + '</div>' +
        (contextLine ? '<div class="sub">' + contextLine + '</div>' : '') + model + updated;
    }
    function codexHistorySummaryHtml(history, state) {
      if (!history || history.error) {
        return '<div class="value muted">' + S.noLocalHistory + '</div><div class="sub">' + escapeHtml(history?.error || S.codexLogNotRead) + '</div>';
      }
      const week = history.lastSevenDays || {};
      const scanNotice = state.historyError
        ? '<div class="sub">⏳ ' + S.localScanFailed + ' · ' + escapeHtml(state.historyError) + '</div>'
        : '';
      return '<div class="value">' + compact(week.totalTokens) + ' ' + S.tokensUnit + ' <span class="muted" style="font-size:12px">' + S.secLast7 + '</span></div>' +
        '<div class="sub">' + S.secLast7 + ' ' + compact(week.totalTokens) + ' ' + S.tokensUnit + ' · ' + S.secToday + ' ' + compact(history.today?.totalTokens) + ' · ' + S.secLast5h + ' ' + compact(history.lastFiveHours?.totalTokens) + ' · ' + S.secCurrentThread + ' ' + compact(history.session?.totalTokens) + '</div>' +
        scanNotice +
        '<div class="sub">' + S.codexHistNote + '</div>' +
        '<table style="margin-top:8px"><thead><tr><th>' + S.colSection + '</th><th>' + S.colTokens + '</th><th>' + S.colInput + '</th><th>' + S.colCache + '</th><th>' + S.colOutput + '</th><th>' + S.colReasoning + '</th></tr></thead><tbody>' +
        codexBucketRow(S.secLast7, history.lastSevenDays) +
        codexBucketRow(S.secToday, history.today) +
        codexBucketRow(S.secLast5h, history.lastFiveHours) +
        codexBucketRow(S.secCurrentThread, history.session) +
        '</tbody></table>' +
        '<div class="sub">' + S.filesScanned + ' ' + compact(history.filesScanned || 0) +
        ' · ' + S.lastScan + ' ' + (history.lastScannedAt ? new Date(history.lastScannedAt).toLocaleString() : '-') +
        ' · ' + S.currentThreadCum + ' ' + compact(history.contextTokens || 0) +
        (history.modelContextWindow ? ' / ' + compact(history.modelContextWindow) : '') +
        (history.sessionModel ? ' · ' + S.model + ' ' + escapeHtml(history.sessionModel) : '') +
        '</div>';
    }
    function codexBucketRow(label, bucket) {
      const b = bucket || {};
      return '<tr><td>' + escapeHtml(label) + '</td><td>' + compact(b.totalTokens) + '</td><td>' + compact(b.inputTokens) + '</td><td>' + compact(b.cachedInputTokens) + '</td><td>' + compact(b.outputTokens) + '</td><td>' + compact(b.reasoningOutputTokens) + '</td></tr>';
    }
    function codexModelHtml(history) {
      const list = (history?.byModel || []).filter(m => (m.totalTokens || 0) > 0).slice(0, 10);
      if (!list.length) return '<div class="value muted">' + S.no7dUse + '</div>';
      return '<div class="sub">' + S.codexModelNote + '</div>' +
        '<table><thead><tr><th>' + S.model + '</th><th>' + S.col7dTokens + '</th><th>' + S.colInput + '</th><th>' + S.colCache + '</th><th>' + S.colOutReason + '</th><th>' + S.colEvents + '</th></tr></thead><tbody>' +
        list.map(m => '<tr><td>' + escapeHtml(m.model || S.unknownModel) + '</td><td>' + compact(m.totalTokens) + '</td><td>' + compact(m.inputTokens) + '</td><td>' + compact(m.cachedInputTokens) + '</td><td>' + compact((m.outputTokens || 0) + (m.reasoningOutputTokens || 0)) + '</td><td>' + compact(m.events) + '</td></tr>').join('') +
        '</tbody></table>';
    }
    function codexThreadsHtml(history) {
      const list = (history?.recentThreads || []).slice(0, 8);
      if (!list.length) return '<div class="value muted">' + S.no7dThreads + '</div>';
      return '<div class="sub">' + S.threadsNote + '</div>' +
        '<table><thead><tr><th>' + S.colThread + '</th><th>' + S.col7dTokens + '</th><th>' + S.colModel + '</th><th>' + S.colEvents + '</th><th>' + S.colUpdated + '</th></tr></thead><tbody>' +
        list.map(t => '<tr><td title="' + escapeHtml(t.threadId) + '">' + escapeHtml(shortThreadTitle(t)) + '</td><td>' + compact(t.lastSevenDays?.totalTokens) + '</td><td>' + escapeHtml(t.model || S.unknownModel) + '</td><td>' + compact(t.events) + '</td><td>' + (t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '-') + '</td></tr>').join('') +
        '</tbody></table>';
    }
    function shortThreadTitle(t) {
      const text = t.title || t.threadId || '';
      return text.length > 34 ? text.slice(0, 31) + '...' : text;
    }
    function extraHtml(state) {
      if (state.extraUsageError) return '<pre class="error">' + escapeHtml(state.extraUsageError) + '</pre>';
      if (state.extraUsageOutput) return '<pre>' + escapeHtml(state.extraUsageOutput) + '</pre>';
      return '<div class="value">' + S.notConfigured + '</div><div class="muted">' + S.customCmdHint + '</div>';
    }

    // ---------- shared ----------
    function card(title, body, kind = "") {
      return '<article class="card ' + kind + '"><div class="label">' + escapeHtml(title) + '</div>' + body + '</article>';
    }
    function formatDuration(minutes) {
      if (minutes >= 1440) return Math.round(minutes / 1440) + S.dayWindow;
      if (minutes >= 60) return Math.round(minutes / 60) + S.hourWindow;
      return minutes + S.minWindow;
    }
    function countdown(iso) {
      const ms = new Date(iso).getTime() - Date.now();
      if (!isFinite(ms) || ms <= 0) return S.soon;
      const m = Math.floor(ms / 60000);
      const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
      if (d > 0) return d + S.dayN + " " + h + S.hourN;
      if (h > 0) return h + S.hourN + " " + mm + S.minN;
      return mm + S.minN;
    }
    function countdownUnix(seconds) {
      if (!seconds) return S.soon;
      return countdown(new Date(seconds * 1000).toISOString());
    }
    function compact(value) {
      const v = Number(value || 0);
      if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
      if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
      if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
      return String(v);
    }
    function money(value) {
      const v = Number(value || 0);
      return v >= 100 ? v.toFixed(0) : v.toFixed(2);
    }
    function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
  </script>
</body>
</html>`;
  }
}

// ===== Codex 상태바 =====
export function formatStatusBarText(state: UsageState): string {
  const T = t();
  if (state.connecting) {
    return "$(sync~spin) Codex";
  }
  if (!state.connected) {
    return "$(warning) Codex";
  }
  const primary = state.rateLimits?.primary;
  const secondary = state.rateLimits?.secondary;
  const tokens = state.tokenUsage?.tokenUsage.total.totalTokens;
  const localFive = state.history?.lastFiveHours.totalTokens;
  const localSeven = state.history?.lastSevenDays.totalTokens;
  const fiveText = primary ? `5h ${formatUsed(primary)}·${countdownShortUnix(primary.resetsAt)}` : "5h ?";
  const sevenText = secondary ? `7d ${formatUsed(secondary)}·${countdownShortUnix(secondary.resetsAt)}` : "7d ?";
  const tokenText = typeof tokens === "number"
    ? ` · ${T.codexThread} ${compactNumber(tokens)}`
    : typeof localFive === "number" || typeof localSeven === "number"
      ? ` · ${T.local} ${compactNumber(localFive ?? 0)}/${compactNumber(localSeven ?? 0)}`
      : "";
  return `$(pulse) Codex ${fiveText} ${sevenText}${tokenText}`;
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
    parts.push(`${primaryName}: ${T.usedResetsIn(state.rateLimits.primary.usedPercent, countdownLongUnix(state.rateLimits.primary.resetsAt), formatReset(state.rateLimits.primary.resetsAt))}`);
  }
  if (state.rateLimits?.secondary) {
    parts.push(`${secondaryName}: ${T.usedResetsIn(state.rateLimits.secondary.usedPercent, countdownLongUnix(state.rateLimits.secondary.resetsAt), formatReset(state.rateLimits.secondary.resetsAt))}`);
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
  const fiveText = five ? `5h ${Math.round(five.utilization)}%·${countdownShort(five.resetsAt)}` : "5h ?";
  const sevenText = seven ? `7d ${Math.round(seven.utilization)}%·${countdownShort(seven.resetsAt)}` : "7d ?";
  const t5 = state.tokens?.lastFiveHours.totalTokens;
  const t7 = state.tokens?.lastSevenDays.totalTokens;
  const tokenText =
    typeof t5 === "number" || typeof t7 === "number"
      ? ` · ${compactNumber(t5 ?? 0)}/${compactNumber(t7 ?? 0)}`
      : "";
  return `$(hubot) Claude ${fiveText} ${sevenText}${tokenText}`;
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
    parts.push(`${T.fiveHourLimit}: ${Math.round(plan.fiveHour.utilization)}% ${T.used}, ${T.resetsIn} ${countdownLong(plan.fiveHour.resetsAt)}`);
  }
  if (plan?.sevenDay) {
    parts.push(`${T.sevenDayLimit}: ${Math.round(plan.sevenDay.utilization)}% ${T.used}, ${T.resetsIn} ${countdownLong(plan.sevenDay.resetsAt)}`);
  }
  if (plan?.sevenDayOpus) {
    parts.push(`${T.weeklyOpus}: ${Math.round(plan.sevenDayOpus.utilization)}%`);
  }
  if (plan?.sevenDaySonnet) {
    parts.push(`${T.weeklySonnet}: ${Math.round(plan.sevenDaySonnet.utilization)}%`);
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

function formatUsed(window: RateLimitSnapshot["primary"]): string {
  return typeof window?.usedPercent === "number" ? `${window.usedPercent}%` : "?";
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
