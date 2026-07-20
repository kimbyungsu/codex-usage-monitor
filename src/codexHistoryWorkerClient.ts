import * as path from "path";
import { Worker } from "worker_threads";
import { CodexHistoryScanResult } from "./codexHistory";

interface PendingRequest {
  resolve: (result: CodexHistoryScanResult) => void;
  reject: (error: Error) => void;
}

interface InFlightScan {
  key: string;
  promise: Promise<CodexHistoryScanResult>;
}

export class CodexHistoryWorkerClient {
  private worker?: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private inFlight?: InFlightScan;
  private disposed = false;

  constructor(
    private readonly cacheDir: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  scan(codexHome?: string, extraSessionPaths: string[] = []): Promise<CodexHistoryScanResult> {
    if (this.disposed) {
      return Promise.reject(new Error("Codex history worker is disposed"));
    }
    const key = JSON.stringify([codexHome ?? null, extraSessionPaths]);
    if (this.inFlight?.key === key) {
      return this.inFlight.promise;
    }
    if (this.inFlight) {
      return this.inFlight.promise.then(() => this.scan(codexHome, extraSessionPaths));
    }

    const promise = this.requestScan(codexHome, extraSessionPaths);
    this.inFlight = { key, promise };
    const clearInFlight = (): void => {
      if (this.inFlight?.promise === promise) {
        this.inFlight = undefined;
      }
    };
    void promise.then(clearInFlight, clearInFlight);
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    const error = new Error("Codex history worker disposed");
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
    this.inFlight = undefined;
    if (this.worker) {
      void this.worker.terminate();
      this.worker = undefined;
    }
  }

  private requestScan(
    codexHome: string | undefined,
    extraSessionPaths: string[],
  ): Promise<CodexHistoryScanResult> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<CodexHistoryScanResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ type: "scan", id, codexHome, extraSessionPaths });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const workerPath = path.join(__dirname, "codexHistoryWorker.js");
    const worker = new Worker(workerPath, { workerData: { cacheDir: this.cacheDir } });
    worker.on("message", (message: any) => {
      const request = this.pending.get(Number(message?.id));
      if (!request) {
        return;
      }
      this.pending.delete(Number(message.id));
      if (message.type === "result") {
        request.resolve(message.result as CodexHistoryScanResult);
      } else {
        request.reject(new Error(String(message.error || "Codex history worker failed")));
      }
    });
    worker.on("error", (error) => this.failWorker(error));
    worker.on("exit", (code) => {
      if (!this.disposed) {
        this.failWorker(new Error(`Codex history worker exited with code ${code}`));
      }
    });
    this.worker = worker;
    this.log(`[codex] history worker started (${workerPath})`);
    return worker;
  }

  private failWorker(error: Error): void {
    this.log(`[codex] history worker failed: ${error.message}`);
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
    this.inFlight = undefined;
    this.worker = undefined;
  }
}
