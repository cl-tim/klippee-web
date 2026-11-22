import { tabLabels } from "../../app/constants";
import { DiagnosticButton } from "./DiagnosticControls";
import {
  Activity,
  AlertTriangle,
  Cpu,
  Database,
  Download,
  FileText,
  FileUp,
  GitCompare,
  Lightbulb,
  ListTree,
  Settings2,
  ShieldCheck,
  Thermometer,
  Trash2,
} from "lucide-react";
import { Menu, Tabs, UnstyledButton } from "@mantine/core";
import { MoreActions } from "../../components/MoreActions";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { PageHeader } from "../../components/common";
import { useFileDrop } from "../../lib/useFileDrop";
import { pickDefaultSession } from "./defaultSession";
import { DiagnosticUploadInbox, type DiagnosticUpload } from "./DiagnosticUploadInbox";
import { maximumCompressedLogBytes, type AnalysisProgress } from "./fileAnalyzer";
import { LogImprovementConsent } from "./LogImprovementConsent";
import { downloadKlippyHtmlReport } from "./report";
import { deriveScopedAnalysis } from "./scopedAnalysis";
import { ThermalView } from "./ThermalView";
import type { DiagnosticSeverity, KlippyLogAnalysis } from "./types";
import { AnalysisProgressBar } from "./views/AnalysisProgressBar";
import { AnalysisScope } from "./views/AnalysisScope";
import { ComparisonView } from "./views/ComparisonView";
import { ConfigEvidenceView } from "./views/ConfigEvidenceView";
import { DiagnosticsTabs, type DiagnosticsTab } from "./views/DiagnosticsTabs";
import { FindingsView } from "./views/FindingsView";
import { IncidentsView } from "./views/IncidentsView";
import { McuView } from "./views/McuView";
import { PrintsView } from "./views/PrintsView";
import { SessionNavigator } from "./views/SessionNavigator";
import { ShutdownsView } from "./views/ShutdownsView";
import { SnapshotView } from "./views/SnapshotView";
import { SshUploadCommands } from "./views/SshUploadCommands";
import { TimelineView } from "./views/TimelineView";
import { startLogAnalysis, type AnalysisTask } from "./workerClient";

type DiagnosticsView = "compare" | "config" | "findings" | "incidents" | "prints" | "shutdowns" | "snapshot" | "timeline" | "mcus" | "thermals";

const logInputAccept = ".gz,.log,.txt,.zip,application/gzip,application/zip,text/plain";
const logInputLabel = "Choose diagnostic log files";

export function LogDiagnosticsView() {
  const inputRef = useRef<HTMLInputElement>(null);
  const taskRef = useRef<AnalysisTask | null>(null);
  const [analysis, setAnalysis] = useState<KlippyLogAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<DiagnosticsView>("findings");
  const [severity, setSeverity] = useState<DiagnosticSeverity | "all">("all");
  const [session, setSession] = useState("all");
  const [query, setQuery] = useState("");
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [uploads, setUploads] = useState<DiagnosticUpload[] | null>(null);
  const [inboxError, setInboxError] = useState("");
  const [remoteLoadingId, setRemoteLoadingId] = useState("");
  const [loadedFiles, setLoadedFiles] = useState<File[]>([]);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const autoOpenedUpload = useRef(false);

  const loadFiles = useCallback(async (fileList?: FileList | File[]) => {
    const files = fileList ? [...fileList] : [];
    if (!files.length) return;
    const totalSize = files.reduce((total, file) => total + file.size, 0);
    if (totalSize > maximumCompressedLogBytes) {
      setError("The selected logs exceed the 256 MiB compressed input limit.");
      return;
    }
    taskRef.current?.cancel();
    setBusy(true);
    setError("");
    setProgress({
      expandedBytes: 0,
      fileIndex: 0,
      fileName: files[0].name,
      fileTotal: files.length,
      processedBytes: 0,
      totalBytes: totalSize,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let task: AnalysisTask | null = null;
    try {
      task = startLogAnalysis(files, setProgress);
      taskRef.current = task;
      const result = await task.promise;
      if (taskRef.current !== task) return;
      setAnalysis(result);
      setLoadedFiles(files);
      setView("findings");
      setSession(pickDefaultSession(result));
      setSeverity("all");
      setQuery("");
    } catch (reason) {
      if (task && taskRef.current !== task) return;
      setError(reason instanceof Error ? reason.message : "The log could not be analyzed.");
    } finally {
      if (!task || taskRef.current === task) {
        taskRef.current = null;
        setBusy(false);
        setProgress(null);
      }
    }
  }, []);

  const { isDragActive, dropProps } = useFileDrop((files) => void loadFiles(files));

  // Copy the selection before clearing the input, so re-selecting the same
  // file (e.g. after editing klippy.log on disk) fires a fresh change event.
  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.currentTarget.files ? [...event.currentTarget.files] : [];
    event.currentTarget.value = "";
    void loadFiles(files);
  };

  const loadRemoteUpload = useCallback(async (upload: DiagnosticUpload) => {
    setRemoteLoadingId(upload.id);
    setInboxError("");
    try {
      const response = await fetch(`/api/diagnostic-uploads/${encodeURIComponent(upload.id)}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("The uploaded log is no longer available.");
      const blob = await response.blob();
      await loadFiles([new File([blob], upload.fileName, { type: upload.contentType })]);
      window.history.replaceState(null, "", "/log-diagnostics");
    } catch (reason) {
      setInboxError(reason instanceof Error ? reason.message : "The uploaded log could not be opened.");
    } finally {
      setRemoteLoadingId("");
    }
  }, [loadFiles]);

  const deleteRemoteUpload = async (upload: DiagnosticUpload) => {
    setRemoteLoadingId(upload.id);
    try {
      const response = await fetch(`/api/diagnostic-uploads/${encodeURIComponent(upload.id)}`, {
        credentials: "include",
        method: "DELETE",
      });
      if (!response.ok) throw new Error("The uploaded log could not be deleted.");
      setUploads((current) => current?.filter((item) => item.id !== upload.id) ?? null);
    } catch (reason) {
      setInboxError(reason instanceof Error ? reason.message : "The uploaded log could not be deleted.");
    } finally {
      setRemoteLoadingId("");
    }
  };

  useEffect(() => {
    let active = true;
    void fetch("/api/diagnostic-uploads", { credentials: "include" })
      .then(async (response) => {
        if (!active) return;
        if (response.status === 401) {
          setSignedIn(false);
          if (new URLSearchParams(window.location.search).has("upload")) {
            setInboxError("Sign in to open this private printer upload.");
          }
          return;
        }
        setSignedIn(true);
        const body = await response.json().catch(() => null) as { uploads?: unknown } | null;
        if (!active) return;
        if (!response.ok || !Array.isArray(body?.uploads)) {
          setInboxError("Printer uploads could not be loaded.");
          return;
        }
        setUploads(body.uploads as DiagnosticUpload[]);
        setInboxError("");
      })
      .catch(() => {
        if (active) setInboxError("Printer uploads could not be loaded.");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (autoOpenedUpload.current || !uploads) return;
    const requestedId = new URLSearchParams(window.location.search).get("upload");
    if (!requestedId) return;
    autoOpenedUpload.current = true;
    const upload = uploads.find((item) => item.id === requestedId);
    if (upload) queueMicrotask(() => void loadRemoteUpload(upload));
    else queueMicrotask(() => setInboxError("That printer upload was not found or has expired."));
  }, [loadRemoteUpload, uploads]);

  const cancelAnalysis = () => taskRef.current?.cancel();

  const clear = () => {
    setAnalysis(null);
    setLoadedFiles([]);
    setSubmissionOpen(false);
    setError("");
    if (inputRef.current) inputRef.current.value = "";
  };

  const events = useMemo(() => {
    if (!analysis) return [];
    const normalized = query.trim().toLowerCase();
    return analysis.events.filter((event) =>
      (severity === "all" || event.severity === severity)
      && (session === "all" || event.session === Number(session))
      && (!normalized || `${event.category} ${event.message}`.toLowerCase().includes(normalized)),
    );
  }, [analysis, query, session, severity]);

  if (!analysis) {
    return (
      <section className="log-diagnostics" aria-labelledby="log-diagnostics-title">
        <PageHeader
          actions={<span className="local-only"><ShieldCheck size={14} /> Browser analysis</span>}
          className="diagnostics-header"
          title={tabLabels.Diagnostics}
          titleId="log-diagnostics-title"
        />
        <UnstyledButton
          {...dropProps}
          className={isDragActive ? "log-drop-zone is-dragging" : "log-drop-zone"}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          style={{
            alignItems: "center",
            display: "flex",
            flexDirection: "column",
            gap: 9,
            justifyContent: "center",
            minHeight: 250,
            padding: 24,
            border: "1.5px dashed var(--border-strong)",
            borderRadius: "var(--radius-md)",
            background: "var(--surface)",
            color: "var(--foreground)",
            cursor: busy ? "not-allowed" : "pointer",
            transition: "border-color 150ms ease, background 150ms ease",
            whiteSpace: "normal",
            width: "100%",
          }}
          type="button"
        >
          <FileUp size={32} />
          <strong>{busy ? "Analyzing logs" : "Choose diagnostic logs"}</strong>
          <span>Klippy, Moonraker, kernel, gzip, or Klippee diagnostic bundles</span>
        </UnstyledButton>
        <input ref={inputRef} accept={logInputAccept} aria-label={logInputLabel} hidden multiple onChange={handleFileInput} type="file" />
        {busy && progress && <AnalysisProgressBar onCancel={cancelAnalysis} progress={progress} />}
        {error && <p className="diagnostics-error" role="alert">{error}</p>}
        {uploads === null && signedIn === null && inboxError && <p className="diagnostics-error" role="alert">{inboxError}</p>}
        {signedIn === false && (
          <DiagnosticUploadInbox
            busyId=""
            error={inboxError}
            onDelete={() => undefined}
            onOpen={() => undefined}
            signedOut
            uploads={[]}
          />
        )}
        {uploads !== null && (
          <DiagnosticUploadInbox
            busyId={remoteLoadingId}
            error={inboxError}
            onDelete={(upload) => void deleteRemoteUpload(upload)}
            onOpen={(upload) => void loadRemoteUpload(upload)}
            uploads={uploads}
          />
        )}
        <SshUploadCommands />
        <div className="diagnostics-coverage" aria-label="Diagnostic coverage">
          {[
            ["Communication", "USB, serial, CAN, counters"],
            ["Thermal", "Heaters, sensors, safety limits"],
            ["Motion", "Homing, endstops, extrusion"],
            ["Runtime", "Firmware, host, macros, storage"],
          ].map(([title, detail]) => <div key={title}><strong>{title}</strong><span>{detail}</span></div>)}
        </div>
      </section>
    );
  }

  const scoped = deriveScopedAnalysis(analysis, session);
  const shutdowns = scoped.sessions.filter((item) => item.shutdownReason).length;
  const repeatedCount = events.reduce((total, event) => total + Math.max(0, event.count - 1), 0);
  const tabs: Array<DiagnosticsTab<DiagnosticsView>> = [
    { icon: <AlertTriangle size={15} />, id: "findings", label: "Findings" },
    ...(analysis.bundle?.evidence ? [{ icon: <Database size={15} />, id: "snapshot", label: "Snapshot" } as const] : []),
    ...(analysis.bundle?.evidence?.config ? [{ icon: <Settings2 size={15} />, id: "config", label: "Config" } as const] : []),
    { icon: <Cpu size={15} />, id: "shutdowns", label: "Shutdowns" },
    { icon: <ListTree size={15} />, id: "incidents", label: "Incidents" },
    { icon: <FileText size={15} />, id: "prints", label: "Prints" },
    { icon: <Activity size={15} />, id: "timeline", label: "Timeline" },
    { icon: <Cpu size={15} />, id: "mcus", label: "MCUs" },
    { icon: <Thermometer size={15} />, id: "thermals", label: "Thermals" },
    { icon: <GitCompare size={15} />, id: "compare", label: "Compare" },
  ];
  return (
    <section className="log-diagnostics has-analysis" aria-labelledby="log-diagnostics-title">
      <PageHeader
        actions={<div className="diagnostics-actions">
          <DiagnosticButton className="primary-action" disabled={busy} onClick={() => downloadKlippyHtmlReport(analysis)} type="button"><Download size={15} /> Export HTML</DiagnosticButton>
          <MoreActions label="More diagnostic actions">
            <Menu.Item disabled={busy} leftSection={<FileUp size={15} />} onClick={() => inputRef.current?.click()}>Replace logs</Menu.Item>
            <Menu.Item disabled={busy} leftSection={<Lightbulb size={15} />} onClick={() => setSubmissionOpen((open) => !open)}>Submit for improvements</Menu.Item>
            <Menu.Divider />
            <Menu.Item color="var(--destructive)" leftSection={<Trash2 size={16} />} onClick={clear}>Clear analysis</Menu.Item>
          </MoreActions>
        </div>}
        className="diagnostics-header"
        title={tabLabels.Diagnostics}
        titleId="log-diagnostics-title"
      />
      <input ref={inputRef} accept={logInputAccept} aria-label={logInputLabel} hidden multiple onChange={handleFileInput} type="file" />
      {busy && progress && <AnalysisProgressBar onCancel={cancelAnalysis} progress={progress} />}
      {submissionOpen && (
        <LogImprovementConsent
          files={loadedFiles}
          onClose={() => setSubmissionOpen(false)}
          signedIn={signedIn}
        />
      )}

      <div className="diagnostics-metrics">
        <div><strong>{analysis.sessions.length}</strong><span>Sessions</span></div>
        <div><strong>{scoped.lineCount.toLocaleString()}</strong><span>Lines in view</span></div>
        <div><strong>{scoped.findings.length}</strong><span>Findings in view</span></div>
        <div><strong>{scoped.prints.length}</strong><span>Prints in view</span></div>
        <div><strong>{shutdowns}</strong><span>Shutdowns</span></div>
        <div><strong>{repeatedCount.toLocaleString()}</strong><span>Repeated lines</span></div>
      </div>

      <AnalysisScope analysis={analysis} />

      <SessionNavigator analysis={analysis} onChange={setSession} value={session} />

      <Tabs id="diagnostics-analysis-tabs" onChange={(value) => value && setView(value as DiagnosticsView)} value={view}>
        <DiagnosticsTabs label="Analysis views" tabs={tabs} value={view} />
        <Tabs.Panel style={{ display: "contents" }} value={view}>
        {view === "findings" && <FindingsView analysis={analysis} findings={scoped.findings} summary={scoped.summary} />}
        {view === "snapshot" && <SnapshotView analysis={analysis} />}
        {view === "config" && <ConfigEvidenceView analysis={analysis} />}
        {view === "shutdowns" && <ShutdownsView analysis={analysis} dumps={scoped.shutdownDumps} />}
        {view === "incidents" && <IncidentsView analysis={analysis} incidents={scoped.incidents} key={session} />}
        {view === "prints" && <PrintsView analysis={analysis} prints={scoped.prints} />}
        {view === "timeline" && (
          <TimelineView analysis={analysis} events={events} query={query} setQuery={setQuery} setSeverity={setSeverity} severity={severity} />
        )}
        {view === "mcus" && <McuView analysis={analysis} key={session} sessions={scoped.sessions} />}
        {view === "thermals" && <ThermalView analysis={analysis} key={session} sessions={scoped.sessions} />}
        {view === "compare" && <ComparisonView analysis={analysis} />}
        </Tabs.Panel>
      </Tabs>
    </section>
  );
}
