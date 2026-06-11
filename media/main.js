// AI 에이전트 사용량 대시보드 (webview 스크립트).
// 확장 쪽에서 postMessage 로 보내는 state(Codex/Claude)와 사전 집계된 insights
// (일별/시간별/히트맵/턴 통계)를 받아 카드를 렌더링한다. 차트는 외부 라이브러리 없이
// 인라인 SVG 로 그린다(CSP·오프라인 안전).
(function () {
  "use strict";

  const S = JSON.parse(document.getElementById("bootstrap").textContent);
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
  pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitPath(); });
  pathList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (btn) vscode.postMessage({ type: "removeClaudePath", path: btn.getAttribute("data-remove") });
  });
  function renderPaths(list) {
    if (!list || !list.length) {
      pathList.innerHTML = '<li class="muted" style="font-size:12px">' + S.noPaths + "</li>";
      return;
    }
    pathList.innerHTML = list.map((p) =>
      '<li class="pathrow"><span>' + escapeHtml(p) + '</span>' +
      '<button class="secondary" data-remove="' + escapeHtml(p) + '">' + S.remove + "</button></li>"
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
  codexPathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitCodexPath(); });
  codexPathList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (btn) vscode.postMessage({ type: "removeCodexPath", path: btn.getAttribute("data-remove") });
  });
  function renderCodexPaths(list) {
    if (!list || !list.length) {
      codexPathList.innerHTML = '<li class="muted" style="font-size:12px">' + S.codexNoPaths + "</li>";
      return;
    }
    codexPathList.innerHTML = list.map((p) =>
      '<li class="pathrow"><span>' + escapeHtml(p) + '</span>' +
      '<button class="secondary" data-remove="' + escapeHtml(p) + '">' + S.remove + "</button></li>"
    ).join("");
  }

  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "state") {
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
      cards.push('<div class="sub" style="grid-column:1/-1;margin:0">⏳ ' + escapeHtml(s.planRateLimited) + "</div>");
    }
    cards.push(windowCard(S.fiveHourLimit, plan.fiveHour, tok.lastFiveHours, proj.fiveHour, sparkSvg(s.samples, "five", plan.fiveHour)));
    cards.push(windowCard(S.weeklyLimit, plan.sevenDay, tok.lastSevenDays, proj.sevenDay, sparkSvg(s.samples, "seven", plan.sevenDay)));
    if (plan.sevenDayOpus) cards.push(windowCard(S.weeklyOpusLimit, plan.sevenDayOpus, null));
    if (plan.sevenDaySonnet) cards.push(windowCard(S.weeklySonnetLimit, plan.sevenDaySonnet, null));
    cards.push(card(S.sessionCard, sessionHtml(tok, s)));
    cards.push(card(S.costCard, costHtml(tok)));
    cards.push(card(S.trendCard, trendHtml(tok.insights), "wide"));
    cards.push(card(S.turnsCard, turnsHtml(tok.insights, true), "wide"));
    cards.push(card(S.cacheCard, cacheHtml(tok.cache), "wide"));
    cards.push(card(S.local7dCard, claudeLocalTokensHtml(tok, s), "wide"));
    cards.push(card(S.byModelCard, byModelHtml(tok), "wide"));
    cards.push(card(S.heatmapCard, heatmapHtml(tok.insights), "wide"));
    cards.push(card(S.codexThreadsTitle, claudeThreadsHtml(tok), "wide"));
    if (s.planError) cards.push(card(S.planAlert, '<div class="error">' + escapeHtml(s.planError) + "</div>", "wide"));
    if (s.tokenError) cards.push(card(S.tokenAlert, '<div class="error">' + escapeHtml(s.tokenError) + "</div>", "wide"));
    if (!s.available && !s.planError && !s.tokenError) {
      cards.push(card(S.status, '<div class="value">' + S.lookingCreds + "</div>", "wide"));
    }
    claudeRoot.innerHTML = cards.join("");
  }

  function windowCard(title, win, tokenBucket, proj, spark) {
    if (!win) {
      return card(title, '<div class="value muted">' + S.notApplicable + "</div>");
    }
    const used = Number(win.utilization || 0);
    const cls = used >= 90 ? "danger" : used >= 70 ? "warn" : "";
    const reset = win.resetsAt ? S.resetsUntil + " " + countdown(win.resetsAt) + " (" + new Date(win.resetsAt).toLocaleString() + ")" : S.noResetTime;
    const tokenLine = tokenBucket
      ? '<div class="sub">' + S.thisPcTokens + " " + compact(tokenBucket.totalTokens) + " · $" + money(tokenBucket.costUsd) + "</div>"
      : "";
    const projLine = proj
      ? (proj.reaches
          ? '<div class="sub">' + S.byTrend + " " + projText(proj) + "</div>"
          : '<div class="sub">' + S.noReachWindow + "</div>")
      : "";
    return card(title,
      '<div class="row"><div class="value">' + used + S.usedSuffix + "</div></div>" +
      '<div class="bar"><div class="fill ' + cls + '" style="width:' + clamp(used, 0, 100) + '%"></div></div>' +
      '<div class="sub">' + escapeHtml(reset) + "</div>" + tokenLine + projLine + (spark || ""));
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
    if (!s) return '<div class="value muted">' + S.noSession + "</div>";
    const model = tok.sessionModel ? '<div class="sub">' + S.model + " " + escapeHtml(tok.sessionModel) + "</div>" : "";
    const updated = state.lastTokenRefresh ? '<div class="sub">' + S.lastUpdate + " " + new Date(state.lastTokenRefresh).toLocaleString() + "</div>" : "";
    return '<div class="value">' + compact(s.totalTokens) + " " + S.tokensUnit + "</div>" +
      '<div class="sub">' + S.contextOccupied + " " + compact(tok.contextTokens) + "</div>" + model + updated;
  }

  function costHtml(tok) {
    const wk = tok.lastSevenDays, today = tok.today, h5 = tok.lastFiveHours;
    if (!wk) return '<div class="value muted">' + S.noData + "</div>";
    return '<div class="value">$' + money(wk.costUsd) + ' <span class="muted" style="font-size:12px">' + S.per7d + "</span></div>" +
      '<div class="sub">' + S.today + " $" + money(today ? today.costUsd : 0) + " · " + S.last5h + " $" + money(h5 ? h5.costUsd : 0) + " · " + S.days7tokens + " " + compact(wk.totalTokens) + "</div>";
  }

  function claudeLocalTokensHtml(tok, state) {
    if (!tok.lastSevenDays) return '<div class="value muted">' + S.noData + "</div>";
    return '<div class="value">' + compact(tok.lastSevenDays.totalTokens) + " " + S.tokensUnit + "</div>" +
      '<div class="sub">' + S.secToday + " " + compact(tok.today && tok.today.totalTokens) + " · " + S.secLast5h + " " + compact(tok.lastFiveHours && tok.lastFiveHours.totalTokens) + " · " + S.secCurrentThread + " " + compact(tok.session && tok.session.totalTokens) + "</div>" +
      '<table style="margin-top:8px"><thead><tr><th>' + S.colSection + "</th><th>" + S.colTokens + "</th><th>" + S.colInput + "</th><th>" + S.colCache + "</th><th>" + S.colOutput + "</th></tr></thead><tbody>" +
      claudeBucketRow(S.secLast7, tok.lastSevenDays) +
      claudeBucketRow(S.secToday, tok.today) +
      claudeBucketRow(S.secLast5h, tok.lastFiveHours) +
      claudeBucketRow(S.secCurrentThread, tok.session) +
      "</tbody></table>" +
      (state.lastTokenRefresh ? '<div class="sub">' + S.lastUpdate + " " + new Date(state.lastTokenRefresh).toLocaleString() + "</div>" : "");
  }

  function claudeBucketRow(label, bucket) {
    const b = bucket || {};
    return "<tr><td>" + escapeHtml(label) + "</td><td>" + compact(b.totalTokens) + "</td><td>" + compact(b.inputTokens) + "</td><td>" + compact((b.cacheReadTokens || 0) + (b.cacheCreationTokens || 0)) + "</td><td>" + compact(b.outputTokens) + "</td></tr>";
  }

  function byModelHtml(tok) {
    const list = (tok.byModel || []).filter((m) => (m.weekTokens || 0) > 0).sort((a, b) => b.weekTokens - a.weekTokens);
    if (!list.length) return '<div class="value muted">' + S.no7dUse + "</div>";
    return '<div class="sub">' + S.byModelNote + "</div>" +
      "<table><thead><tr><th>" + S.model + "</th><th>" + S.col7dTokens + "</th><th>" + S.col7dCost + "</th><th>" + S.colInput + "</th><th>" + S.colCache + "</th><th>" + S.colOutput + "</th></tr></thead><tbody>" +
      list.map((m) => "<tr><td>" + escapeHtml(m.model) + "</td><td>" + compact(m.weekTokens) + "</td><td>$" + money(m.weekCostUsd) + "</td><td>" + compact(m.weekInputTokens) + "</td><td>" + compact(m.weekCacheTokens) + "</td><td>" + compact(m.weekOutputTokens) + "</td></tr>").join("") +
      "</tbody></table>";
  }

  // Claude 최근 스레드(이 PC · 최근 7일) — Codex codexThreadsHtml 와 대칭.
  function claudeThreadsHtml(tok) {
    const list = (tok.recentThreads || []).slice(0, 8);
    if (!list.length) return '<div class="value muted">' + S.no7dThreads + "</div>";
    return '<div class="sub">' + S.threadsNote + "</div>" +
      "<table><thead><tr><th>" + S.colThread + "</th><th>" + S.col7dTokens + "</th><th>" + S.colModel + "</th><th>" + S.colEvents + "</th><th>" + S.colUpdated + "</th></tr></thead><tbody>" +
      list.map((t) => '<tr><td title="' + escapeHtml(t.threadId) + '">' + escapeHtml(shortThreadTitle(t)) + "</td><td>" + compact(t.lastSevenDays && t.lastSevenDays.totalTokens) + "</td><td>" + escapeHtml(t.model || S.unknownModel) + "</td><td>" + compact(t.events) + "</td><td>" + (t.updatedAt ? new Date(t.updatedAt).toLocaleString() : "-") + "</td></tr>").join("") +
      "</tbody></table>";
  }

  // ---------- Codex ----------
  function renderCodex(state) {
    const limit = state.rateLimits || {};
    const token = state.tokenUsage && state.tokenUsage.tokenUsage;
    const account = state.account;
    const history = state.history || {};
    const proj = state.projection || {};
    root.innerHTML = [
      card(S.account, accountHtml(account, state)),
      limitCard(codexLimitTitle(limit.primary, S.fiveHourLimit), limit.primary, history.lastFiveHours, proj.primary, sparkSvgUnix(state.samples, "primary")),
      limitCard(codexLimitTitle(limit.secondary, S.sevenDayLimitCodex), limit.secondary, history.lastSevenDays, proj.secondary, sparkSvgUnix(state.samples, "secondary")),
      card(S.sessionCard, codexSessionHtml(token, history, state)),
      card(S.trendCard, trendHtml(history.insights), "wide"),
      card(S.turnsCard, turnsHtml(history.insights, false), "wide"),
      card(S.codexCacheCard, codexCacheHtml(history), "wide"),
      card(S.codexHistTitle, codexHistorySummaryHtml(history, state), "wide"),
      card(S.codexModelTitle, codexModelHtml(history), "wide"),
      card(S.heatmapCard, heatmapHtml(history.insights), "wide"),
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
    const error = state.error ? '<div class="error">' + escapeHtml(state.error) + "</div>" : "";
    return '<div class="value">' + status + '</div><div class="muted">' + escapeHtml(last) + "</div>" + error;
  }
  function accountHtml(account, state) {
    if (!account) return '<div class="value">' + S.noAccount + '</div><div class="muted">requiresOpenaiAuth: ' + Boolean(state.requiresOpenaiAuth) + "</div>";
    const email = account.email ? '<div class="muted">' + escapeHtml(account.email) + "</div>" : "";
    return '<div class="value">' + escapeHtml(account.planType || account.type || "Unknown") + "</div>" + email;
  }
  function codexLimitTitle(win, fallback) {
    const mins = Number((win && win.windowDurationMins) || 0);
    if (mins > 0 && mins <= 360) return S.fiveHourLimit;
    if (mins >= 6 * 24 * 60) return S.sevenDayLimitCodex;
    return fallback;
  }
  function limitCard(title, win, tokenBucket, proj, spark) {
    if (!win) return card(title, '<div class="value muted">' + S.noLimitInfo + '</div><div class="sub">' + S.noLimitSub + "</div>");
    const used = Number(win.usedPercent || 0);
    const cls = used >= 90 ? "danger" : used >= 70 ? "warn" : "";
    const reset = win.resetsAt
      ? S.resetsUntil + " " + countdownUnix(win.resetsAt) + " (" + new Date(win.resetsAt * 1000).toLocaleString() + ")"
      : S.noResetTime;
    const duration = win.windowDurationMins ? " · " + formatDuration(win.windowDurationMins) : "";
    const tokenLine = tokenBucket
      ? '<div class="sub">' + S.sameWindowLocal + " " + compact(tokenBucket.totalTokens) + " " + S.tokensUnit + "</div>"
      : "";
    const projLine = proj
      ? (proj.reaches
          ? '<div class="sub">' + S.byTrend + " " + projText(proj) + "</div>"
          : '<div class="sub">' + S.noReachWindow + "</div>")
      : "";
    return card(title,
      '<div class="row"><div class="value">' + used + S.usedSuffix + "</div></div>" +
      '<div class="bar"><div class="fill ' + cls + '" style="width:' + clamp(used, 0, 100) + '%"></div></div>' +
      '<div class="sub">' + escapeHtml(reset + duration) + "</div>" + tokenLine + projLine + (spark || ""));
  }
  function creditsHtml(limit) {
    const credits = limit.credits;
    if (!credits) return '<div class="value">' + S.noData + "</div>";
    const balance = credits.balance == null ? S.unknownBalance : S.balance + " " + credits.balance;
    const state = credits.unlimited ? S.unlimited : credits.hasCredits ? S.available : S.noCredits;
    return '<div class="value">' + escapeHtml(state) + '</div><div class="muted">' + escapeHtml(balance) + "</div>";
  }
  function spendHtml(limit) {
    if (!limit) return '<div class="value">' + S.noData + "</div>";
    const reset = limit.resetsAt ? new Date(limit.resetsAt * 1000).toLocaleString() : S.noResetTime;
    return '<div class="value">' + escapeHtml(limit.used) + " / " + escapeHtml(limit.limit) + '</div><div class="muted">' + limit.remainingPercent + S.remainingMid + " " + escapeHtml(reset) + "</div>";
  }
  function tokenHtml(token) {
    if (!token) return '<div class="value">' + S.waitingTokens + '</div><div class="muted">' + S.waitingTokensSub + "</div>";
    return "<table><thead><tr><th>" + S.colScope + "</th><th>" + S.colTotal + "</th><th>" + S.colInput + "</th><th>" + S.colCache + "</th><th>" + S.colOutput + "</th><th>" + S.colReasoning + "</th></tr></thead><tbody>" +
      tokenRow(S.lastTurn, token.last) + tokenRow(S.threadTotal, token.total) +
      "</tbody></table>" + (token.modelContextWindow ? '<div class="muted">' + S.contextWindow + " " + compact(token.modelContextWindow) + "</div>" : "");
  }
  function tokenRow(label, usage) {
    return "<tr><td>" + escapeHtml(label) + "</td><td>" + compact(usage.totalTokens) + "</td><td>" + compact(usage.inputTokens) + "</td><td>" + compact(usage.cachedInputTokens) + "</td><td>" + compact(usage.outputTokens) + "</td><td>" + compact(usage.reasoningOutputTokens) + "</td></tr>";
  }
  function codexSessionHtml(token, history, state) {
    const liveTotal = token && token.total && token.total.totalTokens;
    const localSession = (history && history.session) || {};
    const total = typeof liveTotal === "number" ? liveTotal : Number(localSession.totalTokens || (history && history.contextTokens) || 0);
    if (!total) return '<div class="value muted">' + S.noSession + "</div>";
    const windowSize = Number((token && token.modelContextWindow) || (history && history.modelContextWindow) || 0);
    const liveLast = (token && token.last) || {};
    const liveContext = Number(liveLast.inputTokens || 0) + Number(liveLast.cachedInputTokens || 0);
    const historyContext = Number((history && history.contextTokens) || 0);
    const context = liveContext > 0
      ? liveContext
      : historyContext > 0 && (!windowSize || historyContext <= windowSize * 1.2)
        ? historyContext
        : 0;
    const contextLine = context > 0
      ? S.contextOccupied + " " + compact(context) + (windowSize ? " / " + compact(windowSize) : "")
      : windowSize
        ? S.contextWindow + " " + compact(windowSize)
        : "";
    const model = history && history.sessionModel ? '<div class="sub">' + S.model + " " + escapeHtml(history.sessionModel) + "</div>" : "";
    const updatedAt = state.lastHistoryScanOkAt || (history && history.lastScannedAt);
    const updated = updatedAt ? '<div class="sub">' + S.lastUpdate + " " + new Date(updatedAt).toLocaleString() + "</div>" : "";
    return '<div class="value">' + compact(total) + " " + S.tokensUnit + "</div>" +
      (contextLine ? '<div class="sub">' + contextLine + "</div>" : "") + model + updated;
  }
  function codexHistorySummaryHtml(history, state) {
    if (!history || history.error) {
      return '<div class="value muted">' + S.noLocalHistory + '</div><div class="sub">' + escapeHtml((history && history.error) || S.codexLogNotRead) + "</div>";
    }
    const week = history.lastSevenDays || {};
    const scanNotice = state.historyError
      ? '<div class="sub">⏳ ' + S.localScanFailed + " · " + escapeHtml(state.historyError) + "</div>"
      : "";
    return '<div class="value">' + compact(week.totalTokens) + " " + S.tokensUnit + ' <span class="muted" style="font-size:12px">' + S.secLast7 + "</span></div>" +
      '<div class="sub">' + S.secLast7 + " " + compact(week.totalTokens) + " " + S.tokensUnit + " · " + S.secToday + " " + compact(history.today && history.today.totalTokens) + " · " + S.secLast5h + " " + compact(history.lastFiveHours && history.lastFiveHours.totalTokens) + " · " + S.secCurrentThread + " " + compact(history.session && history.session.totalTokens) + "</div>" +
      scanNotice +
      '<div class="sub">' + S.codexHistNote + "</div>" +
      '<table style="margin-top:8px"><thead><tr><th>' + S.colSection + "</th><th>" + S.colTokens + "</th><th>" + S.colInput + "</th><th>" + S.colCache + "</th><th>" + S.colOutput + "</th><th>" + S.colReasoning + "</th></tr></thead><tbody>" +
      codexBucketRow(S.secLast7, history.lastSevenDays) +
      codexBucketRow(S.secToday, history.today) +
      codexBucketRow(S.secLast5h, history.lastFiveHours) +
      codexBucketRow(S.secCurrentThread, history.session) +
      "</tbody></table>" +
      '<div class="sub">' + S.filesScanned + " " + compact(history.filesScanned || 0) +
      " · " + S.lastScan + " " + (history.lastScannedAt ? new Date(history.lastScannedAt).toLocaleString() : "-") +
      " · " + S.currentThreadCum + " " + compact(history.contextTokens || 0) +
      (history.modelContextWindow ? " / " + compact(history.modelContextWindow) : "") +
      (history.sessionModel ? " · " + S.model + " " + escapeHtml(history.sessionModel) : "") +
      "</div>";
  }
  function codexBucketRow(label, bucket) {
    const b = bucket || {};
    return "<tr><td>" + escapeHtml(label) + "</td><td>" + compact(b.totalTokens) + "</td><td>" + compact(b.inputTokens) + "</td><td>" + compact(b.cachedInputTokens) + "</td><td>" + compact(b.outputTokens) + "</td><td>" + compact(b.reasoningOutputTokens) + "</td></tr>";
  }
  function codexModelHtml(history) {
    const list = ((history && history.byModel) || []).filter((m) => (m.totalTokens || 0) > 0).slice(0, 10);
    if (!list.length) return '<div class="value muted">' + S.no7dUse + "</div>";
    return '<div class="sub">' + S.codexModelNote + "</div>" +
      "<table><thead><tr><th>" + S.model + "</th><th>" + S.col7dTokens + "</th><th>" + S.colInput + "</th><th>" + S.colCache + "</th><th>" + S.colOutReason + "</th><th>" + S.colEvents + "</th></tr></thead><tbody>" +
      list.map((m) => "<tr><td>" + escapeHtml(m.model || S.unknownModel) + "</td><td>" + compact(m.totalTokens) + "</td><td>" + compact(m.inputTokens) + "</td><td>" + compact(m.cachedInputTokens) + "</td><td>" + compact(m.outputTokens) + "</td><td>" + compact(m.events) + "</td></tr>").join("") +
      "</tbody></table>";
  }
  function codexThreadsHtml(history) {
    const list = ((history && history.recentThreads) || []).slice(0, 8);
    if (!list.length) return '<div class="value muted">' + S.no7dThreads + "</div>";
    return '<div class="sub">' + S.threadsNote + "</div>" +
      "<table><thead><tr><th>" + S.colThread + "</th><th>" + S.col7dTokens + "</th><th>" + S.colModel + "</th><th>" + S.colEvents + "</th><th>" + S.colUpdated + "</th></tr></thead><tbody>" +
      list.map((t) => '<tr><td title="' + escapeHtml(t.threadId) + '">' + escapeHtml(shortThreadTitle(t)) + "</td><td>" + compact(t.lastSevenDays && t.lastSevenDays.totalTokens) + "</td><td>" + escapeHtml(t.model || S.unknownModel) + "</td><td>" + compact(t.events) + "</td><td>" + (t.updatedAt ? new Date(t.updatedAt).toLocaleString() : "-") + "</td></tr>").join("") +
      "</tbody></table>";
  }
  function shortThreadTitle(t) {
    const text = t.title || t.threadId || "";
    return text.length > 34 ? text.slice(0, 31) + "..." : text;
  }
  function extraHtml(state) {
    if (state.extraUsageError) return '<pre class="error">' + escapeHtml(state.extraUsageError) + "</pre>";
    if (state.extraUsageOutput) return "<pre>" + escapeHtml(state.extraUsageOutput) + "</pre>";
    return '<div class="value">' + S.notConfigured + '</div><div class="muted">' + S.customCmdHint + "</div>";
  }

  // ---------- 차트 (인라인 SVG · 라이브러리 없음) ----------

  // 모델 색상: 토큰 많은 순으로 VS Code 차트 팔레트를 배정.
  const PALETTE = [
    "var(--vscode-charts-blue)",
    "var(--vscode-charts-purple)",
    "var(--vscode-charts-green)",
    "var(--vscode-charts-orange)",
    "var(--vscode-charts-red)",
    "var(--vscode-charts-yellow)",
  ];
  const ETC_COLOR = "var(--vscode-charts-lines)";
  const ETC_KEY = "__etc__";

  /** 일별 스택 막대(모델별) + 최근 24시간 미니 막대. */
  function trendHtml(ins) {
    const daily = (ins && ins.daily) || [];
    if (!daily.length || !daily.some((d) => d.totalTokens > 0)) {
      return '<div class="value muted">' + S.noData + "</div>";
    }
    // 모델 랭킹(14일 합) → 상위 5개 + 기타.
    const totals = {};
    for (const d of daily) {
      for (const m in d.byModel) totals[m] = (totals[m] || 0) + d.byModel[m];
    }
    const ranked = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
    const top = ranked.slice(0, 5);
    const series = ranked.length > top.length ? top.concat([ETC_KEY]) : top;
    const colorOf = (m) => (m === ETC_KEY ? ETC_COLOR : PALETTE[top.indexOf(m) % PALETTE.length]);
    const labelOf = (m) => (m === ETC_KEY ? S.etcModels : m);

    const W = 720, H = 190, L = 48, R = 8, T = 10, B = 24;
    const plotW = W - L - R, plotH = H - T - B;
    const bw = plotW / daily.length;
    const max = Math.max(1, ...daily.map((d) => d.totalTokens));
    let body = "";
    daily.forEach((d, i) => {
      const x = L + i * bw + bw * 0.16;
      const w = bw * 0.68;
      const dt = new Date(d.dayStartMs);
      const dayLabel = (dt.getMonth() + 1) + "/" + dt.getDate();
      let y = T + plotH;
      for (const m of series) {
        const v = m === ETC_KEY
          ? ranked.slice(top.length).reduce((acc, mm) => acc + (d.byModel[mm] || 0), 0)
          : (d.byModel[m] || 0);
        if (v <= 0) continue;
        const h = (v / max) * plotH;
        y -= h;
        const tip = dayLabel + " · " + labelOf(m) + " · " + compact(v) + " " + S.tokensUnit +
          (typeof d.costUsd === "number" && d.costUsd > 0 ? " (" + dayLabel + " $" + money(d.costUsd) + ")" : "");
        body += '<rect class="seg" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(h, 0.5).toFixed(1) + '" rx="1" fill="' + colorOf(m) + '"><title>' + escapeHtml(tip) + "</title></rect>";
      }
      if ((daily.length - 1 - i) % 2 === 0) {
        body += '<text class="ax" x="' + (L + i * bw + bw / 2).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + escapeHtml(dayLabel) + "</text>";
      }
    });
    let grid = "";
    for (let g = 1; g <= 3; g++) {
      const gy = T + plotH - (g / 4) * plotH;
      grid += '<line class="gridline" x1="' + L + '" y1="' + gy.toFixed(1) + '" x2="' + (W - R) + '" y2="' + gy.toFixed(1) + '"/>' +
        '<text class="ax" x="' + (L - 6) + '" y="' + (gy + 3).toFixed(1) + '" text-anchor="end">' + compact((max * g) / 4) + "</text>";
    }
    const legend = '<div class="legend">' + series.map((m) =>
      '<span class="chip"><i style="background:' + colorOf(m) + '"></i>' + escapeHtml(labelOf(m)) + "</span>"
    ).join("") + "</div>";
    const dailySvg = '<svg class="chart" viewBox="0 0 ' + W + " " + H + '">' + grid + body + "</svg>";
    return '<div class="sub" style="margin-top:0">' + S.trendDailyNote + "</div>" + legend + dailySvg + hourlyHtml(ins);
  }

  /** 최근 24시간 미니 막대(시간 단위). */
  function hourlyHtml(ins) {
    const hourly = (ins && ins.hourly) || [];
    if (!hourly.length || !hourly.some((h) => h.totalTokens > 0)) {
      return "";
    }
    const W = 720, H = 64, L = 48, R = 8, T = 6, B = 16;
    const plotW = W - L - R, plotH = H - T - B;
    const bw = plotW / hourly.length;
    const max = Math.max(1, ...hourly.map((h) => h.totalTokens));
    let body = "";
    hourly.forEach((pt, i) => {
      const hr = new Date(pt.hourStartMs).getHours();
      const x = L + i * bw + bw * 0.18;
      const w = bw * 0.64;
      if (pt.totalTokens > 0) {
        const h = Math.max(1.2, (pt.totalTokens / max) * plotH);
        const y = T + plotH - h;
        body += '<rect class="seg" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1" fill="var(--accent)"><title>' + escapeHtml(hr + ":00 · " + compact(pt.totalTokens) + " " + S.tokensUnit) + "</title></rect>";
      }
      if (hr % 6 === 0) {
        body += '<text class="ax" x="' + (L + i * bw + bw / 2).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle">' + hr + "</text>";
      }
    });
    body += '<line class="gridline" x1="' + L + '" y1="' + (T + plotH) + '" x2="' + (W - R) + '" y2="' + (T + plotH) + '"/>';
    return '<div class="label" style="margin:10px 0 0">' + S.trendHourlyTitle + '</div><svg class="chart" viewBox="0 0 ' + W + " " + H + '">' + body + "</svg>";
  }

  /** 모델별 턴당 통계 테이블(평균 셀에 상대 막대). */
  function turnsHtml(ins, withCost) {
    const list = (ins && ins.modelTurns) || [];
    if (!list.length) return '<div class="value muted">' + S.noTurnData + "</div>";
    const maxAvg = Math.max(1, ...list.map((m) => m.avgTokensPerTurn || 0));
    const head = "<tr><th>" + S.model + "</th><th>" + S.colTurns + "</th><th>" + S.colAvgTurn + "</th><th>" + S.colMedianTurn + "</th><th>" + S.colP90Turn + "</th><th>" + S.colOutTurn + "</th>" + (withCost ? "<th>" + S.colCostTurn + "</th>" : "") + "</tr>";
    const rows = list.map((m) => {
      const pct = clamp(((m.avgTokensPerTurn || 0) / maxAvg) * 100, 0, 100);
      return "<tr><td>" + escapeHtml(m.model) + "</td>" +
        "<td>" + compact(m.turns) + "</td>" +
        '<td><div class="cellbar"><span style="width:' + pct.toFixed(1) + '%"></span><b>' + compact(m.avgTokensPerTurn) + "</b></div></td>" +
        "<td>" + compact(m.medianTokensPerTurn) + "</td>" +
        "<td>" + compact(m.p90TokensPerTurn) + "</td>" +
        "<td>" + compact(m.avgOutputPerTurn) + "</td>" +
        (withCost ? "<td>" + (typeof m.avgCostPerTurn === "number" ? "$" + money(m.avgCostPerTurn) : "-") + "</td>" : "") +
        "</tr>";
    }).join("");
    return '<div class="sub" style="margin-top:0">' + S.turnsNote + "</div>" +
      "<table><thead>" + head + "</thead><tbody>" + rows + "</tbody></table>";
  }

  /** 적중률 도넛 SVG (캐시 카드 공용). */
  function donutHtml(hitPct) {
    const hit = clamp(hitPct || 0, 0, 100);
    const R = 27, C = 2 * Math.PI * R;
    const dash = (hit / 100) * C;
    return '<div class="donutbox">' +
      '<svg class="donut" viewBox="0 0 76 76">' +
      '<circle class="track" cx="38" cy="38" r="' + R + '"/>' +
      '<circle class="arc" cx="38" cy="38" r="' + R + '" stroke-dasharray="' + dash.toFixed(1) + " " + C.toFixed(1) + '" transform="rotate(-90 38 38)"/>' +
      "</svg>" +
      '<div class="center">' + Math.round(hit) + "%</div>" +
      "</div>";
  }

  /** 캐시 효율(Claude): 적중률 도넛 + 절약 추정. */
  function cacheHtml(cache) {
    if (!cache || (cache.cacheReadTokens + cache.cacheWriteTokens + cache.freshInputTokens) <= 0) {
      return '<div class="value muted">' + S.noData + "</div>";
    }
    const hit = clamp(cache.hitRatePercent || 0, 0, 100);
    const saved = cache.savedUsd || 0;
    const facts =
      '<div class="cachefacts">' +
      '<div class="label" style="margin-bottom:2px">' + S.cacheHit + " " + Math.round(hit) + "% · " + S.cacheSaved + "</div>" +
      '<div class="value">' + (saved < 0 ? "-$" + money(-saved) : "$" + money(saved)) + ' <span class="muted" style="font-size:12px">/ 7d</span></div>' +
      '<div class="sub">' + S.cacheRead + " " + compact(cache.cacheReadTokens) + " · " + S.cacheWrite + " " + compact(cache.cacheWriteTokens) + " · " + S.freshInput + " " + compact(cache.freshInputTokens) + "</div>" +
      "</div>";
    return '<div class="cachewrap">' + donutHtml(hit) + facts + '</div><div class="sub">' + S.cacheNote + "</div>";
  }

  /** 캐시 적중률(Codex): cached_input ⊆ input 의미론이라 적중률만 표시($ 미산출 정책). */
  function codexCacheHtml(history) {
    const wk = history && history.lastSevenDays;
    const input = Number((wk && wk.inputTokens) || 0);
    const cached = Number((wk && wk.cachedInputTokens) || 0);
    if (input <= 0) {
      return '<div class="value muted">' + S.noData + "</div>";
    }
    const hit = clamp((cached / input) * 100, 0, 100);
    const facts =
      '<div class="cachefacts">' +
      '<div class="label" style="margin-bottom:2px">' + S.cacheHit + "</div>" +
      '<div class="value">' + Math.round(hit) + '% <span class="muted" style="font-size:12px">/ 7d</span></div>' +
      '<div class="sub">' + S.cacheRead + " " + compact(cached) + " · " + S.nonCachedInput + " " + compact(input - cached) + " · " + S.totalInput + " " + compact(input) + "</div>" +
      "</div>";
    return '<div class="cachewrap">' + donutHtml(hit) + facts + '</div><div class="sub">' + S.codexCacheNote + "</div>";
  }

  /** 요일 × 시간 히트맵. */
  function heatmapHtml(ins) {
    const hm = (ins && ins.heatmap) || [];
    if (!hm.length) return '<div class="value muted">' + S.noData + "</div>";
    let max = 0;
    for (const row of hm) for (const v of row) max = Math.max(max, v);
    if (max <= 0) return '<div class="value muted">' + S.noData + "</div>";
    const days = String(S.weekdaysShort).split(",");
    let cells = '<span></span>';
    for (let h = 0; h < 24; h++) {
      cells += '<span class="hlab">' + (h % 3 === 0 ? h : "") + "</span>";
    }
    for (let d = 0; d < 7; d++) {
      cells += '<span class="dlab">' + escapeHtml(days[d] || "") + "</span>";
      for (let h = 0; h < 24; h++) {
        const v = (hm[d] && hm[d][h]) || 0;
        const tip = (days[d] || "") + " " + h + ":00 · " + compact(v) + " " + S.tokensUnit;
        if (v > 0) {
          const ratio = Math.sqrt(v / max);
          cells += '<i class="cell" style="opacity:' + (0.15 + 0.85 * ratio).toFixed(3) + '" title="' + escapeHtml(tip) + '"></i>';
        } else {
          cells += '<i class="cell empty" title="' + escapeHtml(tip) + '"></i>';
        }
      }
    }
    return '<div class="sub" style="margin-top:0">' + S.heatmapNote + '</div><div class="hm">' + cells + "</div>";
  }

  /** 한도 사용률 스파크라인(Claude: ISO 윈도우 키 five/seven). 점선 = 현재 추세 연장. */
  function sparkSvg(samples, key) {
    const pts = (samples || []).filter((s) => typeof s[key] === "number");
    if (pts.length < 2) return "";
    return sparkCore(pts.map((p) => ({ ts: p.ts, v: p[key] })));
  }
  /** Codex(키 primary/secondary)용 — 데이터 구조 동일. */
  function sparkSvgUnix(samples, key) {
    return sparkSvg(samples, key);
  }
  function sparkCore(pts) {
    const W = 240, H = 44, P = 4;
    const t0 = pts[0].ts;
    const tNow = pts[pts.length - 1].ts;
    const domain = Math.max((tNow - t0) * 1.35, 10 * 60 * 1000);
    const x = (ts) => P + ((ts - t0) / domain) * (W - 2 * P);
    const y = (v) => H - P - (clamp(v, 0, 100) / 100) * (H - 2 * P);
    const line = pts.map((p) => x(p.ts).toFixed(1) + "," + y(p.v).toFixed(1)).join(" ");
    const first = pts[0], last = pts[pts.length - 1];
    let proj = "";
    const dt = last.ts - first.ts;
    if (dt > 0) {
      const rate = (last.v - first.v) / dt; // %/ms
      if (rate > 0) {
        const tFull = last.ts + (100 - last.v) / rate;
        const tEnd = Math.min(tFull, t0 + domain);
        if (tEnd > last.ts) {
          proj = '<line class="proj" x1="' + x(last.ts).toFixed(1) + '" y1="' + y(last.v).toFixed(1) + '" x2="' + x(tEnd).toFixed(1) + '" y2="' + y(last.v + rate * (tEnd - last.ts)).toFixed(1) + '"/>';
          if (tFull <= t0 + domain) {
            proj += '<circle class="projdot" cx="' + x(tFull).toFixed(1) + '" cy="' + y(100).toFixed(1) + '" r="2.4"/>';
          }
        }
      }
    }
    return '<svg class="spark" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none">' +
      '<line class="cap" x1="' + P + '" y1="' + y(100).toFixed(1) + '" x2="' + (W - P) + '" y2="' + y(100).toFixed(1) + '"/>' +
      '<polyline class="hist" points="' + line + '"/>' + proj + "</svg>" +
      '<div class="sub" style="margin-top:2px">' + S.sparkNote + "</div>";
  }

  // ---------- shared ----------
  function card(title, body, kind = "") {
    return '<article class="card ' + kind + '"><div class="label">' + escapeHtml(title) + "</div>" + body + "</article>";
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
    return String(Math.round(v));
  }
  function money(value) {
    const v = Number(value || 0);
    return v >= 100 ? v.toFixed(0) : v.toFixed(2);
  }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
