# AI Agent Usage Monitor (Codex + Claude)

See **Codex and Claude Code usage side by side**, always on, right in the VS Code status bar — plus a dashboard with limits, tokens, trends and activity.

Both agents work **without a separate login**: the extension reuses the credentials of the CLIs you are already signed in to.

- **Codex**: runs the local `codex app-server --stdio` and reads the current account, rate limits and tokens live (it never copies the `auth.json` token). Codex shows limits, tokens and models only — no cost.
- **Claude Code**: calls the same OAuth usage endpoint that the official `/usage` command uses, with the token in `~/.claude/.credentials.json`, to get the limit windows that apply to your account (5-hour, weekly, model-specific, …). Tokens and estimated cost are aggregated from the `~/.claude/projects/**/*.jsonl` transcripts. Credentials are **read only** — the extension never refreshes tokens or writes the file, so it can never interfere with Claude Code's sign-in (including account switches). Claude Code refreshes its own token whenever it is used, so while Claude Code is in use in any window on this PC the limits keep updating with the account-wide total (other windows, the web and other devices included). If Claude Code has not been used on this PC for longer than the token lifetime (usually 8 hours) and the token expires, the extension stops calling the server and quietly shows the last values with a 'last checked' time, then, when Claude Code renews the token (it watches the credentials file), schedules a new read about a second later — after any server-requested retry wait — including everything used meanwhile.

## Screenshots

**Claude Code section** — limit charts (window start → reset · solid = actual usage so far · dashed = average since the window started), 14-day usage trend stacked by model, tokens per turn by model (avg/median/P90/$), cache efficiency (hit rate and estimated savings), weekday × hour activity heatmap:

![Claude dashboard](https://raw.githubusercontent.com/kimbyungsu/codex-usage-monitor/main/docs/screenshot-claude.png)

**Codex section** — the same trend / per-turn / heatmap views (no cost, by design):

![Codex dashboard](https://raw.githubusercontent.com/kimbyungsu/codex-usage-monitor/main/docs/screenshot-codex.png)

> Token and chart numbers in the screenshots come from real local logs; account, limit percentages and thread names are sample/anonymized values. The UI follows the VS Code display language (English or Korean).

## Status bar

Two items on the left: `Codex …` and `Claude …`, each showing **remaining %** and the time until reset.

```
Codex   5h 80% (2h10m) · 7d 54% (3d2h)      plan with a 5-hour limit
Codex   5h none · 7d 53% (1d16h)            plan without a 5-hour limit
```

- The 5-hour slot is always first. If your plan (or the current period) has no 5-hour limit, it reads `5h none` instead of shifting the weekly value into that slot. When the server reports a 5-hour window again, the percentage reappears in the same place.
- The background turns yellow/red as a limit gets close (server-reported severity when available, otherwise 80% / 95%).
- Hover for gauges, exact reset times, the plan name and depletion estimates; click to open the dashboard.

## Features

- **Claude**: usage % and time to reset for every limit window the server reports (5-hour, weekly, model-specific weekly, … — only those that apply), plan display name (follows plan renames), tokens/cost for the last 5h / 7 days, current session tokens and context use, tokens/cost by model (7 days), **recent threads (this PC, 7 days)**, merging other environments
- **Codex**: connection/account (plan display name), limit windows classified by length (5-hour, weekly, …, including model-specific limits) with usage %, reset and window length, credits, spend limit, recent tokens, local 7-day tokens by model and thread, **merging other environments**, custom command output
- Tokens update in near real time via transcript file watching
- Optional notifications when a Claude limit window crosses configurable thresholds

### Visualizations (Claude and Codex)

Drawn as inline SVG with no external libraries, so they work offline and under strict CSP.

- **Usage trend**: daily tokens for the last 14 days stacked by model, plus hourly bars for the last 24 hours (hover for details)
- **Tokens per turn**: per model, the average / median / P90 / output tokens of one turn (user input → final answer, including tool calls and sub-agents), so you can tell whether one long turn pulled the average up. Claude also shows estimated $ per turn
- **Cache efficiency**: Claude shows a hit-rate donut and the estimated net savings (after the cache-write premium); Codex shows a hit-rate donut (`cached_input` is a subset of `input`; no $ estimate because Codex model IDs/aliases change too often for reliable price matching)
- **Activity heatmap**: token distribution by weekday × hour over the last 4 weeks
- **Limit charts**: inside each limit card, x-axis = window start → reset; solid = actual usage so far, dashed = if the average since the window started holds, with the projected 100% point. The solid line uses only values the extension received from the server (no estimates): they are stored per account so the line continues across VS Code restarts and windows (extension storage folder; accounts are kept only as unrecognisable keys, and nothing is stored or joined when the current account cannot be identified, and such values are not joined to an identified account's line either; only records with the same reset time are joined, ambiguous ones are not). The servers do not provide past values, so the line is drawn only from points the extension actually received — the current window from when the extension first saw it, and later windows only while the extension is running and receiving server values. The detailed usage during periods when VS Code was closed or reads failed (expired token, connection errors) is not reconstructed or back-filled; such a period is drawn as a **faint** segment between the surrounding points, while periods with continuous readings stay solid (a period counts as "no values received" when the observation times of consecutive new values are further apart than 30 minutes or three times the normal polling interval, whichever is longer — including while the server only repeated an old observation time; new values received by another VS Code window count) (Codex local session logs are not used, because they cannot tell which account produced each record). Chart history is not used for the forecast.

## Plans whose limits change

Which limit windows apply is decided by the server per plan and per period — for example, Codex suspended the 5-hour limit for some plans in July 2026 (restored for Plus, still off for Pro), and Claude removed it for verified Ultra accounts in October 2026. The extension therefore has no fixed "5-hour / weekly" slots in its data model: it shows only the windows the server reports, classified by **length or kind** — Codex by `windowDurationMins` (when there is no 5-hour window, the weekly window arrives in the first position, so position is never trusted), Claude by the `limits[]` meters of the usage response (`kind` / `group`; older servers fall back to the fixed fields). New meters appear without an extension update.

## Commands

- `AI Usage Monitor: Open dashboard`
- `AI Usage Monitor: Refresh` (Codex and Claude)
- `AI Usage Monitor: Reconnect Codex`
- `AI Usage Monitor: Refresh Claude`

## Settings

Codex

- `codexUsageMonitor.codexCommand`: Codex executable path/command (default `codex`; the binary bundled with the official OpenAI extension is used when found)
- `codexUsageMonitor.refreshIntervalSeconds`: Codex refresh interval (default `60` s)
- `codexUsageMonitor.extraUsageCommand`: show the output of a custom usage reporter command
- `codexUsageMonitor.codexExtraSessionPaths`: other environments' Codex `sessions` folders (or `.codex` homes) to include
- `codexUsageMonitor.showStatusBar`: show the Codex status bar item
- `codexUsageMonitor.notifyOnStartup`: one-time startup notice

Claude

- `codexUsageMonitor.showClaudeStatusBar`: show the Claude status bar item
- `codexUsageMonitor.claudeConfigDir`: Claude config folder (empty = `CLAUDE_CONFIG_DIR` or `~/.claude`)
- `codexUsageMonitor.claudePlanRefreshSeconds`: base refresh interval for plan limits (default `120` s, min 30 s). On HTTP 429 the interval doubles (up to 15 min) and converges back, never below this value
- `codexUsageMonitor.claudeTokenRefreshSeconds`: token re-aggregation interval (default `15` s, together with file watching)
- `codexUsageMonitor.claudeExtraProjectPaths`: other environments' `projects` folders to include
- `codexUsageMonitor.claudeUsageAlertThresholds`: notification thresholds in % (default `[80, 95]`, empty disables)

General

- `codexUsageMonitor.language`: `auto` (follow VS Code), `en` or `ko`

## Notes and limitations

- **Claude limits** are the same values `/usage` shows, but they come from an undocumented internal OAuth usage endpoint (the one the official Claude Code CLI uses). If it changes, limit display may stop working; local token/cost/model aggregation keeps working independently and the status bar falls back to local token info.
- **Claude cost (USD)** is an estimate at public per-model API prices, not what a subscription actually bills.
- **TLS / certificates**: requests follow VS Code's system certificate and proxy handling (`http.systemCertificates`, `http.proxy`). On newer extension hosts (Node 22+), OS certificates are merged in as well. Certificate verification is never disabled, to protect the OAuth token.
- **Data scope**: limit percentages are account-wide (all environments — always from the server); tokens and models come from this PC's local logs. Merging other environments affects only token/model/cost/thread aggregation, never limit percentages or limit charts. Add other environments' folders from the dashboard to merge them.
- **Large transcripts**: session logs can grow to hundreds of MB or more; they are parsed by streaming in chunks (no string-size limit) and incrementally for active sessions.
- **Run-out projection (average since the window started)**: based on the reset time the server reports for your account and that window's start (the server's value when given, otherwise reset − window length), it checks whether the average pace since the window started would reach 100% before the reset — e.g. "runs out around Sun 11/15 5:27 PM (before reset Mon 11/16 10:00 PM)". Near the reset it shows a range that accounts for reported-value rounding (±0.5 pt), otherwise "about 97% at reset". Claude and Codex share one calculation.
- **Reset points are not fixed**: Codex reset times jitter by seconds, windows restart early (usage drops and the reset jumps), and two reset points can alternate (Claude may do the same). Projections are recomputed from the latest reset time on every reading; if usage drops within the same window (a limit restore keeps the regular reset schedule), the numeric projection is held until that window ends.
- **Freshness**: projections are computed at the time each value was observed; the view re-renders every minute so remaining time, passed resets and passed run-out times update, and stale or failed readings are labelled "as of last reading HH:MM".

Source, releases and Korean documentation: [github.com/kimbyungsu/codex-usage-monitor](https://github.com/kimbyungsu/codex-usage-monitor)
