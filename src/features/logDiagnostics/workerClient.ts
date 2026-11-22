import { analyzeLogFiles, type AnalysisProgress } from "./fileAnalyzer";
import type { KlippyLogAnalysis } from "./types";
import type { DiagnosticsWorkerRequest, DiagnosticsWorkerResponse } from "./workerProtocol";

export type AnalysisTask = {
  cancel: () => void;
  promise: Promise<KlippyLogAnalysis>;
};

export function startLogAnalysis(
  files: File[],
  onProgress: (progress: AnalysisProgress) => void,
): AnalysisTask {
  if (typeof Worker === "undefined") {
    return {
      cancel: () => undefined,
      promise: analyzeLogFiles(files, onProgress),
    };
  }

  const worker = new Worker(new URL("./logDiagnostics.worker.ts", import.meta.url), { type: "module" });
  const id = crypto.randomUUID();
  let settled = false;
  let rejectTask: (reason: Error) => void = () => undefined;
  const promise = new Promise<KlippyLogAnalysis>((resolve, reject) => {
    rejectTask = reject;
    worker.addEventListener("message", (event: MessageEvent<DiagnosticsWorkerResponse>) => {
      if (event.data.id !== id) return;
      if (event.data.type === "progress") {
        onProgress(event.data.progress);
        return;
      }
      settled = true;
      worker.terminate();
      if (event.data.type === "complete") resolve(event.data.analysis);
      else reject(new Error(event.data.error));
    });
    worker.addEventListener("error", () => {
      settled = true;
      worker.terminate();
      reject(new Error("The background log analyzer stopped unexpectedly."));
    });
    worker.postMessage({ files, id, type: "analyze" } satisfies DiagnosticsWorkerRequest);
  });

  return {
    cancel: () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectTask(new Error("Log analysis was cancelled."));
    },
    promise,
  };
}
