import { Box, Download, FileAxis3D, FileUp, Gauge, Link2, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FieldLabel } from "../../components/FieldHelp";
import { Accordion, Badge, Button, Group, Menu, NativeSelect, Stack, Text, TextInput, Title } from "@mantine/core";
import { MoreActions } from "../../components/MoreActions";
import { useAccountStorage } from "../../app/contexts/useAccountStorage";
import { formatBytes } from "../../app/format";
import { ParameterControl } from "../cadEditors/ParameterControl";
import { apiError } from "../../lib/api";
import { useFileDrop } from "../../lib/useFileDrop";
import { downloadBlob } from "../../rendering";
import { createDefaultOpenScadFiles } from "./defaultWorkspace";
import { defaultOpenScadParameterValues, parseOpenScadParameters } from "./parameterParser";
import { OpenScadViewer } from "./OpenScadViewer";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { useCadImports } from "./useCadImports";
import { usePanelResize } from "./usePanelResize";
import { loadOpenScadWorkspace, saveOpenScadWorkspace } from "./workspaceStorage";
import type {
  CadEngine,
  OpenScadParameter,
  OpenScadParameterValue,
  OpenScadRenderMode,
  OpenScadSourceFile,
} from "./types";

function sourceWithPythonParameters(source: string, values: Record<string, OpenScadParameterValue>) {
  return Object.entries(values).reduce((current, [key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || (typeof value !== "number" && typeof value !== "boolean")) {
      return current;
    }
    const rendered = typeof value === "boolean" ? (value ? "True" : "False") : String(value);
    return current.replace(new RegExp(`^${key}\\s*=.*$`, "m"), `${key} = ${rendered}`);
  }, source);
}

function cadEngineLabel(engine: CadEngine) {
  if (engine === "build123d") return "build123d";
  return "OpenSCAD";
}

export function OpenScadView() {
  const fieldId = useId();
  const accountStorage = useAccountStorage();
  const [initialWorkspace] = useState(() => {
    const stored = loadOpenScadWorkspace(accountStorage);
    if (stored) return { ...stored, restored: true };
    const files = createDefaultOpenScadFiles();
    return {
      files,
      mainFile: files[0].name,
      parameterValues: defaultOpenScadParameterValues(parseOpenScadParameters(files[0].source)),
      restored: false,
    };
  });
  const [files, setFiles] = useState<OpenScadSourceFile[]>(initialWorkspace.files);
  const [mainFile, setMainFile] = useState(initialWorkspace.mainFile);
  const currentFile = files.find((file) => file.name === mainFile) ?? files[0];
  const currentEngine = currentFile?.engine ?? "openscad";
  const parameters = useMemo(
    () => currentFile?.parameters ?? parseOpenScadParameters(currentFile?.source ?? ""),
    [currentFile?.parameters, currentFile?.source],
  );
  const [parameterValues, setParameterValues] = useState<Record<string, OpenScadParameterValue>>(
    initialWorkspace.parameterValues,
  );
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [renderingMode, setRenderingMode] = useState<OpenScadRenderMode | null>(null);
  const [status, setStatus] = useState(initialWorkspace.restored ? "Restored browser workspace" : "Ready to generate");
  const [error, setError] = useState("");
  const [persistenceError, setPersistenceError] = useState("");
  const [duration, setDuration] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const requestControllerRef = useRef<AbortController | null>(null);
  const {
    beginPanelResize,
    continuePanelResize,
    endPanelResize,
    handlePanelResizeKey,
    panelGridStyle,
    panelRatios,
    parametersPanelRef,
    resetPanelRatios,
    sourcePanelRef,
    viewerPanelRef,
  } = usePanelResize();

  function applyImportedFiles(imported: OpenScadSourceFile[], main: OpenScadSourceFile) {
    setFiles((current) => {
      const importedNames = new Set(imported.map((file) => file.name));
      return [...current.filter((file) => !importedNames.has(file.name)), ...imported];
    });
    setMainFile(main.name);
    syncValues(main.parameters ?? parseOpenScadParameters(main.source), false);
    setStale(false);
  }

  const {
    conversionTarget,
    convertCadFile,
    convertingCad,
    importFiles,
    importFromUrl,
    importUrl,
    importingUrl,
    resetImportState,
    setConversionTarget,
    setImportUrl,
    setShowUrlImport,
    showUrlImport,
  } = useCadImports({
    applyImportedFiles,
    clearPreview: () => setBuffer(null),
    renderingMode,
    requestControllerRef,
    setError,
    setStatus,
  });
  const { isDragActive, dropProps } = useFileDrop((droppedFiles) => void importFiles(droppedFiles));

  useEffect(() => () => requestControllerRef.current?.abort(), []);
  useEffect(() => {
    let nextError = "";
    try {
      saveOpenScadWorkspace(accountStorage, { files, mainFile, parameterValues });
    } catch {
      nextError = "This workspace is too large for browser storage. Download your SCAD before leaving.";
    }
    const timer = window.setTimeout(() => setPersistenceError(nextError), 0);
    return () => window.clearTimeout(timer);
  }, [accountStorage, files, mainFile, parameterValues]);

  const groups = useMemo(() => {
    const grouped = new Map<string, OpenScadParameter[]>();
    for (const parameter of parameters) {
      grouped.set(parameter.group, [...(grouped.get(parameter.group) ?? []), parameter]);
    }
    return [...grouped.entries()];
  }, [parameters]);

  function syncValues(nextParameters: OpenScadParameter[], preserve = true) {
    setParameterValues((current) =>
      Object.fromEntries(
        nextParameters.map((parameter) => [
          parameter.key,
          preserve && current[parameter.key] !== undefined ? current[parameter.key] : parameter.defaultValue,
        ]),
      ),
    );
  }

  function changeMainFile(name: string) {
    const next = files.find((file) => file.name === name);
    if (!next) return;
    setMainFile(name);
    syncValues(next.parameters ?? parseOpenScadParameters(next.source), false);
    setBuffer(null);
    setError("");
    setStatus("Entry file changed");
  }

  function changeSource(source: string) {
    setFiles((current) => current.map((file) => (file.name === mainFile ? { ...file, source } : file)));
    syncValues(parseOpenScadParameters(source));
    setStale(Boolean(buffer));
  }

  function removeFile(name: string) {
    if (files.length === 1) return;
    const nextFiles = files.filter((file) => file.name !== name);
    setFiles(nextFiles);
    if (mainFile === name) {
      setMainFile(nextFiles[0].name);
      syncValues(nextFiles[0].parameters ?? parseOpenScadParameters(nextFiles[0].source), false);
    }
    setBuffer(null);
  }

  function render(mode: OpenScadRenderMode) {
    if (renderingMode || convertingCad || !currentFile) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setRenderingMode(mode);
    setError("");
    setStatus(mode === "preview" ? "Generating preview on server" : "Exporting STL on server");

    void (async () => {
      try {
        if (currentEngine !== "openscad" && !currentFile.plan) {
          throw new Error(`This ${cadEngineLabel(currentEngine)} file has no reconstruction plan.`);
        }
        const endpoint = currentEngine === "openscad" ? "render" : `render-${currentEngine}`;
        const payload = currentEngine !== "openscad"
          ? { parameters: parameterValues, plan: currentFile.plan }
          : {
              files: files
                .filter((file) => (file.engine ?? "openscad") === "openscad")
                .map(({ name, source }) => ({ name, source })),
              mainFile,
              parameters: parameterValues,
            };
        const response = await fetch(`/api/cad/${endpoint}?mode=${mode}`, {
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await apiError(response, `${cadEngineLabel(currentEngine)} could not render this model.`));
        const nextBuffer = await response.arrayBuffer();
        if (nextBuffer.byteLength < 84) throw new Error("The CAD engine returned an empty STL.");
        const nextDuration = Number(response.headers.get("x-cad-duration-ms")) || null;
        if (mode === "preview") {
          setBuffer(nextBuffer);
          setDuration(nextDuration);
          setStatus("Draft preview ready");
          setStale(false);
        } else {
          downloadBlob(new Blob([nextBuffer], { type: "model/stl" }), `${mainFile.replace(/\.(?:scad|py)$/i, "")}.stl`);
          setStatus("Normal STL exported");
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setError(error instanceof Error ? error.message : "The CAD engine could not render this model.");
        setStatus("Render failed");
      } finally {
        setRenderingMode(null);
        if (requestControllerRef.current === controller) requestControllerRef.current = null;
      }
    })();
  }

  function reset() {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    resetImportState();
    const resetFiles = createDefaultOpenScadFiles();
    setFiles(resetFiles);
    setMainFile(resetFiles[0].name);
    setParameterValues(defaultOpenScadParameterValues(parseOpenScadParameters(resetFiles[0].source)));
    setBuffer(null);
    setError("");
    setDuration(null);
    setStale(false);
    setStatus("Scratch file restored");
  }

  function downloadSource() {
    if (!currentFile) return;
    const source = currentEngine !== "openscad"
      ? sourceWithPythonParameters(currentFile.source, parameterValues)
      : currentFile.source;
    downloadBlob(new Blob([source], { type: "text/plain" }), currentFile.name);
  }

  return (
    <section className="openscad-workspace" style={panelGridStyle}>
      <aside
        aria-label="CAD source panel"
        className={isDragActive ? "openscad-source-panel is-drop-target" : "openscad-source-panel"}
        ref={sourcePanelRef}
        {...dropProps}
      >
        {isDragActive ? (
          <div aria-label="Drop OpenSCAD files here" className="openscad-drop-overlay" role="status">
            <FileUp size={32} />
            <Text fw={600}>Drop SCAD files</Text>
            <Text c="dimmed" size="sm">Add one or several files to this workspace</Text>
          </div>
        ) : null}
        <header className="openscad-panel-header">
          <div>
            <Title order={1}>OpenSCAD</Title>
          </div>
          <Group className="openscad-import-actions" gap="xs" style={{ maxWidth: "100%", minWidth: 0 }} wrap="wrap">
            <Button
              aria-expanded={showUrlImport}
              aria-label="Load OpenSCAD from URL"
              className="icon-button"
              disabled={importingUrl || convertingCad || Boolean(renderingMode)}
              onClick={() => setShowUrlImport((current) => !current)}
              title="Load SCAD from URL"
              type="button"
              variant="subtle"
            >
              <Link2 size={18} />
            </Button>
            <label
              className="icon-button openscad-upload"
              title="Reverse-engineer CAD"
            >
              <FileAxis3D size={18} />
              <input
                accept=".step,.stp,.iges,.igs,.brep"
                aria-label={`Reverse-engineer STEP, IGES, or BREP as ${cadEngineLabel(conversionTarget)}`}
                disabled={convertingCad || Boolean(renderingMode)}
                onChange={(event) => {
                  const input = event.currentTarget;
                  void convertCadFile(input.files?.[0]).finally(() => {
                    input.value = "";
                  });
                }}
                type="file"
              />
            </label>
            <label className="icon-button openscad-upload" title="Upload SCAD">
              <FileUp size={18} />
              <input
                accept=".scad,text/plain"
                aria-label="Upload OpenSCAD files"
                multiple
                onChange={(event) => {
                  const input = event.currentTarget;
                  void importFiles(input.files).finally(() => {
                    input.value = "";
                  });
                }}
                type="file"
              />
            </label>
          </Group>
        </header>
        {showUrlImport ? (
          <form
            className="openscad-url-import"
            onSubmit={(event) => {
              event.preventDefault();
              void importFromUrl();
            }}
          >
            <Group align="end" className="openscad-url-import-row" wrap="wrap">
              <div style={{ flex: 1, minWidth: 0 }}><FieldLabel label="SCAD or GitHub URL" htmlFor={`${fieldId}-url`}>Use a direct .scad URL or a public GitHub repository, folder, or file URL.</FieldLabel>
              <TextInput
                id={`${fieldId}-url`}
                autoFocus
                disabled={importingUrl}
                onChange={(event) => setImportUrl(event.currentTarget.value)}
                placeholder="https://…/model.scad"
                style={{ flex: 1 }}
                type="url"
                value={importUrl}
              /></div>
              <Button className="inline-action" disabled={importingUrl || !importUrl.trim()} type="submit" variant="default">
                {importingUrl ? "Loading…" : "Load"}
              </Button>
            </Group>
          </form>
        ) : null}
        <NativeSelect
          aria-label="Reconstruction output"
          data={[
            { label: "OpenSCAD", value: "openscad" },
            { label: "build123d", value: "build123d" },
          ]}
          disabled={convertingCad || Boolean(renderingMode)}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "openscad" || value === "build123d") setConversionTarget(value);
          }}
          value={conversionTarget}
        />
        <NativeSelect
          className="field"
          data={files.map((file) => ({ label: file.name, value: file.name }))}
          label="Entry file"
          onChange={(event) => changeMainFile(event.currentTarget.value)}
          value={mainFile}
        />
        <div className="field openscad-source-editor">
          <FieldLabel label={currentEngine === "openscad" ? "Source — paste or edit SCAD" : `Source — generated ${cadEngineLabel(currentEngine)}`} htmlFor={`${fieldId}-source`}>
            {currentEngine === "openscad" ? "Drop .scad files anywhere in this panel. Editable SCAD is autosaved only in this browser. Rendering is transient; source and generated results are not stored on Klippee. " : "Use the parameter panel to create a comparable render. "}
            {currentEngine === "openscad" && <>BOSL2 is available when rendering. Use <code>include &lt;BOSL2/std.scad&gt;</code>.</>}
          </FieldLabel>
          <textarea
            id={`${fieldId}-source`}
            onChange={(event) => changeSource(event.target.value)}
            readOnly={currentEngine !== "openscad"}
            spellCheck={false}
            value={currentFile?.source ?? ""}
          />
        </div>
        <Text className="openscad-private-note" c="dimmed" size="sm">
          {currentFile?.conversion
            ? `${cadEngineLabel(currentEngine)} reconstruction is generated transiently.`
            : "Editable SCAD is saved only in this browser."}
        </Text>
        {persistenceError ? <Text className="openscad-storage-warning" role="alert" size="sm">{persistenceError}</Text> : null}
      </aside>

      <PanelResizeHandle
        ariaLabel="Resize source and preview panels"
        divider={0}
        onBegin={beginPanelResize}
        onContinue={continuePanelResize}
        onEnd={endPanelResize}
        onKey={handlePanelResizeKey}
        onReset={resetPanelRatios}
        panelRatios={panelRatios}
      />

      <div aria-label="Model preview panel" className="openscad-viewer-panel" ref={viewerPanelRef}>
        <header className="openscad-viewer-header">
          <div>
            <Title order={2}>{mainFile}</Title>
          </div>
          <Badge className="openscad-preview-policy" variant="light">Draft preview · Normal export</Badge>
        </header>
        <div className="openscad-viewer-stage">
          <OpenScadViewer buffer={buffer} />
          {!buffer && !renderingMode && !convertingCad ? (
            <div className="openscad-viewer-empty">
              <Box size={38} />
              <Text fw={600}>No preview yet</Text>
              <Text c="dimmed" size="sm">Adjust the source or parameters, then generate a preview below.</Text>
            </div>
          ) : null}
          {renderingMode || convertingCad ? (
            <div className="openscad-render-state">
              <Gauge size={32} />
              <Text fw={600} role="status">{status}</Text>
              <Text c="dimmed" size="sm">Processing on server</Text>
            </div>
          ) : null}
          {buffer && stale ? <Badge className="openscad-mesh-badge is-stale">Parameters changed — refresh preview</Badge> : null}
        </div>
        {error ? <pre className="openscad-error">{error}</pre> : null}
        <footer className="openscad-actionbar">
          <Text c="dimmed" size="sm" mih="2lh" lineClamp={2} title={status} role={renderingMode || convertingCad ? undefined : "status"}>{!renderingMode && !convertingCad && (stale ? "Showing previous preview" : status === "Draft preview ready" && buffer
            ? `Draft preview ready · ${formatBytes(buffer.byteLength)}${duration ? ` · ${(duration / 1000).toFixed(1)}s` : ""}` : status)}</Text>
          <Group className="cad-preview-actions" gap="xs" wrap="wrap">
            <Button className="inline-action" disabled={Boolean(renderingMode) || convertingCad} onClick={() => render("export")} type="button" variant="default"><Download aria-hidden="true" size={16} />Export STL</Button>
            <Button aria-label={buffer ? "Refresh preview" : "Generate preview"} className="primary-action" disabled={Boolean(renderingMode) || convertingCad} onClick={() => render("preview")} type="button"><Gauge aria-hidden="true" size={17} />{buffer ? "Refresh" : "Preview"}</Button>
            <MoreActions label="More CAD actions">
              <Menu.Item leftSection={<Download size={16} />} onClick={downloadSource}>Download {currentEngine === "openscad" ? "SCAD" : "Python"}</Menu.Item>
              <Menu.Item color="var(--destructive)" disabled={files.length === 1} leftSection={<Trash2 size={16} />} onClick={() => removeFile(mainFile)}>Remove entry file</Menu.Item>
              <Menu.Divider />
              <Menu.Item leftSection={<RotateCcw size={16} />} onClick={reset}>Reset workspace</Menu.Item>
            </MoreActions>
          </Group>
        </footer>
      </div>

      <PanelResizeHandle
        ariaLabel="Resize preview and parameter panels"
        divider={1}
        onBegin={beginPanelResize}
        onContinue={continuePanelResize}
        onEnd={endPanelResize}
        onKey={handlePanelResizeKey}
        onReset={resetPanelRatios}
        panelRatios={panelRatios}
      />

      <aside aria-label="Customizer parameters panel" className="openscad-parameters-panel" ref={parametersPanelRef}>
        <header className="openscad-panel-header">
          <div>
            <Title order={2}>Parameters</Title>
          </div>
          <Badge variant="light">{parameters.length}</Badge>
        </header>
        <div className="openscad-parameter-scroll">
          {groups.length ? (
            <Accordion defaultValue={groups.slice(0, 3).map(([group]) => group)} multiple>
              {groups.map(([group, fields]) => (
                <Accordion.Item key={group} value={group}>
                  <Accordion.Control>{group}</Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="sm">
                      {fields.map((parameter) => (
                        <ParameterControl
                          key={parameter.key}
                          onChange={(value) => {
                            setParameterValues((current) => ({ ...current, [parameter.key]: value }));
                            setStale(Boolean(buffer));
                          }}
                          parameter={parameter}
                          value={parameterValues[parameter.key] ?? parameter.defaultValue}
                        />
                      ))}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              ))}
            </Accordion>
          ) : <Text className="empty-state" c="dimmed">No scalar Customizer parameters were detected. You can still edit and render the source.</Text>}
        </div>
        <div className="openscad-license-links">
          <a href="https://github.com/openscad/openscad" rel="noreferrer" target="_blank">OpenSCAD source and GPL license</a>
          <a href="https://github.com/BelfrySCAD/BOSL2" rel="noreferrer" target="_blank">BOSL2 library and documentation</a>
          <a href="https://github.com/gumyr/build123d" rel="noreferrer" target="_blank">build123d source and Apache license</a>
          <a href="https://github.com/CadQuery/OCP" rel="noreferrer" target="_blank">OpenCascade bindings and license</a>
        </div>
      </aside>
    </section>
  );
}
