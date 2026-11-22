import { DiagnosticButton, DiagnosticCheckbox } from "./DiagnosticControls";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { formatBinaryBytes } from "../../app/format";

type LogImprovementSubmission = {
  expiresAt: string;
  fileName: string;
  id: string;
  originalFileName: string;
  originalSizeBytes: number;
  sha256: string;
  sizeBytes: number;
};

const consentVersion = "2026-07-24";
const maximumSubmissionBytes = 16 * 1024 * 1024;
const maximumFiles = 20;

export function LogImprovementConsent({
  files,
  onClose,
  signedIn,
}: {
  files: File[];
  onClose: () => void;
  signedIn: boolean | null;
}) {
  const [sharingConfirmed, setSharingConfirmed] = useState(false);
  const [redactionConfirmed, setRedactionConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<LogImprovementSubmission[]>([]);
  const [error, setError] = useState("");

  const submit = async () => {
    setSubmitting(true);
    setError("");
    const created: LogImprovementSubmission[] = [];
    try {
      for (const file of files) {
        const prepared = await prepareSubmissionFile(file);
        if (prepared.size > maximumSubmissionBytes) {
          throw new Error(`${file.name} is still larger than 16 MiB after compression and cannot be submitted.`);
        }
        const response = await fetch("/api/log-improvement-submissions", {
          body: prepared.body,
          credentials: "include",
          headers: {
            "content-type": prepared.contentType,
            "x-klippee-consent-version": consentVersion,
            "x-klippee-log-name": encodeURIComponent(file.name),
            "x-klippee-original-size": String(file.size),
            "x-klippee-redaction-confirmed": "1",
          },
          method: "POST",
        });
        const body = await response.json().catch(() => null) as {
          error?: string;
          submission?: LogImprovementSubmission;
        } | null;
        if (!response.ok || !body?.submission) {
          throw new Error(body?.error ?? `Klippee could not submit ${file.name}.`);
        }
        created.push(body.submission);
      }
      setSubmitted(created);
    } catch (reason) {
      setSubmitted(created);
      setError(reason instanceof Error ? reason.message : "The logs could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  const withdraw = async () => {
    setSubmitting(true);
    setError("");
    try {
      for (const submission of submitted) {
        const response = await fetch(`/api/log-improvement-submissions/${encodeURIComponent(submission.id)}`, {
          credentials: "include",
          method: "DELETE",
        });
        if (!response.ok) throw new Error("Klippee could not withdraw every submitted file.");
      }
      setSubmitted([]);
      setSharingConfirmed(false);
      setRedactionConfirmed(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The submission could not be withdrawn.");
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted.length === files.length && files.length > 0) {
    return (
      <section className="log-improvement-consent is-complete" aria-labelledby="log-improvement-title">
        <div className="log-improvement-heading">
          <div><span>Contribution received</span><h2 id="log-improvement-title">Thank you for improving the analyzer</h2></div>
          <DiagnosticButton className="secondary-action" onClick={onClose} type="button">Close</DiagnosticButton>
        </div>
        <p>
          {submitted.length} {submitted.length === 1 ? "file was" : "files were"} stored as gzip and will be available to Klippee developers for up to 90 days.
        </p>
        <div className="log-improvement-result">
          {submitted.map((submission) => (
            <span key={submission.id}><strong>{submission.originalFileName}</strong> Reference {submission.id}</span>
          ))}
        </div>
        {error && <p className="diagnostics-error" role="alert">{error}</p>}
        <DiagnosticButton className="secondary-action" disabled={submitting} onClick={() => void withdraw()} type="button">
          {submitting ? "Withdrawing…" : "Withdraw this submission"}
        </DiagnosticButton>
      </section>
    );
  }

  return (
    <section className="log-improvement-consent" aria-labelledby="log-improvement-title">
      <div className="log-improvement-heading">
        <div><span>Optional contribution</span><h2 id="log-improvement-title">Submit logs for analyzer improvements</h2></div>
        <DiagnosticButton className="secondary-action" onClick={onClose} type="button">Cancel</DiagnosticButton>
      </div>
      <div className="log-improvement-warning">
        <AlertTriangle size={20} />
        <p>
          {files.length === 1 ? "This log" : `These ${files.length} logs`} will be uploaded and shared with Klippee developers.
          Klippy logs can contain printer configuration, hardware identifiers, serial paths, hostnames, IP addresses,
          file paths, macro output, and print filenames. Redact anything you do not want to share before submitting.
        </p>
      </div>
      <p className="log-improvement-retention">
        Submitted logs are not public. They are stored compressed for up to 90 days and used only to improve Klippee's log analyzer.
      </p>
      <fieldset>
        <legend>Consent</legend>
        <label>
          <DiagnosticCheckbox checked={sharingConfirmed} onChange={(event) => setSharingConfirmed(event.target.checked)} />
          I understand that information about my printer and host in these files will be shared with Klippee developers.
        </label>
        <label>
          <DiagnosticCheckbox checked={redactionConfirmed} onChange={(event) => setRedactionConfirmed(event.target.checked)} />
          I have reviewed these files and redacted anything I do not want to share.
        </label>
      </fieldset>
      {signedIn === false && <p className="log-improvement-auth">Sign in from the sidebar before submitting logs.</p>}
      {error && <p className="diagnostics-error" role="alert">{error}</p>}
      {submitted.length > 0 && (
        <>
          <p className="log-improvement-auth">
            {submitted.length} {submitted.length === 1 ? "file was" : "files were"} submitted before the error. Withdraw those files before trying again.
          </p>
          <DiagnosticButton className="secondary-action" disabled={submitting} onClick={() => void withdraw()} type="button">
            {submitting ? "Withdrawing…" : "Withdraw submitted files"}
          </DiagnosticButton>
        </>
      )}
      {files.length > maximumFiles && (
        <p className="diagnostics-error" role="alert">Submit no more than 20 files at a time.</p>
      )}
      <div className="log-improvement-actions">
        <span>{files.length} {files.length === 1 ? "file" : "files"} · {formatBinaryBytes(files.reduce((total, file) => total + file.size, 0))} before compression</span>
        <DiagnosticButton
          className="primary-action"
          disabled={
            !files.length
            || files.length > maximumFiles
            || submitted.length > 0
            || signedIn !== true
            || !sharingConfirmed
            || !redactionConfirmed
            || submitting
          }
          onClick={() => void submit()}
          type="button"
        >
          {submitting ? "Compressing and submitting…" : signedIn === null ? "Checking sign-in…" : signedIn ? "Submit for improvements" : "Sign in to submit"}
        </DiagnosticButton>
      </div>
    </section>
  );
}

async function prepareSubmissionFile(file: File) {
  if (file.type === "application/gzip" || file.name.toLowerCase().endsWith(".gz")) {
    return { body: file as Blob, contentType: "application/gzip", size: file.size };
  }
  if (typeof CompressionStream === "undefined" || typeof file.stream !== "function") {
    return { body: file as Blob, contentType: "text/plain", size: file.size };
  }
  const stream = file.stream().pipeThrough(new CompressionStream("gzip"));
  const body = await new Response(stream).blob();
  return { body, contentType: "application/gzip", size: body.size };
}
