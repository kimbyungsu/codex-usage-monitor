// README 용 대시보드 스크린샷 생성기.
//  - 실제 로컬 로그(Claude ~/.claude/projects, Codex ~/.codex/sessions)로 토큰·차트 데이터를 만들고,
//  - 개인정보(이메일·스레드/프로젝트명·파일경로)는 익명화하며,
//  - 계정 한도 %·샘플은 화면 구성용 가상 값으로 채운 뒤,
//  - media/dashboard.css + media/main.js 그대로를 쓰는 독립 HTML 을 Edge 헤드리스로 캡처한다.
// 사용: node scripts/make-screenshots.js  →  docs/screenshot-claude.png, docs/screenshot-codex.png
const Module = require("module");
const path = require("path");
const fs = require("fs");

// out/*.js 의 `require("vscode")` 를 스텁으로 돌린다 (다른 require 보다 먼저).
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "fake-vscode.js");
  }
  return origResolve.call(this, request, ...rest);
};

const { ClaudeService } = require("../out/claudeService.js");
const { readCodexHistory } = require("../out/codexHistory.js");
const { webviewStrings } = require("../out/i18n.js");

const root = path.join(__dirname, "..");
const docsDir = path.join(root, "docs");
fs.mkdirSync(docsDir, { recursive: true });

const now = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---- 익명화 도우미 ----
const NAMES = ["atlas", "aurora", "castle", "delta", "ember", "flux", "glade", "haven"];
function anonymizeThreads(list) {
  (list || []).forEach((t, i) => {
    t.title = "project-" + NAMES[i % NAMES.length];
    t.threadId = "session-" + String(i + 1).padStart(2, "0");
    t.path = "";
  });
}

// ---- 한도 샘플(스파크라인용 가상 추세) ----
function ramp(keyA, fromA, toA, keyB, fromB, toB, minutes = 100, n = 14) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const wobble = Math.sin(i * 1.7) * 0.8;
    out.push({
      ts: now - (minutes - f * minutes) * 60_000,
      [keyA]: Math.max(0, fromA + (toA - fromA) * f + wobble),
      [keyB]: Math.max(0, fromB + (toB - fromB) * f + wobble * 0.4),
    });
  }
  return out;
}

// ---- Claude 상태 (토큰·차트 = 실데이터, 한도 = 가상) ----
const svc = new ClaudeService({ appendLine() {} });
const tokens = svc.aggregateTokens(); // TS private 이지만 런타임에서는 일반 메서드
anonymizeThreads(tokens.recentThreads);
const claudeState = {
  available: true,
  connecting: false,
  subscriptionType: "max",
  rateLimitTier: "20x",
  plan: {
    fiveHour: { utilization: 56, resetsAt: new Date(now + 165 * 60_000).toISOString() },
    sevenDay: { utilization: 64, resetsAt: new Date(now + 3.4 * DAY).toISOString() },
  },
  tokens,
  projection: {
    fiveHour: { reaches: true, hoursToFull: 2.3, etaMs: now + 2.3 * HOUR },
    sevenDay: { reaches: false },
  },
  samples: ramp("five", 34, 56, "seven", 58, 64),
  lastPlanRefresh: now,
  lastTokenRefresh: now,
};

// ---- Codex 상태 (로컬 로그·차트 = 실데이터, 계정/한도 = 가상) ----
const history = readCodexHistory();
anonymizeThreads(history.recentThreads);
const codexState = {
  connected: true,
  connecting: false,
  account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
  rateLimits: {
    primary: { usedPercent: 37, resetsAt: Math.floor((now + 2.1 * HOUR) / 1000), windowDurationMins: 300 },
    secondary: { usedPercent: 61, resetsAt: Math.floor((now + 4.2 * DAY) / 1000), windowDurationMins: 10080 },
  },
  projection: {
    primary: { reaches: true, hoursToFull: 1.8, etaMs: now + 1.8 * HOUR },
    secondary: { reaches: false },
  },
  samples: ramp("primary", 22, 37, "secondary", 55, 61),
  tokenUsage: {
    threadId: "session-01",
    turnId: "turn-08",
    tokenUsage: {
      last: { inputTokens: 84_512, cachedInputTokens: 64_210, outputTokens: 1_822, reasoningOutputTokens: 1_240, totalTokens: 151_784 },
      total: { inputTokens: 1_274_009, cachedInputTokens: 988_310, outputTokens: 42_551, reasoningOutputTokens: 28_904, totalTokens: 2_333_774 },
      modelContextWindow: 272_000,
    },
  },
  history,
  lastRefresh: now,
  lastHistoryScanOkAt: now,
};

// ---- HTML 하니스 생성 ----
const css = fs.readFileSync(path.join(root, "media", "dashboard.css"), "utf8");
const js = fs.readFileSync(path.join(root, "media", "main.js"), "utf8");
const S = webviewStrings("ko");

// VS Code 다크 테마 변수 대체값 (webview 밖에서 렌더링하므로 직접 정의).
const theme = `
:root {
  --vscode-foreground: #cccccc;
  --vscode-editor-background: #1f1f1f;
  --vscode-editor-foreground: #cccccc;
  --vscode-panel-border: #3c3c3c;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-sideBar-background: #181818;
  --vscode-charts-blue: #3794ff;
  --vscode-charts-purple: #b180d7;
  --vscode-charts-green: #89d185;
  --vscode-charts-orange: #d18616;
  --vscode-charts-red: #f14c4c;
  --vscode-charts-yellow: #cca700;
  --vscode-charts-lines: #6e6e6e;
  --vscode-input-background: #2a2a2a;
  --vscode-input-foreground: #cccccc;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-secondaryBackground: #3a3d41;
  --vscode-button-secondaryForeground: #ffffff;
  --vscode-font-family: "Segoe UI", "Malgun Gothic", sans-serif;
  --vscode-font-size: 13px;
}`;

function buildHtml(showSection) {
  const hide =
    showSection === "claude"
      ? "#codexSection{display:none !important}"
      : "#claudeSection{display:none !important}";
  // 스크린샷에서는 상단 버튼·합산 경로 카드(부가 기능)는 숨겨 차트에 집중.
  const focus = ".actions{display:none} #claudeSection > section.card, #codexSection > section.card {display:none}";
  const bootstrap = JSON.stringify(S).replace(/</g, "\\u003c");
  const stateMsg = JSON.stringify({
    type: "state",
    state: codexState,
    claude: claudeState,
    extraPaths: [],
    codexExtraPaths: [],
  }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<style>${theme}\n${css}\n${hide}\n${focus}</style>
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
      <div class="value">${S.noAgentsDetected}</div><div class="sub">${S.noAgentsHint}</div>
    </section>
    <div id="agentSections">
      <section id="claudeSection">
        <h2>Claude Code <span class="pill" id="claudePlan">—</span></h2>
        <div class="muted" style="margin:-4px 0 10px;font-size:12px">${S.claudeScopeNote}</div>
        <section id="claudeRoot" class="grid"></section>
        <section class="card wide" style="margin-top:12px">
          <div class="mergebox">
            <button id="browsePath">b</button><input id="pathInput" type="text"><button id="addPath">a</button>
          </div>
          <ul id="pathList"></ul>
        </section>
      </section>
      <section id="codexSection">
        <h2>Codex</h2>
        <div class="muted" style="margin:-4px 0 10px;font-size:12px">${S.codexScopeNote}</div>
        <section id="root" class="grid"></section>
        <section class="card wide" style="margin-top:12px">
          <div class="mergebox">
            <button id="browseCodexPath">b</button><input id="codexPathInput" type="text"><button id="addCodexPath">a</button>
          </div>
          <ul id="codexPathList"></ul>
        </section>
      </section>
    </div>
  </main>
  <script type="application/json" id="bootstrap">${bootstrap}</script>
  <script>function acquireVsCodeApi(){return {postMessage(){}, getState(){}, setState(){}};}</script>
  <script>${js}</script>
  <script>window.postMessage(${stateMsg}, "*");</script>
</body>
</html>`;
}

const outClaude = path.join(docsDir, "_shot_claude.html");
const outCodex = path.join(docsDir, "_shot_codex.html");
fs.writeFileSync(outClaude, buildHtml("claude"));
fs.writeFileSync(outCodex, buildHtml("codex"));
console.log("harness written:", outClaude, outCodex);
console.log(
  "claude daily days with data:",
  tokens.insights.daily.filter((d) => d.totalTokens > 0).length,
  "| codex daily days with data:",
  (history.insights ? history.insights.daily.filter((d) => d.totalTokens > 0).length : 0),
);
