import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CodexHistoryIndex } from "../../codexHistory";
import { CodexHistoryWorkerClient } from "../../codexHistoryWorkerClient";

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function eventLine(type: string, payload: Record<string, unknown>): string {
  return jsonLine({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type, ...payload },
  });
}

function tokenCountLine(lastTotal: number, cumulativeTotal: number): string {
  const usage = (total: number) => ({
    input_tokens: total - 3,
    cached_input_tokens: 1,
    output_tokens: 3,
    reasoning_output_tokens: 2,
    total_tokens: total,
  });
  return eventLine("token_count", {
    info: {
      last_token_usage: usage(lastTotal),
      total_token_usage: usage(cumulativeTotal),
      model_context_window: 258400,
    },
  });
}

suite("Codex history incremental index", () => {
  let tempRoot: string;
  let codexHome: string;
  let rolloutFile: string;
  let cacheFile: string;

  setup(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-history-index-"));
    codexHome = path.join(tempRoot, ".codex");
    const rolloutDir = path.join(codexHome, "sessions", "2026", "07", "20");
    fs.mkdirSync(rolloutDir, { recursive: true });
    rolloutFile = path.join(rolloutDir, "rollout-test.jsonl");
    cacheFile = path.join(tempRoot, "cache", "codex-history-cache-v4");

    // 실제 세션처럼 매우 큰 비사용량 payload를 포함해도 한 줄 전체 JSON.parse를 하지 않아야 한다.
    const largeMeta = jsonLine({
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: {
        id: "thread-test",
        thread_name: "incremental fixture",
        model: "gpt-test",
        base_instructions: { text: "x".repeat(400 * 1024) },
      },
    });
    const initial = [
      largeMeta,
      jsonLine({
        timestamp: new Date().toISOString(),
        type: "turn_context",
        payload: { turn_id: "turn-1", model: "gpt-test" },
      }),
      eventLine("task_started", { turn_id: "turn-1" }),
      tokenCountLine(100, 100),
    ].join("");
    fs.writeFileSync(rolloutFile, initial);
  });

  teardown(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("reuses an in-memory and persistent cache without rereading rollout bytes", () => {
    const index = new CodexHistoryIndex(cacheFile);
    const cold = index.scan(codexHome);
    assert.strictEqual(cold.history.filesScanned, 1);
    assert.strictEqual(cold.history.total.totalTokens, 100);
    assert.strictEqual(cold.history.session.totalTokens, 100);
    assert.strictEqual(cold.history.sessionModel, "gpt-test");
    assert.strictEqual(cold.diagnostics.filesParsedFull, 1);
    assert.ok(cold.diagnostics.bytesRead > 400 * 1024);
    assert.strictEqual(cold.diagnostics.cacheWritten, true);
    assert.strictEqual(cold.diagnostics.cacheFilesWritten, 1);
    const persistedBytes = fs.readdirSync(cacheFile)
      .reduce((total, name) => total + fs.statSync(path.join(cacheFile, name)).size, 0);
    assert.ok(
      persistedBytes < 16 * 1024,
      "persistent cache must not retain the large raw message body",
    );

    const warm = index.scan(codexHome);
    assert.strictEqual(warm.diagnostics.bytesRead, 0);
    assert.strictEqual(warm.diagnostics.cacheHits, 1);
    assert.strictEqual(warm.diagnostics.cacheFilesWritten, 0);
    assert.strictEqual(warm.history.total.totalTokens, cold.history.total.totalTokens);

    const restarted = new CodexHistoryIndex(cacheFile).scan(codexHome);
    assert.strictEqual(restarted.diagnostics.cacheLoaded, true);
    assert.strictEqual(restarted.diagnostics.bytesRead, 0);
    assert.strictEqual(restarted.diagnostics.cacheHits, 1);
    assert.strictEqual(restarted.history.total.totalTokens, cold.history.total.totalTokens);
  });

  test("reads only appended bytes and preserves parser state", () => {
    const index = new CodexHistoryIndex(cacheFile);
    index.scan(codexHome);
    const appended = [
      jsonLine({
        timestamp: new Date().toISOString(),
        type: "turn_context",
        payload: { turn_id: "turn-2", model: "gpt-next" },
      }),
      eventLine("task_started", { turn_id: "turn-2" }),
      tokenCountLine(50, 150),
    ].join("");
    fs.appendFileSync(rolloutFile, appended);

    const incremental = index.scan(codexHome);
    assert.strictEqual(incremental.diagnostics.filesParsedIncremental, 1);
    assert.strictEqual(incremental.diagnostics.filesParsedFull, 0);
    assert.strictEqual(incremental.diagnostics.cacheFilesWritten, 1);
    assert.strictEqual(incremental.diagnostics.bytesRead, Buffer.byteLength(appended));
    assert.strictEqual(incremental.history.total.totalTokens, 150);
    assert.strictEqual(incremental.history.session.totalTokens, 150);
    assert.strictEqual(incremental.history.sessionModel, "gpt-next");
  });

  test("falls back to a full parse when a file is rewritten", () => {
    const index = new CodexHistoryIndex(cacheFile);
    index.scan(codexHome);
    fs.writeFileSync(rolloutFile, [
      jsonLine({
        timestamp: new Date().toISOString(),
        type: "session_meta",
        payload: { id: "rewritten", model: "gpt-rewritten" },
      }),
      jsonLine({
        timestamp: new Date().toISOString(),
        type: "turn_context",
        payload: { turn_id: "turn-r", model: "gpt-rewritten" },
      }),
      eventLine("task_started", { turn_id: "turn-r" }),
      tokenCountLine(25, 25),
    ].join(""));

    const rewritten = index.scan(codexHome);
    assert.strictEqual(rewritten.diagnostics.filesParsedFull, 1);
    assert.strictEqual(rewritten.diagnostics.filesParsedIncremental, 0);
    assert.strictEqual(rewritten.history.total.totalTokens, 25);
    assert.strictEqual(rewritten.history.sessionModel, "gpt-rewritten");
  });

  test("waits for a newline before committing a partial JSONL record", () => {
    const index = new CodexHistoryIndex(cacheFile);
    index.scan(codexHome);
    const partial = tokenCountLine(50, 150).trimEnd();
    fs.appendFileSync(rolloutFile, partial);

    const incomplete = index.scan(codexHome);
    assert.strictEqual(incomplete.history.total.totalTokens, 100);

    fs.appendFileSync(rolloutFile, "\n");
    const completed = index.scan(codexHome);
    assert.strictEqual(completed.diagnostics.filesParsedIncremental, 1);
    assert.strictEqual(completed.history.total.totalTokens, 150);
    assert.strictEqual(completed.history.session.totalTokens, 150);
  });

  test("coalesces identical concurrent worker scans", async () => {
    const client = new CodexHistoryWorkerClient(cacheFile);
    try {
      const first = client.scan(codexHome);
      const second = client.scan(codexHome);
      assert.strictEqual(second, first);
      const result = await first;
      assert.strictEqual(result.history.total.totalTokens, 100);
      const warm = await client.scan(codexHome);
      assert.strictEqual(warm.diagnostics.bytesRead, 0);
    } finally {
      client.dispose();
    }
  });
});
