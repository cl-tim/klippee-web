import { DiagnosticButton } from "../DiagnosticControls";
import { HelpRow } from "../../../components/FieldHelp";
import { Settings2 } from "lucide-react";
import { useState } from "react";
import type { KlippyLogAnalysis } from "../types";

export function ConfigEvidenceView({ analysis }: { analysis: KlippyLogAnalysis }) {
  const [sectionLimit, setSectionLimit] = useState(40);
  const config = analysis.bundle?.evidence?.config;
  if (!config) {
    return <div className="diagnostics-empty">
      <Settings2 size={22} />
      <strong>No resolved Klipper configuration found</strong>
    </div>;
  }
  return <div className="diagnostics-view config-evidence-view">
    <div className="bundle-evidence-callout">
      <Settings2 size={20} />
      <span><strong>Active settings at the last Klipper restart</strong>These are Klipper's resolved settings, including defaults. Runtime changes made after the restart may not appear here.</span>
    </div>
    <div className="config-evidence-metrics">
      <article><strong>{config.sectionCount}</strong><span>Resolved sections</span></article>
      <article><strong>{config.retainedSectionCount}</strong><span>Diagnostic sections</span></article>
      <article><strong>{config.warnings.length}</strong><span>Klipper warnings</span></article>
      <article className={config.pendingSave ? "is-warning" : ""}><strong>{config.pendingSave ? "Pending" : "None"}</strong><span>SAVE_CONFIG changes</span></article>
    </div>
    {config.pendingSave && <section className="config-pending-save">
      <h3>Unsaved configuration changes</h3>
      <p>Klipper reported values waiting for <code>SAVE_CONFIG</code>. Review them before saving or restarting.</p>
      {config.pendingSaveItems.length > 0 && <div>{config.pendingSaveItems.map((item) => <code key={item}>{item}</code>)}</div>}
    </section>}
    {config.warnings.length > 0 && <section className="bundle-evidence-warnings">
      <h3>Klipper configuration warnings</h3>
      <ul>{config.warnings.map((warning, index) => <li key={`${warning.type}-${index}`}><strong>{warning.type}:</strong> {warning.message}</li>)}</ul>
    </section>}
    <section>
      <div className="config-evidence-heading">
        <HelpRow label="Diagnostic configuration" help="Communication, heater, sensor, motion, probe, and verification sections retained from the resolved configuration."><h3>Diagnostic configuration</h3></HelpRow>
        <span>{config.sections.length} sections</span>
      </div>
      <div className="config-section-list">
        {config.sections.slice(0, sectionLimit).map((section, index) => {
          const options = Object.entries(section.options);
          return <details key={section.name} open={index === 0}>
          <summary><span><strong>[{section.name}]</strong><small>{section.kind}</small></span><span>{Object.keys(section.options).length} settings</span></summary>
          <dl>
            {options.slice(0, 30).map(([key, value]) => <div key={key}><dt>{key}</dt><dd><code>{value || "(empty)"}</code></dd></div>)}
            {options.length > 30 && <div><dt>Additional settings</dt><dd>{options.length - 30} omitted from this view</dd></div>}
          </dl>
        </details>;
        })}
      </div>
      {config.sections.length > sectionLimit && <DiagnosticButton className="secondary-action diagnostics-load-more" onClick={() => setSectionLimit((value) => value + 40)} type="button">Show more configuration sections</DiagnosticButton>}
    </section>
  </div>;
}
