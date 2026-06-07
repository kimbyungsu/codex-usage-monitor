import { EventEmitter } from "events";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { OutputChannel } from "vscode";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

export class CodexRpcClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  constructor(private readonly codexCommand: string, private readonly output: OutputChannel) {
    super();
  }

  get isRunning(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.child = spawn(this.codexCommand, ["app-server", "--stdio"], {
      windowsHide: true,
      shell: false,
    });

    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.output.appendLine(text);
      }
    });
    this.child.on("error", (error) => {
      this.rejectAll(error);
      this.emit("error", error);
    });
    this.child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
      this.child = undefined;
      this.emit("close", { code, signal });
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex-usage-monitor",
        title: "Codex Usage Monitor",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  async request<T>(method: string, params: unknown = {}, timeoutMs = 15000): Promise<T> {
    if (!this.child || this.child.killed) {
      throw new Error("Codex app-server is not running");
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      this.child?.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(error);
        }
      });
    });
  }

  dispose(): void {
    this.rejectAll(new Error("Codex app-server client disposed"));
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = undefined;
  }

  private handleStdout(text: string): void {
    this.buffer += text;

    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }

      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }

      try {
        const message = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: { message?: string };
        };

        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) {
            continue;
          }
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error) {
            pending.reject(new Error(message.error.message ?? "Codex app-server request failed"));
          } else {
            pending.resolve(message.result);
          }
          continue;
        }

        if (message.method) {
          this.emit("notification", message.method, message.params);
        }
      } catch (error) {
        this.output.appendLine(`Failed to parse Codex app-server message: ${(error as Error).message}`);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
