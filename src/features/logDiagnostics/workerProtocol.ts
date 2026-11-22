import type { AnalysisProgress } from "./fileAnalyzer";
import type { KlippyLogAnalysis } from "./types";

export type DiagnosticsWorkerRequest = {
  files: File[];
  id: string;
  type: "analyze";
};

export type DiagnosticsWorkerResponse =
  | { id: string; progress: AnalysisProgress; type: "progress" }
  | { analysis: KlippyLogAnalysis; id: string; type: "complete" }
  | { error: string; id: string; type: "error" };
