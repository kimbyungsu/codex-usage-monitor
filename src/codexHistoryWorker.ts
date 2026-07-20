import { parentPort, workerData } from "worker_threads";
import { CodexHistoryIndex } from "./codexHistory";

interface ScanRequest {
  type: "scan";
  id: number;
  codexHome?: string;
  extraSessionPaths: string[];
}

const port = parentPort;
if (!port) {
  throw new Error("codexHistoryWorker must run in a Worker Thread");
}

const index = new CodexHistoryIndex(
  typeof workerData?.cacheDir === "string" ? workerData.cacheDir : undefined,
);

port.on("message", (request: ScanRequest) => {
  if (!request || request.type !== "scan") {
    return;
  }
  try {
    const result = index.scan(request.codexHome, request.extraSessionPaths);
    port.postMessage({ type: "result", id: request.id, result });
  } catch (error) {
    port.postMessage({
      type: "error",
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
