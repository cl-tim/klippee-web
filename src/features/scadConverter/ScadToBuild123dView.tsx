import { Check, Copy, Download, FileCode2, Upload, Wand2 } from "lucide-react";
import { Badge, Button, Text, TextInput, Title } from "@mantine/core";
import { useRef, useState, type ChangeEvent } from "react";
import { apiError } from "../../lib/api";
import { useCopyFeedback } from "../../lib/useCopyFeedback";
import { useFileDrop } from "../../lib/useFileDrop";
import { downloadBlob } from "../../rendering";
import { HelpRow } from "../../components/FieldHelp";
import { Card } from "@/components/ui/card";

const SAMPLE_SOURCE = `// Paste or drop an OpenSCAD script, then convert it.
$fn = 48;

difference() {
    cube([40, 40, 12], center = true);
    cylinder(h = 20, r = 8, center = true);
    for (i = [0 : 3])
        rotate([0, 0, i * 90])
            translate([15, 0, 0])
                cylinder(h = 20, r = 2, center = true);
}
`;

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

type ConversionResponse = {
  convertedNodes: number;
  coverage: number;
  duration: number;
  filename: string;
  nodeCount: number;
  source: string;
  unsupported: string[];
};

export function ScadToBuild123dView() {
  const [source, setSource] = useState(SAMPLE_SOURCE);
  const [name, setName] = useState("model.scad");
  const [result, setResult] = useState<ConversionResponse | null>(null);
  const [converting, setConverting] = useState(false);
  const [status, setStatus] = useState("Paste an OpenSCAD script to convert");
  const [error, setError] = useState("");
  const { copied, copy } = useCopyFeedback();
  const fileInputRef = useRef<HTMLInputElement>(null);

  function loadFile(file: File | undefined) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".scad")) {
      setError("Choose a .scad file.");
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setError("That OpenSCAD file is too large to convert.");
      return;
    }
    void file.text().then((text) => {
      setSource(text);
      setName(file.name);
      setResult(null);
      setError("");
      setStatus(`Loaded ${file.name}`);
    });
  }

  const { isDragActive, dropProps } = useFileDrop((files) => loadFile(files[0]));

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    loadFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function convert() {
    if (converting) return;
    if (!source.trim()) {
      setError("Add some OpenSCAD source first.");
      return;
    }
    setConverting(true);
    setError("");
    setStatus("Flattening the script with OpenSCAD");

    void (async () => {
      try {
        const response = await fetch("/api/cad/convert-scad", {
          body: JSON.stringify({
            files: [{ name: name || "model.scad", source }],
            mainFile: name || "model.scad",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (!response.ok) throw new Error(await apiError(response, "The script could not be converted."));
        const data = await response.json() as ConversionResponse;
        setResult(data);
        setStatus(
          data.unsupported.length
            ? `Converted ${Math.round(data.coverage * 100)}% of ${data.nodeCount} operations`
            : `Converted all ${data.nodeCount} operations`,
        );
      } catch (conversionError) {
        setResult(null);
        setError(conversionError instanceof Error ? conversionError.message : "The script could not be converted.");
        setStatus("Conversion failed");
      } finally {
        setConverting(false);
      }
    })();
  }

  function copyOutput() {
    if (!result) return;
    void copy(result.source);
  }

  function downloadOutput() {
    if (!result) return;
    downloadBlob(new Blob([result.source], { type: "text/x-python" }), result.filename);
  }

  return (
    <section aria-label="OpenSCAD to build123d converter" className="scad-converter-workspace">
      <header className="scad-converter-intro">
        <HelpRow label="OpenSCAD to build123d" help={<>
          OpenSCAD flattens the script first, so modules, loops, and variables are resolved before
          translation. Operations without a build123d equivalent are listed rather than guessed at.
        </>}><Title order={1}>OpenSCAD to build123d</Title></HelpRow>
      </header>

      <div className="scad-converter-panes">
        <Card
          aria-label="OpenSCAD source"
          className={isDragActive ? "scad-converter-pane is-dragging p-0 gap-0" : "scad-converter-pane p-0 gap-0"}
          role="region"
          {...dropProps}
        >
          <header>
            <span><FileCode2 aria-hidden="true" size={16} />OpenSCAD</span>
            <div>
              <TextInput aria-label="File name" className="scad-converter-name" onChange={(event) => setName(event.currentTarget.value)} value={name} />
              <Button className="inline-action" onClick={() => fileInputRef.current?.click()} type="button" variant="default">
                <Upload size={15} />Open
              </Button>
              <input
                accept=".scad"
                hidden
                onChange={handleFileInput}
                ref={fileInputRef}
                type="file"
              />
            </div>
          </header>
          <textarea
            aria-label="OpenSCAD source"
            onChange={(event) => { setSource(event.target.value); setResult(null); }}
            spellCheck={false}
            value={source}
          />
        </Card>

        <Card aria-label="build123d source" className="scad-converter-pane p-0 gap-0" role="region">
          <header>
            <span><FileCode2 aria-hidden="true" size={16} />build123d</span>
            <div>
              {result ? (
                <Badge className={result.unsupported.length ? "scad-converter-badge is-partial" : "scad-converter-badge"} variant="light">
                  {Math.round(result.coverage * 100)}% converted
                </Badge>
              ) : null}
              <Button className="inline-action" disabled={!result} onClick={copyOutput} type="button" variant="default">
                {copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "Copied" : "Copy"}
              </Button>
              <Button className="inline-action" disabled={!result} onClick={downloadOutput} type="button" variant="default">
                <Download size={15} />Download
              </Button>
            </div>
          </header>
          {result ? (
            <pre className="scad-converter-output"><code>{result.source}</code></pre>
          ) : (
            <div className="scad-converter-empty">
              <Wand2 size={30} />
              <Text fw={600}>Nothing converted yet</Text>
              <Text c="dimmed" size="sm">Convert the script to see its build123d equivalent.</Text>
            </div>
          )}
        </Card>
      </div>

      {result?.unsupported.length ? (
        <div className="scad-converter-warnings" role="status">
          <Text fw={600}>{result.unsupported.length} operation{result.unsupported.length === 1 ? "" : "s"} could not be converted</Text>
          <ul>
            {result.unsupported.map((entry) => <li key={entry}>{entry}</li>)}
          </ul>
          <Text c="dimmed" size="sm">
            The generated code raises at those points rather than producing different geometry, and each
            one is marked with a FIXME comment.
          </Text>
        </div>
      ) : null}

      {error ? <pre className="openscad-error">{error}</pre> : null}

      <footer className="openscad-actionbar">
        <Text c="dimmed" size="sm" mih="2lh" lineClamp={2} title={status}>{status}{result?.duration ? ` · ${(result.duration / 1000).toFixed(1)}s` : ""}</Text>
        <div>
          <Button className="primary-action" loading={converting} disabled={converting} onClick={convert} type="button">
            <Wand2 size={17} />Convert to build123d
          </Button>
        </div>
      </footer>
    </section>
  );
}
