import { Gunzip, Unzip, UnzipInflate } from "fflate";
import { inferSourceKind, StreamingKlippyLogAnalyzer } from "./analyzer";
import {
  buildDiagnosticBundleFindings,
  diagnosticBundleFindingSeverityRank,
  parseDiagnosticBundleEvidence,
} from "./diagnosticBundleEvidence";
import { correlateFindingsWithDiagnosticConfig } from "./diagnosticConfigEvidence";
import { correlateFindingsWithUsbTopology } from "./diagnosticUsbEvidence";
import { buildDiagnosticSummary } from "./summary";
import type {
  DiagnosticBundleArtifact,
  DiagnosticBundleSummary,
  KlippyLogAnalysis,
  LogSourceSummary,
} from "./types";

export const maximumCompressedLogBytes = 256 * 1024 * 1024;
export const maximumExpandedLogBytes = 512 * 1024 * 1024;
const maximumDiagnosticSnapshotBytes = 4 * 1024 * 1024;
const maximumDiagnosticSnapshotTotalBytes = 16 * 1024 * 1024;
const supportedDiagnosticSnapshots = new Set([
  "snapshots/gcode-store.json",
  "snapshots/host-scheduling.json",
  "snapshots/job-history.json",
  "snapshots/printer-info.json",
  "snapshots/printer-objects.json",
  "snapshots/server-info.json",
  "snapshots/temperature-store.json",
  "snapshots/usb-serial-topology.json",
]);

export type AnalysisProgress = {
  expandedBytes: number;
  fileIndex: number;
  fileName: string;
  fileTotal: number;
  processedBytes: number;
  totalBytes: number;
};

export async function analyzeLogFiles(
  files: File[],
  onProgress: (progress: AnalysisProgress) => void = () => undefined,
): Promise<KlippyLogAnalysis> {
  if (!files.length) throw new Error("Choose at least one log file.");
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > maximumCompressedLogBytes) {
    throw new Error("The selected files exceed the 256 MiB compressed input limit.");
  }

  const analyzer = new StreamingKlippyLogAnalyzer({
    byteSize: totalBytes,
    fileName: files.length === 1 ? files[0].name : `${files.length} log files`,
  });
  let processedBytes = 0;
  let totalExpandedBytes = 0;
  let bundle: DiagnosticBundleSummary | null = null;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const reportProgress = () => onProgress({
      expandedBytes: totalExpandedBytes,
      fileIndex,
      fileName: file.name,
      fileTotal: files.length,
      processedBytes,
      totalBytes,
    });
    if (/\.zip$/i.test(file.name) || file.type === "application/zip") {
      const result = await analyzeDiagnosticBundle(
        file,
        analyzer,
        (processed, expanded) => {
          processedBytes += processed;
          totalExpandedBytes += expanded;
          if (totalExpandedBytes > maximumExpandedLogBytes) {
            throw new Error("Expanded log data exceeds the 512 MiB safety limit.");
          }
          reportProgress();
        },
      );
      bundle = result ?? bundle;
      reportProgress();
      continue;
    }
    const compressed = /\.gz$/i.test(file.name);
    const sourceName = compressed ? file.name.replace(/\.gz$/i, "") : file.name;
    const source: LogSourceSummary = {
      compressed,
      kind: inferSourceKind(sourceName),
      lineCount: 0,
      name: sourceName,
      size: file.size,
    };
    analyzer.beginSource(source);
    const decoder = new TextDecoder();
    if (compressed) {
      let expansionError: Error | null = null;
      const gunzip = new Gunzip((chunk, final) => {
        if (expansionError) return;
        totalExpandedBytes += chunk.byteLength;
        if (totalExpandedBytes > maximumExpandedLogBytes) {
          expansionError = new Error("Expanded log data exceeds the 512 MiB safety limit.");
          return;
        }
        const text = decoder.decode(chunk, { stream: !final });
        if (text) analyzer.pushChunk(text);
      });
      for await (const value of readFileChunks(file)) {
        processedBytes += value.byteLength;
        gunzip.push(value, false);
        if (expansionError) throw expansionError;
        reportProgress();
      }
      gunzip.push(new Uint8Array(), true);
      if (expansionError) throw expansionError;
    } else {
      for await (const value of readFileChunks(file)) {
        processedBytes += value.byteLength;
        totalExpandedBytes += value.byteLength;
        if (totalExpandedBytes > maximumExpandedLogBytes) {
          throw new Error("Expanded log data exceeds the 512 MiB safety limit.");
        }
        const text = decoder.decode(value, { stream: true });
        if (text) analyzer.pushChunk(text);
        reportProgress();
      }
      const remainder = decoder.decode();
      if (remainder) analyzer.pushChunk(remainder);
    }
    analyzer.endSource();
    reportProgress();
  }

  const analysis = analyzer.finish();
  const latestSession = analysis.sessions[analysis.sessions.length - 1]?.number;
  const bundleFindings = bundle?.evidence && latestSession
    ? buildDiagnosticBundleFindings(bundle.evidence, latestSession)
    : [];
  const configFindings = bundle?.evidence?.config
    ? correlateFindingsWithDiagnosticConfig(analysis.findings, bundle.evidence.config)
    : analysis.findings;
  const logFindings = bundle?.evidence
    ? correlateFindingsWithUsbTopology(configFindings, bundle.evidence)
    : configFindings;
  const findings = [...logFindings, ...bundleFindings].sort((left, right) =>
    diagnosticBundleFindingSeverityRank[left.severity] - diagnosticBundleFindingSeverityRank[right.severity]
    || right.session - left.session
    || left.title.localeCompare(right.title));
  return {
    ...analysis,
    bundle,
    findings,
    summary: buildDiagnosticSummary(analysis.sessions, findings),
  };
}

async function analyzeDiagnosticBundle(
  file: File,
  analyzer: StreamingKlippyLogAnalyzer,
  reportBytes: (processed: number, expanded: number) => void,
): Promise<DiagnosticBundleSummary | null> {
  let archiveError: Error | null = null;
  let manifestText = "";
  let retainedSnapshotBytes = 0;
  const snapshotIngestionWarnings: string[] = [];
  const snapshotTexts = new Map<string, string>();
  let logEntries = 0;
  const unzipper = new Unzip((entry) => {
    if (archiveError) return;
    const normalizedName = entry.name.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalizedName || normalizedName.includes("../") || normalizedName.endsWith("/")) return;
    if (normalizedName === "manifest.json") {
      const decoder = new TextDecoder();
      entry.ondata = (error, data, final) => {
        if (error) {
          archiveError = new Error(`Could not read diagnostic bundle manifest: ${error.message}`);
          return;
        }
        if (manifestText.length + data.byteLength > 1024 * 1024) {
          archiveError = new Error("Diagnostic bundle manifest exceeds the 1 MiB safety limit.");
          return;
        }
        manifestText += decoder.decode(data, { stream: !final });
      };
      entry.start();
      return;
    }
    if (supportedDiagnosticSnapshots.has(normalizedName)) {
      const decoder = new TextDecoder();
      let retainedBytes = 0;
      let oversized = false;
      let text = "";
      entry.ondata = (error, data, final) => {
        if (error) {
          snapshotIngestionWarnings.push(`Could not expand ${normalizedName}: ${error.message}`);
          return;
        }
        try {
          reportBytes(0, data.byteLength);
        } catch (reason) {
          archiveError = reason instanceof Error ? reason : new Error("Diagnostic bundle exceeded its safety limit.");
          return;
        }
        retainedBytes += data.byteLength;
        retainedSnapshotBytes += data.byteLength;
        if (
          retainedBytes > maximumDiagnosticSnapshotBytes
          || retainedSnapshotBytes > maximumDiagnosticSnapshotTotalBytes
        ) {
          if (!oversized) {
            oversized = true;
            snapshotIngestionWarnings.push(`${normalizedName} exceeded the browser snapshot analysis limit.`);
          }
          return;
        }
        text += decoder.decode(data, { stream: !final });
        if (final && !oversized) snapshotTexts.set(normalizedName, text);
      };
      entry.start();
      return;
    }
    if (!/\.(?:log|txt)(?:\.gz)?$/i.test(normalizedName)) return;
    logEntries += 1;
    if (logEntries > 16) {
      archiveError = new Error("Diagnostic bundle contains more than 16 analyzable log sources.");
      return;
    }
    const nestedGzip = /\.gz$/i.test(normalizedName);
    const sourceName = normalizedName
      .replace(/^logs\//i, "")
      .replace(/\.gz$/i, "");
    const source: LogSourceSummary = {
      compressed: nestedGzip,
      kind: inferSourceKind(sourceName),
      lineCount: 0,
      name: sourceName,
      size: entry.originalSize ?? 0,
    };
    analyzer.beginSource(source);
    const decoder = new TextDecoder();
    const pushText = (data: Uint8Array, final: boolean) => {
      if (archiveError) return;
      try {
        reportBytes(0, data.byteLength);
      } catch (reason) {
        archiveError = reason instanceof Error ? reason : new Error("Diagnostic bundle exceeded its safety limit.");
        return;
      }
      const text = decoder.decode(data, { stream: !final });
      if (text) analyzer.pushChunk(text);
      if (final) analyzer.endSource();
    };
    const gunzip = nestedGzip
      ? new Gunzip((data, final) => pushText(data, final))
      : null;
    entry.ondata = (error, data, final) => {
      if (error) {
        archiveError = new Error(`Could not expand ${normalizedName}: ${error.message}`);
        return;
      }
      if (gunzip) gunzip.push(data, final);
      else pushText(data, final);
    };
    entry.start();
  });
  unzipper.register(UnzipInflate);
  try {
    for await (const value of readFileChunks(file)) {
      reportBytes(value.byteLength, 0);
      unzipper.push(value, false);
      if (archiveError) throw archiveError;
    }
    unzipper.push(new Uint8Array(), true);
    if (archiveError) throw archiveError;
  } catch (reason) {
    throw reason instanceof Error ? reason : new Error("The diagnostic ZIP bundle could not be expanded.");
  }
  if (!logEntries) throw new Error("The diagnostic bundle does not contain an analyzable log.");
  return parseDiagnosticBundleManifest(manifestText, snapshotTexts, snapshotIngestionWarnings);
}

function parseDiagnosticBundleManifest(
  text: string,
  snapshots: Map<string, string>,
  snapshotIngestionWarnings: string[],
): DiagnosticBundleSummary | null {
  if (!text.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The diagnostic bundle manifest is not valid JSON.");
  }
  if (!isRecord(value) || value.schemaVersion !== 2 || !Array.isArray(value.artifacts)) {
    throw new Error("The diagnostic bundle uses an unsupported manifest format.");
  }
  const artifacts = value.artifacts.slice(0, 128).flatMap((artifact): DiagnosticBundleArtifact[] => {
    if (
      !isRecord(artifact)
      || typeof artifact.archiveName !== "string"
      || typeof artifact.kind !== "string"
      || typeof artifact.originalSizeBytes !== "number"
      || typeof artifact.storedSizeBytes !== "number"
      || !Number.isFinite(artifact.originalSizeBytes)
      || !Number.isFinite(artifact.storedSizeBytes)
      || artifact.originalSizeBytes < 0
      || artifact.storedSizeBytes < 0
      || typeof artifact.truncated !== "boolean"
    ) return [];
    return [{
      archiveName: artifact.archiveName.slice(0, 240),
      kind: artifact.kind.slice(0, 80),
      originalSizeBytes: artifact.originalSizeBytes,
      storedSizeBytes: artifact.storedSizeBytes,
      truncated: artifact.truncated,
    }];
  });
  const client = isRecord(value.client) ? value.client : {};
  return {
    artifacts,
    clientVersion: typeof client.version === "string" ? client.version.slice(0, 80) : "",
    collectionWarnings: Array.isArray(value.collectionWarnings)
      ? value.collectionWarnings
        .filter((warning): warning is string => typeof warning === "string")
        .slice(0, 30)
        .map((warning) => warning.slice(0, 300))
      : [],
    evidence: parseDiagnosticBundleEvidence(snapshots, snapshotIngestionWarnings),
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt.slice(0, 80) : "",
    schemaVersion: 2,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function* readFileChunks(file: File): AsyncGenerator<Uint8Array> {
  if (typeof file.stream === "function") {
    const reader = file.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (typeof file.arrayBuffer === "function") {
    yield new Uint8Array(await file.arrayBuffer());
    return;
  }
  yield new TextEncoder().encode(await file.text());
}
