import { Terminal } from "lucide-react";
import { CommandSnippet } from "../../../components/CommandSnippet";
import { HelpRow } from "../../../components/FieldHelp";

/**
 * Copy-paste bash for sending logs straight from an SSH session on the printer,
 * so users don't have to copy a 60 MiB klippy.log off the machine before they
 * can analyze it here. Leads with the Klippee CLI (which already holds the
 * printer's token) and falls back to a raw authenticated upload.
 */
export function SshUploadCommands() {
  const origin = typeof window !== "undefined" && window.location.origin
    ? window.location.origin
    : "https://klippee.xyz";
  const curlCommand = [
    "curl -fS -X POST",
    '-H "Authorization: Bearer <sync-token>"',
    '-H "Content-Type: application/gzip"',
    '-H "x-klippee-log-name: klippy.log.gz"',
    "--data-binary @/tmp/klippy.log.gz",
    `${origin}/api/sync/repos/<repo-id>/diagnostics`,
  ].join(" ");
  return (
    <details className="diagnostics-ssh-upload">
      <summary>
        <Terminal size={16} />
        <span>
          <strong>Upload from your printer over SSH</strong>
        </span>
      </summary>
      <div className="diagnostics-ssh-body">
        <section>
          <HelpRow label="Upload with the Klippee CLI" help="SSH into the printer and run this command. It bundles the Klippy log with Moonraker logs and runtime state, uploads it privately, and prints a link that opens it here."><h3>With the Klippee CLI</h3></HelpRow>
          <CommandSnippet command="hlab klippee upload-diagnostics" label="Bundle and upload logs" />
          <p className="muted-line">Uploads are private to you, expire after 48 hours, and keep only the newest five per printer.</p>
        </section>
        <section>
          <HelpRow label="Without the CLI (raw upload)" help={<>Compress the log, then post it with a printer sync token that has <code>repo:write</code> scope. Find the repository ID and generate a token on the printer's page under <strong>Manage → CLI</strong>.</>}><h3>Without the CLI (raw upload)</h3></HelpRow>
          <div className="diagnostics-ssh-commands">
            <CommandSnippet command="gzip -c ~/printer_data/logs/klippy.log > /tmp/klippy.log.gz" label="1 · Compress the Klippy log" />
            <CommandSnippet command={curlCommand} label="2 · Upload the compressed log" />
          </div>
          <p className="muted-line">The upload must be 16 MiB or smaller. For a very large log, send only its newest lines instead of step 1:</p>
          <CommandSnippet command="tail -n 20000 ~/printer_data/logs/klippy.log | gzip -c > /tmp/klippy.log.gz" label="Trim a large log first" />
        </section>
      </div>
    </details>
  );
}
