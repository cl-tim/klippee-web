import { CloudDownload, Trash2 } from "lucide-react";
import { formatBinaryBytes } from "../../app/format";
import { DiagnosticButton } from "./DiagnosticControls";
import { formatUploadAge } from "./formatters";

export type DiagnosticUpload = {
  contentType: string;
  createdAt: string;
  expiresAt: string;
  fileName: string;
  id: string;
  originalSizeBytes: number;
  printerId: string;
  printerName: string;
  repositoryId: string;
  sizeBytes: number;
  truncated: boolean;
};

export function DiagnosticUploadInbox({
  busyId,
  error,
  onDelete,
  onOpen,
  signedOut = false,
  uploads,
}: {
  busyId: string;
  error: string;
  onDelete: (upload: DiagnosticUpload) => void;
  onOpen: (upload: DiagnosticUpload) => void;
  signedOut?: boolean;
  uploads: DiagnosticUpload[];
}) {
  return (
    <section className="diagnostic-inbox" aria-labelledby="diagnostic-inbox-title">
      <div className="diagnostic-inbox-heading">
        <div><span>Private diagnostic inbox</span><h2 id="diagnostic-inbox-title">Uploaded from printers</h2></div>
        <small>Stored privately for 48 hours · newest 5 per printer</small>
      </div>
      {error && <p className="diagnostics-error" role="alert">{error}</p>}
      {signedOut ? (
        <div className="diagnostic-inbox-empty">
          <CloudDownload size={20} />
          <span>Sign in to see printer uploads sent with <code>hlab klippee upload-diagnostics</code>.</span>
        </div>
      ) : !uploads.length ? (
        <div className="diagnostic-inbox-empty">
          <CloudDownload size={20} />
          <span>Run <code>hlab klippee upload-diagnostics</code> on a printer, or use its Mainsail/Fluidd macro.</span>
        </div>
      ) : (
        <div className="diagnostic-upload-list">
          {uploads.map((upload) => (
            <article key={upload.id}>
              <CloudDownload size={18} />
              <div>
                <strong>{upload.printerName}</strong>
                <span>{upload.fileName} · {formatBinaryBytes(upload.sizeBytes)} · {formatUploadAge(upload.createdAt)}</span>
                {upload.truncated && <small>One or more sources contain only their newest retained data.</small>}
              </div>
              <DiagnosticButton className="primary-action" disabled={Boolean(busyId)} onClick={() => onOpen(upload)} type="button">
                {busyId === upload.id ? "Opening…" : "Analyze"}
              </DiagnosticButton>
              <DiagnosticButton
                aria-label={`Delete ${upload.fileName} from ${upload.printerName}`}
                className="icon-button"
                disabled={Boolean(busyId)}
                onClick={() => onDelete(upload)}
                title="Delete upload"
                type="button"
              >
                <Trash2 size={15} />
              </DiagnosticButton>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
