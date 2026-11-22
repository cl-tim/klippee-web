/// <reference lib="webworker" />

import { analyzeLogFiles } from "./fileAnalyzer";
import type { DiagnosticsWorkerRequest, DiagnosticsWorkerResponse } from "./workerProtocol";

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.addEventListener("message", (event: MessageEvent<DiagnosticsWorkerRequest>) => {
  if (event.data.type !== "analyze") return;
  const { files, id } = event.data;
  void analyzeLogFiles(files, (progress) => {
    worker.postMessage({ id, progress, type: "progress" } satisfies DiagnosticsWorkerResponse);
  }).then(
    (analysis) => worker.postMessage({ analysis, id, type: "complete" } satisfies DiagnosticsWorkerResponse),
    (reason) => worker.postMessage({
      error: reason instanceof Error ? reason.message : "The logs could not be analyzed.",
      id,
      type: "error",
    } satisfies DiagnosticsWorkerResponse),
  );
});

export {};
