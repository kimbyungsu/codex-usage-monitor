// 다국어(EN/KO). 표시 언어는 설정(codexUsageMonitor.language) 또는
// VS Code 표시 언어(vscode.env.language)를 따른다.
import * as vscode from "vscode";

export type Lang = "en" | "ko";

export function resolveLang(): Lang {
  const cfg = vscode.workspace.getConfiguration("codexUsageMonitor").get<string>("language", "auto");
  if (cfg === "en" || cfg === "ko") {
    return cfg;
  }
  return (vscode.env.language || "en").toLowerCase().startsWith("ko") ? "ko" : "en";
}

// ===== TS(런타임) 측: 상태바 / 툴팁 / 알림 / 시작 안내 =====
interface TsStrings {
  // 상태바/툴팁 공통
  local: string;
  // Codex 툴팁
  codexConnected: string;
  codexDisconnected: string;
  codexAccount: string;
  codexThread: string;
  threadTokens: string;
  last5hLocal: string;
  last7dLocal: string;
  scopeShort: string;
  error: string;
  fiveHourLimit: string;
  sevenDayLimit: string;
  usedResetsIn: (pct: number, cd: string, at: string) => string;
  remainResetsIn: (pct: number, cd: string, at: string) => string;
  // Claude 툴팁
  claudeCredsMissing: string;
  used: string;
  remaining: string;
  resetsIn: string;
  fiveHourEta: string;
  sevenDayEta: string;
  weeklyOpus: string;
  weeklySonnet: string;
  recent5hTokens: string;
  recent7dTokens: string;
  currentSession: string;
  context: string;
  tokensUnit: string;
  plan: string;
  token: string;
  // 429 안내 (알림 아님, 차분한 상태 문구)
  rateLimited: (secs: number) => string;
  // 알림 / 시작
  alert: (label: string, pct: number, top: number, reset: string) => string;
  alertFiveHour: string;
  alertWeekly: string;
  startupNotice: string;
  openDashboard: string;
  pathNotExist: (p: string) => string;
  pathAlready: string;
  pathAdded: (p: string) => string;
  pickFolderLabel: string;
  pickFolderTitle: string;
  codexPickFolderTitle: string;
  // 카운트다운/시간
  soon: string;
  unknown: string;
  dh: (d: number, h: number) => string;
  hm: (h: number, m: number) => string;
  m: (m: number) => string;
  after: string;
}

const KO: TsStrings = {
  local: "로컬",
  codexConnected: "Codex app-server 연결됨",
  codexDisconnected: "Codex app-server 끊김",
  codexAccount: "계정",
  codexThread: "스레드",
  threadTokens: "스레드 토큰",
  last5hLocal: "최근 5시간 로컬 토큰",
  last7dLocal: "최근 7일 로컬 토큰",
  scopeShort: "한도는 계정 전체(서버), 토큰·모델은 이 PC 로컬 기준",
  error: "오류",
  fiveHourLimit: "5시간 한도",
  sevenDayLimit: "7일 한도",
  usedResetsIn: (pct, cd, at) => `${pct}% 사용, 리셋까지 ${cd} (${at})`,
  remainResetsIn: (pct, cd, at) => `${pct}% 남음, 리셋까지 ${cd} (${at})`,
  claudeCredsMissing: "Claude 자격증명 미확인",
  used: "사용",
  remaining: "남음",
  resetsIn: "리셋까지",
  fiveHourEta: "5시간 소진 예상",
  sevenDayEta: "주간 소진 예상",
  weeklyOpus: "주간 Opus",
  weeklySonnet: "주간 Sonnet",
  recent5hTokens: "최근 5시간 토큰",
  recent7dTokens: "최근 7일 토큰",
  currentSession: "현재 세션",
  context: "컨텍스트",
  tokensUnit: "토큰",
  plan: "플랜",
  token: "토큰",
  rateLimited: (secs) =>
    `사용량 서버가 잠시 제한 중입니다 · 마지막 값 표시 · 다음 시도 약 ${secs}초 후`,
  alert: (label, pct, top, reset) =>
    `Claude ${label} 한도 ${pct}% 도달 (임계치 ${top}%)${reset ? ` · 리셋 ${reset}` : ""}`,
  alertFiveHour: "5시간",
  alertWeekly: "주간",
  startupNotice: "AI 에이전트 사용량 모니터가 시작되었습니다. 왼쪽 상태바의 Codex/Claude 항목을 누르면 대시보드가 열립니다.",
  openDashboard: "대시보드 열기",
  pathNotExist: (p) => `경로가 존재하지 않지만 추가합니다: ${p}`,
  pathAlready: "이미 추가된 경로입니다.",
  pathAdded: (p) => `합산 경로 추가됨: ${p}`,
  pickFolderLabel: "이 폴더를 합산에 추가",
  pickFolderTitle: "다른 환경의 .claude 또는 projects 폴더 선택",
  codexPickFolderTitle: "다른 환경의 .codex 또는 sessions 폴더 선택",
  soon: "곧",
  unknown: "미상",
  dh: (d, h) => `${d}일 ${h}시간`,
  hm: (h, m) => `${h}시간 ${m}분`,
  m: (m) => `${m}분`,
  after: "후",
};

const EN: TsStrings = {
  local: "local",
  codexConnected: "Codex app-server connected",
  codexDisconnected: "Codex app-server disconnected",
  codexAccount: "Account",
  codexThread: "Thread",
  threadTokens: "Thread tokens",
  last5hLocal: "Last 5h local tokens",
  last7dLocal: "Last 7d local tokens",
  scopeShort: "Limits are account-wide (server); tokens/models are this PC's local logs",
  error: "Error",
  fiveHourLimit: "5-hour limit",
  sevenDayLimit: "Weekly limit",
  usedResetsIn: (pct, cd, at) => `${pct}% used, resets in ${cd} (${at})`,
  remainResetsIn: (pct, cd, at) => `${pct}% left, resets in ${cd} (${at})`,
  claudeCredsMissing: "Claude credentials not found",
  used: "used",
  remaining: "left",
  resetsIn: "resets in",
  fiveHourEta: "5h limit ETA",
  sevenDayEta: "Weekly limit ETA",
  weeklyOpus: "Weekly Opus",
  weeklySonnet: "Weekly Sonnet",
  recent5hTokens: "Last 5h tokens",
  recent7dTokens: "Last 7d tokens",
  currentSession: "Current session",
  context: "context",
  tokensUnit: "tokens",
  plan: "Plan",
  token: "Tokens",
  rateLimited: (secs) =>
    `Usage server is briefly throttling · showing last value · next try in ~${secs}s`,
  alert: (label, pct, top, reset) =>
    `Claude ${label} usage reached ${pct}% (threshold ${top}%)${reset ? ` · resets ${reset}` : ""}`,
  alertFiveHour: "5h",
  alertWeekly: "weekly",
  startupNotice: "AI Agent Usage Monitor started. Click the Codex/Claude item in the left status bar to open the dashboard.",
  openDashboard: "Open dashboard",
  pathNotExist: (p) => `Path does not exist, adding anyway: ${p}`,
  pathAlready: "Path already added.",
  pathAdded: (p) => `Merge path added: ${p}`,
  pickFolderLabel: "Add this folder to merge",
  pickFolderTitle: "Pick another environment's .claude or projects folder",
  codexPickFolderTitle: "Pick another environment's .codex or sessions folder",
  soon: "soon",
  unknown: "unknown",
  dh: (d, h) => `${d}d ${h}h`,
  hm: (h, m) => `${h}h ${m}m`,
  m: (m) => `${m}m`,
  after: "left",
};

export function t(lang: Lang = resolveLang()): TsStrings {
  return lang === "ko" ? KO : EN;
}

// ===== 웹뷰(대시보드) 문자열: JSON 으로 안전하게 주입 =====
export function webviewStrings(lang: Lang): Record<string, string> {
  const ko: Record<string, string> = {
    pageTitle: "AI 에이전트 사용량",
    refresh: "새로고침",
    codexReconnect: "Codex 재연결",
    claudeScopeNote: "한도(%·리셋)는 <b>계정 전체</b>(서버), 토큰·비용·모델은 <b>이 PC 로컬</b> 기준입니다.",
    codexScopeNote: "한도(%·리셋)는 <b>연결 계정 전체</b>(서버), 토큰·모델은 <b>이 PC 로컬 Codex 로그</b> 기준입니다. Codex 모델별 비용은 새 모델/별칭이 계속 바뀌어 안정적으로 자동 매칭하기 어렵기 때문에 표시하지 않습니다.",
    mergeTitle: "다른 환경 합치기",
    mergeAuto: "같은 PC·같은 계정이면 CLI·VS Code·여러 프로젝트가 <b>전부 자동 합산</b>됩니다 — 따로 할 것 없음.",
    mergeWhen: "다른 Windows 계정 · WSL · 다른 드라이브/PC처럼 <b>.claude 폴더가 따로</b> 있을 때만, 그 환경의 폴더를 아래에서 추가하세요.",
    browse: "📁 폴더 선택해서 추가",
    pathPlaceholder: "또는 경로 직접 입력 (예: \\\\wsl$\\Ubuntu\\home\\계정\\.claude\\projects)",
    add: "추가",
    remove: "삭제",
    noPaths: "추가된 경로 없음 — 이 PC만 집계 중",
    notConnected: "연결 안 됨",
    fiveHourLimit: "5시간 한도",
    weeklyLimit: "주간 한도",
    weeklyOpusLimit: "주간 · Opus 전용한도",
    weeklySonnetLimit: "주간 · Sonnet 전용한도",
    sessionCard: "현재 세션 (이 PC)",
    local7dCard: "최근 7일 로컬 토큰",
    costCard: "비용 (이 PC · 최근 7일·추정)",
    byModelCard: "모델별 토큰 (이 PC · 최근 7일)",
    planAlert: "플랜 한도 알림",
    tokenAlert: "토큰 집계 알림",
    status: "상태",
    lookingCreds: "Claude 자격증명을 찾는 중…",
    notApplicable: "미적용",
    noData: "데이터 없음",
    noAgentsDetected: "감지된 에이전트 없음",
    noAgentsHint: "Codex 또는 Claude Code 자격증명/로컬 로그가 감지되면 자동으로 표시됩니다.",
    usedSuffix: "% 사용",
    resetsUntil: "리셋까지",
    noResetTime: "리셋 시각 미상",
    thisPcTokens: "이 PC 토큰",
    byTrend: "현재 추세로",
    about: "약",
    afterExhaust: "후 소진 예상",
    noReachWindow: "현재 추세론 이번 창 내 한도 미도달",
    noSession: "세션 없음",
    tokensUnit: "토큰",
    model: "모델",
    contextOccupied: "컨텍스트 점유",
    today: "오늘",
    last5h: "최근 5시간",
    days7tokens: "7일 토큰",
    per7d: "/ 7일",
    no7dUse: "최근 7일 사용 없음",
    byModelNote: "이 PC 로컬 로그 기준 · 다른 환경 사용분은 빠질 수 있음(계정 전체는 위 주간 한도 % 참고) · 7일 미사용 모델 자동 제외 · 비용은 추정치 · Claude는 별도 추론 토큰 필드를 제공하지 않아 출력에 포함해 표시합니다.",
    col7dTokens: "7일 토큰",
    col7dCost: "7일 $",
    dayN: "일",
    hourN: "시간",
    minN: "분",
    soon: "곧",
    // Codex
    account: "계정",
    connection: "연결",
    connecting: "연결 중",
    connected: "연결됨",
    disconnected: "끊김",
    notRefreshed: "갱신 안 됨",
    noAccount: "계정 없음",
    credits: "크레딧",
    spendLimit: "지출 한도",
    recentTokens: "최근 토큰 사용",
    customCmd: "사용자 지정 명령",
    sevenDayLimitCodex: "7일 한도",
    noLimitInfo: "한도 정보 없음",
    noLimitSub: "Codex 서버에서 아직 한도 값을 받지 못했습니다.",
    sameWindowLocal: "동일 시간폭 로컬 토큰",
    unlimited: "무제한",
    available: "사용 가능",
    noCredits: "크레딧 없음",
    unknownBalance: "잔액 미상",
    balance: "잔액",
    remainingMid: "% 남음 ·",
    waitingTokens: "토큰 업데이트 대기 중",
    waitingTokensSub: "Codex 스레드가 사용량 이벤트를 보낼 때 갱신됩니다.",
    colScope: "구분",
    colTotal: "합계",
    colInput: "입력",
    colCache: "캐시",
    colOutput: "출력",
    colReasoning: "추론",
    lastTurn: "최근 턴",
    threadTotal: "스레드 누적",
    contextWindow: "컨텍스트 윈도우",
    codexHistTitle: "최근 7일 로컬 토큰",
    codexModelTitle: "모델별 사용량 (이 PC · 최근 7일)",
    codexThreadsTitle: "최근 스레드 (이 PC · 최근 7일)",
    codexMergeTitle: "다른 환경 합치기",
    codexMergeAuto: "같은 PC·같은 계정이면 CLI·IDE·여러 세션이 <b>전부 자동 합산</b>됩니다 — 따로 할 것 없음.",
    codexMergeWhen: "다른 Windows 계정 · WSL · 다른 드라이브/PC처럼 <b>.codex 폴더가 따로</b> 있을 때만, 그 환경의 폴더를 아래에서 추가하세요.",
    codexBrowse: "📁 폴더 선택해서 추가",
    codexPathPlaceholder: "또는 경로 직접 입력 (예: \\\\wsl$\\Ubuntu\\home\\계정\\.codex\\sessions)",
    codexNoPaths: "추가된 경로 없음 — 이 PC만 집계 중",
    noLocalHistory: "로컬 기록 없음",
    codexLogNotRead: "Codex 로그를 아직 읽지 못했습니다.",
    codexHistNote: "한도(%·리셋)는 계정 전체(서버), 토큰·모델은 이 PC 로컬 기준입니다. 7일 미사용 모델은 자동 제외됩니다. Codex 모델별 비용은 안정적인 자동 매칭을 보장할 수 없어 표시하지 않습니다.",
    colSection: "구간",
    colTokens: "토큰",
    secLast7: "최근 7일",
    secToday: "오늘",
    secLast5h: "최근 5시간",
    secCurrentThread: "현재 스레드",
    filesScanned: "스캔 파일",
    lastScan: "마지막 스캔",
    lastUpdate: "마지막 갱신",
    currentThreadCum: "현재 스레드 누적",
    codexModelNote: "이 PC 로컬 Codex 로그 기준 · 다른 PC/브라우저/원격 환경 사용분은 빠질 수 있음 · 7일 미사용 모델 자동 제외 · 비용은 표시하지 않음 · Codex의 출력 토큰은 추론 토큰을 이미 포함합니다(별도 합산 시 이중 계산).",
    localScanFailed: "로컬 로그 스캔 실패 · 마지막 성공값 표시 중",
    colOutReason: "출력(추론 포함)",
    colEvents: "이벤트",
    unknownModel: "미확인",
    no7dThreads: "최근 7일 스레드 사용 없음",
    threadsNote: "스레드 전체 누적이 아니라 최근 7일에 발생한 토큰만 표시합니다.",
    colThread: "스레드",
    colModel: "모델",
    colUpdated: "갱신",
    estimated: "추정",
    notConfigured: "미설정",
    customCmdHint: "codexUsageMonitor.extraUsageCommand 로 사용자 리포터를 표시할 수 있습니다.",
    dayWindow: "일 윈도우",
    hourWindow: "시간 윈도우",
    minWindow: "분 윈도우",
    // 사용 추이 차트
    trendCard: "사용 추이 (이 PC · 최근 14일)",
    trendDailyNote: "일별 토큰 · 모델별 색상 · 막대에 마우스를 올리면 상세",
    trendHourlyTitle: "최근 24시간",
    etcModels: "기타",
    // 턴당 통계
    turnsCard: "턴당 토큰 (이 PC · 최근 7일)",
    turnsNote: "턴 = 사용자 입력 1회부터 최종 응답까지(도구 호출·서브에이전트 포함) · 턴은 토큰을 가장 많이 쓴 모델에 귀속 · 턴 구분 정보가 없는 옛 로그는 제외됩니다.",
    colTurns: "턴",
    colCalls: "호출",
    colAvgTurn: "평균/턴",
    colMedianTurn: "중앙값",
    colP90Turn: "P90",
    colOutTurn: "출력/턴",
    colCostTurn: "$/턴",
    noTurnData: "최근 7일 턴 데이터 없음",
    // 캐시 효율
    cacheCard: "캐시 효율 (이 PC · 최근 7일 · 추정)",
    cacheHit: "캐시 적중률",
    cacheSaved: "절약 추정",
    cacheRead: "캐시 읽기",
    cacheWrite: "캐시 쓰기",
    freshInput: "일반 입력",
    cacheNote: "적중률 = 캐시 읽기 ÷ (캐시 읽기+캐시 쓰기+일반 입력) · 절약 = 캐시 읽기를 일반 입력 단가로 냈을 때와의 차액에서 캐시 쓰기 할증을 뺀 순절감 추정치입니다.",
    // Codex 캐시 적중률
    codexCacheCard: "캐시 적중률 (이 PC · 최근 7일)",
    codexCacheNote: "Codex의 캐시 읽기(cached_input)는 입력(input)의 부분집합입니다 · 적중률 = 캐시 읽기 ÷ 전체 입력 · 절약액($)은 Codex의 새 모델/별칭이 자주 바뀌어 모델별 단가 자동 매칭을 안정적으로 보장할 수 없어 산출하지 않습니다.",
    nonCachedInput: "비캐시 입력",
    totalInput: "전체 입력",
    // 활동 히트맵
    heatmapCard: "활동 히트맵 (이 PC · 최근 4주)",
    heatmapNote: "요일 × 시간대별 토큰 분포",
    heatLess: "적음",
    heatMore: "많음",
    weekdaysShort: "월,화,수,목,금,토,일",
    // 한도 스파크라인
    sparkNote: "최근 사용률 추이 · 점선은 현재 추세 연장",
  };

  const en: Record<string, string> = {
    pageTitle: "AI Agent Usage",
    refresh: "Refresh",
    codexReconnect: "Reconnect Codex",
    claudeScopeNote: "Limits (%/reset) are <b>account-wide</b> (server); tokens/cost/models are <b>this PC's local</b> logs.",
    codexScopeNote: "Limits (%/reset) are <b>account-wide</b> (server); tokens/models are <b>this PC's local Codex logs</b>. Codex model costs are not shown because new model IDs and aliases change too often to guarantee stable automatic matching.",
    mergeTitle: "Merge other environments",
    mergeAuto: "On the same PC and account, CLI · VS Code · multiple projects are <b>all merged automatically</b> — nothing to do.",
    mergeWhen: "Only when a <b>separate .claude folder</b> exists (other Windows account · WSL · another drive/PC), add that environment's folder below.",
    browse: "📁 Pick a folder to add",
    pathPlaceholder: "or type a path (e.g. \\\\wsl$\\Ubuntu\\home\\you\\.claude\\projects)",
    add: "Add",
    remove: "Remove",
    noPaths: "No paths added — counting this PC only",
    notConnected: "Not connected",
    fiveHourLimit: "5-hour limit",
    weeklyLimit: "Weekly limit",
    weeklyOpusLimit: "Weekly · Opus-only limit",
    weeklySonnetLimit: "Weekly · Sonnet-only limit",
    sessionCard: "Current session (this PC)",
    local7dCard: "Last 7d local tokens",
    costCard: "Cost (this PC · last 7d · est.)",
    byModelCard: "By model (this PC · last 7d)",
    planAlert: "Plan limit notice",
    tokenAlert: "Token aggregation notice",
    status: "Status",
    lookingCreds: "Looking for Claude credentials…",
    notApplicable: "N/A",
    noData: "No data",
    noAgentsDetected: "No detected agents",
    noAgentsHint: "Codex or Claude Code appears automatically when credentials or local logs are detected.",
    usedSuffix: "% used",
    resetsUntil: "resets in",
    noResetTime: "no reset time",
    thisPcTokens: "This PC tokens",
    byTrend: "At current rate,",
    about: "about",
    afterExhaust: "until exhausted",
    noReachWindow: "At current rate, won't hit this window's limit",
    noSession: "No session",
    tokensUnit: "tokens",
    model: "Model",
    contextOccupied: "context",
    today: "Today",
    last5h: "Last 5h",
    days7tokens: "7d tokens",
    per7d: "/ 7d",
    no7dUse: "No usage in last 7 days",
    byModelNote: "Based on this PC's local logs · other environments may be missing (see weekly limit % above) · models unused in 7d auto-excluded · cost is an estimate · Claude does not expose separate reasoning-token counts, so they are included in output.",
    col7dTokens: "7d tokens",
    col7dCost: "7d $",
    dayN: "d",
    hourN: "h",
    minN: "m",
    soon: "soon",
    account: "Account",
    connection: "Connection",
    connecting: "Connecting",
    connected: "Connected",
    disconnected: "Disconnected",
    notRefreshed: "Not refreshed",
    noAccount: "No account",
    credits: "Credits",
    spendLimit: "Spend limit",
    recentTokens: "Recent token usage",
    customCmd: "Custom command",
    sevenDayLimitCodex: "Weekly limit",
    noLimitInfo: "No limit data",
    noLimitSub: "No limit values received from the Codex server yet.",
    sameWindowLocal: "Local tokens (same window)",
    unlimited: "Unlimited",
    available: "Available",
    noCredits: "No credits",
    unknownBalance: "Unknown balance",
    balance: "Balance",
    remainingMid: "% remaining ·",
    waitingTokens: "Waiting for token updates",
    waitingTokensSub: "Updates when Codex threads emit usage events.",
    colScope: "Scope",
    colTotal: "Total",
    colInput: "Input",
    colCache: "Cache",
    colOutput: "Output",
    colReasoning: "Reasoning",
    lastTurn: "Last turn",
    threadTotal: "Thread total",
    contextWindow: "Context window",
    codexHistTitle: "Last 7d local tokens",
    codexModelTitle: "By model (this PC · last 7d)",
    codexThreadsTitle: "Recent threads (this PC · last 7d)",
    codexMergeTitle: "Merge other environments",
    codexMergeAuto: "On the same PC and account, CLI · IDE · multiple sessions are <b>all merged automatically</b> — nothing to do.",
    codexMergeWhen: "Only when a <b>separate .codex folder</b> exists (other Windows account · WSL · another drive/PC), add that environment's folder below.",
    codexBrowse: "📁 Pick a folder to add",
    codexPathPlaceholder: "or type a path (e.g. \\\\wsl$\\Ubuntu\\home\\you\\.codex\\sessions)",
    codexNoPaths: "No paths added — counting this PC only",
    noLocalHistory: "No local history",
    codexLogNotRead: "Codex logs not read yet.",
    codexHistNote: "Limits (%/reset) are account-wide (server); tokens/models are this PC's local logs. Models unused in 7d are auto-excluded. Codex model costs are not shown because stable automatic matching cannot be guaranteed.",
    colSection: "Window",
    colTokens: "Tokens",
    secLast7: "Last 7d",
    secToday: "Today",
    secLast5h: "Last 5h",
    secCurrentThread: "Current thread",
    filesScanned: "Files scanned",
    lastScan: "Last scan",
    lastUpdate: "Last update",
    currentThreadCum: "Current thread total",
    codexModelNote: "Based on this PC's local Codex logs · other PC/browser/remote usage may be missing · models unused in 7d auto-excluded · cost is not shown · Codex output tokens already include reasoning tokens (adding them would double-count).",
    localScanFailed: "Local log scan failed · showing last successful values",
    colOutReason: "Output (incl. reasoning)",
    colEvents: "Events",
    unknownModel: "unknown",
    no7dThreads: "No thread usage in last 7 days",
    threadsNote: "Shows tokens from the last 7 days only, not each thread's all-time total.",
    colThread: "Thread",
    colModel: "Model",
    colUpdated: "Updated",
    estimated: "est.",
    notConfigured: "Not configured",
    customCmdHint: "Set codexUsageMonitor.extraUsageCommand to show a custom reporter here.",
    dayWindow: "d window",
    hourWindow: "h window",
    minWindow: "m window",
    // Usage trend chart
    trendCard: "Usage trend (this PC · last 14d)",
    trendDailyNote: "Daily tokens · colored by model · hover a bar for details",
    trendHourlyTitle: "Last 24 hours",
    etcModels: "other",
    // Per-turn stats
    turnsCard: "Tokens per turn (this PC · last 7d)",
    turnsNote: "A turn spans one user input to the final response (tool calls and subagents included) · each turn is attributed to the model that used the most tokens · old logs without turn markers are excluded.",
    colTurns: "Turns",
    colCalls: "Calls",
    colAvgTurn: "Avg/turn",
    colMedianTurn: "Median",
    colP90Turn: "P90",
    colOutTurn: "Out/turn",
    colCostTurn: "$/turn",
    noTurnData: "No turn data in last 7 days",
    // Cache efficiency
    cacheCard: "Cache efficiency (this PC · last 7d · est.)",
    cacheHit: "Cache hit rate",
    cacheSaved: "Est. saved",
    cacheRead: "Cache read",
    cacheWrite: "Cache write",
    freshInput: "Fresh input",
    cacheNote: "Hit rate = cache read ÷ (cache read + cache write + fresh input) · savings = what cache reads would cost at fresh-input rates, minus the cache-write premium (net estimate).",
    // Codex cache hit rate
    codexCacheCard: "Cache hit rate (this PC · last 7d)",
    codexCacheNote: "Codex cached_input is a subset of input · hit rate = cache reads ÷ total input · $ savings are not estimated because Codex model IDs/aliases change too often to guarantee stable automatic price matching.",
    nonCachedInput: "Non-cached input",
    totalInput: "Total input",
    // Activity heatmap
    heatmapCard: "Activity heatmap (this PC · last 4 weeks)",
    heatmapNote: "Tokens by weekday × hour",
    heatLess: "Less",
    heatMore: "More",
    weekdaysShort: "Mon,Tue,Wed,Thu,Fri,Sat,Sun",
    // Limit sparkline
    sparkNote: "Recent utilization trend · dashed line extends the current rate",
  };

  return lang === "ko" ? ko : en;
}
